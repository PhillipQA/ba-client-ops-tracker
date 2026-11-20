// Sessions, passwords and the sign-in checks every route uses.
import { forgetSeedsException, seedsStillAdmits, withAccess } from '../services/access-cache'
import bcrypt from 'bcryptjs'
import type express from 'express'
import { createHash, timingSafeEqual } from 'node:crypto'
import { type InterfaceMode, normalizeInterfaceMode } from '../../src/features/settings/appearance'
import { normalizeAppTheme, normalizeClientThemes } from '../../src/features/settings/theme'
import { idleTimeoutFromEnv, SessionStore } from '../auth/session-store'
import { isProduction } from './config'
import {
  ALL_MODULES,
  BCRYPT_ROUNDS,
  BXI_CORE_ORG_SLUG,
  type defaultAdmin,
  INTERNAL_ADMIN_ACCOUNT_KEY,
  INTERNAL_ADMIN_USER_ID,
  PASSWORD_BOOTSTRAP_MARKER,
} from './constants'

export type SessionUser = Omit<typeof defaultAdmin, 'passwordHash' | 'createdAt'> & {
  createdAt?: string
  organizationId?: string
  organizationName?: string
  organizationSlug?: string
  organizationModules?: string[]
  isPlatformAdmin?: boolean
  accountType?: 'tenant' | 'platform'
  accountKey?: string
  mustChangePassword?: boolean
  lastLoginAt?: string
  theme?: string
  interfaceMode?: InterfaceMode | null
  clientThemes?: Record<string, string>
}

export type OrganizationInfo = {
  id: string
  name: string
  slug: string
  status: 'Active' | 'Suspended'
  enabledModules: string[]
}

// Sessions expire on the server (8 hours absolute, 2 hours idle by default), not only in the browser cookie.
export const sessions = new SessionStore<SessionUser>({
  idleTimeoutMs: idleTimeoutFromEnv(process.env.SESSION_IDLE_TIMEOUT_MINUTES),
})

