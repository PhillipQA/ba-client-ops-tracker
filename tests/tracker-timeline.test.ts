import test from 'node:test'
import assert from 'node:assert/strict'
import type { TrackerColumn, TrackerRow } from '../src/features/trackers/trackerModel'
import {
  buildTimeline,
  cleanTimelineSettings,
  dayNumber,
  draggedDates,
  guessTimelineFields,
  isoOf,
  mondayOf,
  settleTimelineFields,
  weekLabel,
  workingDays,
} from '../src/features/trackers/timelineModel'
import { TRACKER_TEMPLATES, addWorkingDays, templateRows } from '../src/features/trackers/trackerTemplates'
import { sheetFormatRequests, sheetFromTracker } from '../src/features/trackers/sheetFromTracker'

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

test('dragging a bar moves it, or changes one end, and never makes it shorter than a day', () => {
  const start = dayNumber('2026-03-18')!,
    end = dayNumber('2026-03-20')!
  const iso = (dates: { start: number; end: number }) => [isoOf(dates.start), isoOf(dates.end)]
  assert.deepEqual(iso(draggedDates(start, end, 'move', 5)), ['2026-03-23', '2026-03-25'])
  assert.deepEqual(iso(draggedDates(start, end, 'start', -2)), ['2026-03-16', '2026-03-20'])
  assert.deepEqual(iso(draggedDates(start, end, 'end', 10)), ['2026-03-18', '2026-03-30'])
  assert.deepEqual(iso(draggedDates(start, end, 'start', 9)), ['2026-03-20', '2026-03-20'])
  assert.deepEqual(iso(draggedDates(start, end, 'end', -9)), ['2026-03-18', '2026-03-18'])
})

test('saved timeline settings keep only real choices', () => {
  assert.deepEqual(
    cleanTimelineSettings(
      { zoom: 'month', fields: { startId: 'c_end', endId: '', groupId: 'c_phase', progressId: 'c_task', leadId: 7 } },
      columns,
    ),
    { zoom: 'month', fields: { startId: 'c_end', endId: '', groupId: 'c_phase' } },
  )
  assert.deepEqual(cleanTimelineSettings({ zoom: 'year', fields: { startId: '' } }, columns), {})
  assert.deepEqual(cleanTimelineSettings('nonsense', columns), {})
})

test('a new Google Sheet from a tracker: key column first, real dates and checkboxes, dropdowns, empty rows left out', () => {
  const plan = sheetFromTracker(
    [{ id: 'c_secret', name: 'Login', type: 'secret' }, ...columns, { id: 'c_box', name: 'Signed', type: 'checkbox' }],
    [
      { id: 'r1', cells: { c_task: 'Kickoff', c_start: '2026-01-21', c_status: 's2', c_box: true, c_pct: 100 } },
      { id: 'r2', cells: { c_wbs: '1.2' } },
      { id: 'r3', cells: {} },
      { id: 'r4', cells: { c_task: '=1+1', c_lead: 'HeroHub' } },
    ],
    [],
  )
  if ('error' in plan) throw new Error(plan.error)
  assert.equal(plan.keyHeader, 'Task')
  assert.deepEqual(plan.headers, ['Task', 'WBS', 'Phase', 'Lead', 'Start', 'End', '% Done', 'Status', 'Signed'])
  assert.equal(plan.skipped, 1, 'a row with nothing in it has no Sheet row')
  assert.deepEqual(
    plan.placed.map(item => item.key),
    ['Kickoff', 'Kickoff\u001e1', '=1+1'],
    'a row with no name belongs to the named row above, as a sync reads it',
  )
  const first = plan.rowData[1].values
  assert.equal(first[4].userEnteredValue?.numberValue, 46043, '21 Jan 2026 as a Sheets date')
  assert.equal(first[7].userEnteredValue?.stringValue, 'Done')
  assert.equal(first[8].userEnteredValue?.boolValue, true)
  assert.equal(plan.rowData[3].values[0].userEnteredValue?.stringValue, '=1+1', 'kept as text, not a formula')
  assert.deepEqual(
    plan.dropdowns.map(item => item.index),
    [2, 7],
  )
  assert.deepEqual(plan.checkboxes, [8])
  assert.deepEqual(plan.dates, [4, 5])
  const requests = sheetFormatRequests(plan, 3, 1000)
  assert.ok(requests.some((r: any) => r.setDataValidation?.range.startColumnIndex === 7))
  assert.ok(!JSON.stringify(plan).includes('c_secret'), 'Secret columns never go to the Sheet')
  assert.deepEqual(sheetFromTracker([{ id: 'n', name: 'Hours', type: 'number' }], [], []), {
    error: 'The tracker needs a Text column to name each row in the Sheet, such as Task or Branch.',
  })
})

