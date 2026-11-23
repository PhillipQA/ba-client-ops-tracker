import assert from 'node:assert/strict'
import test from 'node:test'
import { PreferenceError, type PreferenceStore } from '../server/workspace/action-center-routes'
import { registerTaskViewRoutes } from '../server/workspace/task-view-routes'

/** Captures the routes and calls their last handler (after auth and rate limiting) directly. */
function harness(store: PreferenceStore) {
  const routes = new Map<string, any>()
  const app: any = {
    get: (path: string, ...handlers: any[]) => routes.set(`GET ${path}`, handlers.at(-1)),
    put: (path: string, ...handlers: any[]) => routes.set(`PUT ${path}`, handlers.at(-1)),
  }
  registerTaskViewRoutes(app, { store, auth: [] })
  const call = async (key: string, body?: unknown) => {
    const result: { status: number; body?: any } = { status: 200 }
    const res: any = {
      setHeader: () => {},
      status: (code: number) => {
        result.status = code
        return res
      },
      json: (value: unknown) => {
        result.body = value
        return res
      },
    }
    await routes.get(key)({ body, authUser: { id: 'u1', organizationId: 'org1' } }, res)
    return result
  }
  return { call }
}

test('saved views are kept in your preferences, beside the Action Center layout', async () => {
  let prefs: Record<string, unknown> = { actionCenter: [{ id: 'w1' }] }
  const store: PreferenceStore = {
    read: async () => structuredClone(prefs),
    write: async (_tenant, _user, next) => {
      prefs = structuredClone(next)
    },
  }
  const { call } = harness(store)
  assert.deepEqual((await call('GET /api/me/task-views')).body, { views: [], stored: true })
  const saved = await call('PUT /api/me/task-views', {
    views: [{ id: 'v1', name: 'Overdue', layout: 'calendar', filters: { date: 'overdue' } }, { name: 'bad' }],
  })
  assert.equal(saved.status, 200)
  assert.equal(saved.body.views.length, 1)
  assert.equal(saved.body.views[0].layout, 'calendar')
  assert.deepEqual(prefs.actionCenter, [{ id: 'w1' }], 'other preferences are kept')
  assert.equal((await call('GET /api/me/task-views')).body.views[0].name, 'Overdue')
  await call('PUT /api/me/task-views', { views: [] })
  assert.equal('taskViews' in prefs, false, 'an empty list removes the entry')
  assert.equal((await call('PUT /api/me/task-views', { views: 'x' })).status, 400)
})

test('without schema v40 the browser keeps the views: the server says so', async () => {
  const store: PreferenceStore = {
    read: async () => {
      throw new PreferenceError('unavailable', 503)
    },
    write: async () => {
      throw new PreferenceError('unavailable', 503)
    },
  }
  const { call } = harness(store)
  assert.deepEqual((await call('GET /api/me/task-views')).body, { views: [], stored: false })
  assert.equal((await call('PUT /api/me/task-views', { views: [] })).status, 503)
})
