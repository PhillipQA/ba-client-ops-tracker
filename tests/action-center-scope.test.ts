import test from 'node:test'
import assert from 'node:assert/strict'
import { itemMatchesActionCenterScope, resolveActionCenterScope, trackedActionCenterUsers } from '../src/actionCenterScope'
import type { UserAccount } from '../src/types'

const accounts = [
  { id: 'admin', name: 'Admin', role: 'Administrator', status: 'Active' },
  { id: 'maria', name: 'Maria', role: 'Contributor', status: 'Active' },
  { id: 'disabled', name: 'Disabled User', role: 'Contributor', status: 'Disabled' },
  { id: 'viewer', name: 'Viewer', role: 'Viewer', status: 'Active' },
] as UserAccount[]

test('Administrators and Contributors can choose all or a user; mine stays personal', () => {
  assert.deepEqual(resolveActionCenterScope('all', 'maria', 'Contributor', accounts), { kind: 'all' })
  assert.deepEqual(resolveActionCenterScope('user:admin', 'maria', 'Contributor', accounts), { kind: 'user', userId: 'admin' })
  assert.deepEqual(resolveActionCenterScope('mine', 'maria', 'Contributor', accounts), { kind: 'mine', userId: 'maria' })
  assert.equal(trackedActionCenterUsers(accounts).length, 2)
})

test('a selected user view includes only work assigned to that user', () => {
  const scope = resolveActionCenterScope('user:admin', 'maria', 'Contributor', accounts)
  assert.equal(itemMatchesActionCenterScope({ assignedToUserId: 'admin' }, scope), true)
  assert.equal(itemMatchesActionCenterScope({ assignedToUserId: 'maria' }, scope), false)
  assert.equal(itemMatchesActionCenterScope({}, scope), false)
})

test('Viewers cannot expand Action Center visibility and invalid targets fall back to mine', () => {
  assert.deepEqual(resolveActionCenterScope('all', 'viewer', 'Viewer', accounts), { kind: 'mine', userId: 'viewer' })
  assert.deepEqual(resolveActionCenterScope('user:disabled', 'maria', 'Contributor', accounts), { kind: 'mine', userId: 'maria' })
})
