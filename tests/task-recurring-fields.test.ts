import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { defaultTaskSettings } from '../src/app/data'
import { isTaskClosed, normalizeTaskSettings } from '../src/app/store'
import {
  cleanCustomValues,
  cleanFieldDefs,
  cleanFieldValue,
  customSearchText,
  fieldIdFor,
  fieldText,
  type TaskFieldDef,
} from '../src/features/tasks/customFields'
import {
  cleanRecurrence,
  nextCopy,
  nextDueDay,
  nextOccurrence,
  recurrenceText,
  withRecurrences,
} from '../src/features/tasks/recurrence'
import { planWorkflowUpdate } from '../src/features/tasks/workflow'
import type { WorkItem } from '../src/shared/types'

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
const settings = defaultTaskSettings
const openStatus = settings.statuses.find(status => !status.closed)!.label
const closedStatus = settings.statuses.find(status => status.closed)!.label
const task = (id: string, extra: Partial<WorkItem> = {}) =>
  ({
    id,
    title: `Task ${id}`,
    type: 'Task',
    priority: 'Medium',
    status: openStatus,
    waitingOn: 'Me',
    owner: 'Phillip',
    dateRaised: '2026-11-01',
    followUpDate: '',
    description: 'Weekly status report',
    resolution: '',
    source: 'Internal',
    ...extra,
  }) as WorkItem

test('repeat rules: cleaned, with weekdays, workdays and month day only where they apply', () => {
  assert.deepEqual(cleanRecurrence({ every: '2', unit: 'week', weekdays: [4, 1, 1, 9] }), {
    every: 2,
    unit: 'week',
    weekdays: [1, 4],
  })
  assert.deepEqual(cleanRecurrence({ every: 1, unit: 'day', workdaysOnly: true, weekdays: [1] }), {
    every: 1,
    unit: 'day',
    workdaysOnly: true,
  })
  assert.deepEqual(cleanRecurrence({ every: 1, unit: 'month', monthDay: 31, until: '2026-12-31' }), {
    every: 1,
    unit: 'month',
    monthDay: 31,
    until: '2026-12-31',
  })
  for (const bad of [null, {}, { every: 0, unit: 'day' }, { every: 1, unit: 'hour' }, { every: 100, unit: 'day' }])
    assert.equal(cleanRecurrence(bad), undefined)
  assert.equal(recurrenceText({ every: 1, unit: 'week', weekdays: [1, 4] }), 'Every week on Mon, Thu')
  assert.equal(recurrenceText({ every: 2, unit: 'day', workdaysOnly: true }), 'Every 2 days (workdays)')
})

test('the next occurrence: days, workdays, weekdays, every 2 weeks, month ends and leap days', () => {
  assert.equal(nextOccurrence('2026-11-23', { every: 3, unit: 'day' }), '2026-11-26')
  assert.equal(nextOccurrence('2026-11-27', { every: 1, unit: 'day', workdaysOnly: true }), '2026-11-30', 'Fri → Mon')
  // 2026-11-23 is a Monday.
  assert.equal(nextOccurrence('2026-11-23', { every: 1, unit: 'week', weekdays: [1, 4] }), '2026-11-26', 'Mon → Thu')
  assert.equal(nextOccurrence('2026-11-26', { every: 1, unit: 'week', weekdays: [1, 4] }), '2026-11-30', 'Thu → Mon')
  assert.equal(nextOccurrence('2026-11-26', { every: 2, unit: 'week', weekdays: [1, 4] }), '2026-12-07')
  assert.equal(nextOccurrence('2026-11-23', { every: 1, unit: 'week' }), '2026-11-30', 'same weekday by default')
  assert.equal(nextOccurrence('2026-01-31', { every: 1, unit: 'month', monthDay: 31 }), '2026-02-28')
  assert.equal(nextOccurrence('2026-02-28', { every: 1, unit: 'month', monthDay: 31 }), '2026-03-31', 'keeps day 31')
  assert.equal(nextOccurrence('2028-02-29', { every: 1, unit: 'year' }), '2029-02-28')
})

test('missed occurrences are skipped, and the series ends at its end date', () => {
  const rule = { every: 1, unit: 'week' as const }
  assert.equal(nextDueDay({ dueDate: '2026-11-02' }, rule, '2026-11-23'), '2026-11-23', 'not in the past')
  assert.equal(nextDueDay({ dueDate: '2026-11-23' }, rule, '2026-11-23'), '2026-11-30')
  assert.equal(nextDueDay({}, rule, '2026-11-23'), '2026-11-30', 'counts from the day it closed')
  assert.equal(nextDueDay({ dueDate: '2026-11-23' }, { ...rule, until: '2026-11-29' }, '2026-11-23'), null)
})

