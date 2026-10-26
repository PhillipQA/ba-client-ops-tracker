import test from 'node:test'
import assert from 'node:assert/strict'
import {
  assertLifecycleMutation,
  isTaskArchived,
  LifecycleError,
  taskArchiveBlockers,
  type LifecycleStore,
} from '../src/features/tasks/lifecycle'
import type { WorkItem } from '../src/shared/types'

const actor = { role: 'Contributor', modules: ['clients', 'projects', 'items', 'action'], accountType: 'tenant' }
const statuses = [
  { id: 'open', label: 'Open', closed: false },
  { id: 'resolved', label: 'Resolved', closed: true },
  { id: 'closed', label: 'Closed', closed: true },
]
const item = (id: string, status: string, parentTaskId?: string, extra: Partial<WorkItem> = {}): WorkItem => ({
  id,
  title: id,
  parentTaskId,
  type: 'Task',
  priority: 'Medium',
  status,
  waitingOn: status === 'Open' ? 'Me' : 'Done',
  owner: '',
  dateRaised: '2026-10-01',
  followUpDate: '',
  description: '',
  resolution: '',
  source: 'Internal',
  ...extra,
})
const store = (items: WorkItem[]): LifecycleStore => ({
  clients: [],
  projects: [],
  items,
  taskSettings: { statuses, visibleColumns: [] },
})
const save = (before: WorkItem[], after: WorkItem[]) => assertLifecycleMutation(store(before), store(after), actor)
const rejects = (before: WorkItem[], after: WorkItem[], message: RegExp) =>
  assert.throws(
    () => save(before, after),
    (error: any) => error instanceof LifecycleError && message.test(error.message),
  )

test('a task closes only when all its subtasks are closed or resolved', () => {
  const before = [item('T', 'Open'), item('s1', 'Resolved', 'T'), item('s2', 'Open', 'T')]
  rejects(before, [item('T', 'Closed'), before[1], before[2]], /Complete the 1 open subtask of “T”/)
  // Closing the last subtask and the task in the same save is fine.
  save(before, [item('T', 'Resolved'), before[1], item('s2', 'Closed', 'T')])
  // A subtask waiting on the completion option counts as finished.
  save(before, [item('T', 'Resolved'), before[1], { ...before[2], waitingOn: 'Done' }])
})

test('only a closed task with finished subtasks can be archived; subtasks cannot be archived alone', () => {
  const open = [item('T', 'Open'), item('s1', 'Resolved', 'T')]
  rejects(open, [{ ...open[0], archived: true }, open[1]], /cannot be archived yet\. Close or resolve the task first/)
  const done = [item('T', 'Resolved'), item('s1', 'Resolved', 'T')]
  rejects(done, [done[0], { ...done[1], archived: true }], /Archive the parent task/)
  save(done, [{ ...done[0], archived: true, archivedAt: '2026-10-26T04:00:00Z' }, done[1]])
  assert.deepEqual(taskArchiveBlockers(open, open[0], store(open).taskSettings), ['Close or resolve the task first.'])
})

test('an archived task and its subtasks change only by reopening', () => {
  const archived = [item('T', 'Resolved', undefined, { archived: true }), item('s1', 'Resolved', 'T')]
  assert.equal(isTaskArchived(archived, archived[1]), true, 'its subtasks are archived with it')
  rejects(archived, [{ ...archived[0], title: 'Renamed' }, archived[1]], /Reopen task “T” before changing it/)
  rejects(archived, [archived[0], { ...archived[1], status: 'Open' }], /Reopen task “T” before changing its work/)
  rejects(archived, [archived[1]], /Reopen task “T” before deleting it/)
  rejects(archived, [...archived, item('s2', 'Open', 'T')], /Reopen task “T”/)
  // Reopening: unarchived and back to an open status in one save.
  const { archived: _a, ...rest } = archived[0]
  save(archived, [{ ...rest, status: 'Open', waitingOn: 'Me' }, archived[1]])
})
