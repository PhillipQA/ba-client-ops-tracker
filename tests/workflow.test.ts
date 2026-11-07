import assert from 'node:assert/strict'
import test from 'node:test'
import { assertLifecycleMutation } from '../src/features/tasks/lifecycle'
import { cleanLabels, healthLabel, planWorkflowUpdate, priorityLabel } from '../src/features/tasks/workflow'
import { normalizeTaskSettings } from '../src/app/store'
import { workflowView } from '../server/workspace/workflow-routes'

const settings: any = {
  statuses: [
    { id: 'open', label: 'Open', closed: false },
    { id: 'doing', label: 'In Progress', closed: false },
    { id: 'blocked', label: 'Blocked', closed: false },
    { id: 'closed', label: 'Closed', closed: true },
  ],
  visibleColumns: ['status', 'priority'],
  waitingOn: [
    { id: 'internal', label: 'Internal', done: false },
    { id: 'client', label: 'Client', done: false },
    { id: 'done', label: 'Done', done: true },
  ],
}
const task = (id: string, status: string, extra: any = {}) => ({
  id,
  title: `Task ${id}`,
  type: 'Task',
  priority: 'Medium',
  status,
  waitingOn: 'Internal',
  owner: '',
  dateRaised: '2026-11-01',
  followUpDate: '',
  description: '',
  resolution: '',
  source: 'Other',
  ...extra,
})
const items = [
  task('a', 'Open'),
  task('b', 'Blocked'),
  task('c', 'Closed', { waitingOn: 'Done', archived: true }),
  task('d', 'Blocked', { waitingOn: 'Client' }),
]
const input = (changes: any = {}) => ({
  statuses: settings.statuses,
  visibleColumns: settings.visibleColumns,
  waitingOn: settings.waitingOn,
  ...changes,
})

test('renaming a status or waiting-on option carries over to every task, archived ones too', () => {
  const plan = planWorkflowUpdate(
    settings,
    items,
    input({
      statuses: settings.statuses.map((s: any) => (s.id === 'closed' ? { ...s, label: 'Completed' } : s)),
      waitingOn: settings.waitingOn.map((o: any) => (o.id === 'client' ? { ...o, label: 'Customer' } : o)),
    }),
  )
  assert.ok(plan.ok, !plan.ok ? plan.error : '')
  if (!plan.ok) return
  assert.equal(plan.items.find(i => i.id === 'c').status, 'Completed')
  assert.equal(plan.items.find(i => i.id === 'd').waitingOn, 'Customer')
  assert.equal(plan.renamedTasks, 2)
  const before: any = { clients: [], projects: [], items, taskSettings: settings }
  const after: any = { ...before, items: plan.items, taskSettings: plan.taskSettings }
  assert.doesNotThrow(() => assertLifecycleMutation(before, after, { role: 'Administrator', modules: ['items'] }))
})

test('a status still in use is removed only by choosing where its tasks move', () => {
  const without = settings.statuses.filter((s: any) => s.id !== 'blocked')
  const refused = planWorkflowUpdate(settings, items, input({ statuses: without }))
  assert.equal(refused.ok, false)
  if (!refused.ok) assert.match(refused.error, /“Blocked” is used by 2 tasks/)
  const moved = planWorkflowUpdate(settings, items, input({ statuses: without, statusMoves: { blocked: 'doing' } }))
  assert.ok(moved.ok)
  if (!moved.ok) return
  assert.deepEqual(
    moved.items.map(i => i.status),
    ['Open', 'In Progress', 'Closed', 'In Progress'],
  )
  assert.equal(moved.movedTasks, 2)
  // An unused status just goes.
  const unused = planWorkflowUpdate(
    settings,
    items,
    input({ statuses: settings.statuses.filter((s: any) => s.id !== 'doing') }),
  )
  assert.ok(unused.ok)
})

test('archived work stays done', () => {
  const reopened = planWorkflowUpdate(
    settings,
    items,
    input({ statuses: settings.statuses.map((s: any) => (s.id === 'closed' ? { ...s, closed: false } : s)) }),
  )
  assert.equal(reopened.ok, false)
  const statuses = [
    ...settings.statuses.filter((s: any) => s.id !== 'closed'),
    { id: 'done2', label: 'Done', closed: true },
  ]
  const toOpen = planWorkflowUpdate(settings, items, input({ statuses, statusMoves: { closed: 'open' } }))
  assert.equal(toOpen.ok, false, 'archived tasks cannot move to an open status')
  const toDone = planWorkflowUpdate(settings, items, input({ statuses, statusMoves: { closed: 'done2' } }))
  assert.ok(toDone.ok)
  if (!toDone.ok) return
  const before: any = { clients: [], projects: [], items, taskSettings: settings }
  assert.doesNotThrow(() =>
    assertLifecycleMutation(before, { ...before, items: toDone.items, taskSettings: toDone.taskSettings }, null),
  )
})

test('a browser save still cannot change an archived task', () => {
  const before: any = { clients: [], projects: [], items, taskSettings: settings }
  const edited = items.map(i => (i.id === 'c' ? { ...i, status: 'Open' } : i))
  assert.throws(() => assertLifecycleMutation(before, { ...before, items: edited }, null), /Reopen task/)
})

test('lists are checked', () => {
  const bad = (changes: any) => planWorkflowUpdate(settings, items, input(changes))
  assert.equal(bad({ statuses: [] }).ok, false)
  assert.equal(bad({ statuses: [...settings.statuses, { id: 'x', label: 'open', closed: false }] }).ok, false)
  assert.equal(bad({ statuses: settings.statuses.map((s: any) => ({ ...s, closed: true })) }).ok, false)
  assert.equal(bad({ statuses: settings.statuses.map((s: any) => ({ ...s, closed: false })) }).ok, false)
  assert.equal(bad({ visibleColumns: ['status', 'secret'] }).ok, false)
})

test('priority and health names change only what people see', () => {
  const plan = planWorkflowUpdate(
    settings,
    items,
    input({
      labels: { priority: { Urgent: 'P1', Low: '  ', Medium: 'Medium' }, health: { 'At Risk': 'Red' }, other: 1 },
    }),
  )
  assert.ok(plan.ok)
  if (!plan.ok) return
  assert.deepEqual(plan.taskSettings.labels, { priority: { Urgent: 'P1' }, health: { 'At Risk': 'Red' } })
  assert.equal(priorityLabel('Urgent', plan.taskSettings.labels), 'P1')
  assert.equal(priorityLabel('High', plan.taskSettings.labels), 'High')
  assert.equal(healthLabel('At Risk', plan.taskSettings.labels), 'Red')
  assert.deepEqual(plan.items, items, 'tasks keep their stored priority')
  assert.deepEqual(normalizeTaskSettings(plan.taskSettings).labels, plan.taskSettings.labels, 'the browser keeps them')
  assert.deepEqual(cleanLabels({ priority: { Urgent: 'x'.repeat(50) } }).priority?.Urgent?.length, 30)
})

test('the editor sees how many tasks use each status and option', () => {
  const view = workflowView({ items, taskSettings: settings }, settings)
  assert.deepEqual(view.usage.statuses, { Open: 1, Blocked: 2, Closed: 1 })
  assert.deepEqual(view.usage.waitingOn, { Internal: 2, Done: 1, Client: 1 })
})
