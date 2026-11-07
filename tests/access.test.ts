import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AccessDenied,
  creatorAssignments,
  effectiveAccount,
  isAccountManagerOnly,
  mergeScopedSave,
  scopedState,
  scopeFor,
} from '../src/shared/access'
import { keepSeedsFields } from '../src/shared/seeds'
import { assertLifecycleMutation } from '../src/features/tasks/lifecycle'
import { sanitizeStateForClient } from '../server/services/client-state'
import { canCreateWork, visibleTask, visibleTaskIds } from '../server/services/visibility'

const client = (id: string, name: string) => ({
  id,
  name,
  contact: `${name} contact`,
  email: `${id}@client.example`,
  status: 'Active',
  health: 'Good',
  notes: `${name} secret notes`,
})
const task = (id: string, fields: Record<string, unknown>) => ({
  id,
  title: `Task ${id}`,
  type: 'Task',
  priority: 'Medium',
  status: 'Open',
  waitingOn: 'Internal',
  owner: '',
  dateRaised: '2026-11-01',
  followUpDate: '',
  description: '',
  resolution: '',
  source: 'Other',
  ...fields,
})

/** Acme (A) and Bolt (B). P1 belongs to Acme; P2 is an older project with work for both; P3 is Bolt's. */
function workspace(access: any = {}) {
  return {
    clients: [client('A', 'Acme'), client('B', 'Bolt')],
    projects: [
      { id: 'P1', name: 'Acme Portal', status: 'Active', targetDate: '', summary: 'Acme summary', clientId: 'A' },
      { id: 'P2', name: 'Shared Rollout', status: 'Active', targetDate: '', summary: 'Shared summary' },
      { id: 'P3', name: 'Bolt Billing', status: 'Active', targetDate: '', summary: 'Bolt summary', clientId: 'B' },
    ],
    items: [
      task('t1', { clientId: 'A', projectId: 'P1' }),
      task('t1a', { clientId: 'A', projectId: 'P1', parentTaskId: 't1' }),
      task('t2', { clientId: 'A', projectId: 'P2' }),
      task('t3', { clientId: 'B', projectId: 'P2', title: 'Bolt confidential task' }),
      task('t4', { clientId: 'B', projectId: 'P3' }),
      task('mine', { assignedToUserId: 'ba' }),
      task('theirs', { assignedToUserId: 'pm' }),
    ],
    activity: [
      { id: 'a1', clientId: 'A', date: '2026-11-01', text: 'Acme activity' },
      { id: 'a2', clientId: 'B', date: '2026-11-01', text: 'Bolt activity' },
    ],
    planner: [
      { id: 'pl1', title: 'Acme meeting', clientId: 'A' },
      { id: 'pl2', title: 'Bolt meeting', clientId: 'B' },
      { id: 'pl3', title: 'Team lunch' },
    ],
    rtms: [
      { id: 'r1', clientId: 'A', projectId: 'P1' },
      { id: 'r2', clientId: 'B', projectId: 'P3' },
    ],
    workEvents: [],
    notifications: [],
    taskSettings: { statuses: [{ id: 'open', label: 'Open', closed: false }], visibleColumns: [] },
    accounts: [
      { id: 'ba', name: 'Bea', role: 'Contributor', status: 'Active', email: 'bea@co' },
      { id: 'pm', name: 'Paolo', role: 'Contributor', status: 'Active', email: 'paolo@co' },
      { id: 'am', name: 'Amy', role: 'Contributor', status: 'Active', email: 'amy@co' },
      { id: 'admin', name: 'Admin', role: 'Administrator', status: 'Active', email: 'admin@co' },
    ],
    access: {
      strictVisibility: true,
      assignments: [
        { id: 'x1', userId: 'ba', role: 'BA', clientId: 'A', source: 'manual' },
        { id: 'x2', userId: 'pm', role: 'PM', projectId: 'P3', source: 'manual' },
        { id: 'x3', userId: 'am', role: 'AM', clientId: 'A', source: 'manual' },
      ],
      ...access,
    },
  }
}
const ids = (records: any[]) => records.map(record => record.id)

