// The task timer, kept per person on the server (see src/features/tasks/timer.ts for how a timer works). One row per
// person in user_task_timers, holding their timers as JSON: a read is one small query by primary key, and nothing
// runs between reads, so a timer costs the server nothing while it runs.
import type express from 'express'
import type { Express, RequestHandler } from 'express'
import rateLimit from 'express-rate-limit'
import { requireAuth, requireTenantWorkspace, type SessionUser } from '../core/auth'
import { followUpTimeZone } from '../core/config'
import { tenantIdForUser } from '../core/tenant-state'
import { dateKeyInTimeZone } from '../services/follow-up-rollover'
import {
  cleanTimers,
  clearTimerDay,
  pauseTimer,
  startTimer,
  stopTimer,
  type TaskTimer,
  type TimerChange,
} from '../../src/features/tasks/timer'

export type TimerStore = {
  read: (tenant: string, userId: string) => Promise<TaskTimer[]>
  write: (tenant: string, userId: string, timers: TaskTimer[]) => Promise<void>
}

export class TimerError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message)
  }
}
const UNAVAILABLE = 'Timers are unavailable. An existing database needs database/migrations/schema-v39-task-timers.sql.'

export function createTimerStore(db: any): TimerStore {
  const table = () => {
    if (!db) throw new TimerError(UNAVAILABLE, 503)
    return db.from('user_task_timers')
  }
  return {
    async read(tenant, userId) {
      const r = await table().select('timers').eq('tenant_id', tenant).eq('user_id', userId).maybeSingle()
      if (r.error) throw new TimerError(UNAVAILABLE, 503)
      return cleanTimers(r.data?.timers)
    },
    async write(tenant, userId, timers) {
      const r = await table().upsert(
        { tenant_id: tenant, user_id: userId, timers: cleanTimers(timers), updated_at: new Date().toISOString() },
        { onConflict: 'tenant_id,user_id' },
      )
      if (r.error) throw new TimerError(UNAVAILABLE, 503)
    },
  }
}

/** The business date of a moment, as the rest of the app counts days. */
export const businessDayOf =
  (timeZone = followUpTimeZone) =>
  (ms: number) =>
    dateKeyInTimeZone(new Date(ms), timeZone)

/**
 * A person's own timers: read them, start, pause or stop one, and take a day's time out of a stopped one once it is
 * logged or thrown away. A timer changes no task: the time becomes an entry only when the person saves it.
 */
export function registerTimerRoutes(
  app: Express,
  deps: { store: TimerStore; auth?: RequestHandler[]; now?: () => Date; dayOf?: (ms: number) => string },
) {
  const auth = deps.auth || [requireAuth, requireTenantWorkspace]
  const now = deps.now || (() => new Date())
  const dayOf = deps.dayOf || businessDayOf()
  const who = (req: express.Request) => (req as express.Request & { authUser: SessionUser }).authUser
  const tenantOf = (user: SessionUser) => String(tenantIdForUser(user))
  const limit = rateLimit({
    windowMs: 60_000,
    limit: 60,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: req => `${who(req)?.organizationId || ''}:${who(req)?.id || ''}`,
    message: { error: 'Too many timer changes in a minute. Wait a moment and try again.' },
  })
  const wrap =
    (handler: (req: express.Request, res: express.Response) => Promise<void>): RequestHandler =>
    async (req, res) => {
      try {
        if (who(req).role === 'Viewer') throw new TimerError('Viewers cannot log time.', 403)
        await handler(req, res)
      } catch (error) {
        if (error instanceof TimerError) return void res.status(error.status).json({ error: error.message })
        console.error('Timer request failed.')
        res.status(500).json({ error: 'The timer could not be changed. Try again.' })
      }
    }
  const taskIdOf = (req: express.Request) => {
    const id = String(req.params.taskId || '').slice(0, 80)
    if (!id) throw new TimerError('Which task?')
    return id
  }
  const change = (work: (timers: TaskTimer[], taskId: string, req: express.Request) => TimerChange) =>
    wrap(async (req, res) => {
      const user = who(req)
      const timers = await deps.store.read(tenantOf(user), user.id)
      const result = work(timers, taskIdOf(req), req)
      if (result.problem) throw new TimerError(result.problem, 409)
      await deps.store.write(tenantOf(user), user.id, result.timers)
      res.json({ timers: result.timers, now: now().toISOString() })
    })

  app.get(
    '/api/timers',
    ...auth,
    limit,
    wrap(async (req, res) => {
      const user = who(req)
      res.json({ timers: await deps.store.read(tenantOf(user), user.id), now: now().toISOString() })
    }),
  )
  app.post(
    '/api/timers/:taskId/start',
    ...auth,
    limit,
    change((timers, id) => startTimer(timers, id, now().toISOString())),
  )
  app.post(
    '/api/timers/:taskId/pause',
    ...auth,
    limit,
    change((timers, id) => pauseTimer(timers, id, now().toISOString())),
  )
  app.post(
    '/api/timers/:taskId/stop',
    ...auth,
    limit,
    change((timers, id) => stopTimer(timers, id, now().toISOString())),
  )
  app.post(
    '/api/timers/:taskId/clear',
    ...auth,
    limit,
    change((timers, id, req) => {
      const date = String(req.body?.date || '')
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new TimerError('Which day?')
      return clearTimerDay(timers, id, date, dayOf)
    }),
  )
  app.delete(
    '/api/timers/:taskId',
    ...auth,
    limit,
    change((timers, id) => ({ timers: timers.filter(timer => timer.taskId !== id) })),
  )
}