test('the next copy: same details, Open, dates moved, subtasks copied, nothing done carried over', () => {
  const parent = task('p', {
    status: closedStatus,
    startDate: '2026-11-20',
    dueDate: '2026-11-23',
    followUpDate: '2026-11-22',
    resolution: 'Sent',
    resolvedDate: '2026-11-23',
    comments: [{ id: 'c' } as any],
    evidence: [{ id: 'e' } as any],
    timeEntries: [{ id: 't' } as any],
    estimateHours: 2,
    custom: { module: 'Billing' },
    recurrence: { every: 1, unit: 'week' },
  })
  const sub = task('s', { parentTaskId: 'p', status: closedStatus, dueDate: '2026-11-22', subtaskOrder: 0 })
  let n = 0
  const copy = nextCopy(parent, [parent, sub], { openStatus, openWaitingOn: 'Me' }, '2026-11-23', () => `new${++n}`)!
  assert.equal(copy.length, 2)
  const [head, child] = copy
  assert.equal(head.id, 'new1')
  assert.equal(head.status, openStatus)
  assert.equal(head.dueDate, '2026-11-30')
  assert.equal(head.startDate, '2026-11-27', 'moved by the same 7 days')
  assert.equal(head.followUpDate, '2026-11-29')
  assert.equal(head.resolution, '')
  assert.equal(head.resolvedDate, undefined)
  for (const key of ['comments', 'evidence', 'timeEntries', 'recurrenceNextId'] as const)
    assert.equal(head[key], undefined, key)
  assert.equal(head.estimateHours, 2)
  assert.deepEqual(head.custom, { module: 'Billing' })
  assert.equal(head.recurrenceOf, 'p')
  assert.deepEqual(head.recurrence, { every: 1, unit: 'week' })
  assert.equal(child.parentTaskId, 'new1')
  assert.equal(child.status, openStatus)
  assert.equal(child.dueDate, '2026-11-29')
  assert.equal(
    nextCopy(sub, [parent, sub], { openStatus, openWaitingOn: 'Me' }, '2026-11-23'),
    null,
    'subtasks don’t repeat',
  )
})

test('closing a repeating task makes the next one once; other changes make nothing', () => {
  const rule = { every: 1, unit: 'day' as const }
  const before = [task('a', { recurrence: rule, dueDate: '2026-11-23' }), task('b', { recurrence: rule }), task('c')]
  const after = [
    { ...before[0], status: closedStatus },
    { ...before[1], title: 'Renamed' },
    { ...before[2], status: closedStatus },
  ]
  const open = { openStatus, openWaitingOn: 'Me' as WorkItem['waitingOn'] }
  const first = withRecurrences(before, after, settings, isTaskClosed, open, '2026-11-23', () => 'next-a')
  assert.equal(first.made.length, 1)
  assert.equal(first.items.length, 4)
  assert.equal(first.items[0].recurrenceNextId, 'next-a')
  assert.equal(first.items[3].dueDate, '2026-11-24')
  // Reopened and closed again: the copy already exists.
  const reopened = first.items.map(item => (item.id === 'a' ? { ...item, status: openStatus } : item))
  const again = reopened.map(item => (item.id === 'a' ? { ...item, status: closedStatus } : item))
  assert.equal(withRecurrences(reopened, again, settings, isTaskClosed, open, '2026-11-23').made.length, 0)
  // A task added already closed, or one that was closed before, makes nothing.
  const created = withRecurrences(
    [],
    [task('x', { recurrence: rule, status: closedStatus })],
    settings,
    isTaskClosed,
    open,
    '2026-11-23',
  )
  assert.equal(created.made.length, 0)
})

