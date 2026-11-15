import assert from 'node:assert/strict'
import test from 'node:test'
import { cleanTimelineSettings } from '../src/features/trackers/timelineModel'
import {
  cleanAutomations,
  describeAutomation,
  newAutomation,
  planAutomations,
  setCellValue,
  triggered,
} from '../src/features/trackers/trackerAutomations'
import type { TrackerColumn, TrackerRow } from '../src/features/trackers/trackerModel'
import { makeLookup } from '../src/features/trackers/trackerQuery'

const columns: TrackerColumn[] = [
  { id: 'c_site', name: 'Site', type: 'text' },
  {
    id: 'c_status',
    name: 'Status',
    type: 'select',
    options: [
      { id: 'o_new', label: 'Not started', color: 'gray' },
      { id: 'o_live', label: 'Live', color: 'green' },
      { id: 'o_block', label: 'Blocked', color: 'red' },
    ],
  },
  { id: 'c_done', name: 'Done date', type: 'date' },
  { id: 'c_ok', name: 'Signed off', type: 'checkbox' },
  { id: 'c_owner', name: 'Owner', type: 'person' },
  { id: 'c_type', name: 'Type', type: 'text', synced: true },
]
const row = (cells: TrackerRow['cells'], extra: Partial<TrackerRow> = {}): TrackerRow => ({
  id: 'r1',
  position: 0,
  cells,
  secretSet: {},
  taskId: '',
  version: 1,
  updatedAt: '',
  ...extra,
})
const today = '2026-11-16'
const lookup = { ...makeLookup([], [{ id: 'u1', name: 'Lea Cruz', username: 'lea' }], today), columns }
const live = {
  id: 'a_live',
  when: { kind: 'changed', columnId: 'c_status', to: 'o_live' },
  conditions: [],
  then: [
    { kind: 'set', columnId: 'c_done', value: 'today' },
    { kind: 'set', columnId: 'c_ok', value: 'true' },
  ],
}
const added = {
  id: 'a_added',
  when: { kind: 'added' },
  conditions: [],
  then: [{ kind: 'task', assigneeColumnId: 'c_owner' }],
}
const blocked = {
  id: 'a_block',
  when: { kind: 'changed', columnId: 'c_status', to: 'o_block' },
  conditions: [{ columnId: 'c_site', op: 'not_empty', value: '' }],
  then: [
    { kind: 'notify', people: ['u1'] },
    { kind: 'comment', text: 'Blocked, please check' },
  ],
}

test('automations are cleaned: known columns, values that fit, at least one action', () => {
  const list = cleanAutomations(
    [
      live,
      added,
      blocked,
      { id: 'a_none', when: { kind: 'added' }, conditions: [], then: [] },
      { id: 'a_bad', when: { kind: 'changed', columnId: 'c_gone' }, then: [{ kind: 'comment', text: 'x' }] },
      { id: 'a_badset', when: { kind: 'added' }, then: [{ kind: 'set', columnId: 'c_status', value: 'o_nope' }] },
      {
        id: 'a_synced',
        when: { kind: 'added' },
        then: [
          { kind: 'set', columnId: 'c_type', value: 'x' },
          { kind: 'comment', text: ' ok ' },
        ],
      },
    ],
    columns,
  )
  assert.deepEqual(
    list.map(item => item.id),
    ['a_live', 'a_added', 'a_block', 'a_synced'],
  )
  assert.equal(list[3].then.length, 2, 'A Sheet column may be named; the run skips it')
  assert.deepEqual(list[3].then[1], { kind: 'comment', text: 'ok' })
  assert.equal(cleanTimelineSettings({ automations: [live] }, columns).automations?.length, 1)
})

test('a save starts the automations whose trigger and conditions match', () => {
  const list = cleanAutomations([live, added, blocked], columns)
  const was = row({ c_site: 'Festival', c_status: 'o_new' })
  const ids = (before: TrackerRow | null, after: TrackerRow) =>
    triggered(list, before, after, columns, lookup, today).map(item => item.id)
  assert.deepEqual(ids(was, row({ c_site: 'Festival', c_status: 'o_live' })), ['a_live'])
  assert.deepEqual(ids(was, row({ c_site: 'Festival', c_status: 'o_block' })), ['a_block'])
  assert.deepEqual(ids(was, row({ c_status: 'o_block' })), [], 'Condition fails: no site')
  assert.deepEqual(ids(was, was), [], 'Nothing changed')
  assert.deepEqual(ids(null, row({ c_site: 'New' })), ['a_added'])
  assert.deepEqual(ids(was, row({ c_site: 'Renamed', c_status: 'o_new' })), [], 'Not a watched change')
  assert.deepEqual(triggered([{ ...list[0], off: true }], was, row({ c_status: 'o_live' }), columns, lookup, today), [])
})

test('the plan: values to set, the task, people, comments; and what it skipped', () => {
  const list = cleanAutomations([live, added, blocked], columns)
  const options = {
    today,
    locked: (column: TrackerColumn) => Boolean(column.synced),
    tasksByTemplate: false,
    personName: (id: string) => (id === 'u1' ? 'Lea Cruz' : ''),
  }
  const plan = planAutomations(list, row({ c_site: 'Festival', c_owner: 'u9' }), columns, options)
  assert.deepEqual(plan.cells, { c_done: today, c_ok: true })
  assert.deepEqual(plan.task, { assignee: 'u9' })
  assert.deepEqual(plan.notify, ['u1'])
  assert.deepEqual(plan.comments, ['Blocked, please check'])
  assert.deepEqual(plan.done, [
    'set Done date',
    'set Signed off',
    'created its task',
    'notified Lea Cruz',
    'added a comment',
  ])
  // A row with a task, a tracker that makes its own tasks, a nameless row, a Sheet cell.
  assert.equal(planAutomations(list, row({ c_site: 'X' }, { taskId: 't1' }), columns, options).task, null)
  const byTemplate = planAutomations([list[1]], row({ c_site: 'X' }), columns, { ...options, tasksByTemplate: true })
  assert.deepEqual([byTemplate.task, byTemplate.skipped], [null, ['this tracker makes its tasks by itself']])
  assert.deepEqual(planAutomations([list[1]], row({}), columns, options).skipped, ['no task: the row has no name yet'])
  const sheet = planAutomations(
    cleanAutomations(
      [{ id: 'a_s', when: { kind: 'added' }, then: [{ kind: 'set', columnId: 'c_type', value: 'x' }] }],
      columns,
    ),
    row({}),
    columns,
    options,
  )
  assert.deepEqual([sheet.cells, sheet.skipped], [{}, ['Type comes from the Google Sheet']])
  assert.equal(setCellValue(columns[2], 'today', today), today)
  assert.equal(setCellValue(columns[3], 'false', today), false)
})

test('an automation reads as a sentence; a new one starts on Status', () => {
  const [first, , third] = cleanAutomations([live, added, blocked], columns)
  const name = (id: string) => (id === 'u1' ? 'Lea Cruz' : '')
  assert.equal(
    describeAutomation(first, columns, name),
    'Status changes to Live → Set Done date to today; Set Signed off to ticked',
  )
  assert.equal(
    describeAutomation(third, columns, name),
    'Status changes to Blocked, if Site is not empty → Notify Lea Cruz; Add a comment: “Blocked, please check”',
  )
  const fresh = newAutomation(columns)
  assert.deepEqual(fresh?.when, { kind: 'changed', columnId: 'c_status', to: 'o_block' })
  assert.deepEqual(fresh?.then, [{ kind: 'set', columnId: 'c_done', value: 'today' }])
})
