// The Action Center layout: each person's own, kept in user_preferences (one row per person, JSON), and a job role's
// starting layout, kept on the role in the workspace (Settings › Roles). See src/shared/actionCenterLayout.ts.
// Until schema v40 is run, a person's own layout lives only in their browser; role layouts work either way.
import type express from 'express'
import type { Express, RequestHandler } from 'express'
import rateLimit from 'express-rate-limit'
import { requireAuth, requireTenantWorkspace, type SessionUser } from '../core/auth'
import { tenantIdForUser } from '../core/tenant-state'
import { type ActionCenterLayout, cleanLayout } from '../../src/shared/actionCenterLayout'
import { personRoles } from '../../src/shared/access'
import { cleanJobRole, jobRoles } from '../../src/shared/roles'

export type PreferenceStore = {
  read: (tenant: string, userId: string) => Promise<Record<string, unknown>>
  write: (tenant: string, userId: string, prefs: Record<string, unknown>) => Promise<void>
}

export class PreferenceError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message)
  }
}
const UNAVAILABLE =
  'Your layout is kept in this browser only. An existing database needs database/migrations/schema-v40-user-preferences.sql.'

export function createPreferenceStore(db: any): PreferenceStore {
  const table = () => {
    if (!db) throw new PreferenceError(UNAVAILABLE, 503)
    return db.from('user_preferences')
  }
  return {
    read: async (tenant, userId) => {
      const r = await table().select('prefs').eq('tenant_id', tenant).eq('user_id', userId).maybeSingle()
      if (r.error) throw new PreferenceError(UNAVAILABLE, 503)
      const prefs = r.data?.prefs
      return prefs && typeof prefs === 'object' && !Array.isArray(prefs) ? prefs : {}
    },
    write: async (tenant, userId, prefs) => {
      const r = await table().upsert(
        { tenant_id: tenant, user_id: userId, prefs, updated_at: new Date().toISOString() },
        { onConflict: 'tenant_id,user_id' },
      )
      if (r.error) throw new PreferenceError(UNAVAILABLE, 503)
    },
  }
}

/** The starting layout of the first of a person's roles that has one. */
export function roleLayoutFor(state: any, userId: string) {
  const mine = new Set(personRoles(state, userId))
  const role = jobRoles(state).find(candidate => mine.has(candidate.id) && candidate.actionCenter)
  return role ? { id: role.id, name: role.name, layout: role.actionCenter as ActionCenterLayout } : null
}

export function registerActionCenterRoutes(
  app: Express,
  deps: {
    store: PreferenceStore
    load: (organizationId: string) => Promise<{ data: any }>
    commit?: (organizationId: string, state: any, actor: any, reason: string, before: any) => Promise<unknown>
    auth?: RequestHandler[]
  },
) {
  const auth = deps.auth || [requireAuth, requireTenantWorkspace]
  const who = (req: express.Request) => (req as express.Request & { authUser: SessionUser }).authUser
  const limit = rateLimit({
    windowMs: 60_000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: req => `${who(req)?.organizationId || ''}:${who(req)?.id || ''}`,
    message: { error: 'Too many layout changes in a minute. Wait a moment and try again.' },
  })
  const wrap =
    (handler: (req: express.Request, res: express.Response) => Promise<void>): RequestHandler =>
    async (req, res) => {
      res.setHeader('Cache-Control', 'no-store')
      try {
        await handler(req, res)
      } catch (error: any) {
        const status = error instanceof PreferenceError ? error.status : Number(error?.status) || 0
        if (!status) console.error('Action Center layout request failed.')
        res.status(status || 500).json({ error: status ? error.message : 'The layout could not be saved. Try again.' })
      }
    }
  /** A layout from the request: a list, or null to go back to the role's (or built-in) layout. */
  const layoutOf = (req: express.Request) => {
    if (req.body?.layout === null) return null
    const layout = cleanLayout(req.body?.layout)
    if (!layout) throw new PreferenceError('Send the layout as a list of widgets, or null to reset it.')
    return layout
  }

  app.get(
    '/api/me/action-center',
    ...auth,
    wrap(async (req, res) => {
      const user = who(req)
      const role = roleLayoutFor((await deps.load(user.organizationId)).data, String(user.id))
      try {
        const prefs = await deps.store.read(String(tenantIdForUser(user)), String(user.id))
        res.json({ own: cleanLayout(prefs.actionCenter) ?? null, role, stored: true })
      } catch (error) {
        if (!(error instanceof PreferenceError)) throw error
        res.json({ own: null, role, stored: false })
      }
    }),
  )
  app.put(
    '/api/me/action-center',
    ...auth,
    limit,
    wrap(async (req, res) => {
      const user = who(req)
      const layout = layoutOf(req)
      const tenant = String(tenantIdForUser(user))
      const { actionCenter: _old, ...rest } = await deps.store.read(tenant, String(user.id))
      await deps.store.write(tenant, String(user.id), layout ? { ...rest, actionCenter: layout } : rest)
      res.json({ own: layout })
    }),
  )
  // An Administrator saves a layout as a role's starting layout (null takes it off the role).
  app.put(
    '/api/account/roles/:roleId/action-center',
    ...auth,
    limit,
    wrap(async (req, res) => {
      const user = who(req)
      if (user.role !== 'Administrator')
        throw new PreferenceError('Only Administrators set a role’s starting layout.', 403)
      if (!deps.commit) throw new PreferenceError('Role layouts are unavailable.', 503)
      const layout = layoutOf(req)
      const state = await deps.load(user.organizationId)
      if (!state.data) throw new PreferenceError('This account has no saved workspace yet.', 409)
      const roleId = String(req.params.roleId || '')
      const roles = jobRoles(state.data)
      if (!roles.some(role => role.id === roleId)) throw new PreferenceError('That role no longer exists.', 404)
      const next = {
        ...state.data,
        jobRoles: roles
          .map(role => {
            if (role.id !== roleId) return role
            const { actionCenter: _old, ...rest } = role
            return layout ? { ...rest, actionCenter: layout } : rest
          })
          .map(cleanJobRole),
      }
      await deps.commit(user.organizationId, next, user, 'account-role-layout', state.data)
      res.json({ role: roleLayoutFor(next, String(user.id)), roles: jobRoles(next) })
    }),
  )
}
