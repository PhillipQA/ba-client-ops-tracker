// Each person's saved Tasks views (a name, filters and a layout), kept in their user_preferences row under
// `taskViews`, so they follow the person to any browser. Until schema v40 is run there is nowhere to keep them: the
// browser then keeps them itself (see src/features/tasks/useSavedTaskViews.ts).
import type express from 'express'
import type { Express, RequestHandler } from 'express'
import rateLimit from 'express-rate-limit'
import { requireAuth, requireTenantWorkspace, type SessionUser } from '../core/auth'
import { tenantIdForUser } from '../core/tenant-state'
import { cleanSavedViews } from '../../src/features/tasks/taskViews'
import { PreferenceError, type PreferenceStore } from './action-center-routes'

export function registerTaskViewRoutes(app: Express, deps: { store: PreferenceStore; auth?: RequestHandler[] }) {
  const auth = deps.auth || [requireAuth, requireTenantWorkspace]
  const who = (req: express.Request) => (req as express.Request & { authUser: SessionUser }).authUser
  const limit = rateLimit({
    windowMs: 60_000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: req => `${who(req)?.organizationId || ''}:${who(req)?.id || ''}`,
    message: { error: 'Too many changes to your views in a minute. Wait a moment and try again.' },
  })
  const wrap =
    (handler: (req: express.Request, res: express.Response) => Promise<void>): RequestHandler =>
    async (req, res) => {
      res.setHeader('Cache-Control', 'no-store')
      try {
        await handler(req, res)
      } catch (error: any) {
        const status = error instanceof PreferenceError ? error.status : 0
        if (!status) console.error('Saved Tasks views request failed.')
        res.status(status || 500).json({ error: status ? error.message : 'Your views could not be saved. Try again.' })
      }
    }

  app.get(
    '/api/me/task-views',
    ...auth,
    wrap(async (req, res) => {
      const user = who(req)
      try {
        const prefs = await deps.store.read(String(tenantIdForUser(user)), String(user.id))
        res.json({ views: cleanSavedViews(prefs.taskViews), stored: true })
      } catch (error) {
        if (!(error instanceof PreferenceError)) throw error
        res.json({ views: [], stored: false })
      }
    }),
  )
  app.put(
    '/api/me/task-views',
    ...auth,
    limit,
    wrap(async (req, res) => {
      const user = who(req)
      if (!Array.isArray(req.body?.views)) throw new PreferenceError('Send your views as a list.')
      const views = cleanSavedViews(req.body.views)
      const tenant = String(tenantIdForUser(user))
      const { taskViews: _old, ...rest } = await deps.store.read(tenant, String(user.id))
      await deps.store.write(tenant, String(user.id), views.length ? { ...rest, taskViews: views } : rest)
      res.json({ views, stored: true })
    }),
  )
}
