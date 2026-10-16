import test from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeStateForClient } from '../server/services/client-state'

const account = (id: string, role: string) => ({ id, username: id, name: `Name ${id}`, email: `${id}@example.com`, phone: `555-${id}`, role, passwordHash: `hash-${id}` })
const state = () => ({
  clients: [{ id: 'c1' }],
  accounts: [account('admin', 'Administrator'), account('viewer', 'Viewer'), account('contrib', 'Contributor')],
  items: [{ id: 't1' }, { id: 't2', source: 'Discord', externalSourceId: 'd1' }],
  activity: [{ text: 'Discord inquiry captured: x' }, { text: 'Edited task' }],
  notifications: [{ recipientUserId: 'viewer', id: 'n1' }, { recipientUserId: 'admin', id: 'n2' }],
})

test('nobody receives password hashes', () => {
  for (const user of [{ id: 'admin', role: 'Administrator' }, { id: 'viewer', role: 'Viewer' }]) {
    const result = sanitizeStateForClient(state(), user)
    assert(result.accounts.every((a: any) => a.passwordHash === ''))
    assert(!JSON.stringify(result).includes('hash-'))
  }
})

test('non-administrators see their own contact details but not their colleagues', () => {
  const result = sanitizeStateForClient(state(), { id: 'viewer', role: 'Viewer' })
  const byId = Object.fromEntries(result.accounts.map((a: any) => [a.id, a]))
  assert.equal(byId.viewer.email, 'viewer@example.com'); assert.equal(byId.viewer.phone, '555-viewer')
  for (const id of ['admin', 'contrib']) {
    assert.equal(byId[id].email, ''); assert.equal(byId[id].phone, '')
    assert.equal(byId[id].name, `Name ${id}`, 'names stay, so assignee lists and comments still work')
  }
})

test('administrators keep everyone\'s contact details', () => {
  const result = sanitizeStateForClient(state(), { id: 'admin', role: 'Administrator' })
  assert.equal(result.accounts.find((a: any) => a.id === 'viewer').email, 'viewer@example.com')
})

test('other behaviour is unchanged: Discord captures hidden, notifications limited to the recipient, input not mutated', () => {
  const input = state()
  const before = JSON.stringify(input)
  const result = sanitizeStateForClient(input, { id: 'viewer', role: 'Viewer' })
  assert.deepEqual(result.items.map((i: any) => i.id), ['t1'])
  assert.deepEqual(result.activity.map((a: any) => a.text), ['Edited task'])
  assert.deepEqual(result.notifications.map((n: any) => n.id), ['n1'])
  assert.deepEqual(result.clients, [{ id: 'c1' }])
  assert.equal(JSON.stringify(input), before)
  for (const odd of [null, undefined, [], 'text']) assert.equal(sanitizeStateForClient(odd, { id: 'x' }), odd)
})
