import assert from 'node:assert/strict'
import { test } from 'node:test'
import express from 'express'
import {
  PreferenceError,
  type PreferenceStore,
  registerActionCenterRoutes,
} from '../server/workspace/action-center-routes'

const people: Record<string, any> = {
  ana: { id: 'ana', role: 'Contributor', organizationId: 'org' },
  boss: { id: 'boss', role: 'Administrator', organizationId: 'org' },
}

async function serve(store: PreferenceStore, workspace: { data: any }) {
  const app = express()
  app.use(express.json())
  const auth = [
    (req: any, res: any, next: any) => {
      req.authUser = people[String(req.headers['x-test-user'] || '')]
      if (!req.authUser) return void res.status(401).json({ error: 'Sign in.' })
      next()
    },
  ]
  registerActionCenterRoutes(app, {
    store,
    auth,
    load: async () => workspace,
    commit: async (_org, next) => void (workspace.data = next),
  })
  const server = app.listen(0)
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No port')
  const ask = async (method: string, path: string, as: string, body?: any) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-test-user': as },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: response.status, body: await response.json().catch(() => ({})) }
  }
  return { ask, close: () => server.close() }
}

test('each person keeps their own layout; an Administrator sets a role’s starting layout', async () => {
  const kept = new Map<string, Record<string, unknown>>()
  const store: PreferenceStore = {
    read: async (tenant, userId) => kept.get(`${tenant}:${userId}`) || {},
    write: async (tenant, userId, prefs) => void kept.set(`${tenant}:${userId}`, prefs),
  }
  const workspace = { data: { accounts: [{ id: 'ana', jobRoles: ['QA'] }] } }
  const { ask, close } = await serve(store, workspace)
  try {
    assert.deepEqual((await ask('GET', '/api/me/action-center', 'ana')).body, { own: null, role: null, stored: true })

    // Only an Administrator saves a role's starting layout.
    const layout = [{ id: 'dochub', width: 'half' }]
    assert.equal((await ask('PUT', '/api/account/roles/QA/action-center', 'ana', { layout })).status, 403)
    assert.equal((await ask('PUT', '/api/account/roles/NOPE/action-center', 'boss', { layout })).status, 404)
    assert.equal((await ask('PUT', '/api/account/roles/QA/action-center', 'boss', { layout })).status, 200)
    const withRole = (await ask('GET', '/api/me/action-center', 'ana')).body
    assert.equal(withRole.role.id, 'QA')
    assert.deepEqual(withRole.role.layout, layout)

    // Ana's own layout, then back to the role's.
    const mine = [{ id: 'workhub', width: 'full' }]
    assert.deepEqual((await ask('PUT', '/api/me/action-center', 'ana', { layout: mine })).body.own, mine)
    assert.deepEqual((await ask('GET', '/api/me/action-center', 'ana')).body.own, mine)
    assert.equal((await ask('PUT', '/api/me/action-center', 'ana', { layout: 'all' })).status, 400)
    await ask('PUT', '/api/me/action-center', 'ana', { layout: null })
    assert.equal((await ask('GET', '/api/me/action-center', 'ana')).body.own, null)
    assert.deepEqual((await ask('GET', '/api/me/action-center', 'boss')).body.own, null, 'Not shared between people')
  } finally {
    close()
  }
})

test('before schema v40, the page still loads and the layout stays in the browser', async () => {
  const store: PreferenceStore = {
    read: async () => {
      throw new PreferenceError('missing', 503)
    },
    write: async () => {
      throw new PreferenceError('missing', 503)
    },
  }
  const { ask, close } = await serve(store, { data: {} })
  try {
    assert.deepEqual((await ask('GET', '/api/me/action-center', 'ana')).body, { own: null, role: null, stored: false })
    assert.equal((await ask('PUT', '/api/me/action-center', 'ana', { layout: [] })).status, 503)
  } finally {
    close()
  }
})
