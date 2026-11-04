import test from 'node:test'
import assert from 'node:assert/strict'
import {
  assertLifecycleMutation,
  archiveBlockers,
  archivedWorkReason,
  LifecycleError,
  type LifecycleStore,
} from '../src/features/tasks/lifecycle'
import { createWorkspaceGuard, WorkspaceRaceError } from '../server/services/workspace-guard'

const admin = { role: 'Administrator', modules: ['clients', 'projects', 'items', 'action'], accountType: 'tenant' }
const contributor = { ...admin, role: 'Contributor' }
const copy = <T>(v: T): T => structuredClone(v)
function state(): LifecycleStore {
  const clients = ['a', 'b'].map(id => ({
    id,
    name: `Client ${id}`,
    status: 'Closed' as const,
    contact: '',
    email: '',
    health: 'Good' as const,
    notes: '',
  }))
  const project = { id: 'p', name: 'Shared rollout', status: 'Closed' as const, targetDate: '', summary: '' }
  const task = (id: string, clientId: string, parentTaskId?: string) => ({
    id,
    title: id,
    clientId,
    projectId: 'p',
    parentTaskId,
    type: 'Task' as const,
    priority: 'Medium' as const,
    status: 'Complete',
    waitingOn: 'Done' as const,
    owner: '',
    dateRaised: '2026-09-20',
    followUpDate: '',
    description: '',
    resolution: '',
    source: 'Internal' as const,
  })
  return {
    clients,
    projects: [project],
    items: [task('task-a', 'a'), task('child-a', 'a', 'task-a'), task('task-b', 'b')],
    planner: [],
    activity: [],
    taskSettings: {
      statuses: [
        { id: 'open', label: 'Open', closed: false },
        { id: 'done', label: 'Complete', closed: true },
      ],
      visibleColumns: ['status'],
    },
  }
}
function change(base: LifecycleStore, kind: 'clients' | 'projects', index: number, patch: object) {
  const next = copy(base)
  Object.assign(next[kind][index], patch, { lifecycleVersion: (base[kind][index].lifecycleVersion || 0) + 1 })
  return next
}
function archived() {
  return change(state(), 'projects', 0, { archived: true })
}

