import { registerGitlab } from './gitlab'
import { registerGithub } from './github'
import { registerDrive } from './google-drive'
import {
  attachmentContentType,
  attachmentDisposition,
  gmailAttachmentParts,
  gmailAttachmentSummaries,
  gmailBodyText,
  gmailWindowStart,
  matchAttachmentPart,
  storedAttachment,
  syncGmailPages,
} from './gmail-content'
import { registerOutbound } from './gmail-outbound'
import { hasScope, READ_SCOPE, SEND_SCOPE } from './gmail-send'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { Express, Request, Response, NextFunction } from 'express'
import { encryptSecret, decryptSecret, encryptionKey, IntegrationError } from './tenant-integrations'
import {
  findCommunicationTaskDuplicate,
  findSubtaskDuplicate,
  nextSubtaskOrder,
  subtaskParentProblem,
} from '../../src/features/work-hub/communicationTasks'
import { isWorkDone } from '../../src/features/tasks/lifecycle'
import { canCreateWork, visibleTask, visibleTaskIds } from '../services/visibility'
import { defaultWaitingOn } from '../../src/features/tasks/waitingOn'

type Middleware = (req: Request, res: Response, next: NextFunction) => any
const CALLBACK = '/api/communications/gmail/callback'
const COOKIE = 'ba_gmail_oauth'
const oauthStates = new Map<
  string,
  {
    token: string
    userId: string
    tenantId: string
    verifier: string
    cookie: string
    revision: string
    expires: number
    send?: boolean
    sheets?: boolean
    /** Asked for full Sheets access (editing), so a tracker can mark rows done in its Sheet. */
    sheetsWrite?: boolean
  }
