import type { Express, Request, RequestHandler } from 'express'
import { randomUUID } from 'node:crypto'
import { normalizeAppTheme, THEME_IDS } from './src/theme'

type Dependencies = {
  requireAuth: RequestHandler
  requireTenant: RequestHandler
  organizationById: (id: string) => Promise<any>
  load: (id: string) => Promise<any>
  commit: (id: string, next: any, actor: any, reason: string, before: any) => Promise<any>
  hashPassword: (password: string) => Promise<string>
  refreshSessions: (id: string, account: any, organization: any, passwordChanged: boolean) => void
}
class AccountError extends Error {
  constructor(message: string, public status = 400) { super(message) }
}
const roles = ['Administrator', 'Contributor', 'Viewer']
// Deliberately return only public fields, never stored password material.
export function publicAccount(account: any) {
  return Object.fromEntries(['id', 'username', 'name', 'email', 'phone', 'role', 'modules', 'status', 'createdAt', 'theme', 'clientThemes'].map(key => [key, account[key]]))
}
export function registerAccountUsers(app: Express, deps: Dependencies) {
  const queues = new Map<string, Promise<unknown>>()
  const actor = (req: Request): any => (req as any).authUser
  const route = (admin: boolean, operation: (req: Request, user: any, organization: any, state: any) => Promise<any>): RequestHandler => async (req, res) => {
    const user = actor(req)
    const id = user.organizationId
    const previous = queues.get(id) || Promise.resolve()
    const work = previous.catch(() => {}).then(async () => {
      const organization = await deps.organizationById(id)
      if (!organization || organization.status !== 'Active') throw new AccountError('This account is unavailable.', 403)
      const state = (await deps.load(id)).data
      if (!state) throw new AccountError('Account data is unavailable. Try again.', 503)
      const current = state.accounts.find((a: any) => a.id === user.id && a.status === 'Active')
      if (!current) throw new AccountError('Sign in again.', 401)
      if (admin && current.role !== 'Administrator') throw new AccountError('Only account Administrators can manage users and permissions.', 403)
      return operation(req, { ...user, role: current.role }, organization, state)
    })
    queues.set(id, work)
    try { res.json(await work) }
    catch (error: any) { res.status(error.status || 500).json({ error: error.status ? error.message : 'Could not save account changes. Please retry.' }) }
    finally { if (queues.get(id) === work) queues.delete(id) }
  }
  const middleware = [deps.requireAuth, deps.requireTenant]
  const save = async (organization: any, state: any, account: any, user: any, passwordChanged = false) => {
    const exists = state.accounts.some((a: any) => a.id === account.id)
    const accounts = exists ? state.accounts.map((a: any) => a.id === account.id ? account : a) : [...state.accounts, account]
    await deps.commit(organization.id, { ...state, accounts }, user, 'account-user-settings', state)
    deps.refreshSessions(organization.id, account, organization, passwordChanged)
    return { user: publicAccount(account) }
  }
  const fields = (body: any, base: any) => {
    const next = { ...base }
    for (const key of ['name', 'email', 'phone']) if (body[key] !== undefined) {
      if (typeof body[key] !== 'string' || body[key].length > 254) throw new AccountError(`Invalid ${key}.`)
      next[key] = body[key].trim()
    }
    if (!next.name) throw new AccountError('Display name is required.')
    if (next.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next.email)) throw new AccountError('Enter a valid email address.')
    return next
  }
  const access = (body: any, base: any, organization: any) => {
    const role = body.role ?? base.role
    const status = body.status ?? base.status
    if (!roles.includes(role) || !['Active', 'Disabled'].includes(status)) throw new AccountError('Choose a valid role and status.')
    const modules = body.modules ?? base.modules
    if (!Array.isArray(modules) || modules.some((m: any) => !organization.enabledModules.includes(m))) throw new AccountError('Only modules enabled for this account can be assigned.')
    return { ...fields(body, base), role, status, modules: role === 'Administrator' ? [...organization.enabledModules] : [...new Set(modules)] }
  }
  app.get('/api/account/users', ...middleware, route(true, async (_req, _user, organization, state) => ({ users: state.accounts.map(publicAccount), enabledModules: organization.enabledModules })))
  app.post('/api/account/users', ...middleware, route(true, async (req, user, organization, state) => {
    const body = req.body || {}
    const username = typeof body.username === 'string' ? body.username.trim() : ''
    if (!username || username.length > 100) throw new AccountError('Enter a username of 1–100 characters.')
    if (state.accounts.some((a: any) => a.username.toLowerCase() === username.toLowerCase())) throw new AccountError('That username is already used in this account.', 409)
    if (typeof body.password !== 'string' || body.password.length < 8 || body.password.length > 256) throw new AccountError('Use a password of 8–256 characters.')
    const account = access(body, { id: randomUUID(), username, name: username, email: '', phone: '', role: 'Contributor', status: 'Active', modules: [], createdAt: new Date().toISOString().slice(0, 10), theme: 'default', clientThemes: {} }, organization)
    account.passwordHash = await deps.hashPassword(body.password)
    return save(organization, state, account, user)
  }))
  app.patch('/api/account/users/:userId', ...middleware, route(true, async (req, user, organization, state) => {
    const existing = state.accounts.find((a: any) => a.id === req.params.userId)
    if (!existing) throw new AccountError('User was not found in this account.', 404)
    const account = access(req.body || {}, existing, organization)
    const losesAdmin = account.role !== 'Administrator' || account.status !== 'Active'
    if (existing.id === user.id && losesAdmin) throw new AccountError('You cannot disable or demote your own signed-in user.')
    if (existing.role === 'Administrator' && existing.status === 'Active' && losesAdmin && !state.accounts.some((a: any) => a.id !== existing.id && a.role === 'Administrator' && a.status === 'Active')) throw new AccountError('Keep at least one active Administrator.')
    return save(organization, state, account, user)
  }))
  app.patch('/api/account/profile', ...middleware, route(false, async (req, user, organization, state) => {
    const body = req.body || {}
    if (Object.keys(body).some(key => !['name', 'email', 'phone', 'theme', 'clientId', 'clientTheme', 'newPassword'].includes(key))) throw new AccountError('Only your own profile and theme preferences can be changed.', 403)
    const existing = state.accounts.find((a: any) => a.id === user.id)
    const account = fields(body, existing)
    if (body.theme !== undefined) {
      if (!THEME_IDS.has(body.theme)) throw new AccountError('Choose a valid theme.')
      account.theme = normalizeAppTheme(body.theme)
    }
    if (body.clientId !== undefined || body.clientTheme !== undefined) {
      if (typeof body.clientId !== 'string' || !state.clients.some((c: any) => c.id === body.clientId)) throw new AccountError('Client was not found in this account.', 404)
      if (body.clientTheme !== null && !THEME_IDS.has(body.clientTheme)) throw new AccountError('Choose a valid client theme.')
      account.clientThemes = { ...(existing.clientThemes || {}) }
      if (body.clientTheme === null) delete account.clientThemes[body.clientId]
      else Object.defineProperty(account.clientThemes, body.clientId, { value: body.clientTheme, enumerable: true, configurable: true, writable: true })
    }
    if (body.newPassword !== undefined) {
      if (typeof body.newPassword !== 'string' || body.newPassword.length < 8 || body.newPassword.length > 256) throw new AccountError('Use a password of 8–256 characters.')
      account.passwordHash = await deps.hashPassword(body.newPassword)
    }
    return save(organization, state, account, user, body.newPassword !== undefined)
  }))
}