test('only Administrators can rename an existing client; names retain IDs and relationships', () => {
  const before = state(),
    next = change(before, 'clients', 0, { name: 'Renamed client' })
  assert.throws(() => assertLifecycleMutation(before, next, contributor), /Only an Administrator/)
  assertLifecycleMutation(before, next, admin)
  assert.deepEqual(next.items, before.items)
  assert.equal(next.clients[0].id, before.clients[0].id)
})
test('project names/details are editable by assigned writers, never Viewers or users without module access', () => {
  const before = state(),
    next = change(before, 'projects', 0, { name: 'Revised rollout', summary: 'New scope' })
  assertLifecycleMutation(before, next, contributor)
  for (const actor of [
    { ...admin, role: 'Viewer' },
    { ...admin, modules: ['clients'] },
    { ...admin, accountType: 'platform' },
  ])
    assert.throws(() => assertLifecycleMutation(before, next, actor), /edit access/)
})
test('client/project hard deletion and ID replacement are rejected for all roles', () => {
  for (const kind of ['clients', 'projects'] as const)
    for (const actor of [admin, contributor]) {
      const before = state(),
        next = copy(before)
      next[kind].splice(0, 1)
      assert.throws(() => assertLifecycleMutation(before, next, actor), /cannot be deleted/)
      const swapped = copy(before)
      swapped[kind][0].id = 'replacement'
      assert.throws(() => assertLifecycleMutation(before, swapped, actor), /cannot be deleted/)
    }
})
test('shared project archive requires its own Closed state, every client, task and subtask', () => {
  const before = state()
  assert.deepEqual(archiveBlockers(before, 'projects', 'p'), [])
  assertLifecycleMutation(before, archived(), contributor)
  for (const mutate of [
    (s: LifecycleStore) => {
      s.projects[0].status = 'Active'
    },
    (s: LifecycleStore) => {
      s.clients[1].status = 'Active'
    },
    (s: LifecycleStore) => {
      s.items[1].status = 'Open'
    },
  ]) {
    const current = copy(before)
    mutate(current)
    assert.throws(
      () => assertLifecycleMutation(current, change(current, 'projects', 0, { archived: true }), admin),
      /Closed|Complete/,
    )
  }
})
test('waiting-on Done alone never masks an open subtask; inherited and custom completion states count', () => {
  const current = state()
  current.items[1].status = 'Open'
  delete current.items[1].projectId
  delete current.items[1].clientId
  assert(archiveBlockers(current, 'projects', 'p').some(s => s.includes('child-a')))
  assert(archiveBlockers(current, 'clients', 'a').some(s => s.includes('child-a')))
  current.items[1].status = 'Complete'
  assert.deepEqual(archiveBlockers(current, 'projects', 'p'), [])
})
test('client archive checks all of its projects and work; can activate without deleting history', () => {
  const before = state(),
    next = change(before, 'clients', 0, { archived: true })
  assertLifecycleMutation(before, next, contributor)
  const active = change(next, 'clients', 0, { archived: false })
  assertLifecycleMutation(next, active, contributor)
  assert.deepEqual(active.items, before.items)
  before.projects[0].status = 'UAT'
  assert.throws(
    () => assertLifecycleMutation(before, change(before, 'clients', 0, { archived: true }), admin),
    /linked projects Closed/,
  )
})
test('completion and archival cannot be bypassed by deleting or moving unfinished tasks in the same save', () => {
  const current = state()
  current.items[1].status = 'Open'
  for (const remove of [true, false]) {
    const next = change(current, 'projects', 0, { archived: true })
    if (remove) next.items.splice(1, 1)
    else {
      next.items[1].projectId = undefined
      next.items[1].parentTaskId = undefined
    }
    assert.throws(() => assertLifecycleMutation(current, next, admin), /Complete/)
  }
})
test('archived project work is read-only across create, edit, reopen, delete, reassignment, planner and notes', () => {
  const current = archived()
  const edits: ((s: LifecycleStore) => void)[] = [
    s => {
      s.items.push({ ...s.items[0], id: 'new' })
    },
    s => {
      s.items[0].description = 'edit'
    },
    s => {
      s.items[0].status = 'Open'
    },
    s => {
      s.items.splice(0, 1)
    },
    s => {
      s.items[0].projectId = undefined
    },
    s => {
      s.activity!.push({ id: 'note', projectId: 'p', date: '2026-09-20', text: 'new' })
    },
    s => {
      s.planner!.push({
        id: 'event',
        title: 'new',
        projectId: 'p',
        date: '2026-09-20',
        startTime: '',
        endTime: '',
        allDay: true,
        source: 'Local',
        status: 'Planned',
        notes: '',
      })
    },
  ]
  for (const edit of edits) {
    const next = copy(current)
    edit(next)
    assert.throws(() => assertLifecycleMutation(current, next, admin), /Activate project/)
  }
  assertLifecycleMutation(current, copy(current), admin)
})
test('archived client prevents new work, and malformed subtask associations cannot evade an archived parent', () => {
  const current = change(state(), 'clients', 0, { archived: true })
  const next = copy(current)
  next.items[0].description = 'edit'
  assert.throws(() => assertLifecycleMutation(current, next, admin), /Activate client/)
  const projectState = archived()
  projectState.projects.push({ id: 'other', name: 'Active project', status: 'Active', targetDate: '', summary: '' })
  const payload = copy(projectState)
  payload.items.push({ ...payload.items[1], id: 'bad-child', projectId: 'other' })
  assert.throws(() => assertLifecycleMutation(projectState, payload, admin), /Activate project/)
  assert.match(archivedWorkReason(projectState, { parentTaskId: 'task-a', projectId: 'other' }), /Activate project/)
})
test('reactivation restores project use; reopening a client under an archived project requires activating the project first', () => {
  const current = archived(),
    active = change(current, 'projects', 0, { archived: false })
  assertLifecycleMutation(current, active, contributor)
  const next = copy(active)
  next.items.push({ ...active.items[0], id: 'new', status: 'Open' })
  assertLifecycleMutation(active, next, contributor)
  assert.throws(
    () => assertLifecycleMutation(current, change(current, 'clients', 0, { status: 'Active' }), admin),
    /Activate project/,
  )
})
test('legacy records default active, while stale version and invalid metadata are rejected', () => {
  const current = state()
  assertLifecycleMutation(current, copy(current), admin)
  const stale = copy(current)
  stale.projects[0].name = 'unversioned change'
  assert.throws(() => assertLifecycleMutation(current, stale, admin), /another session/)
  for (const patch of [{ name: ' ' }, { archived: 'yes' }, { status: 'whatever' }])
    assert.throws(() => assertLifecycleMutation(current, change(current, 'projects', 0, patch), admin), LifecycleError)
  const saved = change(current, 'projects', 0, { name: 'new' })
  assert.throws(() => assertLifecycleMutation(saved, current, admin), /another session/)
})
test('Closed completion status cannot be set while tasks or subtasks are unfinished', () => {
  const current = state()
  current.items[1].status = 'Open'
  current.projects[0].status = 'Active'
  current.clients[0].status = 'Active'
  for (const kind of ['projects', 'clients'] as const)
    assert.throws(
      () => assertLifecycleMutation(current, change(current, kind, 0, { status: 'Closed' }), admin),
      /Complete all/,
    )
})
test('serialized commits prevent a concurrent task write from racing past archive validation', async () => {
  let saved = state()
  const initial = copy(saved)
  const guard = createWorkspaceGuard(async () => copy(saved), state)
  const save = (next: LifecycleStore) =>
    guard('tenant-a', next, admin, initial, async () => {
      saved = copy(next)
    })
  const archive = archived(),
    taskUpdate = copy(initial)
  taskUpdate.items[0].status = 'Open'
  const result = await Promise.allSettled([save(archive), save(taskUpdate)])
  assert.equal(result[0].status, 'fulfilled')
  assert.equal(result[1].status, 'rejected')
  // A race, not a lifecycle violation: the browser refetches, merges and retries (then the real check refuses it).
  assert.ok((result[1] as PromiseRejectedResult).reason instanceof WorkspaceRaceError)
  assert.equal(saved.projects[0].archived, true)
  assert.equal(saved.items[0].status, 'Complete')
})
test('guard reload checks completion and does not persist failed saves; independent tenants remain separate', async () => {
  const states: Record<string, LifecycleStore> = { a: state(), b: state() }
  const guard = createWorkspaceGuard(async id => copy(states[id]), state)
  const next = archived()
  await assert.rejects(
    guard('a', next, admin, states.a, async () => {
      throw new Error('database unavailable')
    }),
    /database unavailable/,
  )
  assert.equal(states.a.projects[0].archived, undefined)
  await guard('b', next, admin, states.b, async () => {
    states.b = copy(next)
  })
  assert.equal(states.b.projects[0].archived, true)
  assert.equal(states.a.projects[0].archived, undefined)
  states.a.items[1].status = 'Open'
  await assert.rejects(
    guard('a', next, admin, undefined, async () => {
      states.a = copy(next)
    }),
    /Complete/,
  )
})
