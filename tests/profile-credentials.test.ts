import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { registerAccountUsers } from '../server/accounts/account-users'

// Changing your email address or password from My profile must prove you know the current password.
async function fixture(run: (f: any) => Promise<void>) {
  const account = (id: string) => ({ id, username: id, name: id, email: '', phone: '', role: 'Contributor', modules: ['items'], status: 'Active', passwordHash: `stored-${id}`, createdAt: '2026-09-19', theme: 'default' })
  const state: any = { clients: [], items: [], accounts: [account('maria'), account('carlo')] }
  const sessions: any = { maria: { ...account('maria'), organizationId: 'org', accountType: 'tenant' }, carlo: { ...account('carlo'), organizationId: 'org', accountType: 'tenant' } }
  const app = express(); app.use(express.json())
  const auth: any = (req: any, res: any, next: any) => { req.authUser = sessions[req.get('x-user')]; return req.authUser ? next() : res.sendStatus(401) }
  registerAccountUsers(app, {
    requireAuth: auth, requireTenant: (_req: any, _res: any, next: any) => next(),
    organizationById: async (id: string) => ({ id, status: 'Active', enabledModules: ['items'] }),
    load: async () => ({ data: structuredClone(state) }),
    commit: async (_id: string, next: any) => { Object.assign(state, structuredClone(next)) },
    hashPassword: async (password: string) => `hashed:${password}`,
    verifyCurrentPassword: async (user: any, password: string) => password === `current-${user.id}`,
    refreshSessions: (_id: string, account: any, _org: any, changed: boolean) => { if (changed) delete sessions[account.id] },
  })
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as any).port}`
  const call = async (user: string, body: any) => {
    const response = await fetch(`${base}/api/account/profile`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'x-user': user }, body: JSON.stringify(body) })
    const text = await response.text()
    let data: any; try { data = JSON.parse(text) } catch { data = text }
    return { status: response.status, data }
  }
  try { await run({ call, state, sessions }) }
  finally { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())) }
}

test('without the current password a password or email change is refused and nothing changes', async () => fixture(async ({ call, state, sessions }: any) => {
  for (const body of [{ newPassword: 'replacement-password' }, { email: 'new@example.com' }, { newPassword: 'replacement-password', currentPassword: '' }]) {
    const result = await call('maria', body)
    assert.equal(result.status, 403)
    assert.match(result.data.error, /current password/i)
  }
  assert.equal(state.accounts[0].passwordHash, 'stored-maria')
  assert.equal(state.accounts[0].email, '')
  assert(sessions.maria, 'the session is untouched')
}))

test('a wrong current password is refused', async () => fixture(async ({ call, state }: any) => {
  const result = await call('maria', { email: 'new@example.com', currentPassword: 'wrong' })
  assert.equal(result.status, 403)
  assert.match(result.data.error, /incorrect/i)
  assert.equal(state.accounts[0].email, '')
}))

test('the right current password allows an email change and a password change', async () => fixture(async ({ call, state, sessions }: any) => {
  assert.equal((await call('maria', { email: 'new@example.com', currentPassword: 'current-maria' })).status, 200)
  assert.equal(state.accounts[0].email, 'new@example.com')
  assert(sessions.maria, 'an email change does not sign anyone out')
  assert.equal((await call('maria', { newPassword: 'replacement-password', currentPassword: 'current-maria' })).status, 200)
  assert.equal(state.accounts[0].passwordHash, 'hashed:replacement-password')
  assert.equal(sessions.maria, undefined, 'a password change signs the user out everywhere')
}))

test('profile edits that are not credentials need no password, and re-sending the same email is not a change', async () => fixture(async ({ call, state }: any) => {
  assert.equal((await call('maria', { name: 'Maria Santos', phone: '555-0100', theme: 'default', email: '' })).status, 200)
  assert.equal(state.accounts[0].name, 'Maria Santos')
  assert.equal((await call('maria', { email: 'maria@example.com', currentPassword: 'current-maria' })).status, 200)
  assert.equal((await call('maria', { email: 'MARIA@example.com ', name: 'Maria S.' })).status, 200)
  assert.equal(state.accounts[0].name, 'Maria S.')
}))

test('repeated wrong passwords are throttled per user, even for the right password while locked', async () => fixture(async ({ call }: any) => {
  for (let attempt = 0; attempt < 5; attempt++) {
    assert.equal((await call('maria', { newPassword: 'replacement-password', currentPassword: `guess-${attempt}` })).status, 403)
  }
  assert.equal((await call('maria', { newPassword: 'replacement-password', currentPassword: 'current-maria' })).status, 429)
  assert.equal((await call('carlo', { email: 'c@example.com', currentPassword: 'current-carlo' })).status, 200, 'other users are unaffected')
}))
