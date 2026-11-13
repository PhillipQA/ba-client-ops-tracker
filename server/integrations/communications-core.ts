/**
 * Work Hub communications, the base: access checks, the account's Gmail settings, Google access for a person,
 * the Drive link, and reading a Gmail attachment. The other communication modules build on this.
 */
import { registerDrive } from './google-drive'
import { storedAttachment, matchAttachmentPart, gmailAttachmentParts, attachmentContentType } from './gmail-content'
import type { Request, Response, Express } from 'express'
import { IntegrationError, decryptSecret } from './tenant-integrations'
import {
  CALLBACK,
  type CommunicationsDeps,
  type GmailCredentials,
  gmailKind,
  google,
  type Middleware,
  origin,
} from './communications-common'

export function communicationsCore(app: Express, deps: CommunicationsDeps) {
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

  return {
    wrap,
    account,
    saveAccount,
    auth,
    accountGate,
    current,
    guard,
    db,
    own,
    gmailGate,
    gmailAttachment,
    settings,
    gmailBackfillCooldowns,
    createTaskInOrder,
    activeAccount,
    accessGrant,
    drive,
    liveUser,
    accessToken,
    gmailSyncJobs,
    gmailQuotaCooldowns,
    grantFor,
  }
}

export type CommunicationsCore = ReturnType<typeof communicationsCore>