test('the Project timeline template starts with the task list, scheduled on working days from the start date', () => {
  const template = TRACKER_TEMPLATES.find(item => item.id === 'project-timeline')!
  const made: TrackerColumn[] = template.columns.map((column, at) => ({
    id: `c${at}`,
    name: column.name,
    type: column.type,
    options: column.options?.map((option, i) => ({ id: `o${at}_${i}`, ...option })),
  }))
  const id = (name: string) => made.find(column => column.name === name)!.id
  const rows = templateRows(template, made, '2026-11-02')
  assert.equal(rows.length, 22)
  const byWbs = (wbs: string) => rows.find(row => row.cells[id('WBS')] === wbs)!.cells
  const kickoff = byWbs('1.1')
  assert.equal(kickoff[id('Task')], 'Formal Kickoff')
  assert.equal(kickoff[id('Start')], '2026-11-02')
  assert.equal(kickoff[id('End')], '2026-11-02')
  assert.equal(kickoff[id('% Done')], 0)
  const phase = made.find(column => column.name === 'Phase')!
  assert.equal(kickoff[phase.id], phase.options!.find(option => option.label === 'Project Planning')!.id)
  const build = byWbs('2.1')
  assert.deepEqual([build[id('Start')], build[id('End')]], ['2026-11-09', '2026-12-04'], '20 working days')
  assert.equal(byWbs('6.1')[id('Predecessor')], '5.1 & 3.9')
  assert.equal(byWbs('7.1')[id('Start')], '2027-01-04', 'Go Live 45 working days in')
  // Every task starts after the tasks it follows.
  for (const row of rows) {
    const before = String(row.cells[id('Predecessor')] || '')
    for (const wbs of before
      .split('&')
      .map(item => item.trim())
      .filter(Boolean))
      assert.ok(
        String(byWbs(wbs)[id('End')]) < String(row.cells[id('Start')]),
        `${row.cells[id('WBS')]} starts after ${wbs}`,
      )
  }
  assert.equal(
    templateRows(template, made, '2026-11-07')[0].cells[id('Start')],
    '2026-11-09',
    'a Saturday start moves to Monday',
  )
  assert.equal(templateRows(template, made, '')[0].cells[id('Start')], undefined, 'no start date, no dates')
  assert.equal(addWorkingDays(dayNumber('2026-11-06')!, 1), dayNumber('2026-11-09'), 'Friday + 1 is Monday')
  const timeline = buildTimeline(
    rows.map((row, at) => ({
      id: `r${at}`,
      position: at,
      cells: row.cells,
      secretSet: {},
      taskId: '',
      version: 1,
      updatedAt: '',
    })),
    made,
    guessTimelineFields(made),
    { today: dayNumber('2026-11-02')! },
  )
  assert.deepEqual(
    timeline.groups.map(group => group.label),
    [
      'Project Planning',
      'Data Build-up',
      'Hardware & BIR',
      'Training',
      'UAT',
      'Pre-Live',
      'Go Live',
      'Support Turnover',
    ],
  )
  assert.equal(timeline.unscheduled, 0)
})