>()
/** Reading Google Sheets for connected trackers: the sheets' values, and the list of sheets a person can open (theirs, shared with them, shared drives). */
export const SHEETS_READ_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly'
export const DRIVE_LIST_SCOPE = 'https://www.googleapis.com/auth/drive.metadata.readonly'
/** Editing Google Sheets, for trackers that mark rows done in their Sheet. It includes reading. */
export const SHEETS_WRITE_SCOPE = 'https://www.googleapis.com/auth/spreadsheets'
const gmailKind = 'gmail-refresh' as const
type GmailCredentials = { clientId: string; clientSecret: string; redirectUri: string }
const google = async (url: string, init: RequestInit, timeout = 20000) => {
  const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeout) })
  const data: any = await response.json()
  if (!response.ok) {
    const message = data.error_description || data.error?.message || 'Gmail request failed.'
    if (
      response.status === 429 ||
      (response.status === 403 && /quota|rate.?limit|userRateLimitExceeded/i.test(message))
    )
      throw new IntegrationError(
        'Gmail quota is temporarily exceeded. Wait a minute, then click Sync Gmail again.',
        429,
      )
    throw Object.assign(new IntegrationError(message, 502), { upstreamStatus: response.status })
  }
  return data
}
function origin(req: Request) {
  const url = new URL(process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`)
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
  )
    throw new IntegrationError('Use an HTTPS application URL for Gmail.', 503)
  return url.origin
}
function validateCredentials(input: any, appOrigin: string): GmailCredentials {
  let source = input || {}
  if (input?.oauthJson) {
    if (JSON.stringify(input.oauthJson).length > 32768)
      throw new IntegrationError('Choose an OAuth JSON file under 32 KB.')
    try {
      source = (typeof input.oauthJson === 'string' ? JSON.parse(input.oauthJson) : input.oauthJson).web
    } catch {
      throw new IntegrationError('Choose a Google OAuth Web application JSON file.')
    }
    if (!source) throw new IntegrationError('Use a Web application OAuth client.')
  }
  const clientId = String(source.client_id ?? source.clientId ?? '').trim()
  const clientSecret = String(source.client_secret ?? source.clientSecret ?? '').trim()
  const redirectUri = `${appOrigin}${CALLBACK}`
  if (!/^[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/.test(clientId) || clientId.length > 256)
    throw new IntegrationError('Enter a valid Google OAuth Client ID.')
  if (clientSecret.length < 10 || clientSecret.length > 4096 || /\s/.test(clientSecret))
    throw new IntegrationError('Enter the Google OAuth Client Secret.')
  return { clientId, clientSecret, redirectUri }
}
function requireText(input: unknown, field: string, max = 4000) {
  if (typeof input !== 'string' || input.trim().length > max) throw new IntegrationError(`${field} is invalid.`)
  return input.trim()
}
/** The database has no read_at column yet (a database from before the read_at column): reading and writing go on without it. */
const missingReadColumn = (error: any) =>
  Boolean(error) && (error.code === '42703' || error.code === 'PGRST204' || /read_at/.test(String(error.message || '')))
/** Unread counts cover received email and Discord messages only: not GitHub, GitLab or manual logs. */
export const UNREAD_SOURCES = ['Gmail', 'Discord'] as const

export function registerCommunications(
  app: Express,
  deps: {
    db: any
    requireAuth: Middleware
    requireTenant: Middleware
    requirePlatformAdmin: Middleware
    sessionFromRequest: (req: Request) => { token: string; user: any }
    sessionByToken: (token: string) => any
    organizationById: (id: string) => Promise<any>
    load: (id: string) => Promise<any>
    commit: (id: string, next: any, user: any, source: string, current: any) => Promise<any>
    openStatus: (state: any) => string
  },
) {
  const { db } = deps
  const gmailSyncJobs = new Map<string, Promise<any>>()
  const gmailBackfillCooldowns = new Map<string, number>()
  const gmailQuotaCooldowns = new Map<string, number>()
  const taskCreateJobs = new Map<string, Promise<void>>()
  const createTaskInOrder = async (tenantId: string, create: () => Promise<void>) => {
    const previous = taskCreateJobs.get(tenantId) || Promise.resolve()
    const job = previous.catch(() => undefined).then(create)
    taskCreateJobs.set(tenantId, job)
    try {
      await job
    } finally {
      if (taskCreateJobs.get(tenantId) === job) taskCreateJobs.delete(tenantId)
    }
  }
  const auth = [deps.requireAuth, deps.requireTenant]
  const current = (req: Request) => (req as any).authUser
  const guard: Middleware = async (req, res, next) => {
    try {
      await liveUser(current(req))
      res.setHeader('Cache-Control', 'no-store')
      next()
    } catch (e) {
      res
        .status(e instanceof IntegrationError ? e.status : 503)
        .json({ error: e instanceof Error ? e.message : 'Work Hub unavailable.' })
    }
  }
  const wrap =
    (fn: (req: Request, res: Response) => Promise<any>): Middleware =>
    async (req, res) => {
      try {
        if (!db) throw new IntegrationError('Cloud storage is required for private communications.', 503)
        await fn(req, res)
      } catch (error) {
        res.status(error instanceof IntegrationError ? error.status : 503).json({
          error:
            error instanceof IntegrationError
              ? error.message
              : 'Communications are unavailable. Check the database connection; a new database needs database/schema.sql.',
        })
      }
    }
  const account = async (tenantId: string) => {
    const { data, error } = await db.from('gmail_accounts').select('*').eq('tenant_id', tenantId).maybeSingle()
    if (error)
      throw new IntegrationError(
        'Gmail settings cannot be saved. Check the database connection; a new database needs database/schema.sql.',
        503,
      )
    return data
  }
  const saveAccount = async (tenantId: string, patch: any) => {
    const previous = await account(tenantId)
    const record = { ...patch, updated_at: new Date().toISOString() }
    const { error } = previous
      ? await db.from('gmail_accounts').update(record).eq('tenant_id', tenantId)
      : await db.from('gmail_accounts').insert({ tenant_id: tenantId, ...record })
    if (error) throw new IntegrationError('Could not save account Gmail settings.', 503)
  }
  const activeAccount = async (tenantId: string) => {
    const row = await account(tenantId)
    if (!row?.platform_enabled)
      throw new IntegrationError('Internal Admin has not enabled Gmail for this account.', 403)
    if (!row.account_enabled || !row.encrypted_config)
      throw new IntegrationError('Ask your account administrator to configure Gmail in Settings.', 409)
    const credentials = JSON.parse(decryptSecret(row.encrypted_config, tenantId, 'gmail-oauth')) as GmailCredentials
    return { row, credentials }
  }
  const liveUser = async (user: any, settingsAccess = false) => {
    const org = await deps.organizationById(user.organizationId)
    if (!org || org.status !== 'Active' || !org.enabledModules.includes('inbox'))
      throw new IntegrationError('Work Hub is disabled for this account.', 403)
    const { data, error } = await db
      .from('app_users')
      .select('id,role,status,modules')
      .eq('organization_id', user.organizationId)
      .eq('id', user.id)
      .is('deleted_at', null)
      .maybeSingle()
    if (error || !data || data.status !== 'Active') throw new IntegrationError('This user is unavailable.', 403)
    if (
      settingsAccess
        ? data.role !== 'Administrator' || !org.enabledModules.includes('settings')
        : data.role !== 'Administrator' && !data.modules?.includes('inbox')
    )
      throw new IntegrationError(
        settingsAccess ? 'Account Administrator with Settings access is required.' : 'Work Hub access is required.',
        403,
      )
    return user.organizationId as string
  }
  const gmailGate: Middleware = async (req, res, next) => {
    try {
      await liveUser(current(req))
      next()
    } catch (e) {
      res
        .status(e instanceof IntegrationError ? e.status : 503)
        .json({ error: e instanceof Error ? e.message : 'Gmail access unavailable.' })
    }
  }
  const accountGate: Middleware = async (req, res, next) => {
    try {
      await liveUser(current(req), true)
      next()
    } catch (e) {
      res
        .status(e instanceof IntegrationError ? e.status : 503)
        .json({ error: e instanceof Error ? e.message : 'Gmail settings unavailable.' })
    }
  }
  const settings = async (tenant: string, user: string) => {
    const { data, error } = await db
      .from('user_communication_settings')
      .select('*')
      .eq('tenant_id', tenant)
      .eq('user_id', user)
      .maybeSingle()
    if (error) throw error
    return data
  }
  const own = async (req: Request, id: string) => {
    const { data, error } = await db
      .from('user_communications')
      .select('*')
      .eq('tenant_id', current(req).organizationId)
      .eq('owner_user_id', current(req).id)
      .eq('id', id)
      .maybeSingle()
    if (error) throw error
    if (!data) throw new IntegrationError('Communication not found.', 404)
    return data
  }
  const drive = registerDrive(app, {
    db,
    auth,
    guard,
    accountGate,
    gmailGate,
    wrap,
    current,
    liveUser,
    activeAccount,
    google,
    origin,
    callbackPath: CALLBACK,
    sessionFromRequest: deps.sessionFromRequest,
    sessionByToken: deps.sessionByToken,
    own,
    attachment: (req, message, index) => gmailAttachment(req, message, index),
    load: deps.load,
    commit: deps.commit,
    inOrder: createTaskInOrder,
  })
  app.get(
    '/api/internal-admin/organizations/:organizationId/gmail',
    deps.requireAuth,
    deps.requirePlatformAdmin,
    wrap(async (req, res) => {
      const id = String(req.params.organizationId)
      if (!(await deps.organizationById(id))) throw new IntegrationError('Account not found.', 404)
      const row = await account(id)
      res.json({ enabled: Boolean(row?.platform_enabled), configured: Boolean(row?.encrypted_config) })
    }),
  )
  app.put(
    '/api/internal-admin/organizations/:organizationId/gmail',
    deps.requireAuth,
    deps.requirePlatformAdmin,
    wrap(async (req, res) => {
      const id = String(req.params.organizationId)
      if (!(await deps.organizationById(id))) throw new IntegrationError('Account not found.', 404)
      if (typeof req.body?.enabled !== 'boolean') throw new IntegrationError('Specify whether Gmail is enabled.')
      await saveAccount(id, { platform_enabled: req.body.enabled })
      res.json({ ok: true })
    }),
  )
  app.get(
    '/api/account/gmail',
    ...auth,
    accountGate,
    wrap(async (req, res) => {
      const user = current(req),
        row = await account(user.organizationId)
      let encryptionReady = true
      try {
        encryptionKey()
      } catch {
        encryptionReady = false
      }
      const credentials =
        row?.encrypted_config && encryptionReady
          ? (JSON.parse(decryptSecret(row.encrypted_config, user.organizationId, 'gmail-oauth')) as GmailCredentials)
          : null
      res.json({
        platformEnabled: Boolean(row?.platform_enabled),
        configured: Boolean(row?.encrypted_config),
        enabled: Boolean(row?.account_enabled),
        encryptionReady,
        clientId: credentials?.clientId || '',
        redirectUri: credentials?.redirectUri || '',
        expectedRedirectUri: `${origin(req)}${CALLBACK}`,
      })
    }),
  )
  app.put(
    '/api/account/gmail',
    ...auth,
    accountGate,
    wrap(async (req, res) => {
      if (typeof req.body?.enabled !== 'boolean')
        throw new IntegrationError('Specify whether Gmail is enabled for this account.')
      const user = current(req),
        previous = await account(user.organizationId)
      if (!previous?.platform_enabled)
        throw new IntegrationError('Internal Admin must enable Gmail for this account first.', 403)
      const replacing = Boolean(req.body?.oauthJson || req.body?.clientId || req.body?.clientSecret)
      if (!replacing && !previous.encrypted_config)
        throw new IntegrationError('Upload a Google Web OAuth JSON file or enter both credentials.')
      const patch: any = { account_enabled: req.body.enabled }
      if (replacing) {
        const credentials = validateCredentials(req.body, origin(req))
        patch.encrypted_config = encryptSecret(JSON.stringify(credentials), user.organizationId, 'gmail-oauth')
        patch.revision = randomUUID()
      }
      await saveAccount(user.organizationId, patch)
      res.json({ ok: true, reconnectRequired: replacing })
    }),
  )
  app.delete(
    '/api/account/gmail',
    ...auth,
    accountGate,
    wrap(async (req, res) => {
      const user = current(req)
      await saveAccount(user.organizationId, { encrypted_config: null, account_enabled: false, revision: randomUUID() })
      res.json({ ok: true })
    }),
  )
  app.get(
    '/api/communications',
    ...auth,
    guard,
    wrap(async (req, res) => {
      const user = current(req)
      // The person's own emails linked to some tasks (DRF creation shows the task's email). Newest first, at most 20.
      if (req.query.taskIds !== undefined) {
        const ids = [
          ...new Set(
            String(req.query.taskIds)
              .split(',')
              .map(id => id.trim())
              .filter(Boolean),
          ),
        ]
        if (!ids.length || ids.length > 50 || ids.some(id => id.length > 128))
          throw new IntegrationError('Choose up to 50 tasks.')
        const state = await deps.load(user.organizationId)
        // With per-person visibility on, tasks outside this person's clients and projects are not asked about.
        const visible = visibleTaskIds(state?.data, user)
        if (visible) ids.splice(0, ids.length, ...ids.filter(id => visible.has(id)))
        if (!ids.length) return void res.json({ items: [] })
        // family=1: also the parent task and the subtasks, so a file on a subtask can answer the task's email.
        if (req.query.family === '1') {
          const all: any[] = (Array.isArray(state?.data?.items) ? state.data.items : []).filter(
            (item: any) => !visible || visible.has(String(item?.id || '')),
          )
          const asked = new Set(ids)
          for (const item of all) {
            const id = String(item?.id || ''),
              parent = String(item?.parentTaskId || '')
            if (asked.has(id) && parent) ids.push(parent)
            if (parent && asked.has(parent)) ids.push(id)
          }
          ids.splice(0, ids.length, ...[...new Set(ids)].slice(0, 100))
        }
        const linked = (query: any) =>
          query
            .eq('tenant_id', user.organizationId)
            .eq('owner_user_id', user.id)
            .order('received_at', { ascending: false })
            .limit(20)
        const [latest, any] = await Promise.all([
          linked(db.from('user_communications').select('*').in('linked_task_id', ids)),
          linked(db.from('user_communications').select('*').overlaps('linked_task_ids', ids)),
        ])
        if (latest.error) throw latest.error
        const byId = new Map<string, any>()
        // A database before linked_task_ids still answers by the latest linked task.
        for (const row of [...(latest.data || []), ...(any.error ? [] : any.data || [])]) byId.set(row.id, row)
        const items = [...byId.values()]
          .sort((a, b) => new Date(b.received_at).getTime() - new Date(a.received_at).getTime())
          .slice(0, 20)
        res.json({ items })
        return
      }
      // Keep the old response for older clients while the new Hub uses bounded pages.
      const paginated = req.query.page !== undefined || req.query.pageSize !== undefined
      const page = Number(req.query.page ?? 1),
        pageSize = Number(req.query.pageSize ?? 10)
      const tab = String(req.query.tab ?? 'All'),
        label = String(req.query.label ?? '')
      if (
        !Number.isSafeInteger(page) ||
        page < 1 ||
        page > 1000000 ||
        ![5, 10, 15].includes(pageSize) ||
        !['All', 'Gmail', 'Discord', 'Manual', 'Archived'].includes(tab) ||
        label.length > 128
      )
        throw new IntegrationError('Choose a valid communication view and page.')
      const filtered = (head = false) => {
        let query = db
          .from('user_communications')
          .select('*', paginated ? { count: 'exact', head } : {})
          .eq('tenant_id', user.organizationId)
          .eq('owner_user_id', user.id)
        if (paginated) {
          query =
            tab === 'Archived' || req.query.archived === 'true'
              ? query.eq('status', 'Archived')
              : query.neq('status', 'Archived')
          if (['Gmail', 'Discord', 'Manual'].includes(tab)) query = query.eq('source', tab)
          if (tab === 'Gmail' && label) query = query.contains('source_labels', [label])
        }
        return query
      }
      const query = filtered().order('received_at', { ascending: false }).order('id', { ascending: false })
      const { data, count, error } = await (paginated
        ? query.range((page - 1) * pageSize, page * pageSize - 1)
        : query.limit(200))
      // PostgREST can return 416 when the last item on a page was archived.
      if (paginated && error?.code === 'PGRST103') {
        const latest = await filtered(true)
        if (latest.error) throw latest.error
        res.json({ items: [], total: latest.count || 0, page, pageSize })
        return
      }
      if (error) throw error
      res.json({ items: data || [], ...(paginated ? { total: count || 0, page, pageSize } : {}) })
    }),
  )
  app.get(
    '/api/communications/:id/thread',
    ...auth,
    guard,
    wrap(async (req, res) => {
      const selected = await own(req, String(req.params.id)),
        user = current(req)
      const page = Number(req.query.page ?? 1),
        pageSize = 50
      if (!Number.isSafeInteger(page) || page < 1 || page > 1000000)
        throw new IntegrationError('Choose a valid thread page.')
      if (!selected.thread_id) {
        res.json({ items: [selected], total: 1 })
        return
      }
      const { data, count, error } = await db
        .from('user_communications')
        .select('*', { count: 'exact' })
        .eq('tenant_id', user.organizationId)
        .eq('owner_user_id', user.id)
        .eq('source', selected.source)
        .eq('thread_id', selected.thread_id)
        .order('received_at', { ascending: true })
        .order('id', { ascending: true })
        .range((page - 1) * pageSize, page * pageSize - 1)
      if (error) throw error
      res.json({ items: data || [], total: count || 0 })
    }),
  )
  /** Fetch one attachment of the user's own Gmail message straight from Gmail. Nothing is stored. */
  const gmailAttachment = async (req: Request, message: any, index: number) => {
    const stored = Array.isArray(message.attachments) ? message.attachments : []
    const wanted =
      Number.isSafeInteger(index) && index >= 0 && index < stored.length ? storedAttachment(stored[index]) : null
    if (message.source !== 'Gmail' || !message.external_id || !wanted)
      throw new IntegrationError('Attachment not found.', 404)
    const token = await accessToken(req),
      headers = { Authorization: `Bearer ${token}` }
    const messageUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(message.external_id)}`
    const missing = (error: unknown, text: string) => {
      if ((error as any)?.upstreamStatus === 404) throw new IntegrationError(text, 404)
      throw error
    }
    const detail = await google(`${messageUrl}?format=full`, { headers }).catch(error =>
      missing(error, 'This email is no longer available in Gmail.'),
    )
    const part = matchAttachmentPart(gmailAttachmentParts(detail.payload), wanted, index)
    if (!part) throw new IntegrationError('This attachment is no longer available in Gmail.', 404)
    const encoded =
      part.data ||
      (part.attachmentId
        ? String(
            (
              await google(
                `${messageUrl}/attachments/${encodeURIComponent(part.attachmentId)}`,
                { headers },
                60000,
              ).catch(error => missing(error, 'This attachment is no longer available in Gmail.'))
            ).data || '',
          )
        : '')
    if (!encoded) throw new IntegrationError('This attachment is empty or unavailable in Gmail.', 404)
    return { name: part.name, mimeType: attachmentContentType(part.mimeType), file: Buffer.from(encoded, 'base64url') }
  }
  // Attachments are streamed from Gmail on request and never written to the database or disk.
  app.get(
    '/api/communications/:id/attachments/:index',
    ...auth,
    guard,
    gmailGate,
    wrap(async (req, res) => {
      const { name, mimeType, file } = await gmailAttachment(
        req,
        await own(req, String(req.params.id)),
        Number(req.params.index),
      )
      res.setHeader('Content-Type', mimeType)
      res.setHeader('Content-Disposition', attachmentDisposition(name))
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'")
      res.setHeader('Content-Length', String(file.length))
      res.end(file)
    }),
  )
  app.get(
    '/api/communications/settings',
    ...auth,
    guard,
    wrap(async (req, res) => {
      const user = current(req),
        row = await settings(user.organizationId, user.id),
        config = await account(user.organizationId)
      const enabled = Boolean(config?.platform_enabled && config?.account_enabled && config?.encrypted_config)
      const connected = Boolean(row?.gmail_refresh_token && row.gmail_config_revision === config?.revision)
      res.json({
        discordUserId: row?.discord_user_id || '',
        captureMentions: row?.discord_capture_mentions ?? true,
        gmailEmail: connected ? row.gmail_email || '' : '',
        gmailLabels: row?.gmail_labels || [],
        gmailLabelCatalog: row?.gmail_label_catalog || [],
        gmailConnected: connected,
        gmailReconnectRequired: Boolean(row?.gmail_refresh_token && !connected),
        gmailAvailable: enabled,
        gmailPlatformEnabled: Boolean(config?.platform_enabled),
        callbackUrl: `${origin(req)}${CALLBACK}`,
      })
    }),
  )
  app.put(
    '/api/communications/settings',
    ...auth,
    guard,
    wrap(async (req, res) => {
      const user = current(req),
        id = String(req.body?.discordUserId || '').trim()
      if (id && !/^\d{15,22}$/.test(id)) throw new IntegrationError('Enter a valid Discord user ID.')
      const labels = req.body?.gmailLabels
      if (
        !Array.isArray(labels) ||
        labels.length > 30 ||
        labels.some((x: any) => typeof x !== 'string' || x.length > 128)
      )
        throw new IntegrationError('Choose up to 30 Gmail labels.')
      const previous = await settings(user.organizationId, user.id)
      const { error } = await db.from('user_communication_settings').upsert(
        {
          tenant_id: user.organizationId,
          user_id: user.id,
          discord_user_id: id || null,
          discord_capture_mentions: req.body?.captureMentions !== false,
          gmail_labels: [...new Set(labels)],
          gmail_email: previous?.gmail_email || null,
          gmail_refresh_token: previous?.gmail_refresh_token || null,
          gmail_label_catalog: previous?.gmail_label_catalog || [],
          gmail_sync_state:
            JSON.stringify([...(previous?.gmail_labels || [])].sort()) === JSON.stringify([...labels].sort())
              ? previous?.gmail_sync_state || {}
              : {},
          gmail_config_revision: previous?.gmail_config_revision || null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'tenant_id,user_id' },
      )
      if (error)
        throw new IntegrationError(
          error.code === '23505'
            ? 'This Discord account is already linked to another user in this workspace.'
            : 'Could not save communication settings.',
          error.code === '23505' ? 409 : 503,
        )
      if (JSON.stringify([...(previous?.gmail_labels || [])].sort()) !== JSON.stringify([...labels].sort()))
        gmailBackfillCooldowns.delete(`${user.organizationId}:${user.id}`)
      res.json({ saved: true })
    }),
  )
  app.post(
    '/api/communications',
    ...auth,
    guard,
    wrap(async (req, res) => {
      if (current(req).role === 'Viewer')
        throw new IntegrationError('Viewer accounts cannot create communications.', 403)
      const subject = requireText(req.body?.subject, 'Subject', 200),
        body = requireText(req.body?.body, 'Message', 30000)
      if (!subject && !body) throw new IntegrationError('Enter a subject or message.')
      const { data, error } = await db
        .from('user_communications')
        .insert({
          tenant_id: current(req).organizationId,
          owner_user_id: current(req).id,
          source: 'Manual',
          subject,
          body,
          sender: current(req).name,
        })
        .select('*')
        .single()
      if (error) throw error
      res.status(201).json({ item: data })
    }),
  )
  app.patch(
    '/api/communications/:id',
    ...auth,
    guard,
    wrap(async (req, res) => {
      await own(req, req.params.id)
      const status = String(req.body?.status || '')
      if (!['New', 'Open', 'Resolved', 'Archived'].includes(status)) throw new IntegrationError('Invalid status.')
      const { data, error } = await db
        .from('user_communications')
        .update({ status })
        .eq('id', req.params.id)
        .eq('tenant_id', current(req).organizationId)
        .eq('owner_user_id', current(req).id)
        .select('*')
        .single()
      if (error) throw error
      res.json({ item: data })
    }),
  )
  // Unread email and Discord messages, for the badge on Work Hub. Archived messages are not counted.
  app.get(
    '/api/communications/unread',
    ...auth,
    guard,
    wrap(async (req, res) => {
      const user = current(req)
      const counts: Record<string, number> = {}
      for (const source of UNREAD_SOURCES) {
        const { count, error } = await db
          .from('user_communications')
          .select('id', { count: 'exact', head: true })
          .eq('tenant_id', user.organizationId)
          .eq('owner_user_id', user.id)
          .eq('source', source)
          .neq('status', 'Archived')
          .is('read_at', null)
        if (missingReadColumn(error)) {
          res.json({ available: false, gmail: 0, discord: 0 })
          return
        }
        if (error) throw error
        counts[source] = count || 0
      }
      res.json({ available: true, gmail: counts.Gmail, discord: counts.Discord })
    }),
  )
  // Opening a message marks it, and the rest of its conversation, as read. It can be marked unread again.
  app.patch(
    '/api/communications/:id/read',
    ...auth,
    guard,
    wrap(async (req, res) => {
      const message = await own(req, String(req.params.id)),
        user = current(req)
      if (typeof req.body?.read !== 'boolean') throw new IntegrationError('Say whether the message is read.')
      if (!('read_at' in message))
        throw new IntegrationError(
          'Read and unread are unavailable. Check the database connection; a new database needs database/schema.sql.',
          503,
        )
      const readAt = req.body.read ? new Date().toISOString() : null
      let query = db
        .from('user_communications')
        .update({ read_at: readAt })
        .eq('tenant_id', user.organizationId)
        .eq('owner_user_id', user.id)
      query =
        req.body.read && message.thread_id
          ? query.eq('source', message.source).eq('thread_id', message.thread_id).is('read_at', null)
          : query.eq('id', message.id)
      const { error } = await query
      if (error) throw error
      res.json({ id: message.id, read_at: readAt })
    }),
  )
  app.post(
    '/api/communications/read-all',
    ...auth,
    guard,
    wrap(async (req, res) => {
      const user = current(req),
        source = String(req.body?.source || '')
      if (!(UNREAD_SOURCES as readonly string[]).includes(source))
        throw new IntegrationError('Choose Gmail or Discord.')
      const { error } = await db
        .from('user_communications')
        .update({ read_at: new Date().toISOString() })
        .eq('tenant_id', user.organizationId)
        .eq('owner_user_id', user.id)
        .eq('source', source)
        .neq('status', 'Archived')
        .is('read_at', null)
      if (missingReadColumn(error))
        throw new IntegrationError(
          'Read and unread are unavailable. Check the database connection; a new database needs database/schema.sql.',
          503,
        )
      if (error) throw error
      res.json({ ok: true })
    }),
  )
  /** Trackers the person can open that have this work on a row (the row's task, or a task made from a cell). */
  const trackersFor = async (user: any, taskIds: string[]) => {
    try {
      const [rows, links] = await Promise.all([
        db.from('tenant_tracker_rows').select('tracker_id').eq('tenant_id', user.organizationId).in('task_id', taskIds),
        db
          .from('tenant_tracker_task_links')
          .select('tracker_id')
          .eq('tenant_id', user.organizationId)
          .in('task_id', taskIds),
      ])
      const ids = [...new Set([...(rows.data || []), ...(links.data || [])].map((row: any) => String(row.tracker_id)))]
      if (!ids.length) return []
      const trackers = await db
        .from('tenant_trackers')
        .select('id,name,private,created_by,archived_at')
        .eq('tenant_id', user.organizationId)
        .in('id', ids)
      return (trackers.data || [])
        .filter((row: any) => !row.archived_at && (!row.private || row.created_by === user.id))
        .map((row: any) => ({ id: String(row.id), name: String(row.name || 'Tracker') }))
    } catch {
      // Trackers are only a heads-up: linking still works without them.
      return []
    }
  }
  /**
   * Links one of your emails to an existing task or subtask (or removes the link). Only your own copy of the email
   * changes: the task gets nothing from the email, as with Create task. The answer names the trackers the work is on.
   */
  app.post(
    '/api/communications/:id/link-task',
    ...auth,
    guard,
    wrap(async (req, res) => {
      const user = current(req)
      if (!user.modules?.includes('items') && !user.modules?.includes('inbox') && user.role !== 'Administrator')
        throw new IntegrationError('Task access is required.', 403)
      const taskId = requireText(req.body?.taskId, 'Task', 100)
      const unlink = req.body?.unlink === true
      // In order with Create task and other links on this account, so two at once cannot lose one of them.
      await createTaskInOrder(user.organizationId, async () => {
        const communication = await own(req, req.params.id)
        const stateResult = await deps.load(user.organizationId)
        const items: any[] = Array.isArray(stateResult?.data?.items) ? stateResult.data.items : []
        // Old Discord captures are kept away from every browser (see sanitizeStateForClient): not linkable either.
        const task = items.find(
          item =>
            String(item?.id) === taskId &&
            !(item?.source === 'Discord' && item?.externalSourceId) &&
            visibleTask(stateResult.data, user, taskId, 'write'),
        )
        if (!unlink && (!task || task.archived)) throw new IntegrationError('That task or subtask was not found.', 404)
        const existing = [
          ...new Set([
            ...(Array.isArray(communication.linked_task_ids) ? communication.linked_task_ids : []),
            ...(communication.linked_task_id ? [communication.linked_task_id] : []),
          ]),
        ].map(String)
        const ids = unlink ? existing.filter(id => id !== taskId) : [...existing.filter(id => id !== taskId), taskId]
        // The badge keeps the latest link; the full list is what Drive filing, DRF and replies read.
        const latest = ids.at(-1) || null
        const { error } = await db
          .from('user_communications')
          .update({ linked_task_id: latest, linked_task_ids: ids.slice(-200) })
          .eq('id', communication.id)
          .eq('tenant_id', user.organizationId)
          .eq('owner_user_id', user.id)
        if (error) throw error
        const parent = task?.parentTaskId ? String(task.parentTaskId) : ''
        res.json({
          linkedTaskId: latest,
          linkedTaskIds: ids,
          trackers: unlink ? [] : await trackersFor(user, parent ? [taskId, parent] : [taskId]),
        })
      })
    }),
  )
  app.post(
    '/api/communications/:id/create-task',
    ...auth,
    guard,
    wrap(async (req, res) => {
      const user = current(req)
      if (user.role === 'Viewer' || (!user.modules?.includes('items') && user.role !== 'Administrator'))
        throw new IntegrationError('Task write access is required.', 403)
      await createTaskInOrder(user.organizationId, async () => {
        const communication = await own(req, req.params.id)
        const stateResult = await deps.load(user.organizationId),
          state = stateResult.data
        if (!state) throw new IntegrationError('Workspace data is unavailable.', 503)
        // A subtask goes under an existing open task and takes that task's client and project.
        const parentTaskId = req.body?.parentTaskId ? requireText(req.body.parentTaskId, 'Parent task', 100) : ''
        const parent = parentTaskId ? (state.items || []).find((x: any) => x.id === parentTaskId) : undefined
        if (parentTaskId) {
          const problem = subtaskParentProblem(parent, status =>
            isWorkDone({ status } as any, state.taskSettings || { statuses: [] }),
          )
          if (problem) throw new IntegrationError(problem)
        }
        const clientId = parent ? String(parent.clientId || '') : requireText(req.body?.clientId, 'Client', 100),
          projectId = parent ? String(parent.projectId || '') : requireText(req.body?.projectId, 'Project', 100)
        if (
          !clientId ||
          !projectId ||
          !state.clients?.some((x: any) => x.id === clientId && !x.archived) ||
          !state.projects?.some((x: any) => x.id === projectId && !x.archived)
        )
          throw new IntegrationError(
            parent
              ? `“${parent.title}” has no active client and project, so a subtask cannot be added to it here.`
              : 'Select an active client and project.',
          )
        if (!canCreateWork(state, user, { clientId, projectId, parentTaskId }))
          throw new IntegrationError('You don’t have access to that client or project.', 403)
        const assignee = requireText(req.body?.assignedToUserId, 'Assignee', 100)
        const account = (state.accounts || []).find(
          (x: any) => x.id === assignee && x.status !== 'Disabled' && ['Administrator', 'Contributor'].includes(x.role),
        )
        if (!account) throw new IntegrationError('Select an active team member.')
        const title = requireText(req.body?.title, 'Task title', 200),
          description = requireText(req.body?.description, 'Task description', 5000)
        if (!title) throw new IntegrationError(parent ? 'Enter a subtask title.' : 'Enter a task title.')
        const duplicate = parent
          ? findSubtaskDuplicate(state.items || [], parent.id, title)
          : findCommunicationTaskDuplicate(state.items || [], { title, clientId, projectId })
        if (duplicate) {
          res.status(409).json({
            code: 'DUPLICATE_TASK',
            error: parent
              ? `“${parent.title}” already has a subtask named “${duplicate.title}”. Enter a different title.`
              : `A task named “${duplicate.title}” already exists for this client and project. Enter a different task title.`,
            taskId: duplicate.id,
          })
          return
        }
        const item = {
          id: randomUUID(),
          clientId,
          projectId,
          ...(parent ? { parentTaskId: parent.id, subtaskOrder: nextSubtaskOrder(state.items || [], parent.id) } : {}),
          title,
          type: 'Task',
          priority: 'Medium',
          status: deps.openStatus(state),
          waitingOn: defaultWaitingOn(state?.taskSettings),
          owner: account.name || account.username,
          assignedToUserId: assignee,
          dateRaised: new Date().toISOString().slice(0, 10),
          dueDate: '',
          followUpDate: '',
          description,
          resolution: '',
          source: 'Internal',
        }
        // Shared task contains only the fields explicitly submitted here; never a private source ID or thread.
        await deps.commit(
          user.organizationId,
          { ...state, items: [item, ...(state.items || [])] },
          user,
          'communication-task',
          state,
        )
        // This private badge records the latest task; it must not restrict subsequent tasks.
        // A badge-write failure does not undo a task that was already committed.
        let warning: string | undefined
        try {
          const { error } = await db
            .from('user_communications')
            .update({ linked_task_id: item.id })
            .eq('id', communication.id)
            .eq('tenant_id', user.organizationId)
            .eq('owner_user_id', user.id)
          if (error) warning = 'Task created, but the message badge could not be updated.'
        } catch {
          warning = 'Task created, but the message badge could not be updated.'
        }
        // Private list of every task made from this message, used to pick a Drive folder.
        // Kept separate so a database without schema v23 still records the badge above.
        try {
          const ids = [
            ...new Set([
              ...(Array.isArray(communication.linked_task_ids) ? communication.linked_task_ids : []),
              ...(communication.linked_task_id ? [communication.linked_task_id] : []),
              item.id,
            ]),
          ].slice(-200)
          await db
            .from('user_communications')
            .update({ linked_task_ids: ids })
            .eq('id', communication.id)
            .eq('tenant_id', user.organizationId)
            .eq('owner_user_id', user.id)
        } catch {
          /* Older schema: the latest-task badge still works. */
        }
        res.status(201).json({ task: item, ...(warning ? { warning } : {}) })
      })
    }),
  )
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
        sheetsWrite = req.query.sheets === 'write'
      if (!send || !sheets || !sheetsWrite) {
        try {
          const scope = (await accessGrant(req)).scope
          send ||= hasScope(scope, SEND_SCOPE)
          sheetsWrite ||= hasScope(scope, SHEETS_WRITE_SCOPE)
          sheets ||= sheetsWrite || hasScope(scope, SHEETS_READ_SCOPE)
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
        scope: `${READ_SCOPE}${send ? ` ${SEND_SCOPE}` : ''}${sheets ? ` ${sheetsWrite ? SHEETS_WRITE_SCOPE : SHEETS_READ_SCOPE} ${DRIVE_LIST_SCOPE}` : ''} https://www.googleapis.com/auth/userinfo.email`,
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
  /** A fresh Gmail access token and the permissions it carries. */
  async function accessGrant(req: Request) {
    const user = current(req)
    return grantFor(user.organizationId, user.id)
  }
  /** A fresh Google access token for one person, by account and user id (used by connected trackers, which sync as the person who connected them). */
  async function grantFor(tenantId: string, userId: string) {
    const row = await settings(tenantId, userId)
    const config = await activeAccount(tenantId)
    if (!row?.gmail_refresh_token || row.gmail_config_revision !== config.row.revision)
      throw new IntegrationError(
        'Connect your Google account again in Work Hub. The account OAuth configuration changed.',
        409,
      )
    const refresh = decryptSecret(row.gmail_refresh_token, `${tenantId}:${userId}`, gmailKind)
    const grant = await google('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.credentials.clientId,
        client_secret: config.credentials.clientSecret,
        refresh_token: refresh,
        grant_type: 'refresh_token',
      }),
    })
    return { token: String(grant.access_token), scope: String(grant.scope || ''), email: String(row.gmail_email || '') }
  }
  async function accessToken(req: Request) {
    return (await accessGrant(req)).token
  }
  // Sending email from the tracker: composer status and the send call. Needs Drive's file lookup for attachments.
  registerOutbound(app, {
    db,
    auth,
    guard,
    gmailGate,
    wrap,
    current,
    google,
    settings,
    activeAccount,
    accessGrant,
    own,
    load: deps.load,
    commit: deps.commit,
    inOrder: createTaskInOrder,
    driveFile: drive.taskFile,
  })
  registerGithub(app, {
    db,
    requireAuth: deps.requireAuth,
    requireTenant: deps.requireTenant,
    guard,
    load: deps.load,
    commit: deps.commit,
    openStatus: deps.openStatus,
  })
  registerGitlab(app, {
    db,
    requireAuth: deps.requireAuth,
    requireTenant: deps.requireTenant,
    guard,
    load: deps.load,
    commit: deps.commit,
    openStatus: deps.openStatus,
  })
  const timer = setInterval(() => {
    const now = Date.now()
    for (const [key, value] of oauthStates) if (value.expires < now) oauthStates.delete(key)
  }, 60000)
  timer.unref()
  return {
    /** A Google access token for one person, and the permissions it carries. Connected trackers read Sheets with it. */
    googleAccess: grantFor,
    /** Files a document into the shared Google Drive; used by DocHub when a signature completes. */
    driveFiler: drive.filer,
    async captureDiscord(message: any, tenantId: string) {
      const ids = [...new Set((message.mentions?.users ? [...message.mentions.users.keys()] : []) as string[])]
      const { data: linked, error } = await db
        .from('user_communication_settings')
        .select('user_id,discord_user_id,discord_capture_mentions')
        .eq('tenant_id', tenantId)
        .in('discord_user_id', ids.length ? ids : ['0'])
      if (error) throw error
      const recipients = (linked || []).filter(
        (x: any) => x.discord_capture_mentions && ids.includes(x.discord_user_id),
      )
      // A bot DM routes only when the sender has linked their Discord identity.
      if (!message.guildId) {
        const { data: sender, error: dmError } = await db
          .from('user_communication_settings')
          .select('user_id')
          .eq('tenant_id', tenantId)
          .eq('discord_user_id', String(message.author.id))
        if (dmError) throw dmError
        recipients.push(...(sender || []))
      }
      let count = 0
      for (const recipient of new Map<string, any>(recipients.map((x: any) => [String(x.user_id), x])).values()) {
        const { error: writeError } = await db.from('user_communications').insert({
          tenant_id: tenantId,
          owner_user_id: recipient.user_id,
          source: 'Discord',
          external_id: String(message.id),
          thread_id: String(
            message.guildId
              ? message.channel?.isThread?.()
                ? message.channelId
                : message.reference?.messageId || message.id
              : message.channelId || '',
          ),
          subject: message.guildId ? `Mention in #${message.channel?.name || 'channel'}` : 'Bot direct message',
          body: String(message.content || '').slice(0, 30000),
          sender: String(message.author?.globalName || message.author?.username || 'Discord user'),
          received_at: new Date(message.createdTimestamp || Date.now()).toISOString(),
        })
        if (writeError && writeError.code !== '23505') throw writeError
        if (!writeError) count++
      }
      return count
    },
  }
}