test('with visibility off, everyone sees and changes everything, as before', () => {
  const state = workspace({ strictVisibility: false })
  const scope = scopeFor(state, 'ba')
  assert.equal(scope.all, true)
  assert.equal(scopedState(state, scope), state)
  assert.ok(visibleTask(state, { id: 'nobody' }, 't4', 'write'))
  assert.equal(visibleTaskIds(state, { id: 'nobody' }), null)
})

test('a BA on a client sees that client and its work, never another client’s', () => {
  const state = workspace()
  const view = scopedState(state, scopeFor(state, 'ba'))
  assert.deepEqual(ids(view.items), ['t1', 't1a', 't2', 'mine'])
  assert.deepEqual(ids(view.clients), ['A'])
  assert.deepEqual(ids(view.activity), ['a1'])
  assert.deepEqual(ids(view.planner), ['pl1', 'pl3'])
  assert.deepEqual(ids(view.rtms), ['r1'])
  // The shared older project shows by name (its Acme task refers to it) but opens nothing of Bolt's.
  const shared = view.projects.find((project: any) => project.id === 'P2')
  assert.equal(shared.accessLimited, true)
  assert.equal(shared.summary, '')
  assert.ok(!view.projects.some((project: any) => project.id === 'P3'))
})

test('a PM on one project sees its work; its client shows by name only', () => {
  const state = workspace()
  const view = scopedState(state, scopeFor(state, 'pm'))
  assert.deepEqual(ids(view.items), ['t4', 'theirs'])
  assert.deepEqual(ids(view.projects), ['P3'])
  const bolt = view.clients.find((item: any) => item.id === 'B')
  assert.equal(bolt.name, 'Bolt')
  assert.equal(bolt.email, '')
  assert.equal(bolt.notes, '')
  assert.equal(bolt.accessLimited, true)
})

test('nothing of a hidden client leaves the server, whatever the field', () => {
  const state = workspace()
  for (const userId of ['ba', 'am', 'admin']) {
    const sent = JSON.stringify(
      sanitizeStateForClient(state, { id: userId, role: userId === 'admin' ? 'Administrator' : 'Contributor' }),
    )
    for (const secret of ['Bolt', 'b@client.example', 'Bolt secret notes', 'Bolt confidential task', 'Bolt summary'])
      assert.ok(!sent.includes(secret), `${userId} received “${secret}”`)
  }
  const pm = JSON.stringify(sanitizeStateForClient(state, { id: 'pm', role: 'Contributor' }))
  for (const secret of ['Acme', 'a@client.example', 'Acme secret notes', 'Acme summary'])
    assert.ok(!pm.includes(secret), `pm received “${secret}”`)
})

test('the browser hears only its own assignments', () => {
  const sent = sanitizeStateForClient(workspace(), { id: 'admin', role: 'Administrator' })
  assert.deepEqual(sent.access.assignments, [])
  assert.equal(sent.access.strictVisibility, true)
  const ba = sanitizeStateForClient(workspace(), { id: 'ba', role: 'Contributor' })
  assert.deepEqual(
    ba.access.assignments.map((a: any) => a.id),
    ['x1'],
  )
  assert.deepEqual(ba.access.roles, ['BA'])
})

test('an Administrator with no assignments sees no client data: there is no back door', () => {
  const state = workspace()
  const view = scopedState(state, scopeFor(state, 'admin'))
  assert.deepEqual(view.clients, [])
  assert.deepEqual(view.projects, [])
  assert.deepEqual(view.items, [])
  assert.equal(visibleTask(state, { id: 'admin' }, 't1'), undefined)
})

test('your own unfiled work stays yours; subtasks follow their task', () => {
  const state = workspace()
  assert.ok(visibleTask(state, { id: 'ba' }, 'mine', 'write'))
  assert.equal(visibleTask(state, { id: 'ba' }, 'theirs'), undefined)
  assert.ok(visibleTask(state, { id: 'ba' }, 't1a', 'write'))
  const created = {
    ...state,
    items: [...state.items, task('quick', {})],
    workEvents: [{ action: 'created', taskId: 'quick', actorUserId: 'pm' }],
  }
  assert.ok(visibleTask(created, { id: 'pm' }, 'quick'))
  assert.equal(visibleTask(created, { id: 'ba' }, 'quick'), undefined)
})