test('custom fields: definitions cleaned, values by type, removed fields’ values kept', () => {
  const defs = cleanFieldDefs([
    { id: 'module', name: 'Module', type: 'select', options: ['Billing', 'Billing', ' Auth '], showInTable: true },
    { id: 'points', name: 'Story points', type: 'number' },
    { id: 'dup', name: 'module', type: 'text' },
    { id: 'empty', name: 'Empty choice', type: 'select', options: [] },
    { id: 'link', name: 'Ticket', type: 'url' },
    { id: 'ok', name: 'Signed off', type: 'checkbox' },
    { name: 'No id', type: 'text' },
  ])
  assert.deepEqual(
    defs.map(def => def.id),
    ['module', 'points', 'link', 'ok'],
  )
  assert.deepEqual(defs[0].options, ['Billing', 'Auth'])
  const [module, points, link, ok] = defs
  assert.equal(cleanFieldValue(points, '3.5'), 3.5)
  assert.equal(cleanFieldValue(points, 'lots'), undefined)
  assert.equal(cleanFieldValue(link, 'gitlab.com/x/-/issues/7'), 'https://gitlab.com/x/-/issues/7')
  assert.equal(cleanFieldValue(link, 'javascript:alert(1)'), undefined)
  assert.equal(cleanFieldValue(ok, false), undefined)
  assert.equal(cleanFieldValue(ok, true), true)
  assert.equal(cleanFieldValue({ id: 'd', name: 'D', type: 'date' }, '2026-11-23T10:00'), '2026-11-23')
  assert.deepEqual(
    cleanCustomValues(defs, { module: 'Billing', points: '', link: '' }, { old: 'kept', module: 'Auth' }),
    { old: 'kept', module: 'Billing' },
  )
  assert.equal(cleanCustomValues(defs, {}), undefined)
  assert.equal(fieldText(ok, true), 'Yes')
  assert.equal(fieldText({ id: 'd', name: 'D', type: 'date' } as TaskFieldDef, '2026-11-23'), 'Nov 23, 2026')
  assert.equal(customSearchText(defs, { custom: { module: 'Billing', points: 3 } }), 'Billing 3')
  assert.equal(fieldIdFor('Story points', ['story-points']), 'story-points-2')
  assert.equal(module.showInTable, true)
})

test('workflow: custom fields are kept unless sent, saved when sent, refused when invalid', () => {
  const current = { ...settings, customFields: [{ id: 'module', name: 'Module', type: 'text' as const }] }
  const base = { statuses: current.statuses, visibleColumns: current.visibleColumns }
  const kept = planWorkflowUpdate(current, [], base)
  assert.ok(kept.ok)
  assert.deepEqual(kept.ok && kept.taskSettings.customFields, current.customFields)
  const saved = planWorkflowUpdate(current, [], {
    ...base,
    customFields: [{ id: 'pts', name: 'Points', type: 'number' }],
  })
  assert.ok(saved.ok)
  assert.deepEqual(saved.ok && saved.taskSettings.customFields, [{ id: 'pts', name: 'Points', type: 'number' }])
  const cleared = planWorkflowUpdate(current, [], { ...base, customFields: [] })
  assert.equal(cleared.ok && 'customFields' in cleared.taskSettings, false)
  const bad = planWorkflowUpdate(current, [], { ...base, customFields: [{ id: 'x', name: '', type: 'text' }] })
  assert.equal(bad.ok, false)
  assert.deepEqual(
    normalizeTaskSettings({ ...settings, customFields: [{ id: 'a', name: 'A', type: 'nope' } as any] }).customFields,
    undefined,
  )
  assert.deepEqual(normalizeTaskSettings(current).customFields, current.customFields)
})

test('wiring: every close goes through recurrence, forms, table, search, settings and history', () => {
  const save = read('src/app/state/useWorkspaceSave.ts')
  assert.match(save, /const repeated = withRecurrences\(/)
  assert.match(save, /Repeating task: made the next/)
  const forms = read('src/features/tasks/TaskForms.tsx')
  assert.match(forms, /<RepeatField/)
  assert.match(forms, /<CustomFieldInputs/)
  assert.match(forms, /recurrence: parent \? undefined : repeat/)
  assert.match(forms, /custom: cleanCustomValues\(customFields, customValues, item\.custom\)/)
  const table = read('src/features/tasks/TaskTable.tsx')
  assert.match(table, /shownFields = \(taskSettings\.customFields \|\| \[\]\)\.filter\(field => field\.showInTable\)/)
  assert.match(table, /<RepeatBadge/)
  assert.match(read('src/features/tasks/TaskBoard.tsx'), /<RepeatBadge/)
  assert.match(read('src/app/state/useWorkViews.ts'), /customSearchText\(store\.taskSettings\.customFields/)
  assert.match(read('src/features/settings/WorkflowEditor.tsx'), /<CustomFieldsEditor/)
  const history = read('server/core/tenant-state.ts')
  assert.match(history, /\['recurrence', 'repeat'\]/)
  assert.match(history, /\['custom', 'custom fields'\]/)
  // Closing rules are unchanged: recurrence only adds the next task after a close.
  for (const file of ['src/features/tasks/lifecycle.ts', 'src/features/tasks/closeSubtasks.ts'])
    assert.doesNotMatch(read(file), /recurrence|customFields/, file)
})
