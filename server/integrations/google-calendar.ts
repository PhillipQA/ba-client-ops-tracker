import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { Express, Request, Response, NextFunction } from 'express'
import rateLimit from 'express-rate-limit'
import { encryptionKey, IntegrationError } from './tenant-integrations'

export const CALENDAR_CALLBACK = '/api/integrations/google-calendar/callback'
export const CALENDAR_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/calendar.events.readonly',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
]
const ACCOUNT_TABLE = 'google_calendar_accounts'
const CONNECTION_TABLE = 'google_calendar_connections'
const COOKIE = 'ba_calendar_oauth'
const API = 'https://www.googleapis.com/calendar/v3'
type Middleware = (req: Request, res: Response, next: NextFunction) => any
type Actor = {
  id: string
  organizationId?: string
  accountType?: string
  status: string
  role: string
  modules: string[]
}
type Credentials = { clientId: string; clientSecret: string; redirectUri: string }
type Tokens = { accessToken: string; refreshToken: string; expiresAt: number; email: string; subject: string }
type Pending = {
  tenantId: string
  userId: string
  sessionToken: string
  cookie: string
  verifier: string
  revision: string
  expiresAt: number
}
type GoogleFetch = typeof fetch

// Independent AEAD contexts prevent moving a credential/token between tenants or users.
export function sealCalendar(value: unknown, tenantId: string, userId?: string) {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv)
  cipher.setAAD(Buffer.from(JSON.stringify(['google-calendar', tenantId, userId ?? null, 1])))
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), body.toString('base64')].join('.')
}
export function openCalendar<T>(value: string, tenantId: string, userId?: string): T {
  try {
    const [version, iv, tag, body] = value.split('.')
    if (version !== 'v1') throw new Error()
    const cipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64'))
    cipher.setAAD(Buffer.from(JSON.stringify(['google-calendar', tenantId, userId ?? null, 1])))
    cipher.setAuthTag(Buffer.from(tag, 'base64'))
    return JSON.parse(Buffer.concat([cipher.update(Buffer.from(body, 'base64')), cipher.final()]).toString('utf8'))
  } catch {
    throw new IntegrationError(
      'Calendar credentials could not be decrypted. Ask Internal Admin to check the original integration master key.',
      503,
    )
  }
}
export function validateCredentials(input: any, origin: string): Credentials {
  let source = input || {}
  if (input?.oauthJson) {
    if (JSON.stringify(input.oauthJson).length > 32768)
      throw new IntegrationError('Choose an OAuth JSON file under 32 KB.')
    try {
      source = (typeof input.oauthJson === 'string' ? JSON.parse(input.oauthJson) : input.oauthJson).web
    } catch {
      throw new IntegrationError('Choose the Google OAuth Web application JSON file.')
    }
    if (!source)
      throw new IntegrationError('Use a Web application OAuth client, not a Desktop or service-account file.')
  }
  const clientId = String(source.client_id ?? source.clientId ?? '').trim()
  const clientSecret = String(source.client_secret ?? source.clientSecret ?? '').trim()
  const redirectUri = String(input.redirectUri || `${origin}${CALENDAR_CALLBACK}`).trim()
  if (!/^[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/.test(clientId) || clientId.length > 256)
    throw new IntegrationError('Enter a valid Google OAuth Client ID.')
  if (clientSecret.length < 10 || clientSecret.length > 4096 || /\s/.test(clientSecret))
    throw new IntegrationError('Enter the Google OAuth Client Secret.')
  if (redirectUri !== `${origin}${CALENDAR_CALLBACK}`)
    throw new IntegrationError('The redirect URI must exactly match this application’s callback address shown below.')
  return { clientId, clientSecret, redirectUri }
}
function check(error: any) {
  if (error)
    throw new IntegrationError(
      'Calendar storage is unavailable. Apply supabase/schema-v9-google-calendar.sql and check Supabase.',
      503,
    )
}
export function createCalendarStore(db: any) {
  const table = (name: string) => {
    if (!db) throw new IntegrationError('Supabase is required for Google Calendar.', 503)
    return db.from(name)
  }
  const config = async (tenantId: string) => {
    const { data, error } = await table(ACCOUNT_TABLE).select('*').eq('tenant_id', tenantId).maybeSingle()
    check(error)
    return data
  }
  const connection = async (tenantId: string, userId: string) => {
    const { data, error } = await table(CONNECTION_TABLE)
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('user_id', userId)
      .maybeSingle()
    check(error)
    return data
  }
  const saveConfig = async (tenantId: string, patch: any) => {
    const current = await config(tenantId)
    const record = { ...patch, updated_at: new Date().toISOString() }
    const { error } = current
      ? await table(ACCOUNT_TABLE).update(record).eq('tenant_id', tenantId)
      : await table(ACCOUNT_TABLE).insert({ tenant_id: tenantId, ...record })
    check(error)
  }
  const saveConnection = async (tenantId: string, userId: string, patch: any) => {
    const { error } = await table(CONNECTION_TABLE).upsert(
      { ...patch, tenant_id: tenantId, user_id: userId, updated_at: new Date().toISOString() },
      { onConflict: 'tenant_id,user_id' },
    )
    check(error)
  }
  const removeConnection = async (tenantId: string, userId: string) => {
    const { error } = await table(CONNECTION_TABLE).delete().eq('tenant_id', tenantId).eq('user_id', userId)
    check(error)
  }
  return { config, connection, saveConfig, saveConnection, removeConnection }
}

export function calendarRange(start: unknown, end: unknown, timeZone: unknown) {
  const from = new Date(String(start)),
    to = new Date(String(end)),
    zone = String(timeZone || 'Asia/Manila')
  if (
    !Number.isFinite(from.getTime()) ||
    !Number.isFinite(to.getTime()) ||
    to <= from ||
    to.getTime() - from.getTime() > 32 * 86400000
  )
    throw new IntegrationError('Choose a calendar range of up to 31 days.')
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone }).format(from)
  } catch {
    throw new IntegrationError('Choose a valid time zone.')
  }
  return { timeMin: from.toISOString(), timeMax: to.toISOString(), timeZone: zone }
}
function safeCalendarLink(value: unknown) {
  try {
    const url = new URL(String(value))
    return url.protocol === 'https:' && ['calendar.google.com', 'www.google.com'].includes(url.hostname)
      ? url.href
      : undefined
  } catch {
    return undefined
  }
}
export function mapCalendarEvent(event: any, calendarId: string, timeZone: string) {
  if (
    !event.id ||
    event.status === 'cancelled' ||
    event.attendees?.some((a: any) => a.self && a.responseStatus === 'declined')
  )
    return null
  const allDay = Boolean(event.start?.date)
  const parts = (value: string) => {
    const date = new Date(value)
    if (!Number.isFinite(date.getTime())) return null
    const p = Object.fromEntries(
      new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      })
        .formatToParts(date)
        .map(v => [v.type, v.value]),
    )
    return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` }
  }
  const start = allDay ? { date: String(event.start.date), time: '' } : parts(event.start?.dateTime)
  const end = allDay ? null : parts(event.end?.dateTime)
  if (!start) return null
  let endDate = end?.date || start.date
  if (allDay && /^\d{4}-\d{2}-\d{2}$/.test(event.end?.date || ''))
    endDate = new Date(Date.parse(`${event.end.date}T00:00:00Z`) - 86400000).toISOString().slice(0, 10)
  // A timed event ending at midnight does not occupy the following day.
  if (!allDay && end?.time === '00:00' && end.date > start.date)
    endDate = new Date(Date.parse(`${end.date}T00:00:00Z`) - 86400000).toISOString().slice(0, 10)
  return {
    id: `${encodeURIComponent(calendarId)}:${event.id}`,
    calendarId,
    title: String(event.summary || '(Untitled event)').slice(0, 1000),
    date: start.date,
    endDate,
    startTime: start.time,
    endTime: end?.time || '',
    allDay,
    notes: String(event.description || '').slice(0, 12000),
    location: String(event.location || '').slice(0, 1000),
    calendarLink: safeCalendarLink(event.htmlLink),
  }
}

export function registerGoogleCalendarRoutes(
  app: Express,
  deps: {
    db: any
    requireAuth: Middleware
    requireTenant: Middleware
    requirePlatformAdmin: Middleware
    organizationById: (id: string) => Promise<any>
    sessionFromRequest: (req: Request) => { token: string; user: Actor | null }
    sessionByToken: (token: string) => Actor | null
    fetchGoogle?: GoogleFetch
    now?: () => number
  },
) {
  const store = createCalendarStore(deps.db),
    googleFetch = deps.fetchGoogle || fetch,
    now = deps.now || Date.now
  const pending = new Map<string, Pending>(),
    queues = new Map<string, Promise<unknown>>()
  async function locked<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    const job = (queues.get(tenantId) || Promise.resolve()).catch(() => undefined).then(fn)
    queues.set(tenantId, job)
    try {
      return await job
    } finally {
      if (queues.get(tenantId) === job) queues.delete(tenantId)
    }
  }
  function clearPending(tenantId: string, userId?: string) {
    for (const [key, state] of pending)
      if (state.tenantId === tenantId && (!userId || state.userId === userId)) pending.delete(key)
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
      throw new IntegrationError('Use HTTPS or a localhost development URL for Calendar.', 503)
    return url.origin
  }
  const wrap =
    (fn: (req: Request, res: Response) => Promise<any>): Middleware =>
    async (req, res) => {
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('Referrer-Policy', 'no-referrer')
      try {
        if (!['GET', 'HEAD'].includes(req.method) && (req.get('origin') !== origin(req) || !req.is('application/json')))
          throw new IntegrationError('Calendar changes require a same-origin JSON request.', 403)
        await fn(req, res)
      } catch (e) {
        if (!res.headersSent)
          res.status(e instanceof IntegrationError ? e.status : 503).json({
            error: e instanceof IntegrationError ? e.message : 'Calendar is temporarily unavailable. Please retry.',
          })
      }
    }
  const limiter = rateLimit({
    windowMs: 60000,
    limit: 90,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many Calendar requests. Wait a minute and retry.' },
  })
  const userScope = [deps.requireAuth, deps.requireTenant, limiter]
  const actor = (req: Request) => (req as any).authUser as Actor
  async function verifyUser(user: Actor, purpose: 'settings' | 'calendar' | 'disconnect' = 'calendar') {
    if (!user?.organizationId || user.accountType !== 'tenant' || user.status !== 'Active')
      throw new IntegrationError('Sign in to your tenant account.', 401)
    const org = await deps.organizationById(user.organizationId)
    if (!org || org.status !== 'Active') throw new IntegrationError('This account is unavailable.', 403)
    if (!deps.db) throw new IntegrationError('Supabase is required for Calendar.', 503)
    const { data: record, error } = await deps.db
      .from('app_users')
      .select('id,role,status,modules')
      .eq('organization_id', user.organizationId)
      .eq('id', user.id)
      .is('deleted_at', null)
      .maybeSingle()
    check(error)
    if (!record || record.status !== 'Active') throw new IntegrationError('This user is unavailable.', 403)
    const allowed = (module: string) =>
      org.enabledModules.includes(module) && (record.role === 'Administrator' || record.modules?.includes(module))
    if (
      purpose === 'settings'
        ? record.role !== 'Administrator' || !allowed('settings')
        : purpose !== 'disconnect' && !allowed('action')
    )
      throw new IntegrationError(
        purpose === 'settings'
          ? 'An account Administrator with Settings access is required.'
          : 'Action Center access is required.',
        403,
      )
    return user.organizationId
  }
  async function activeConfig(tenantId: string) {
    const row = await store.config(tenantId)
    if (!row?.platform_enabled)
      throw new IntegrationError('Google Calendar is disabled for this account in Internal Admin.', 403)
    if (!row.account_enabled || !row.encrypted_config)
      throw new IntegrationError(
        'Ask your account administrator to configure and enable Google Calendar in Settings.',
        409,
      )
    return { row, credentials: openCalendar<Credentials>(row.encrypted_config, tenantId) }
  }
  async function google(url: string, init: RequestInit = {}) {
    let response: Awaited<ReturnType<GoogleFetch>>
    try {
      response = await googleFetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15000) })
    } catch {
      throw new IntegrationError('Google could not be reached. Please retry.', 502)
    }
    const body: any = await response.json().catch(() => ({}))
    if (!response.ok) {
      if (response.status === 401 || body.error === 'invalid_grant')
        throw new IntegrationError('Google authorization expired or was revoked. Disconnect and connect again.', 401)
      if (response.status === 429)
        throw new IntegrationError('Google Calendar request limit reached. Wait a minute and refresh.', 429)
      if (response.status === 403)
        throw new IntegrationError(
          'Google denied Calendar access. Check the Calendar API, selected permissions and Workspace policy.',
          403,
        )
      throw new IntegrationError(
        'Google rejected the Calendar request. Check OAuth credentials, callback URL and calendar access.',
        502,
      )
    }
    return body
  }
  const tokenRequest = (credentials: Credentials, params: Record<string, string>) =>
    google('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        ...params,
      }),
    })
  function validateScopes(scope: unknown) {
    const granted = new Set(String(scope || '').split(' '))
    if (!CALENDAR_SCOPES.slice(2).every(s => granted.has(s)))
      throw new IntegrationError(
        'Both read-only Calendar permissions are required. Connect again and select both permissions.',
        403,
      )
  }
  async function authorized(tenantId: string, userId: string) {
    const config = await activeConfig(tenantId),
      row = await store.connection(tenantId, userId)
    if (!row || row.config_revision !== config.row.revision)
      throw new IntegrationError(
        'Connect your Google Calendar first. Account credential changes require reconnecting.',
        409,
      )
    let tokens = openCalendar<Tokens>(row.encrypted_tokens, tenantId, userId)
    if (tokens.expiresAt < now() + 60000) {
      const next = await tokenRequest(config.credentials, {
        grant_type: 'refresh_token',
        refresh_token: tokens.refreshToken,
      })
      if (!next.access_token || !Number.isFinite(Number(next.expires_in)))
        throw new IntegrationError('Google did not return a usable access token. Reconnect Calendar.', 502)
      if (next.scope) validateScopes(next.scope)
      tokens = {
        ...tokens,
        accessToken: next.access_token,
        refreshToken: next.refresh_token || tokens.refreshToken,
        expiresAt: now() + Number(next.expires_in) * 1000,
      }
      row.encrypted_tokens = sealCalendar(tokens, tenantId, userId)
      await store.saveConnection(tenantId, userId, row)
    }
    return { row, tokens }
  }
  async function pages(path: string, token: string, params: Record<string, string>, limit = 20) {
    const items: any[] = []
    let pageToken = ''
    for (let page = 0; page < limit; page++) {
      const query = new URLSearchParams({ ...params, ...(pageToken ? { pageToken } : {}) })
      const body = await google(`${API}${path}?${query}`, { headers: { Authorization: `Bearer ${token}` } })
      if (Array.isArray(body.items)) items.push(...body.items)
      pageToken = body.nextPageToken || ''
      if (!pageToken) return items
    }
    throw new IntegrationError(
      'This selection has too many Calendar records. Select fewer calendars or a shorter range.',
      422,
    )
  }
  const listCalendars = async (token: string) =>
    (await pages('/users/me/calendarList', token, { maxResults: '250', minAccessRole: 'reader', showDeleted: 'false' }))
      .filter(c => c.id && !c.deleted)
      .map(c => ({
        id: String(c.id),
        name: String(c.summaryOverride || c.summary || c.id),
        primary: Boolean(c.primary),
        timeZone: String(c.timeZone || ''),
      }))

  app.get(
    '/api/account/google-calendar',
    ...userScope,
    wrap(async (req, res) => {
      const tenantId = await verifyUser(actor(req), 'settings'),
        row = await store.config(tenantId)
      let encryptionReady = true
      try {
        encryptionKey()
      } catch {
        encryptionReady = false
      }
      const credentials =
        row?.encrypted_config && encryptionReady ? openCalendar<Credentials>(row.encrypted_config, tenantId) : null
      res.json({
        platformEnabled: Boolean(row?.platform_enabled),
        enabled: Boolean(row?.account_enabled),
        configured: Boolean(row?.encrypted_config),
        encryptionReady,
        clientId: credentials?.clientId || '',
        redirectUri: credentials?.redirectUri || `${origin(req)}${CALENDAR_CALLBACK}`,
        expectedRedirectUri: `${origin(req)}${CALENDAR_CALLBACK}`,
      })
    }),
  )
  app.put(
    '/api/account/google-calendar',
    ...userScope,
    wrap(async (req, res) => {
      const user = actor(req),
        tenantId = await verifyUser(user, 'settings')
      if (typeof req.body?.enabled !== 'boolean')
        throw new IntegrationError('Specify whether Calendar is enabled for this account.')
      await locked(tenantId, async () => {
        await verifyUser(user, 'settings')
        const previous = await store.config(tenantId)
        if (!previous?.platform_enabled)
          throw new IntegrationError('Internal Admin must enable Google Calendar for this account first.', 403)
        const replacing = Boolean(req.body?.oauthJson || req.body?.clientId || req.body?.clientSecret)
        if (!replacing && !previous.encrypted_config)
          throw new IntegrationError('Upload the Google OAuth JSON or enter both credentials.')
        const patch: any = { account_enabled: Boolean(req.body?.enabled) }
        if (replacing) {
          const credentials = validateCredentials(req.body, origin(req))
          patch.encrypted_config = sealCalendar(credentials, tenantId)
          patch.revision = randomUUID()
        }
        await store.saveConfig(tenantId, patch)
        clearPending(tenantId)
      })
      res.json({ ok: true })
    }),
  )
  app.delete(
    '/api/account/google-calendar',
    ...userScope,
    wrap(async (req, res) => {
      const user = actor(req),
        tenantId = await verifyUser(user, 'settings')
      await locked(tenantId, async () => {
        await verifyUser(user, 'settings')
        await store.saveConfig(tenantId, { encrypted_config: null, account_enabled: false, revision: randomUUID() })
        clearPending(tenantId)
      })
      res.json({ ok: true })
    }),
  )
  app.get(
    '/api/internal-admin/organizations/:organizationId/google-calendar',
    deps.requireAuth,
    deps.requirePlatformAdmin,
    limiter,
    wrap(async (req, res) => {
      const id = String(req.params.organizationId)
      if (!(await deps.organizationById(id))) throw new IntegrationError('Account not found.', 404)
      const row = await store.config(id)
      res.json({ enabled: Boolean(row?.platform_enabled), configured: Boolean(row?.encrypted_config) })
    }),
  )
  app.put(
    '/api/internal-admin/organizations/:organizationId/google-calendar',
    deps.requireAuth,
    deps.requirePlatformAdmin,
    limiter,
    wrap(async (req, res) => {
      const id = String(req.params.organizationId)
      if (!(await deps.organizationById(id))) throw new IntegrationError('Account not found.', 404)
      if (typeof req.body?.enabled !== 'boolean') throw new IntegrationError('Specify enabled or disabled.')
      await locked(id, async () => {
        await store.saveConfig(id, { platform_enabled: req.body.enabled })
        clearPending(id)
      })
      res.json({ ok: true })
    }),
  )
  app.get(
    '/api/me/google-calendar',
    ...userScope,
    wrap(async (req, res) => {
      const user = actor(req),
        tenantId = await verifyUser(user, 'disconnect'),
        config = await store.config(tenantId),
        connection = await store.connection(tenantId, user.id)
      const connected = Boolean(
        connection && config?.encrypted_config && connection.config_revision === config.revision,
      )
      const tokens = connected ? openCalendar<Tokens>(connection.encrypted_tokens, tenantId, user.id) : null
      res.json({
        enabled: Boolean(config?.platform_enabled && config?.account_enabled && config?.encrypted_config),
        connected,
        hasConnection: Boolean(connection),
        email: tokens?.email || '',
        selectedCalendarIds: connected ? connection.selected_calendars : [],
        reconnectRequired: Boolean(connection && !connected),
      })
    }),
  )
  app.post(
    '/api/me/google-calendar/connect',
    ...userScope,
    wrap(async (req, res) => {
      const user = actor(req),
        tenantId = await verifyUser(user),
        session = deps.sessionFromRequest(req)
      if (!session.token) throw new IntegrationError('Sign in again to connect Calendar.', 401)
      await locked(tenantId, async () => {
        await verifyUser(user)
        const config = await activeConfig(tenantId)
        if (config.credentials.redirectUri !== `${origin(req)}${CALENDAR_CALLBACK}`)
          throw new IntegrationError(
            'The application URL changed. Ask your administrator to update the saved Calendar credentials.',
            409,
          )
        for (const [key, state] of pending) if (state.expiresAt <= now()) pending.delete(key)
        clearPending(tenantId, user.id)
        if (pending.size > 1000)
          throw new IntegrationError('Too many pending Calendar connections. Retry shortly.', 429)
        const state = randomBytes(32).toString('hex'),
          cookie = randomBytes(32).toString('hex'),
          verifier = randomBytes(32).toString('base64url')
        pending.set(state, {
          tenantId,
          userId: user.id,
          sessionToken: session.token,
          cookie,
          verifier,
          revision: config.row.revision,
          expiresAt: now() + 10 * 60000,
        })
        // A dedicated Lax cookie permits Google's cross-site callback without weakening ba_session (Strict).
        res.cookie(COOKIE, cookie, {
          httpOnly: true,
          secure: origin(req).startsWith('https:'),
          sameSite: 'lax',
          path: CALENDAR_CALLBACK,
          maxAge: 10 * 60000,
        })
        const query = new URLSearchParams({
          client_id: config.credentials.clientId,
          redirect_uri: config.credentials.redirectUri,
          response_type: 'code',
          scope: CALENDAR_SCOPES.join(' '),
          access_type: 'offline',
          prompt: 'consent select_account',
          state,
          code_challenge: createHash('sha256').update(verifier).digest('base64url'),
          code_challenge_method: 'S256',
        })
        res.json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${query}` })
      })
    }),
  )
  app.get(CALENDAR_CALLBACK, limiter, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Referrer-Policy', 'no-referrer')
    let result = 'failed'
    try {
      const state = typeof req.query.state === 'string' ? req.query.state : '',
        saved = pending.get(state)
      const cookie =
        (req.headers.cookie || '')
          .split(';')
          .map(v => v.trim())
          .find(v => v.startsWith(`${COOKIE}=`))
          ?.slice(COOKIE.length + 1) || ''
      if (
        !saved ||
        saved.expiresAt <= now() ||
        !/^[a-f0-9]{64}$/.test(cookie) ||
        !timingSafeEqual(Buffer.from(cookie), Buffer.from(saved.cookie))
      )
        throw new Error('Invalid state')
      pending.delete(state)
      const user = deps.sessionByToken(saved.sessionToken)
      if (!user || user.id !== saved.userId || user.organizationId !== saved.tenantId)
        throw new Error('Session expired')
      await locked(saved.tenantId, async () => {
        await verifyUser(user)
        const config = await activeConfig(saved.tenantId)
        if (
          config.row.revision !== saved.revision ||
          config.credentials.redirectUri !== `${origin(req)}${CALENDAR_CALLBACK}`
        )
          throw new Error('Configuration changed')
        if (req.query.error) {
          result = 'denied'
          return
        }
        if (typeof req.query.code !== 'string' || req.query.code.length > 4096) throw new Error('Missing code')
        const grant = await tokenRequest(config.credentials, {
          grant_type: 'authorization_code',
          code: req.query.code,
          redirect_uri: config.credentials.redirectUri,
          code_verifier: saved.verifier,
        })
        validateScopes(grant.scope)
        if (!grant.access_token || !grant.refresh_token || !Number.isFinite(Number(grant.expires_in)))
          throw new Error('Missing offline token')
        const identity = await google('https://openidconnect.googleapis.com/v1/userinfo', {
          headers: { Authorization: `Bearer ${grant.access_token}` },
        })
        if (!identity.sub || !identity.email || identity.email_verified !== true) throw new Error('Unverified identity')
        // Recheck the original session after remote calls (logout/password reset invalidates it).
        const current = deps.sessionByToken(saved.sessionToken)
        if (!current || current.id !== saved.userId || current.organizationId !== saved.tenantId)
          throw new Error('Session expired')
        await verifyUser(current)
        const tokens: Tokens = {
          accessToken: grant.access_token,
          refreshToken: grant.refresh_token,
          expiresAt: now() + Number(grant.expires_in) * 1000,
          email: identity.email,
          subject: identity.sub,
        }
        await store.saveConnection(saved.tenantId, saved.userId, {
          config_revision: config.row.revision,
          encrypted_tokens: sealCalendar(tokens, saved.tenantId, saved.userId),
          selected_calendars: ['primary'],
        })
        result = 'connected'
      })
    } catch {
      /* Never log or return authorization codes, tokens, or provider response bodies. */
    }
    res.clearCookie(COOKIE, { path: CALENDAR_CALLBACK, httpOnly: true, sameSite: 'lax' })
    res.redirect(303, `/#calendar=${result}`)
  })
  app.delete(
    '/api/me/google-calendar',
    ...userScope,
    wrap(async (req, res) => {
      const user = actor(req),
        tenantId = await verifyUser(user, 'disconnect')
      const revoked = await locked(tenantId, async () => {
        clearPending(tenantId, user.id)
        const row = await store.connection(tenantId, user.id)
        let token = ''
        try {
          if (row) token = openCalendar<Tokens>(row.encrypted_tokens, tenantId, user.id).refreshToken
        } catch {
          /* Allow removal even if a key was lost. */
        }
        await store.removeConnection(tenantId, user.id)
        if (!token) return !row
        try {
          const response = await googleFetch('https://oauth2.googleapis.com/revoke', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token }),
            signal: AbortSignal.timeout(15000),
            redirect: 'error',
          })
          return response.ok
        } catch {
          return false
        }
      })
      res.json({
        ok: true,
        message: revoked
          ? 'Disconnected and Google access revoked.'
          : 'Disconnected locally. Google revocation could not be confirmed; remove this app in your Google Account permissions as well.',
      })
    }),
  )
  app.get(
    '/api/me/google-calendar/calendars',
    ...userScope,
    wrap(async (req, res) => {
      const user = actor(req),
        tenantId = await verifyUser(user)
      const calendars = await locked(tenantId, async () => {
        await verifyUser(user)
        const { tokens } = await authorized(tenantId, user.id)
        return listCalendars(tokens.accessToken)
      })
      res.json({ calendars })
    }),
  )
  app.put(
    '/api/me/google-calendar/calendars',
    ...userScope,
    wrap(async (req, res) => {
      const user = actor(req),
        tenantId = await verifyUser(user),
        ids = req.body?.calendarIds
      if (!Array.isArray(ids) || ids.length > 10 || ids.some(id => typeof id !== 'string' || !id || id.length > 1024))
        throw new IntegrationError('Select up to 10 calendars.')
      await locked(tenantId, async () => {
        await verifyUser(user)
        const { row, tokens } = await authorized(tenantId, user.id),
          calendars = await listCalendars(tokens.accessToken)
        const allowed = new Set(['primary', ...calendars.map(c => c.id)])
        if (ids.some(id => !allowed.has(id)))
          throw new IntegrationError('A selected calendar is no longer accessible. Reload the calendar list.')
        const primary = calendars.find(c => c.primary)?.id
        await store.saveConnection(tenantId, user.id, {
          ...row,
          selected_calendars: [...new Set(ids.map(id => (id === primary ? 'primary' : id)))],
        })
      })
      res.json({ ok: true })
    }),
  )
  app.get(
    '/api/me/google-calendar/events',
    ...userScope,
    wrap(async (req, res) => {
      const user = actor(req),
        tenantId = await verifyUser(user),
        range = calendarRange(req.query.start, req.query.end, req.query.timeZone)
      const events = await locked(tenantId, async () => {
        await verifyUser(user)
        const { row, tokens } = await authorized(tenantId, user.id),
          records: any[] = []
        for (const calendarId of row.selected_calendars as string[]) {
          const items = await pages(`/calendars/${encodeURIComponent(calendarId)}/events`, tokens.accessToken, {
            ...range,
            singleEvents: 'true',
            orderBy: 'startTime',
            showDeleted: 'false',
            maxResults: '250',
          })
          records.push(...items.map(event => mapCalendarEvent(event, calendarId, range.timeZone)).filter(Boolean))
        }
        await verifyUser(user)
        return [...new Map(records.map(event => [event.id, event])).values()].sort(
          (a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime),
        )
      })
      res.json({ events, timeZone: range.timeZone, refreshedAt: new Date(now()).toISOString() })
    }),
  )
}
