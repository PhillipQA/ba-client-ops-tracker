import assert from 'node:assert/strict'
import test from 'node:test'
import {
  TRACKER_MEMBERS,
  cleanMembers,
  projectUsers,
  trackerFolders,
  trackerUsers,
  trackersInFolder,
  userReason,
  usersOf,
  validateMembers,
} from '../src/features/trackers/trackerFolders'
import type { Tracker } from '../src/features/trackers/trackerModel'

const state = () => ({
  accounts: [
    { id: 'phillip', name: 'Phillip', status: 'Active' },
    { id: 'anna', name: 'Anna', status: 'Active' },
    { id: 'ben', name: 'Ben', status: 'Active' },
    { id: 'new', username: 'newhire', status: 'Active' },
    { id: 'gone', name: 'Gone', status: 'Disabled' },
  ],
  access: {
    assignments: [
      { userId: 'anna', role: 'BA', projectId: 'p-makati', source: 'manual' },
      { userId: 'ben', role: 'PM', projectId: 'p-makati', source: 'manual' },
      { userId: 'gone', role: 'BA', projectId: 'p-makati', source: 'manual' },
      { userId: 'ben', role: 'PM', clientId: 'c-primer', source: 'manual' },
    ],
  },
})

const tracker = (id: string, data: Partial<Tracker>): Tracker =>
  ({ id, name: id, createdBy: 'phillip', columns: [], ...data }) as Tracker

test('a tracker’s users: creator, active people on its projects, then people added by hand', () => {
  const s = state()
  const onProjects = projectUsers(s)
  assert.deepEqual([...(onProjects.get('p-makati') || [])].sort(), ['anna', 'ben'], 'disabled people are left out')
  assert.equal(onProjects.has('c-primer'), false, 'a client assignment is not a project')
  assert.deepEqual(trackerUsers({ created_by: 'phillip', project_id: 'p-makati' }, s, onProjects), [
    'phillip',
    'anna',
    'ben',
  ])
  assert.deepEqual(
    trackerUsers({ created_by: 'phillip', project_id: '', members: ['new', 'gone', 'phillip', 'new'] }, s),
    ['phillip', 'new'],
    'added people: active only, no duplicates, the creator once',
  )
  assert.deepEqual(trackerUsers({ created_by: 'gone', project_id: '' }, s), ['gone'], 'the creator always keeps it')
})

test('people added by hand are checked before saving', () => {
  const s = state()
  assert.deepEqual(validateMembers(s, ['anna', 'anna', 'phillip'], 'phillip'), { ok: true, members: ['anna'] })
  assert.equal(validateMembers(s, ['gone'], 'phillip').ok, false)
  assert.equal(validateMembers(s, ['nobody'], 'phillip').ok, false)
  assert.equal(validateMembers(s, 'anna', 'phillip').ok, false)
  const tooMany = Array.from({ length: TRACKER_MEMBERS + 5 }, (_, i) => `p${i}`)
  assert.equal(validateMembers(s, tooMany, 'x').ok, false)
  assert.deepEqual(cleanMembers(undefined), [], 'trackers from before schema v36 have no added people')
})

test('every active person has a folder, the viewer’s first; a shared tracker is in each user’s folder', () => {
  const s = state()
  const trackers = [
    tracker('rollout', { users: ['phillip', 'anna', 'ben'], members: [] }),
    tracker('mine', { users: ['phillip'] }),
    tracker('anna-own', { createdBy: 'anna', users: ['anna'] }),
    tracker('older-server', { createdBy: 'ben' }),
  ]
  const folders = trackerFolders(s.accounts, trackers, 'anna')
  assert.deepEqual(
    folders.map(folder => [folder.name, folder.count, folder.mine]),
    [
      ['Anna', 2, true],
      ['Ben', 2, false],
      ['newhire', 0, false],
      ['Phillip', 2, false],
    ],
    'a brand-new person has an empty folder; a disabled one has none',
  )
  assert.deepEqual(
    trackersInFolder(trackers, 'ben').map(t => t.id),
    ['rollout', 'older-server'],
  )
  assert.deepEqual(usersOf(tracker('x', { createdBy: 'ben' })), ['ben'])
  const rollout = tracker('rollout', { members: ['anna'] })
  assert.equal(userReason(rollout, 'phillip'), 'creator')
  assert.equal(userReason(rollout, 'anna'), 'added')
  assert.equal(userReason(rollout, 'ben'), 'project')
})
