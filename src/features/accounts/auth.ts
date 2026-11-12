import type { AppTheme } from '../settings/theme'
import type { InterfaceMode } from '../settings/appearance'
import type { AppModule, UserRole } from '../../shared/types'

export interface AuthUser {
  id: string
  username: string
  name: string
  email: string
  phone: string
  role: UserRole
  modules: AppModule[]
  status: 'Active' | 'Disabled'
  organizationId?: string
  organizationName?: string
  organizationSlug?: string
  organizationModules?: AppModule[]
  isPlatformAdmin?: boolean
  accountType?: 'tenant' | 'platform'
  accountKey?: string
  mustChangePassword?: boolean
  theme?: AppTheme
  interfaceMode?: InterfaceMode | null
  clientThemes?: Record<string, AppTheme>
  lastLoginAt?: string
}

export async function hashPassword(value: string) {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
}

async function authRequest(path: string, options?: RequestInit) {
  const requestId = crypto.randomUUID()
  const headers = new Headers(options?.headers)
  headers.set('Content-Type', 'application/json')
  headers.set('X-Auth-Request-Id', requestId)
  try {
    const response = await fetch(path, {
      ...options,
      credentials: 'same-origin',
      cache: 'no-store',
      headers,
    })
    // The connection can also close while receiving the response body.
    const text = await response.text()
    let body: any = {}
    try {
      const parsed: unknown = JSON.parse(text)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed
    } catch {
      /* A proxy can return HTML. Use the HTTP fallback below. */
    }
    return { response, body, requestId }
  } catch {
    console.warn('Authentication connection interrupted', { requestId, path })
    throw new Error(`The connection was interrupted. Please try again. Reference: ${requestId}`)
  }
}

export async function getAuthSession(): Promise<AuthUser | null> {
  const { response, body } = await authRequest('/api/auth/session')
  if (response.status === 401) return null
  if (!response.ok) throw new Error(body.error || 'Could not check login session.')
  return (body.user ?? null) as AuthUser | null
}

export async function login(account: string, username: string, password: string): Promise<AuthUser> {
  const { response, body, requestId } = await authRequest('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ account, username, password }),
  })
  if (!response.ok) throw new Error(body.error || `Login failed (HTTP ${response.status}). Reference: ${requestId}`)
  if (!body.user || typeof body.user.id !== 'string')
    throw new Error(
      `The server returned an incomplete login response. Please refresh and try again. Reference: ${requestId}`,
    )
  return body.user as AuthUser
}

/** The Google client ID for Sign in with Google, or '' when it is not set up. */
export async function googleSignInClientId(): Promise<string> {
  try {
    const { response, body } = await authRequest('/api/auth/google')
    return response.ok && typeof body.clientId === 'string' ? body.clientId : ''
  } catch {
    return ''
  }
}

export type GoogleAccountChoice = { name: string; slug: string }

/**
 * Signs in with a Google ID token. When the email is registered in several accounts, the answer is the accounts to
 * choose from; call again with the chosen one.
 */
export async function loginWithGoogle(
  credential: string,
  account?: string,
): Promise<{ user: AuthUser } | { accounts: GoogleAccountChoice[] }> {
  const { response, body, requestId } = await authRequest('/api/auth/google', {
    method: 'POST',
    body: JSON.stringify({ credential, ...(account ? { account } : {}) }),
  })
  if (response.status === 409 && Array.isArray(body.accounts) && body.accounts.length)
    return { accounts: body.accounts as GoogleAccountChoice[] }
  if (!response.ok)
    throw new Error(body.error || `Sign in with Google failed (HTTP ${response.status}). Reference: ${requestId}`)
  if (!body.user || typeof body.user.id !== 'string')
    throw new Error(`The server returned an incomplete login response. Please try again. Reference: ${requestId}`)
  return { user: body.user as AuthUser }
}

export async function logout() {
  const { response, body, requestId } = await authRequest('/api/auth/logout', { method: 'POST', body: '{}' })
  // An expired/revoked session is already signed out. Show other failures.
  if (response.status === 401) return
  if (!response.ok || body.ok !== true)
    throw new Error(body.error || `Sign out could not be confirmed (HTTP ${response.status}). Reference: ${requestId}`)
}
