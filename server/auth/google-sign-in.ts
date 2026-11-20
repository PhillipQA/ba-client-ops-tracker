/**
 * Sign in with Google.
 *
 * The login page gets a Google ID token for the person (Google Identity Services, the same Google client the app
 * already uses to send time to Seeds) and posts it here. The server checks that Google signed it, for this app, and
 * that the email is verified; then signs in the user registered with that email. It never creates a user.
 * When Seeds is on for the account, the email must also be in Seeds' active-employee directory, so someone who has
 * left can no longer get in this way. Password sign-in is unchanged and stays as the backup.
 */
import { createPublicKey, type KeyObject, verify } from 'node:crypto'
import { seedsState } from '../../src/shared/seeds'

const GOOGLE_KEYS_URL = 'https://www.googleapis.com/oauth2/v3/certs'
const ISSUERS = ['accounts.google.com', 'https://accounts.google.com']
const MAX_TOKEN_LENGTH = 4096

export class GoogleSignInError extends Error {
  constructor(
    message: string,
    public status = 401,
  ) {
    super(message)
  }
}

export type GoogleIdentity = { email: string; name: string; subject: string }

const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))

/** Checks Google ID tokens against Google's published signing keys (cached as long as Google allows). */
export function createGoogleVerifier(options: { request?: typeof fetch; now?: () => number } = {}) {
  const request = options.request || fetch
  const now = options.now || Date.now
  let keys = new Map<string, KeyObject>()
  let loadedAt = 0
  let freshUntil = 0

  async function loadKeys() {
    let response: Response
    try {
      response = await request(GOOGLE_KEYS_URL, { signal: AbortSignal.timeout(10_000) })
    } catch {
      throw new GoogleSignInError(
        'Google could not be reached to check your sign-in. Try again, or use your password.',
        503,
      )
    }
    if (!response.ok)
      throw new GoogleSignInError(
        'Google could not be reached to check your sign-in. Try again, or use your password.',
        503,
      )
    const body: any = await response.json().catch(() => ({}))
    const next = new Map<string, KeyObject>()
    for (const jwk of Array.isArray(body?.keys) ? body.keys : []) {
      if (jwk?.kty !== 'RSA' || typeof jwk.kid !== 'string') continue
      try {
        next.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' }))
      } catch {
        /* A key that cannot be read is skipped. */
      }
    }
    if (!next.size) throw new GoogleSignInError('Google sign-in is unavailable right now. Use your password.', 503)
    const maxAge = Number(/max-age=(\d+)/.exec(response.headers.get('cache-control') || '')?.[1] || 3600)
    keys = next
    loadedAt = now()
    freshUntil = loadedAt + Math.min(Math.max(maxAge, 60), 86_400) * 1000
  }

  return async function verifyGoogleIdToken(idToken: unknown, clientId: string): Promise<GoogleIdentity> {
    const invalid = () => new GoogleSignInError('That Google sign-in could not be verified. Try again.')
    if (typeof idToken !== 'string' || idToken.length > MAX_TOKEN_LENGTH) throw invalid()
    const parts = idToken.split('.')
    if (parts.length !== 3) throw invalid()
    let header: any
    let claims: any
    try {
      header = decode(parts[0])
      claims = decode(parts[1])
    } catch {
      throw invalid()
    }
    if (header?.alg !== 'RS256' || typeof header.kid !== 'string') throw invalid()
    if (now() >= freshUntil) await loadKeys()
    // Google rotates its keys: an unknown key id is looked up once more, at most once a minute.
    if (!keys.has(header.kid) && now() - loadedAt > 60_000) await loadKeys()
    const key = keys.get(header.kid)
    if (!key) throw invalid()
    const signed = verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'))
    if (!signed) throw invalid()
    if (!clientId || claims?.aud !== clientId) throw new GoogleSignInError('That Google sign-in is not for this app.')
    if (!ISSUERS.includes(claims.iss)) throw invalid()
    if (!(Number(claims.exp) * 1000 > now()))
      throw new GoogleSignInError('Your Google sign-in expired. Sign in with Google again.')
    const email = String(claims.email || '')
      .trim()
      .toLowerCase()
    if (!email || (claims.email_verified !== true && claims.email_verified !== 'true'))
      throw new GoogleSignInError('Your Google account has no verified email.')
    // Google vouches for an address only when it hosts the mailbox: Gmail, or a Google Workspace domain (hd).
    if (!email.endsWith('@gmail.com') && !claims.hd)
      throw new GoogleSignInError('Sign in with a Gmail or Google Workspace account.')
    return { email, name: String(claims.name || ''), subject: String(claims.sub || '') }
  }
}

