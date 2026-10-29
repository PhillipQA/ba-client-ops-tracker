import test from 'node:test'
import assert from 'node:assert/strict'
import type { TrackerColumn, TrackerRow } from '../src/features/trackers/trackerModel'
import {
  buildTimeline,
  dayNumber,
  guessTimelineFields,
  isoOf,
  mondayOf,
  settleTimelineFields,
  weekLabel,
  workingDays,
} from '../src/features/trackers/trackerTimeline'
import { TRACKER_TEMPLATES } from '../src/features/trackers/trackerTemplates'

const columns: TrackerColumn[] = [
  { id: 'c_task', name: 'Task', type: 'text' },
  { id: 'c_wbs', name: 'WBS', type: 'text' },
  {
    id: 'c_phase',
    name: 'Phase',
    type: 'select',
    options: [
      { id: 'p1', label: 'Project Planning', color: 'blue' },
      { id: 'p2', label: 'Data Build-up', color: 'purple' },
    ],
  },
  { id: 'c_lead', name: 'Lead', type: 'text' },
  { id: 'c_start', name: 'Start', type: 'date' },
  { id: 'c_end', name: 'End', type: 'date' },
  { id: 'c_pct', name: '% Done', type: 'number' },
  {
    id: 'c_status',
    name: 'Status',
    type: 'select',
    options: [
      { id: 's1', label: 'Pending', color: 'gray' },
      { id: 's2', label: 'Done', color: 'green' },
    ],
  },
]
let n = 0
const row = (cells: TrackerRow['cells']): TrackerRow => ({
  id: `r${++n}`,
  position: n,
  cells,
  secretSet: {},
  taskId: '',
  version: 1,
  updatedAt: '',
})
const fields = guessTimelineFields(columns)
const today = dayNumber('2026-07-01')!

test('the columns are picked by type and name', () => {
  assert.deepEqual(fields, {
    startId: 'c_start',
    endId: 'c_end',
    progressId: 'c_pct',
    groupId: 'c_phase',
    statusId: 'c_status',
    leadId: 'c_lead',
  })
  const saved = settleTimelineFields(columns, { endId: '', progressId: 'c_gone', startId: 'c_task' })
  assert.equal(saved.endId, '', 'choosing None is kept')
  assert.equal(saved.progressId, 'c_pct', 'a column that no longer exists falls back to the guess')
  assert.equal(saved.startId, 'c_start', 'a column of the wrong type falls back to the guess')
})

test('days, weeks and working days work like the sheet', () => {
  const kickoff = dayNumber('2026-01-21')! // a Wednesday
  assert.equal(isoOf(mondayOf(kickoff)), '2026-01-19')
  assert.equal(weekLabel(kickoff, mondayOf(kickoff)), 'Week 1')
  assert.equal(weekLabel(dayNumber('2026-02-02')!, mondayOf(kickoff)), 'Week 3')
  assert.equal(workingDays(dayNumber('2026-03-18')!, dayNumber('2026-03-24')!), 5, 'Wed to Tue skips the weekend')
  assert.equal(workingDays(kickoff, kickoff), 1)
  assert.equal(dayNumber('not a date'), null)
})

test('rows become bars grouped by phase, with progress, lateness and phase summaries', () => {
  const rows = [
    row({
      c_task: 'Formal Kickoff',
      c_phase: 'p1',
      c_start: '2026-01-21',
      c_end: '2026-01-21',
      c_pct: 1,
      c_status: 's2',
    }),
    row({ c_task: 'Products Syncing', c_phase: 'p2', c_start: '2026-06-22', c_end: '2026-06-26', c_pct: 0 }),
    row({ c_task: 'BPM Discussion', c_phase: 'p1', c_start: '2026-01-23', c_pct: 0.5, c_lead: 'iRipple' }),
    row({ c_task: 'Client Endorsement', c_phase: 'p2' }),
  ]
  const timeline = buildTimeline(rows, columns, fields, { today })
  assert.deepEqual(
    timeline.groups.map(group => [group.label, group.items.length]),
    [
      ['Project Planning', 2],
      ['Data Build-up', 2],
    ],
    'phases keep the order their first row appears in',
  )
  const [planning, build] = timeline.groups
  const [kickoff, bpm] = planning.items
  assert.equal(kickoff.progress, 100, '1 in a column of 0–1 values means 100%')
  assert.equal(bpm.progress, 50)
  assert.equal(bpm.end, bpm.start, 'a row with only a start is a one-day bar')
  assert.equal(bpm.lead, 'iRipple')
  assert.equal(bpm.late, true, 'past its end and not finished')
  assert.equal(kickoff.late, false)
  assert.equal(planning.progress, 75, 'the phase is the average by working days')
  assert.equal(isoOf(planning.start!), '2026-01-21')
  assert.equal(isoOf(planning.end!), '2026-01-23')
  assert.equal(build.items[1].start, null, 'a row with no dates has no bar')
  assert.equal(timeline.unscheduled, 1)
  assert.equal(isoOf(timeline.from!), '2026-01-19', 'the chart starts on the Monday of the first start')
  assert.equal(isoOf(timeline.to!), '2026-07-05', 'and ends on the Sunday after today or the last end')
  assert.equal(isoOf(timeline.weekOne!), '2026-01-19')
})

test('without a % column, progress comes from a Done status; percentages above 1 are read as they are', () => {
  const noPct = { ...fields, progressId: '' }
  const [done, pending] = buildTimeline(
    [row({ c_start: '2026-07-01', c_status: 's2' }), row({ c_start: '2026-07-01', c_status: 's1' })],
    columns,
    noPct,
    { today },
  ).groups.flatMap(group => group.items)
  assert.equal(done.progress, 100)
  assert.equal(pending.progress, 0)
  const [half] = buildTimeline([row({ c_start: '2026-07-01', c_pct: 50 })], columns, fields, { today }).groups[0].items
  assert.equal(half.progress, 50)
  const reversed = buildTimeline([row({ c_start: '2026-07-10', c_end: '2026-07-01' })], columns, fields, { today })
  assert.ok(reversed.groups[0].items[0].start! < reversed.groups[0].items[0].end!, 'an end before the start is swapped')
})

test('the Project timeline template has what the timeline needs', () => {
  const template = TRACKER_TEMPLATES.find(item => item.id === 'project-timeline')!
  const made: TrackerColumn[] = template.columns.map((column, at) => ({
    id: `c${at}`,
    name: column.name,
    type: column.type,
    options: column.options?.map((option, i) => ({ id: `o${at}_${i}`, ...option })),
  }))
  const picked = guessTimelineFields(made)
  const name = (id: string) => made.find(column => column.id === id)?.name
  assert.deepEqual(
    [
      name(picked.startId),
      name(picked.endId),
      name(picked.progressId),
      name(picked.groupId),
      name(picked.statusId),
      name(picked.leadId),
    ],
    ['Start', 'End', '% Done', 'Phase', 'Status', 'Lead'],
  )
})
