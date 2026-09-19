import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { registerAccountUsers } from '../account-users'
import { normalizeClientThemes, themeForContext } from '../src/theme'

async function fixture(run: (f: any) => Promise<void>) {
  const account = (id: string, role: string) => ({ id, username: id, name: id, email: '', phone: '', role, modules: ['clients', 'items', 'reports'], status: 'Active', passwordHash: 'private-password-hash', createdAt: '2026-09-19', theme: 'blue-sky', clientThemes: {} })
  const states: any = {
    a: { clients: [{ id: 'client-a' }], items: [{ id: 'task-a' }], accounts: [account('admin-a', 'Administrator'), account('viewer-a', 'Viewer'), account('contributor-a', 'Contributor')] },
    b: { clients: [{ id: 'client-b' }], accounts: [account('admin-b', 'Administrator')] },
  }
  const sessions: any = Object.fromEntries(Object.entries(states).flatMap(([organizationId, state]: any) => state.accounts.map((a: any) => [a.id, { ...a, organizationId, accountType: 'tenant' }])))
  sessions.platform = { id: 'platform', accountType: 'platform', role: 'Administrator' }
  let failSave = false
  const app = express(); app.use(express.json())
  const auth: any = (req: any, res: any, next: any) => { req.authUser = sessions[req.get('x-user')]; return req.authUser ? next() : res.sendStatus(401) }
  const tenant: any = (req: any, res: any, next: any) => req.authUser.accountType === 'tenant' ? next() : res.sendStatus(403)
  registerAccountUsers(app, {
    requireAuth: auth, requireTenant: tenant,
    organizationById: async id => ({ id, status: 'Active', enabledModules: ['clients', 'items', 'reports', 'settings'] }),
    load: async id => ({ data: structuredClone(states[id]) }),
    commit: async (id, next) => { if (failSave) throw new Error('Database offline'); states[id] = structuredClone(next) },
    hashPassword: async password => `hashed:${password}`,
    refreshSessions: (id, user, _org, changed) => { if (sessions[user.id]?.organizationId === id) { if (changed || user.status === 'Disabled') delete sessions[user.id]; else sessions[user.id] = { ...sessions[user.id], ...user } } },
  })
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as any).port}`
  const call = async (path: string, user = 'admin-a', method = 'GET', body?: any) => {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', 'x-user': user }, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await response.text()
    let data: any; try { data = JSON.parse(text) } catch { data = text }
    return { status: response.status, data, text }
  }
  try { await run({ call, states, sessions, fail: () => { failSave = true } }) }
  finally { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())) }
}

test('account users API requires an active tenant administrator', async () => fixture(async ({ call }: any) => {
  assert.equal((await call('/api/account/users', 'missing')).status, 401)
  for (const user of ['platform', 'viewer-a', 'contributor-a']) {
    assert.equal((await call('/api/account/users', user)).status, 403)
    assert.equal((await call('/api/account/users', user, 'POST', {})).status, 403)
    assert.equal((await call('/api/account/users/admin-a', user, 'PATCH', { role: 'Viewer' })).status, 403)
  }
}))

test('create Contributor and Viewer in one tenant; duplicate usernames are scoped and passwords are never returned', async () => fixture(async ({ call, states }: any) => {
  for (const role of ['Contributor', 'Viewer']) {
    const otherTenantBefore = JSON.stringify(states.b)
    const body = { username: role, password: 'long-enough', role, modules: ['reports'], organizationId: 'b', isPlatformAdmin: true }
    const result = await call('/api/account/users', 'admin-a', 'POST', body)
    assert.equal(result.status, 200)
    assert(!result.text.includes('password')); assert(!result.text.includes('long-enough'))
    assert.equal(states.a.accounts.at(-1).passwordHash, 'hashed:long-enough')
    assert.equal(states.a.accounts.at(-1).isPlatformAdmin, undefined)
    assert.equal(JSON.stringify(states.b), otherTenantBefore)
    assert.equal((await call('/api/account/users', 'admin-a', 'POST', { ...body, username: role.toLowerCase() })).status, 409)
    assert.equal((await call('/api/account/users', 'admin-b', 'POST', body)).status, 200)
  }
  const listing = await call('/api/account/users')
  assert(!listing.text.includes('passwordHash')); assert(!listing.text.includes('admin-b'))
}))

test('module ceiling, role validation, tenant ownership and self-demotion guards', async () => fixture(async ({ call, states }: any) => {
  assert.equal((await call('/api/account/users/admin-b', 'admin-a', 'PATCH', { role: 'Viewer' })).status, 404)
  assert.equal((await call('/api/account/users/contributor-a', 'admin-a', 'PATCH', { modules: ['ai'] })).status, 400)
  assert.equal((await call('/api/account/users/contributor-a', 'admin-a', 'PATCH', { role: 'Superuser' })).status, 400)
  assert.equal((await call('/api/account/users/admin-a', 'admin-a', 'PATCH', { role: 'Viewer' })).status, 400)
  assert.equal((await call('/api/account/users/admin-a', 'admin-a', 'PATCH', { status: 'Disabled' })).status, 400)
  assert.equal(states.a.accounts[0].role, 'Administrator')
}))

test('role/module changes refresh sessions and disabling a user revokes access', async () => fixture(async ({ call, sessions }: any) => {
  assert.equal((await call('/api/account/users/contributor-a', 'admin-a', 'PATCH', { role: 'Viewer', modules: ['reports'] })).status, 200)
  assert.equal(sessions['contributor-a'].role, 'Viewer')
  assert.deepEqual(sessions['contributor-a'].modules, ['reports'])
  assert.equal((await call('/api/account/users/contributor-a', 'admin-a', 'PATCH', { status: 'Disabled' })).status, 200)
  assert.equal((await call('/api/account/profile', 'contributor-a', 'PATCH', { theme: 'busy-city' })).status, 401)
}))

test('Viewer personal and client themes persist independently by tenant/user/client', async () => fixture(async ({ call, states }: any) => {
  const original = structuredClone(states)
  assert.equal((await call('/api/account/profile', 'viewer-a', 'PATCH', { theme: 'dark-geek' })).status, 200)
  assert.equal((await call('/api/account/profile', 'viewer-a', 'PATCH', { clientId: 'client-a', clientTheme: 'busy-city' })).status, 200)
  const saved = JSON.parse(JSON.stringify(states.a.accounts[1]))
  assert.equal(themeForContext(saved), 'dark-geek')
  assert.equal(themeForContext(saved, 'client-a'), 'busy-city')
  assert.equal(themeForContext(saved, 'another-client'), 'dark-geek')
  assert.deepEqual(states.b, original.b)
  assert.deepEqual(states.a.accounts[0], original.a.accounts[0])
  assert.deepEqual(states.a.items, original.a.items)
  assert.equal((await call('/api/account/profile', 'viewer-a', 'PATCH', { clientId: 'client-a', clientTheme: null })).status, 200)
  assert.equal(themeForContext(states.a.accounts[1], 'client-a'), 'dark-geek')
}))

test('profile cannot grant access, target another user, or set another tenant client theme', async () => fixture(async ({ call }: any) => {
  for (const body of [{ role: 'Administrator' }, { modules: ['settings'] }, { id: 'admin-a' }, { organizationId: 'b' }, { clientThemes: { 'client-b': 'busy-city' } }]) assert.equal((await call('/api/account/profile', 'viewer-a', 'PATCH', body)).status, 403)
  assert.equal((await call('/api/account/profile', 'viewer-a', 'PATCH', { clientId: 'client-b', clientTheme: 'busy-city' })).status, 404)
  assert.equal((await call('/api/account/profile', 'viewer-a', 'PATCH', { theme: 'invalid' })).status, 400)
}))

test('failed database writes report failure, preserve data and keep sessions unchanged', async () => fixture(async ({ call, states, sessions, fail }: any) => {
  const before = JSON.stringify({ states, sessions }); fail()
  assert.equal((await call('/api/account/profile', 'viewer-a', 'PATCH', { theme: 'busy-city' })).status, 500)
  assert.equal((await call('/api/account/users/viewer-a', 'admin-a', 'PATCH', { status: 'Disabled' })).status, 500)
  assert.equal(JSON.stringify({ states, sessions }), before)
}))

test('concurrent user updates retain both changes and password change invalidates sessions', async () => fixture(async ({ call, states, sessions }: any) => {
  const results = await Promise.all([
    call('/api/account/profile', 'viewer-a', 'PATCH', { theme: 'green-grass' }),
    call('/api/account/profile', 'contributor-a', 'PATCH', { theme: 'calm-mountain' }),
  ])
  assert(results.every((r: any) => r.status === 200))
  assert.equal(states.a.accounts[1].theme, 'green-grass')
  assert.equal(states.a.accounts[2].theme, 'calm-mountain')
  assert.equal((await call('/api/account/profile', 'viewer-a', 'PATCH', { newPassword: 'replacement-password' })).status, 200)
  assert.equal(sessions['viewer-a'], undefined)
}))

test('theme normalization retains existing personal theme and ignores invalid overrides', () => {
  assert.deepEqual(normalizeClientThemes({ a: 'dark-geek', b: 'invalid', c: 7 }), { a: 'dark-geek' })
  assert.equal(themeForContext({ theme: 'blue-sky' }, 'client-a'), 'blue-sky')
  assert.equal(themeForContext({}, 'client-a'), 'default')
})
