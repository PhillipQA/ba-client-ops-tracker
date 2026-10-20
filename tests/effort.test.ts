import test from 'node:test'
import assert from 'node:assert/strict'
import { capacityHoursBetween, effortRows, effortSummary, formatHours, normalizeEstimate, validateTimeEntryInput, workingDaysBetween, type TimeEntry } from '../src/effort'
import { addTimeEntry, applyEffortSaveRules, removeTimeEntry } from '../server/services/time-entries'
import { boardColumns } from '../src/taskBoardModel'
import { workspaceVersion } from '../server/services/workspace-version'
import type { TaskSettings, WorkItem } from '../src/types'

const entry = (overrides: Partial<TimeEntry> = {}): TimeEntry => ({ id: crypto.randomUUID(), date: '2026-10-15', hours: 1, category: 'Analysis', note: '', userId: 'maria', userName: 'Maria', createdAt: '2026-10-15T01:00:00.000Z', ...overrides })

test('time entry input is validated and rounded to quarter hours', () => {
  assert.deepEqual(validateTimeEntryInput({ date: '2026-10-19', hours: 1.3, category: 'Meeting', note: '  call  ' }), { ok: true, value: { date: '2026-10-19', hours: 1.25, category: 'Meeting', note: 'call' } })
  assert.equal(validateTimeEntryInput({ date: '2026-02-30', hours: 1, category: 'Meeting' }).ok, false)
  assert.equal(validateTimeEntryInput({ date: '2026-10-19', hours: 0.1, category: 'Meeting' }).ok, false)
  assert.equal(validateTimeEntryInput({ date: '2026-10-19', hours: 25, category: 'Meeting' }).ok, false)
  assert.equal(validateTimeEntryInput({ date: '2026-10-19', hours: 'abc', category: 'Meeting' }).ok, false)
  assert.equal(validateTimeEntryInput({ date: '2026-10-19', hours: 1, category: 'Gaming' }).ok, false)
  assert.equal(validateTimeEntryInput({ date: '2026-10-19', hours: 1, category: 'Meeting', note: 'x'.repeat(501) }).ok, false)
})

test('estimates are optional, non-negative and capped', () => {
  assert.deepEqual(normalizeEstimate(''), { ok: true, value: undefined })
  assert.deepEqual(normalizeEstimate('0'), { ok: true, value: undefined })
  assert.deepEqual(normalizeEstimate('6.1'), { ok: true, value: 6 })
  assert.equal(normalizeEstimate(-1).ok, false)
  assert.equal(normalizeEstimate(5000).ok, false)
  assert.equal(normalizeEstimate('ten').ok, false)
})

test('parent effort rolls up subtask time, and subtask estimates when the parent has none', () => {
  const parent = { id: 'p', timeEntries: [entry({ hours: 2, category: 'Meeting' })] }
  const child = { id: 'c', parentTaskId: 'p', estimateHours: 3, timeEntries: [entry({ hours: 2.5 })] }
  const summary = effortSummary(parent, [parent, child])
  assert.equal(summary.logged, 4.5)
  assert.equal(summary.subtaskLogged, 2.5)
  assert.equal(summary.estimate, 3)
  assert.equal(summary.estimateFromSubtasks, true)
  assert.equal(summary.overBy, 1.5)
  assert.equal(summary.percent, 150)
  assert.deepEqual(summary.byCategory, [{ category: 'Analysis', hours: 2.5 }, { category: 'Meeting', hours: 2 }])
  // A subtask never rolls anything up.
  assert.equal(effortSummary(child, [parent, child]).logged, 2.5)
  // A parent's own estimate wins over its subtasks'.
  assert.equal(effortSummary({ ...parent, estimateHours: 10 }, [parent, child]).estimate, 10)
})

test('hours format compactly', () => {
  assert.equal(formatHours(1.5), '1.5h')
  assert.equal(formatHours(1.25), '1.25h')
  assert.equal(formatHours(3), '3h')
})

test('capacity counts weekdays only', () => {
  assert.equal(workingDaysBetween('2026-10-19', '2026-10-25'), 5)
  assert.equal(workingDaysBetween('2026-10-24', '2026-10-25'), 0)
  assert.equal(capacityHoursBetween('2026-10-01', '2026-10-31'), 22 * 8)
})

test('report rows filter by range, client, project and the person who logged the time', () => {
  const items = [
    { id: 'a', clientId: 'acme', projectId: 'x', timeEntries: [entry({ date: '2026-10-01', userId: 'maria' }), entry({ date: '2026-09-30' })] },
    { id: 'b', clientId: 'acme', projectId: 'y', timeEntries: [entry({ date: '2026-10-02', userId: 'jo' })] },
    { id: 'c', clientId: 'north', timeEntries: [entry({ date: '2026-10-03' })] },
  ]
  assert.equal(effortRows(items, { from: '2026-10-01', to: '2026-10-31' }).length, 3)
  assert.equal(effortRows(items, { from: '2026-10-01', to: '2026-10-31', clientId: 'acme' }).length, 2)
  assert.equal(effortRows(items, { from: '2026-10-01', to: '2026-10-31', projectId: 'y' }).length, 1)
  assert.equal(effortRows(items, { from: '2026-10-01', to: '2026-10-31', userId: 'jo' }).length, 1)
})

