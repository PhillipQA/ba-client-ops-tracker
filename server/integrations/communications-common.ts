/**
 * Constants and helpers shared by the Work Hub communication modules (see communications.ts).
 */
import type { Request, Response, NextFunction } from 'express'
import { IntegrationError } from './tenant-integrations'

export type Middleware = (req: Request, res: Response, next: NextFunction) => any

export const CALLBACK = '/api/communications/gmail/callback'

export const COOKIE = 'ba_gmail_oauth'

export const oauthStates = new Map<
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

/** Downloading Excel files kept in Drive, for trackers that follow one (asked for with ?sheets=1&excel=1). */
export const DRIVE_READ_SCOPE = 'https://www.googleapis.com/auth/drive.readonly'

/** Editing Google Sheets, for trackers that mark rows done in their Sheet. It includes reading. */
export const SHEETS_WRITE_SCOPE = 'https://www.googleapis.com/auth/spreadsheets'

export const gmailKind = 'gmail-refresh' as const

export type GmailCredentials = { clientId: string; clientSecret: string; redirectUri: string }

export const google = async (url: string, init: RequestInit, timeout = 20000) => {
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

export function origin(req: Request) {
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

export function validateCredentials(input: any, appOrigin: string): GmailCredentials {
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

export function requireText(input: unknown, field: string, max = 4000) {
  if (typeof input !== 'string' || input.trim().length > max) throw new IntegrationError(`${field} is invalid.`)
  return input.trim()
}

/** The database has no read_at column yet (a database from before the read_at column): reading and writing go on without it. */
export const missingReadColumn = (error: any) =>
  Boolean(error) && (error.code === '42703' || error.code === 'PGRST204' || /read_at/.test(String(error.message || '')))

/** Unread counts cover received email and Discord messages only: not GitHub, GitLab or manual logs. */
export const UNREAD_SOURCES = ['Gmail', 'Discord'] as const

/** What registerCommunications needs from the server. */
export type CommunicationsDeps = {
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
}
