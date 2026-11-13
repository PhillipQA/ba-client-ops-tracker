/**
 * Connecting a person's Gmail (OAuth), its labels, disconnecting, and syncing mail into Work Hub.
 */
import { gmailWindowStart, syncGmailPages, gmailBodyText, gmailAttachmentSummaries } from './gmail-content'
import { hasScope, SEND_SCOPE, READ_SCOPE } from './gmail-send'
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import type { Express } from 'express'
import { IntegrationError, encryptSecret, decryptSecret } from './tenant-integrations'
import {
  CALLBACK,
  type CommunicationsDeps,
  COOKIE,
  DRIVE_LIST_SCOPE,
  DRIVE_READ_SCOPE,
  gmailKind,
  google,
  missingReadColumn,
  oauthStates,
  origin,
  SHEETS_READ_SCOPE,
  SHEETS_WRITE_SCOPE,
} from './communications-common'
import type { CommunicationsCore } from './communications-core'

export function gmailRoutes(app: Express, deps: CommunicationsDeps, comms: CommunicationsCore) {
  const {
    auth,
    guard,
    gmailGate,
    wrap,
    current,
    activeAccount,
    accessGrant,
    drive,
    liveUser,
    settings,
    db,
    accessToken,
    gmailSyncJobs,
    gmailQuotaCooldowns,
    gmailBackfillCooldowns,
  } = comms
  app.get(
    '/api/communications/gmail/connect',
    ...auth,
    guard,
    gmailGate,
    wrap(async (req, res) => {
      const user = current(req),
        session = deps.sessionFromRequest(req),
        config = await activeAccount(user.organizationId)
      if (!session.token || config.credentials.redirectUri !== `${origin(req)}${CALLBACK}`)
        throw new IntegrationError(
          'Gmail callback or session changed. Ask your account administrator to update the OAuth client.',
          409,
        )
      const verifier = randomBytes(32).toString('base64url'),
        state = randomBytes(32).toString('hex'),
        cookie = randomBytes(32).toString('hex')
      for (const [key, value] of oauthStates)
        if (value.userId === user.id && value.tenantId === user.organizationId) oauthStates.delete(key)
      if (oauthStates.size > 1000)
        throw new IntegrationError('Too many pending Gmail connections. Try again shortly.', 429)
      // Sending is opt-in (?send=1). A plain reconnect keeps it if the person had already allowed it, so reconnecting never drops it.
      // Google Sheets (for connected trackers) works the same way: asked for with ?sheets=1 and kept on a plain reconnect.
      // Editing Sheets (?sheets=write, for marking rows done in a Sheet) is asked for separately and also kept.
      const askedSheets = req.query.sheets === '1' || req.query.sheets === 'write'
      let send = req.query.send === '1',
        sheets = askedSheets,
        sheetsWrite = req.query.sheets === 'write',
        driveRead = askedSheets && req.query.excel === '1'
      if (!send || !sheets || !sheetsWrite || !driveRead) {
        try {
          const scope = (await accessGrant(req)).scope
          send ||= hasScope(scope, SEND_SCOPE)
          sheetsWrite ||= hasScope(scope, SHEETS_WRITE_SCOPE)
          sheets ||= sheetsWrite || hasScope(scope, SHEETS_READ_SCOPE)
          driveRead ||= hasScope(scope, DRIVE_READ_SCOPE)
        } catch {
          /* Not connected yet, or the old token no longer works. */
        }
      }
      oauthStates.set(state, {
        token: session.token,
        userId: user.id,
        tenantId: user.organizationId,
        verifier,
        cookie,
        revision: config.row.revision,
        expires: Date.now() + 600000,
        send,
        sheets: askedSheets ? true : sheets ? undefined : false,
        sheetsWrite: req.query.sheets === 'write',
      })
      res.cookie(COOKIE, cookie, {
        httpOnly: true,
        secure: origin(req).startsWith('https:'),
        sameSite: 'lax',
        path: CALLBACK,
        maxAge: 600000,
      })
      const query = new URLSearchParams({
        client_id: config.credentials.clientId,
        redirect_uri: config.credentials.redirectUri,
        response_type: 'code',
        scope: `${READ_SCOPE}${send ? ` ${SEND_SCOPE}` : ''}${sheets ? ` ${sheetsWrite ? SHEETS_WRITE_SCOPE : SHEETS_READ_SCOPE} ${driveRead ? DRIVE_READ_SCOPE : DRIVE_LIST_SCOPE}` : ''} https://www.googleapis.com/auth/userinfo.email`,
        access_type: 'offline',
        prompt: 'consent select_account',
        state,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
      })
      res.json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${query}` })
    }),
  )
  app.get(CALLBACK, async (req, res) => {
    if (drive.handles(req.query.state)) {
      await drive.callback(req, res)
      return
    }
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Referrer-Policy', 'no-referrer')
    let result = 'error'
    try {
      const state = typeof req.query.state === 'string' ? req.query.state : '',
        saved = oauthStates.get(state)
      const cookie =
        (req.headers.cookie || '')
          .split(';')
          .map(x => x.trim())
          .find(x => x.startsWith(`${COOKIE}=`))
          ?.slice(COOKIE.length + 1) || ''
      if (
        !saved ||
        saved.expires < Date.now() ||
        !/^[a-f0-9]{64}$/.test(cookie) ||
        !timingSafeEqual(Buffer.from(cookie), Buffer.from(saved.cookie))
      )
        throw new Error('Invalid state')
      oauthStates.delete(state)
      const user = deps.sessionByToken(saved.token)
      if (!user || user.id !== saved.userId || user.organizationId !== saved.tenantId)
        throw new Error('Session expired')
      await liveUser(user)
      const config = await activeAccount(saved.tenantId)
      if (config.row.revision !== saved.revision || config.credentials.redirectUri !== `${origin(req)}${CALLBACK}`)
        throw new Error('Account OAuth settings changed')
      if (req.query.error) {
        result = 'denied'
        throw new Error('Denied')
      }
      if (typeof req.query.code !== 'string' || req.query.code.length > 4096) throw new Error('Missing code')
      const grant = await google('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: req.query.code,
          client_id: config.credentials.clientId,
          client_secret: config.credentials.clientSecret,
          redirect_uri: config.credentials.redirectUri,
          code_verifier: saved.verifier,
          grant_type: 'authorization_code',
        }),
      })
      if (!grant.access_token || !grant.refresh_token || !hasScope(grant.scope, READ_SCOPE))
        throw new Error('Gmail did not grant offline read access')
      const identity = await google('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${grant.access_token}` },
      })
      if (!identity.email || identity.email_verified !== true) throw new Error('Google identity is unverified')
      const stillSignedIn = deps.sessionByToken(saved.token)
      if (!stillSignedIn || stillSignedIn.id !== saved.userId || stillSignedIn.organizationId !== saved.tenantId)
        throw new Error('Session expired')
      await liveUser(stillSignedIn)
      if ((await activeAccount(saved.tenantId)).row.revision !== saved.revision)
        throw new Error('Account OAuth settings changed')
      const previous = await settings(saved.tenantId, saved.userId)
      const sameMailbox = previous?.gmail_email?.toLowerCase() === String(identity.email).toLowerCase()
      const { error } = await db.from('user_communication_settings').upsert(
        {
          tenant_id: saved.tenantId,
          user_id: saved.userId,
          discord_user_id: previous?.discord_user_id || null,
          discord_capture_mentions: previous?.discord_capture_mentions ?? true,
          gmail_email: String(identity.email),
          gmail_refresh_token: encryptSecret(grant.refresh_token, `${saved.tenantId}:${saved.userId}`, gmailKind),
          gmail_sync_state: {},
          gmail_config_revision: saved.revision,
          gmail_labels: sameMailbox ? previous?.gmail_labels || [] : [],
          gmail_label_catalog: sameMailbox ? previous?.gmail_label_catalog || [] : [],
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'tenant_id,user_id' },
      )
      if (error) throw error
      // Google lets people untick individual permissions, so report what was actually granted.
      result =
        saved.sheets === true && saved.sheetsWrite
          ? hasScope(grant.scope, SHEETS_WRITE_SCOPE)
            ? 'sheets-write-enabled'
            : 'sheets-write-denied'
          : saved.sheets === true
            ? hasScope(grant.scope, SHEETS_READ_SCOPE) || hasScope(grant.scope, SHEETS_WRITE_SCOPE)
              ? 'sheets-enabled'
              : 'sheets-denied'
            : saved.send
              ? hasScope(grant.scope, SEND_SCOPE)
                ? 'send-enabled'
                : 'send-denied'
              : 'connected'
    } catch {
      /* Never log authorization codes, tokens, or provider details. */
    }
    res.clearCookie(COOKIE, { path: CALLBACK, httpOnly: true, sameSite: 'lax' })
    // Allowing Google Sheets starts from Trackers, so it returns there.
    if (result.startsWith('sheets-')) return void res.redirect(303, `/#sheets=${result.slice('sheets-'.length)}`)
    res.redirect(303, `/#gmail=${result}`)
  })
  app.get(
    '/api/communications/gmail/labels',
    ...auth,
    guard,
    gmailGate,
    wrap(async (req, res) => {
      const token = await accessToken(req),
        result = await google('https://gmail.googleapis.com/gmail/v1/users/me/labels', {
          headers: { Authorization: `Bearer ${token}` },
        })
      const labels = (result.labels || [])
        .filter((x: any) => x.type === 'user' && typeof x.id === 'string' && typeof x.name === 'string')
        .map((x: any) => ({ id: x.id, name: x.name }))
      const user = current(req)
      const { error } = await db
        .from('user_communication_settings')
        .update({ gmail_label_catalog: labels, updated_at: new Date().toISOString() })
        .eq('tenant_id', user.organizationId)
        .eq('user_id', user.id)
      if (error)
        throw new IntegrationError(
          'Could not save Gmail label names. Check the database connection; a new database needs database/schema.sql.',
          503,
        )
      res.json({ labels })
    }),
  )
  app.delete(
    '/api/communications/gmail',
    ...auth,
    guard,
    wrap(async (req, res) => {
      const user = current(req),
        previous = await settings(user.organizationId, user.id)
      if (previous?.gmail_refresh_token) {
        try {
          const token = decryptSecret(previous.gmail_refresh_token, `${user.organizationId}:${user.id}`, gmailKind)
          await fetch('https://oauth2.googleapis.com/revoke', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token }),
            signal: AbortSignal.timeout(10000),
            redirect: 'error',
          })
        } catch {
          /* Disconnect locally even if revocation is temporarily unavailable. */
        }
      }
      const { error } = await db
        .from('user_communication_settings')
        .update({
          gmail_email: null,
          gmail_refresh_token: null,
          gmail_labels: [],
          gmail_label_catalog: [],
          gmail_sync_state: {},
          updated_at: new Date().toISOString(),
        })
        .eq('tenant_id', user.organizationId)
        .eq('user_id', user.id)
      if (error) throw error
      res.json({ disconnected: true })
    }),
  )
  app.post(
    '/api/communications/gmail/sync',
    ...auth,
    guard,
    gmailGate,
    wrap(async (req, res) => {
      const user = current(req),
        key = `${user.organizationId}:${user.id}`
      const ongoing = gmailSyncJobs.get(key)
      if (ongoing) {
        res.json(await ongoing)
        return
      }
      const quotaUntil = gmailQuotaCooldowns.get(key) || 0
      if (Date.now() < quotaUntil)
        throw new IntegrationError(
          'Gmail quota is temporarily exceeded. Wait a minute, then click Sync Gmail again.',
          429,
        )
      const backfillUntil = gmailBackfillCooldowns.get(key) || 0
      if (Date.now() < backfillUntil) {
        res.json({
          imported: 0,
          updated: 0,
          pages: 0,
          hasMore: true,
          retryAfterSeconds: Math.ceil((backfillUntil - Date.now()) / 1000),
        })
        return
      }
      const job = (async () => {
        const row = await settings(user.organizationId, user.id),
          labels = Array.isArray(row?.gmail_labels) ? row.gmail_labels : []
        if (!labels.length) throw new IntegrationError('Select monitored Gmail labels in settings first.')
        const token = await accessToken(req),
          windowStart = gmailWindowStart(row?.gmail_sync_state)
        let imported = 0,
          updated = 0
        const checkpoint = async (state: any) => {
          const { error } = await db
            .from('user_communication_settings')
            .update({ gmail_sync_state: state, updated_at: new Date().toISOString() })
            .eq('tenant_id', user.organizationId)
            .eq('user_id', user.id)
          if (error)
            throw new IntegrationError(
              'Could not save Gmail progress. Check the database connection; a new database needs database/schema.sql.',
              503,
            )
        }
        const result = await syncGmailPages(
          labels,
          row?.gmail_sync_state,
          {
            list: async (label, pageToken) =>
              google(
                `https://gmail.googleapis.com/gmail/v1/users/me/messages?${new URLSearchParams({ labelIds: label, maxResults: '20', q: `after:${windowStart}`, ...(pageToken ? { pageToken } : {}) })}`,
                { headers: { Authorization: `Bearer ${token}` } },
              ),
            checkpoint,
            message: async (externalId, label) => {
              const { data: found, error: lookupError } = await db
                .from('user_communications')
                .select('*')
                .eq('tenant_id', user.organizationId)
                .eq('owner_user_id', user.id)
                .eq('source', 'Gmail')
                .eq('external_id', externalId)
                .maybeSingle()
              if (lookupError) throw lookupError
              // Saved bodies do not need to be downloaded again on a manual check.
              // Revisit a message if it appears under a newly monitored label.
              if (found && Array.isArray(found.source_labels) && found.source_labels.includes(label)) return
              const detail = await google(
                `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(externalId)}?format=full`,
                { headers: { Authorization: `Bearer ${token}` } },
              )
              const headers = detail.payload?.headers || [],
                head = (name: string) => String(headers.find((x: any) => x.name?.toLowerCase() === name)?.value || '')
              const extracted = await gmailBodyText(detail.payload, async id => {
                const part = await google(
                  `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(externalId)}/attachments/${encodeURIComponent(id)}`,
                  { headers: { Authorization: `Bearer ${token}` } },
                )
                return String(part.data || '')
              })
              const body =
                extracted ||
                `${String(detail.snippet || '')}\n[Only a Gmail snippet is available; review the original email before interpreting it.]`
              const sourceLabels = Array.isArray(detail.labelIds) ? detail.labelIds.map(String) : [label]
              const fields = {
                thread_id: String(detail.threadId || ''),
                subject: head('subject').slice(0, 500),
                sender: head('from').slice(0, 500),
                body:
                  body.length > 30000
                    ? body.slice(0, 29850) +
                      '\n[Body shortened at 30,000 characters. Review the original email for remaining content.]'
                    : body,
                attachments: gmailAttachmentSummaries(detail.payload),
                source_label: sourceLabels.find((id: string) => labels.includes(id)) || '',
                source_labels: sourceLabels,
                received_at: new Date(Number(detail.internalDate || Date.now())).toISOString(),
              }
              // New mail stays unread while Gmail has it unread; mail already read in Gmail arrives read.
              const unread = sourceLabels.includes('UNREAD')
              const readAt = unread ? null : new Date().toISOString()
              const write = (withRead: boolean) =>
                found
                  ? db
                      .from('user_communications')
                      .update(withRead && found.read_at == null && !unread ? { ...fields, read_at: readAt } : fields)
                      .eq('id', found.id)
                      .eq('tenant_id', user.organizationId)
                      .eq('owner_user_id', user.id)
                  : db.from('user_communications').insert({
                      tenant_id: user.organizationId,
                      owner_user_id: user.id,
                      source: 'Gmail',
                      external_id: externalId,
                      ...fields,
                      ...(withRead ? { read_at: readAt } : {}),
                    })
              let { error } = await write(!found || 'read_at' in found)
              if (missingReadColumn(error)) ({ error } = await write(false))
              if (error && error.code !== '23505') throw error
              if (!error) {
                if (found) updated++
                else imported++
              }
            },
          },
          3,
          windowStart,
        )
        if (!result.hasMore) await checkpoint({})
        return { imported, updated, pages: result.pages, hasMore: result.hasMore }
      })()
      gmailSyncJobs.set(key, job)
      try {
        const result = await job
        if (result.hasMore) gmailBackfillCooldowns.set(key, Date.now() + 60_000)
        else gmailBackfillCooldowns.delete(key)
        res.json(result)
      } catch (error) {
        if (error instanceof IntegrationError && error.status === 429) gmailQuotaCooldowns.set(key, Date.now() + 60_000)
        throw error
      } finally {
        if (gmailSyncJobs.get(key) === job) gmailSyncJobs.delete(key)
      }
    }),
  )
}