test('an Account Manager sees their clients read-only, as a Viewer of four pages', () => {
  const state = workspace()
  assert.ok(visibleTask(state, { id: 'am' }, 't1'))
  assert.equal(visibleTask(state, { id: 'am' }, 't1', 'write'), undefined)
  assert.equal(isAccountManagerOnly(state, 'am'), true)
  const account = effectiveAccount(
    { id: 'am', role: 'Contributor', modules: ['action', 'clients', 'items', 'reports', 'ai', 'settings'] },
    state,
  )
  assert.equal(account.role, 'Viewer')
  assert.deepEqual(account.modules, ['action', 'reports', 'explorer', 'ai'])
  // An Administrator tagged as AM keeps Settings, so visibility can always be turned off again.
  assert.equal(
    effectiveAccount({ id: 'am', role: 'Administrator', modules: ['settings'] }, state).role,
    'Administrator',
  )
  // Roles add up: an AM who is also a BA somewhere keeps their own role.
  const both = workspace({
    assignments: [
      { id: 'y1', userId: 'am', role: 'AM', clientId: 'A', source: 'manual' },
      { id: 'y2', userId: 'am', role: 'BA', projectId: 'P3', source: 'manual' },
    ],
  })
  assert.equal(isAccountManagerOnly(both, 'am'), false)
  assert.equal(effectiveAccount({ id: 'am', role: 'Contributor', modules: ['items'] }, both).role, 'Contributor')
  assert.ok(visibleTask(both, { id: 'am' }, 't4', 'write'))
  assert.equal(visibleTask(both, { id: 'am' }, 't1', 'write'), undefined)
})

test('a save from a partial view keeps everything else exactly where it was', () => {
  const current = workspace()
  const scope = scopeFor(current, 'ba')
  const view = scopedState(current, scope)
  const edited = {
    ...view,
    items: [
      { ...view.items[0], title: 'Renamed Acme task' },
      ...view.items.slice(1).filter((item: any) => item.id !== 't2'),
      task('new1', { clientId: 'A', projectId: 'P1' }),
    ],
  }
  const merged = mergeScopedSave(current, edited, scope)
  assert.deepEqual(ids(merged.items), ['t1', 't1a', 't3', 't4', 'mine', 'theirs', 'new1'])
  assert.equal(merged.items[0].title, 'Renamed Acme task')
  assert.deepEqual(merged.items[2], current.items[3])
  assert.deepEqual(merged.clients, current.clients, 'limited and hidden clients stay as stored')
  assert.deepEqual(ids(merged.projects), ['P1', 'P2', 'P3'])
  assert.equal(merged.projects[1].summary, 'Shared summary')
  assert.deepEqual(ids(merged.planner), ['pl1', 'pl2', 'pl3'])
  assert.deepEqual(ids(merged.rtms), ['r1', 'r2'])
  const actor = { id: 'ba', role: 'Contributor', modules: ['clients', 'projects', 'items'], accountType: 'tenant' }
  assert.doesNotThrow(() => assertLifecycleMutation(current as any, merged, actor as any))
})

test('an unchanged save changes nothing', () => {
  const current = workspace()
  for (const userId of ['ba', 'pm', 'am', 'admin']) {
    const scope = scopeFor(current, userId)
    const merged = mergeScopedSave(current, scopedState(current, scope), scope)
    for (const key of ['clients', 'projects', 'items', 'planner', 'rtms'] as const)
      assert.deepEqual(merged[key], (current as any)[key], `${userId} ${key}`)
  }
})

