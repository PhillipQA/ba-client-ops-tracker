import test from 'node:test'
import assert from 'node:assert/strict'
import { accountChangesAreSelfOnly, SELF_EDITABLE_ACCOUNT_FIELDS } from '../server/services/account-guard'

// Mirrors the account shape the save path compares: id + profile fields + access fields.
const account = (over: Record<string, unknown> = {}) => ({
  id: 'me', username: 'me', name: 'Me', email: 'me@example.com', phone: '555-0100',
  role: 'Contributor', modules: ['items'], status: 'Active', passwordHash: 'hash-me', theme: 'default', ...over,
})
const other = account({ id: 'boss', username: 'boss', name: 'Boss', email: 'boss@example.com', role: 'Administrator', modules: ['items', 'settings'] })
const base = () => [account(), { ...other }]

test('an unchanged account set is self-only', () => {
  assert.equal(accountChangesAreSelfOnly(base(), base(), 'me'), true)
})

test('the signed-in user may change their own allow-listed profile fields', () => {
  const next = [account({ name: 'My New Name', email: 'new@example.com', phone: '555-9999', passwordHash: 'hash-new', theme: 'ocean' }), { ...other }]
  assert.equal(accountChangesAreSelfOnly(base(), next, 'me'), true)
})

test('the signed-in user cannot escalate their own role', () => {
  const next = [account({ role: 'Administrator' }), { ...other }]
  assert.equal(accountChangesAreSelfOnly(base(), next, 'me'), false)
})

test('the signed-in user cannot grant themselves extra modules', () => {
  const next = [account({ modules: ['items', 'settings'] }), { ...other }]
  assert.equal(accountChangesAreSelfOnly(base(), next, 'me'), false)
})

test('the signed-in user cannot change their own status', () => {
  const next = [account({ status: 'Disabled' }), { ...other }]
  assert.equal(accountChangesAreSelfOnly(base(), next, 'me'), false)
})

test('no change to any other user is permitted through a workspace save', () => {
  const next = [account(), { ...other, role: 'Contributor' }]
  assert.equal(accountChangesAreSelfOnly(base(), next, 'me'), false)
})

test('a self profile edit combined with tampering another user is rejected whole', () => {
  const next = [account({ name: 'Me Again' }), { ...other, modules: ['items', 'settings', 'documents'] }]
  assert.equal(accountChangesAreSelfOnly(base(), next, 'me'), false)
})

test('adding an account is not self-only', () => {
  const next = [...base(), account({ id: 'ghost', username: 'ghost', role: 'Administrator' })]
  assert.equal(accountChangesAreSelfOnly(base(), next, 'me'), false)
})

test('removing an account is not self-only', () => {
  assert.equal(accountChangesAreSelfOnly(base(), [account()], 'me'), false)
})

test('an incoming account whose id is unknown to the server is rejected', () => {
  const next = [account({ id: 'me2' }), { ...other }]
  assert.equal(accountChangesAreSelfOnly(base(), next, 'me'), false)
})

test('field reordering alone is not treated as a change', () => {
  const reordered = [{ status: 'Active', role: 'Administrator', id: 'boss', modules: ['items', 'settings'], phone: other.phone, email: other.email, name: other.name, username: 'boss', passwordHash: other.passwordHash, theme: other.theme }, account()]
  assert.equal(accountChangesAreSelfOnly(base(), reordered, 'me'), true)
})

test('the allow-list is exactly the self-editable profile fields', () => {
  assert.deepEqual([...SELF_EDITABLE_ACCOUNT_FIELDS], ['name', 'email', 'phone', 'passwordHash', 'theme'])
})
