import type { AppModule, UserRole } from './types'

export interface AuthUser {
  id: string
  username: string
  name: string
  email: string
  phone: string
  role: UserRole
  modules: AppModule[]
  status: 'Active' | 'Disabled'
}

export async function hashPassword(value: string) {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function authRequest(path: string, options?: RequestInit) {
  const response = await fetch(path, {
    ...options,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options?.headers || {}) },
  })
  const body = await response.json().catch(() => ({}))
  return { response, body }
}

export async function getAuthSession(): Promise<AuthUser | null> {
  const { response, body } = await authRequest('/api/auth/session')
  if (response.status === 401) return null
  if (!response.ok) throw new Error(body.error || 'Could not check login session.')
  return (body.user ?? null) as AuthUser | null
}

export async function login(username: string, password: string): Promise<AuthUser> {
  const { response, body } = await authRequest('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  })
  if (!response.ok) throw new Error(body.error || 'Login failed.')
  return body.user as AuthUser
}

export async function logout() {
  await authRequest('/api/auth/logout', { method: 'POST', body: '{}' })
}
