import assert from 'node:assert/strict'
import test from 'node:test'
import { dayNumber, isoOf } from '../src/features/trackers/timelineModel'
import {
  buildLinks,
  cascade,
  conflicts,
  criticalPath,
  dependencyFields,
  earliestStart,
  lastEnd,
  parsePredecessors,
  rowDates,
} from '../src/features/trackers/trackerDependencies'
import type { TrackerColumn, TrackerRow } from '../src/features/trackers/trackerModel'

const columns: TrackerColumn[] = [
  { id: 'c_wbs', name: 'WBS', type: 'text' },
  { id: 'c_task', name: 'Task', type: 'text' },
  { id: 'c_pre', name: 'Predecessor', type: 'text' },
  { id: 'c_start', name: 'Start', type: 'date' },
  { id: 'c_end', name: 'End', type: 'date' },
]
const row = (id: string, wbs: string, task: string, pre: string, start: string, end: string): TrackerRow => ({
  id,
  position: 0,
  cells: { c_wbs: wbs, c_task: task, c_pre: pre, c_start: start, c_end: end },
  secretSet: {},
  taskId: '',
  version: 1,
  updatedAt: '',
})
// Nov 2026: the 2nd, 9th, 16th, 23rd and 30th are Mondays.
const rows = [
  row('survey', '1.1', 'Site survey', '', '2026-11-02', '2026-11-06'),
  row('sign', '1.2', 'Electrical sign-off', '1.1', '2026-11-09', '2026-11-13'),
  row('install', '2.1', 'Install fixtures', '1.2', '2026-11-16', '2026-11-20'),
  row('pos', '2.2', 'POS setup', '2.1', '2026-11-23', '2026-11-25'),
  row('train', '2.3', 'Staff training', '1.1', '2026-11-23', '2026-11-24'),
  row('live', '3.1', 'Go-live', '2.2 & 2.3', '2026-11-27', '2026-11-27'),
]
const fields = dependencyFields(columns)
const links = buildLinks(rows, fields)
const dates = rowDates(rows, 'c_start', 'c_end')
const day = (iso: string) => dayNumber(iso)!
const iso = (map: Map<string, { start: number; end: number }>) =>
  Object.fromEntries([...map].map(([id, value]) => [id, `${isoOf(value.start)}..${isoOf(value.end)}`]))

test('the Predecessor column and the WBS column are found by name', () => {
  assert.deepEqual(fields, { predecessorId: 'c_pre', keyId: 'c_wbs', titleId: 'c_task' })
  assert.equal(dependencyFields(columns.filter(column => column.id !== 'c_pre')), undefined)
})

test('predecessors are read as a sheet writes them, with lag', () => {
  assert.deepEqual(parsePredecessors('5.1 & 3.9'), [
    { ref: '5.1', lag: 0 },
    { ref: '3.9', lag: 0 },
  ])
  assert.deepEqual(parsePredecessors('2.1+2d, 1.1 - 1 day; Site survey'), [
    { ref: '2.1', lag: 2 },
    { ref: '1.1', lag: -1 },
    { ref: 'Site survey', lag: 0 },
  ])
  assert.deepEqual(parsePredecessors(''), [])
  assert.deepEqual(parsePredecessors(null), [])
})

test('links join rows by WBS or title; unknown references are reported', () => {
  assert.equal(links.all.length, 6)
  assert.deepEqual(
    links.into.get('live')?.map(link => link.from),
    ['pos', 'train'],
  )
  const odd = buildLinks([...rows, row('x', '9', 'Odd', '7.7 & site survey & 9', '2026-12-01', '2026-12-01')], fields)
  assert.deepEqual(odd.unknown.get('x'), ['7.7'])
  assert.deepEqual(
    odd.into.get('x')?.map(link => link.from),
    ['survey'],
    'By title, and never itself',
  )
})

test('a row starts the working day after its predecessor ends', () => {
  assert.equal(isoOf(earliestStart(day('2026-11-13'), 0)), '2026-11-16', 'Friday → Monday')
  assert.equal(isoOf(earliestStart(day('2026-11-11'), 0)), '2026-11-12')
  assert.equal(isoOf(earliestStart(day('2026-11-13'), 2)), '2026-11-18')
  assert.equal(isoOf(earliestStart(day('2026-11-13'), -1)), '2026-11-13')
})

test('moving a row later pushes the rows after it, keeping their length; rows with slack stay', () => {
  // Electrical sign-off slips three working days: Nov 12–18.
  const moved = cascade(dates, links, 'sign', { start: day('2026-11-12'), end: day('2026-11-18') })
  assert.deepEqual(iso(moved), {
    install: '2026-11-19..2026-11-25',
    pos: '2026-11-26..2026-11-30',
    live: '2026-12-01..2026-12-01',
  })
  assert.ok(!moved.has('train'), 'Staff training waits only for the survey')
  assert.equal(isoOf(lastEnd(dates, moved)!), '2026-12-01')
  // Moving earlier, or within the slack, pushes nothing.
  assert.equal(cascade(dates, links, 'sign', { start: day('2026-11-05'), end: day('2026-11-11') }).size, 0)
  assert.equal(cascade(dates, links, 'train', { start: day('2026-11-25'), end: day('2026-11-26') }).size, 0)
})

test('a loop in the links does not run forever', () => {
  const loop = [
    row('a', '1', 'A', '2', '2026-11-02', '2026-11-03'),
    row('b', '2', 'B', '1', '2026-11-04', '2026-11-05'),
  ]
  const loopLinks = buildLinks(loop, fields)
  const moved = cascade(rowDates(loop, 'c_start', 'c_end'), loopLinks, 'a', {
    start: day('2026-11-09'),
    end: day('2026-11-10'),
  })
  assert.deepEqual(iso(moved), { b: '2026-11-11..2026-11-12' })
})

test('rows that start too early are flagged, and the critical path is the chain that sets the end', () => {
  assert.equal(conflicts(dates, links).size, 0)
  const late = new Map(dates).set('sign', { start: day('2026-11-12'), end: day('2026-11-18') })
  assert.deepEqual([...conflicts(late, links)], ['install'])
  assert.deepEqual([...criticalPath(dates, links)], ['live', 'pos', 'install', 'sign', 'survey'])
  assert.equal(criticalPath(dates, buildLinks(rows, undefined)).size, 0)
})