test('workspace saves cannot add, change or remove time entries', () => {
  const stored = { id: 't', title: 'Task', timeEntries: [entry({ id: 'kept' })] }
  const forged = { id: 't', title: 'Task', estimateHours: '4.1', timeEntries: [entry({ id: 'forged', hours: 20 })] }
  const result = applyEffortSaveRules(stored, forged)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.value.timeEntries.map((row: TimeEntry) => row.id), ['kept'])
  assert.equal(result.value.estimateHours, 4)
  // New tasks start with no time logged, whatever the browser sends.
  const created = applyEffortSaveRules(undefined, forged)
  assert.equal(created.ok && created.value.timeEntries.length, 0)
  // A cleared estimate is removed.
  const cleared = applyEffortSaveRules(stored, { ...stored, estimateHours: '' })
  assert.equal(cleared.ok && 'estimateHours' in cleared.value, false)
  assert.equal(applyEffortSaveRules(stored, { ...stored, estimateHours: -2 }).ok, false)
})

test('time entries record the signed-in author and only the author or an Administrator can remove them', () => {
  const task = { id: 't', timeEntries: [] }
  const now = new Date('2026-10-19T03:00:00.000Z')
  const added = addTimeEntry(task, { date: '2026-10-19', hours: 1.5, category: 'Analysis', note: 'Spec', userId: 'someone-else' }, { id: 'maria', name: 'Maria', role: 'Contributor' }, now, 'entry-1')
  assert.equal(added.ok, true)
  if (!added.ok) return
  assert.equal(added.value.entry.userId, 'maria')
  assert.equal(added.value.entry.createdAt, now.toISOString())
  assert.equal(added.value.task.timeEntries.length, 1)
  const denied = removeTimeEntry(added.value.task, 'entry-1', { id: 'jo', role: 'Contributor' })
  assert.deepEqual(denied.ok ? null : denied.status, 403)
  assert.equal(removeTimeEntry(added.value.task, 'entry-1', { id: 'admin', role: 'Administrator' }).ok, true)
  const own = removeTimeEntry(added.value.task, 'entry-1', { id: 'maria', role: 'Contributor' })
  assert.equal(own.ok && own.value.task.timeEntries.length, 0)
  const missing = removeTimeEntry(added.value.task, 'nope', { id: 'maria', role: 'Contributor' })
  assert.deepEqual(missing.ok ? null : missing.status, 404)
  const invalid = addTimeEntry(task, { date: 'soon', hours: 1, category: 'Analysis' }, { id: 'maria' }, now, 'entry-2')
  assert.deepEqual(invalid.ok ? null : invalid.status, 400)
})

test('logging time does not change the workspace version used for save conflicts', () => {
  const base = { clients: [], projects: [], planner: [], rtms: [], items: [{ id: 't', title: 'Task', timeEntries: [] }] }
  const withTime = { ...base, items: [{ id: 't', title: 'Task', timeEntries: [entry()] }] }
  assert.equal(workspaceVersion(base), workspaceVersion(withTime))
  assert.notEqual(workspaceVersion(base), workspaceVersion({ ...base, items: [{ id: 't', title: 'Task', estimateHours: 3, timeEntries: [] }] }))
})

test('board columns follow configured statuses or waiting-on, with closed work collapsed', () => {
  const settings: TaskSettings = { statuses: [{ id: 'open', label: 'Open', closed: false }, { id: 'blocked', label: 'Blocked', closed: false }, { id: 'resolved', label: 'Resolved', closed: true }], visibleColumns: ['status'] }
  const item = (id: string, status: string, waitingOn: WorkItem['waitingOn'], priority: WorkItem['priority'] = 'Medium', dueDate = '') => ({ id, status, waitingOn, priority, dueDate, title: id, followUpDate: '' }) as WorkItem
  const items = [item('low', 'Open', 'Me', 'Low'), item('urgent', 'Open', 'Client', 'Urgent'), item('done', 'Resolved', 'Done'), item('legacy', 'Parked', 'Me')]
  const byStatus = boardColumns(items, 'status', settings)
  assert.deepEqual(byStatus.map((column) => column.label), ['Open', 'Blocked', 'Resolved', 'Other status'])
  assert.deepEqual(byStatus[0].items.map((row) => row.id), ['urgent', 'low'])
  assert.equal(byStatus[1].tone, 'blocked')
  assert.equal(byStatus[2].collapsed, true)
  assert.equal(byStatus[3].acceptsDrops, false)
  const byWaiting = boardColumns(items, 'waiting', settings)
  assert.deepEqual(byWaiting.map((column) => column.key), ['Me', 'Developer', 'Client', 'QA', 'Design', 'Done'])
  assert.equal(byWaiting.find((column) => column.key === 'Done')?.acceptsDrops, false)
})