test('work cannot be added to, or moved into, a client you cannot change', () => {
  const current = workspace()
  const scope = scopeFor(current, 'ba')
  const view = scopedState(current, scope)
  assert.throws(
    () =>
      mergeScopedSave(
        current,
        { ...view, items: [...view.items, task('sneak', { clientId: 'B', projectId: 'P3' })] },
        scope,
      ),
    AccessDenied,
  )
  assert.throws(
    () =>
      mergeScopedSave(
        current,
        {
          ...view,
          items: view.items.map((item: any) => (item.id === 't1' ? { ...item, clientId: 'B', projectId: 'P3' } : item)),
        },
        scope,
      ),
    AccessDenied,
  )
  // A stale copy of a record you no longer see is ignored, not saved over the stored one.
  const stale = { ...view, items: [...view.items, { ...current.items[4], title: 'Overwritten' }] }
  assert.equal(mergeScopedSave(current, stale, scope).items.find((item: any) => item.id === 't4').title, 'Task t4')
  // An Account Manager's edits do not land.
  const amScope = scopeFor(current, 'am')
  const amView = scopedState(current, amScope)
  const amSave = { ...amView, items: amView.items.map((item: any) => ({ ...item, title: 'AM edit' })) }
  assert.deepEqual(mergeScopedSave(current, amSave, amScope).items, current.items)
})

test('new subtasks go under tasks you can change', () => {
  const current = workspace()
  const scope = scopeFor(current, 'ba')
  const view = scopedState(current, scope)
  const ok = mergeScopedSave(current, { ...view, items: [...view.items, task('sub', { parentTaskId: 't1' })] }, scope)
  assert.ok(ok.items.some((item: any) => item.id === 'sub'))
  assert.throws(
    () => mergeScopedSave(current, { ...view, items: [...view.items, task('sub', { parentTaskId: 't4' })] }, scope),
    AccessDenied,
  )
  assert.equal(canCreateWork(current, { id: 'ba' }, { parentTaskId: 't4' }), false)
  assert.equal(canCreateWork(current, { id: 'ba' }, { clientId: 'A', projectId: 'P1' }), true)
  assert.equal(canCreateWork(current, { id: 'am' }, { clientId: 'A', projectId: 'P1' }), false)
})

test('new clients are kept visible to whoever made them; with Seeds connected they come from Seeds', () => {
  const current = workspace()
  const scope = scopeFor(current, 'ba')
  const view = scopedState(current, scope)
  const next = mergeScopedSave(current, { ...view, clients: [...view.clients, client('C', 'Cobalt')] }, scope)
  assert.deepEqual(
    creatorAssignments(current, next, 'ba').map(a => [a.clientId, a.role]),
    [['C', 'BA']],
  )
  assert.throws(
    () =>
      mergeScopedSave(current, { ...view, clients: [...view.clients, client('C', 'Cobalt')] }, scope, {
        seedsConnected: true,
      }),
    /come from Seeds/,
  )
})

test('once Seeds has synced, only its assignments count', () => {
  const state = {
    ...workspace({
      assignments: [
        { id: 'm', userId: 'ba', role: 'BA', clientId: 'A', source: 'manual' },
        { id: 's', userId: 'ba', role: 'BA', clientId: 'B', source: 'seeds' },
      ],
    }),
    seeds: { connected: true, users: { ba: { connected: true, lastSuccessAt: '2026-11-07T00:00:00Z' } } },
  }
  assert.deepEqual(ids(scopedState(state, scopeFor(state, 'ba')).clients), ['B'])
  const offline = { ...state, seeds: { ...state.seeds, connected: false } }
  assert.deepEqual(ids(scopedState(offline, scopeFor(offline, 'ba')).clients), ['A'])
})

test('Seeds-owned fields cannot be changed, claimed or deleted from the browser', () => {
  const current = {
    clients: [{ ...client('A', 'Acme'), seedsId: 's-a' }, client('B', 'Bolt')],
    projects: [{ id: 'P1', name: 'Portal', clientId: 'A', contractNumber: 'C-100', seedsId: 's-p1' }],
    items: [task('t1', { seedsId: 's-t1', title: 'Seeds task' })],
  }
  const next = keepSeedsFields(current, {
    clients: [
      { ...current.clients[0], name: 'Renamed', notes: 'ok' },
      { ...current.clients[1], seedsId: 'forged' },
    ],
    projects: [],
    items: [{ ...current.items[0], title: 'Changed', description: 'mine' }],
  })
  assert.equal(next.clients[0].name, 'Acme')
  assert.equal(next.clients[0].notes, 'ok')
  assert.equal(next.clients[1].seedsId, undefined)
  assert.deepEqual(next.projects, current.projects)
  assert.equal(next.items[0].title, 'Seeds task')
  assert.equal(next.items[0].description, 'mine')
})