/** Escapes a value for an exact ILIKE match (\, % and _ are wildcards otherwise). */
export const exactLike = (value: string) => value.replace(/[\\%_]/g, character => `\\${character}`)

export type GoogleCandidate = { user: any; organization: { id: string; name: string; slug: string } }
export type GoogleChoice =
  | { ok: true; candidate: GoogleCandidate }
  | { ok: false; status: number; error: string; accounts?: { name: string; slug: string }[] }

/**
 * Which user a Google email signs in as. Candidates are active users, in active accounts, registered with exactly
 * that email. One email in several accounts asks which account; two users with it in one account is refused.
 */
export function chooseGoogleUser(candidates: GoogleCandidate[], email: string, accountId = ''): GoogleChoice {
  if (!candidates.length)
    return {
      ok: false,
      status: 403,
      error: `No active user is registered with ${email}. Ask your Administrator to put this email on your user, or sign in with your password.`,
    }
  const accounts = [...new Map(candidates.map(({ organization }) => [organization.id, organization])).values()]
  if (accounts.length > 1 && !accountId)
    return {
      ok: false,
      status: 409,
      error: 'Your email is registered in more than one account. Choose the account to open.',
      accounts: accounts.map(({ name, slug }) => ({ name, slug })),
    }
  const inAccount = accountId ? candidates.filter(({ organization }) => organization.id === accountId) : candidates
  if (!inAccount.length)
    // The same answer whether the account is unknown or has no user with this email.
    return { ok: false, status: 403, error: `Incorrect account, or ${email} is not a user of it.` }
  if (inAccount.length > 1)
    return {
      ok: false,
      status: 409,
      error: `More than one user in ${inAccount[0].organization.name} has the email ${email}. Sign in with your password, and ask your Administrator to fix the duplicate.`,
    }
  return { ok: true, candidate: inAccount[0] }
}

/**
 * Seeds decides who may sign in. Once Seeds is on for the account and has given its active-employee directory, a
 * person must be in it, by email, whichever way they sign in (Google or password), and a signed-in session ends once
 * they drop out of it. Nobody is let through by role: the one way past Seeds is an exception that Internal Admin sets
 * on a user, and it covers password sign-in only (see seedsSignInRoute). Before Seeds is on, or while its directory is
 * empty, there is nothing to check against.
 */
export function seedsEmployeeEmails(state: any): Set<string> | null {
  const seeds = seedsState(state)
  if (!seeds.connected || !seeds.people.length) return null
  return new Set(
    seeds.people
      .map(person =>
        String(person.email || '')
          .trim()
          .toLowerCase(),
      )
      .filter(Boolean),
  )
}

export function seedsAdmits(user: { email?: unknown }, employees: Set<string> | null) {
  if (!employees) return true
  const email = String(user.email || '')
    .trim()
    .toLowerCase()
  return Boolean(email) && employees.has(email)
}

/** Why a sign-in is refused because of Seeds, for the person to read. */
export const notInSeeds = (email: unknown) =>
  String(email || '').trim()
    ? `${String(email).trim()} is not an active employee in Seeds, so it cannot sign in here. Ask your Administrator.`
    : 'Your user has no email, so it cannot be matched to Seeds. Ask your Administrator to add your Seeds email.'

export function seedsAllowsSignIn(state: any, user: { email?: unknown }) {
  return seedsAdmits(user, seedsEmployeeEmails(state))
}

/**
 * A user's Seeds exception, from app_users.seeds_exempt: true or false, or 'legacy' while the database is older than
 * schema v43 and has no such column. Then Administrators keep the automatic pass they had before exceptions, so
 * deploying ahead of the migration locks nobody out.
 */
export type SeedsExemption = boolean | 'legacy'

/**
 * How a sign-in gets past Seeds: 'seeds' when Seeds lets the person in (an active employee, or Seeds not checking),
 * 'exception' when only the person's Seeds exception does, or null when they are refused. The exception is for
 * password sign-in only: Sign in with Google always needs Seeds.
 */
export function seedsSignInRoute(
  state: any,
  user: { role?: unknown; email?: unknown },
  exemption: SeedsExemption,
  method: 'password' | 'google',
): 'seeds' | 'exception' | null {
  if (seedsAllowsSignIn(state, user)) return 'seeds'
  if (exemption === 'legacy') return user.role === 'Administrator' ? 'exception' : null
  return method === 'password' && exemption === true ? 'exception' : null
}
