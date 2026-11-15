import assert from 'node:assert/strict'
import test from 'node:test'
import {
  boardField,
  boardLanes,
  calendarField,
  calendarTitle,
  cardFacts,
  mondayOf,
  monthDays,
  rowsByDay,
  stepAnchor,
  weekDays,
} from '../src/features/trackers/trackerBoard'
import type { TrackerColumn, TrackerRow } from '../src/features/trackers/trackerModel'

const status: TrackerColumn = {
  id: 'c_status',
  name: 'Status',
  type: 'select',
  options: [
    { id: 'o_new', label: 'Not started', color: 'gray' },
    { id: 'o_test', label: 'Testing', color: 'blue' },
    { id: 'o_live', label: 'Live', color: 'green' },
  ],
}
const owner: TrackerColumn = { id: 'c_owner', name: 'Owner', type: 'person' }
const columns: TrackerColumn[] = [
  { id: 'c_site', name: 'Site', type: 'text' },
  { id: 'c_type', name: 'Type', type: 'select', options: [{ id: 'o_mall', label: 'Mall', color: 'gray' }] },
  status,
  owner,
  { id: 'c_survey', name: 'Survey', type: 'date' },
  { id: 'c_go', name: 'Go-live', type: 'date' },
]
const row = (id: string, cells: TrackerRow['cells']): TrackerRow => ({
  id,
  position: 0,
  cells,
  secretSet: {},
  taskId: '',
  version: 1,
  updatedAt: '',
})
const rows = [
  row('a', { c_site: 'Makati', c_status: 'o_live', c_owner: 'u2', c_go: '2026-10-28' }),
  row('b', { c_site: 'BGC', c_status: 'o_new', c_owner: 'u1', c_go: '2026-11-20' }),
  row('c', { c_site: 'Festival', c_status: 'o_new', c_go: '2026-11-20' }),
  row('d', { c_site: 'Alabang', c_status: 'o_deleted' }),
]
const names: Record<string, string> = { u1: 'Ana', u2: 'Jun' }

test('the board stands on a Status column unless another is chosen', () => {
  assert.equal(boardField(columns, '')?.id, 'c_status')
  assert.equal(boardField(columns, 'c_owner')?.id, 'c_owner')
  assert.equal(boardField(columns, 'c_gone')?.id, 'c_status')
  assert.equal(boardField([columns[0]], ''), undefined)
})

test('a Choice board has a lane per option, in order; rows without a known value stand first', () => {
  const lanes = boardLanes(status, rows, id => names[id] || '')
  assert.deepEqual(
    lanes.map(lane => [lane.label, lane.value, lane.rows.map(item => item.id).join('')]),
    [
      ['No Status', '', 'd'],
      ['Not started', 'o_new', 'bc'],
      ['Testing', 'o_test', ''],
      ['Live', 'o_live', 'a'],
    ],
  )
  // No row without a value: no empty first lane.
  assert.equal(boardLanes(status, rows.slice(0, 3), () => '')[0].label, 'Not started')
})

test('a Person board has a lane per person with rows, by name, and Nobody', () => {
  const lanes = boardLanes(owner, rows, id => names[id] || '')
  assert.deepEqual(
    lanes.map(lane => [lane.label, lane.rows.length]),
    [
      ['Nobody', 2],
      ['Ana', 1],
      ['Jun', 1],
    ],
  )
})

test('a card shows a few facts, dates first, without its title or the lane’s field', () => {
  const text = (column: TrackerColumn, item: TrackerRow) => String(item.cells[column.id] ?? '')
  assert.deepEqual(cardFacts(rows[0], columns, status, text), [
    { name: 'Go-live', text: '2026-10-28' },
    { name: 'Owner', text: 'u2' },
  ])
})

test('the calendar shows whole weeks from Monday, and steps by month or week', () => {
  assert.equal(calendarField(columns, '')?.id, 'c_go')
  assert.equal(calendarField(columns, 'c_survey')?.id, 'c_survey')
  assert.equal(mondayOf('2026-11-15'), '2026-11-09')
  const november = monthDays('2026-11-15')
  assert.equal(november[0], '2026-10-26')
  assert.equal(november[november.length - 1], '2026-12-06')
  assert.equal(november.length % 7, 0)
  // A month that starts on a Monday and fills four weeks exactly.
  assert.deepEqual([monthDays('2027-02-10')[0], monthDays('2027-02-10').length], ['2027-02-01', 28])
  assert.deepEqual(weekDays('2026-11-15'), [
    '2026-11-09',
    '2026-11-10',
    '2026-11-11',
    '2026-11-12',
    '2026-11-13',
    '2026-11-14',
    '2026-11-15',
  ])
  assert.equal(stepAnchor('2026-12-31', 'month', 2), '2027-02-01')
  assert.equal(stepAnchor('2026-11-15', 'week', -1), '2026-11-08')
  assert.equal(calendarTitle('2026-11-15', 'month'), 'November 2026')
  assert.equal(calendarTitle('2026-11-15', 'week'), 'Nov 9 – 15, 2026')
  assert.equal(calendarTitle('2026-12-01', 'week'), 'Nov 30 – Dec 6, 2026')
})

test('rows fall on the day of their date; rows without one are set aside', () => {
  const { byDay, undated } = rowsByDay(rows, columns[5])
  assert.deepEqual(
    byDay.get('2026-11-20')?.map(item => item.id),
    ['b', 'c'],
  )
  assert.deepEqual(
    undated.map(item => item.id),
    ['d'],
  )
})