// Legacy SHA-256 digest retained only for backward-compatible verification and
// as the browser-to-server pre-hash used by the existing Settings UI. Passwords
// stored by the server are bcrypt hashes of this digest.
export function passwordHash(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

export function isBcryptHash(value: unknown) {
  return /^\$2[aby]\$/.test(String(value || ''))
}

export function isLegacyDigest(value: unknown) {
  return /^[a-f0-9]{64}$/i.test(String(value || ''))
}

export function safeEqualText(left: string, right: string) {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function secureHashDigest(digest: string) {
  return bcrypt.hash(digest, BCRYPT_ROUNDS)
}

export async function secureHashPassword(plaintext: string) {
  return secureHashDigest(passwordHash(plaintext))
}

export async function verifyPassword(plaintext: string, storedHash: unknown) {
  const stored = String(storedHash || '')
  if (!stored || stored === PASSWORD_BOOTSTRAP_MARKER) return false
  const digest = passwordHash(plaintext)
  if (isBcryptHash(stored)) return bcrypt.compare(digest, stored)
  return isLegacyDigest(stored) && safeEqualText(digest.toLowerCase(), stored.toLowerCase())
}

export function bootstrapPasswordUsable(value: string) {
  return value.length >= 12 && !['admin', 'password', 'changeme'].includes(value.toLowerCase())
}

export function sessionCookie(token: string, maxAge: number) {
  return `ba_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${isProduction ? '; Secure' : ''}`
}

export function safeUser(account: any, organization?: OrganizationInfo | null): SessionUser {
  const role = account.role === 'Administrator' || account.role === 'Viewer' ? account.role : 'Contributor'
  const organizationModules = organization?.enabledModules?.filter(value => ALL_MODULES.includes(String(value))) || [
    ...ALL_MODULES,
  ]
  const accountModules = Array.isArray(account.modules)
    ? account.modules.filter((value: unknown) => ALL_MODULES.includes(String(value)))
    : []
  const modules =
    role === 'Administrator'
      ? [...organizationModules]
      : accountModules.filter((value: string) => organizationModules.includes(value))
  return {
    id: String(account.id),
    username: String(account.username || ''),
    name: String(account.name || account.username || 'User'),
    email: String(account.email || ''),
    phone: String(account.phone || ''),
    role,
    modules,
    theme: normalizeAppTheme(account.theme ?? account.raw_data?.theme),
    interfaceMode: normalizeInterfaceMode(
      account.interfaceMode === undefined ? account.raw_data?.interfaceMode : account.interfaceMode,
    ),
    clientThemes: normalizeClientThemes(account.clientThemes ?? account.raw_data?.clientThemes),
    status: account.status === 'Disabled' ? 'Disabled' : 'Active',
    createdAt: account.createdAt || account.created_on ? String(account.createdAt || account.created_on) : undefined,
    organizationId: organization?.id || (account.organization_id ? String(account.organization_id) : undefined),
    organizationName: organization?.name,
    organizationSlug: organization?.slug,
    organizationModules,
    isPlatformAdmin: false,
    accountType: 'tenant',
    accountKey: organization?.slug || BXI_CORE_ORG_SLUG,
    lastLoginAt: account.last_login_at
      ? String(account.last_login_at)
      : account.lastLoginAt
        ? String(account.lastLoginAt)
        : undefined,
  }
}

export function safePlatformUser(account: any): SessionUser {
  return {
    id: String(account.id || INTERNAL_ADMIN_USER_ID),
    username: String(account.username || 'admin'),
    name: String(account.name || 'Internal Administrator'),
    email: String(account.email || ''),
    phone: String(account.phone || ''),
    role: 'Administrator',
    modules: [],
    status: account.status === 'Disabled' ? 'Disabled' : 'Active',
    isPlatformAdmin: true,
    accountType: 'platform',
    accountKey: String(account.account_key || INTERNAL_ADMIN_ACCOUNT_KEY),
    mustChangePassword: Boolean(account.must_change_password),
    lastLoginAt: account.last_login_at ? String(account.last_login_at) : undefined,
  }
}

function parseCookies(header = '') {
  return Object.fromEntries(
    header
      .split(';')
      .map(part => part.trim())
      .filter(Boolean)
      .map(part => {
        const index = part.indexOf('=')
        return index < 0 ? [part, ''] : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))]
      }),
  )
}

export function sessionFromRequest(req: express.Request) {
  const token = parseCookies(req.headers.cookie || '').ba_session
  let user = token ? (sessions.get(token) ?? null) : null
  // Seeds decides who is in: someone no longer an active Seeds employee is signed out unless this password session
  // came in by a Seeds exception (Internal Admin is not a tenant).
  if (user && user.accountType !== 'platform' && !seedsStillAdmits(user, token)) {
    sessions.delete(token)
    forgetSeedsException(token)
    user = null
  }
  // Account Managers are Viewers of four pages while per-person visibility is on (see services/access-cache.ts).
  return token ? { token, user: user ? withAccess(user) : null } : { token: '', user: null }
}

export function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const { user } = sessionFromRequest(req)
  if (!user || user.status !== 'Active') {
    res.status(401).json({ error: 'Please sign in.' })
    return
  }
  ;(req as express.Request & { authUser?: SessionUser }).authUser = user
  next()
}

// accountChangesAreSelfOnly lives in ./services/account-guard so it can be unit tested without
// starting this server. The regression test there pins the privilege-escalation cases.

export function moduleAllowed(user: SessionUser, module: string) {
  return user.modules.includes(module)
}

export function requireTenantWorkspace(req: express.Request, res: express.Response, next: express.NextFunction) {
  const user = (req as express.Request & { authUser?: SessionUser }).authUser
  if (!user || user.accountType === 'platform' || !user.organizationId) {
    res.status(403).json({ error: 'A tenant workspace login is required for this action.' })
    return
  }
  next()
}
