import test from 'node:test'
import assert from 'node:assert/strict'
import {
  cleanDefinition,
  enterCell,
  fillDetails,
  freeSpot,
  parseClipboard,
  pasteInto,
  readDate,
  reidentify,
  rolloutReport,
  newWidget,
  overlaps,
  placeWidget,
  REPORT_TEMPLATES,
  type Widget,
} from '../src/features/reports/custom/reportModel'
import {
  computeWidget,
  rangeDates,
  sourceFields,
  sourceRecords,
  type ReportData,
} from '../src/features/reports/custom/reportData'

const noOverlap = (widgets: Widget[]) => {
  for (let a = 0; a < widgets.length; a++)
    for (let b = a + 1; b < widgets.length; b++) assert.equal(overlaps(widgets[a], widgets[b]), false)
}

test('cleanDefinition keeps what it knows, drops the rest, and untangles overlaps', () => {
  const cleaned = cleanDefinition({
    filters: { range: 'custom', from: '2026-10-01', to: 'nope', clientId: 'c1' },
    widgets: [
      {
        id: 'a',
        kind: 'bar',
        x: 0,
        y: 0,
        w: 6,
        h: 8,
        source: 'tasks',
        groupBy: 'client',
        filters: [{ field: 'done', op: 'false' }],
      },
      { id: 'b', kind: 'bar', x: 2, y: 1, w: 6, h: 8, source: 'tasks', measure: { op: 'sum', field: 'hours' } },
      { id: 'c', kind: 'rocket', x: 0, y: 0, w: 1, h: 1 },
      { id: 'a', kind: 'metric' },
      { id: 'd', kind: 'note', text: 'Hello\nthere', x: 40, w: 99 },
    ],
  })
  assert.deepEqual(cleaned.filters, { range: 'custom', from: '2026-10-01', clientId: 'c1' })
  assert.deepEqual(
    cleaned.widgets.map(widget => widget.id),
    ['a', 'b', 'd'],
  )
  noOverlap(cleaned.widgets)
  const note = cleaned.widgets.find(widget => widget.id === 'd') as Widget
  assert.equal(note.text, 'Hello\nthere')
  assert.equal(note.w, 12)
  assert.equal(note.x, 0)
})

test('moving a widget onto another pushes the other out of the way', () => {
  const a = { ...newWidget('bar', { x: 0, y: 0 }), id: 'a' }
  const b = { ...newWidget('bar', { x: 6, y: 0 }), id: 'b' }
  const c = { ...newWidget('table', { x: 0, y: 8 }), id: 'c' }
  const moved = placeWidget([a, b, c], 'c', { x: 0, y: 0, w: 12, h: 8 })
  noOverlap(moved)
  const byId = Object.fromEntries(moved.map(widget => [widget.id, widget]))
  assert.deepEqual([byId.c.x, byId.c.y], [0, 0])
  assert.equal(byId.a.y, 8)
  assert.equal(byId.b.y, 8)
  // Resizing below the minimum keeps the minimum.
  const tiny = placeWidget(moved, 'a', { x: 0, y: 8, w: 1, h: 1 })
  assert.ok((tiny.find(widget => widget.id === 'a') as Widget).w >= 3)
})

test('freeSpot fills the first gap', () => {
  assert.deepEqual(freeSpot([{ x: 0, y: 0, w: 6, h: 4 }], 6, 4), { x: 6, y: 0 })
  assert.deepEqual(freeSpot([{ x: 0, y: 0, w: 12, h: 4 }], 3, 3), { x: 0, y: 4 })
})

test('every ready-made report is tidy', () => {
  for (const template of REPORT_TEMPLATES) {
    const definition = template.build()
    noOverlap(definition.widgets)
    assert.deepEqual(cleanDefinition(definition).widgets.length, definition.widgets.length, template.id)
  }
})

test('date ranges', () => {
  assert.deepEqual(rangeDates({ range: 'this_month' }, '2026-02-10'), { from: '2026-02-01', to: '2026-02-28' })
  assert.deepEqual(rangeDates({ range: 'last_month' }, '2026-01-10'), { from: '2025-12-01', to: '2025-12-31' })
  assert.deepEqual(rangeDates({ range: 'this_week' }, '2026-10-29'), { from: '2026-10-26', to: '2026-11-01' })
  assert.deepEqual(rangeDates({ range: 'this_quarter' }, '2026-11-05'), { from: '2026-10-01', to: '2026-12-31' })
  assert.equal(rangeDates({ range: 'all' }, '2026-10-29'), null)
})

const admin = { id: 'u1', name: 'Ana', role: 'Administrator', status: 'Active' } as any
const data = (overrides: Partial<ReportData> = {}): ReportData => ({
  clients: [
    { id: 'c1', name: 'Acme' },
    { id: 'c2', name: 'Globex' },
  ] as any,
  projects: [],
  items: [
    {
      id: 't1',
      title: 'One',
      clientId: 'c1',
      status: 'Open',
      waitingOn: 'Me',
      dateRaised: '2026-10-01',
      dueDate: '2026-10-05',
      followUpDate: '',
      assignedToUserId: 'u1',
      timeEntries: [
        {
          id: 'e1',
          date: '2026-10-02',
          hours: 2,
          category: 'Analysis',
          note: '',
          userId: 'u1',
          userName: 'Ana',
          createdAt: '',
        },
      ],
    },
    {
      id: 't2',
      title: 'Two',
      clientId: 'c1',
      status: 'Resolved',
      waitingOn: 'Me',
      dateRaised: '2026-10-01',
      resolvedDate: '2026-10-04',
      followUpDate: '',
      assignedToUserId: 'u2',
    },
    {
      id: 't3',
      title: 'Three',
      clientId: 'c2',
      parentTaskId: 't1',
      status: 'Open',
      waitingOn: 'Client',
      dateRaised: '2026-10-20',
      followUpDate: '',
      assignedToUserId: 'u2',
    },
  ] as any,
  planner: [],
  workEvents: [],
  accounts: [admin, { id: 'u2', name: 'Ben', role: 'Contributor', status: 'Active' }] as any,
  taskSettings: {
    statuses: [
      { label: 'Open', closed: false },
      { label: 'Resolved', closed: true },
    ],
    visibleColumns: [],
  } as any,
  today: '2026-10-29',
  currentUser: admin,
  trackers: {},
  ...overrides,
})

test('tasks: state, overdue, turnaround, and grouping', () => {
  const records = sourceRecords('tasks', data())
  const byId = Object.fromEntries(records.map(record => [record.$id, record]))
  assert.equal(byId.t1.state, 'Overdue')
  assert.equal(byId.t2.state, 'Done')
  assert.equal(byId.t2.turnaroundDays, 3)
  assert.equal(byId.t3.kind, 'Subtask')
  assert.equal(byId.t1.progress, 0)
  assert.equal(byId.t1.hoursLogged, 2)

  const fields = sourceFields('tasks')
  const bar = {
    ...newWidget('bar', { x: 0, y: 0 }),
    groupBy: 'client',
    filters: [{ field: 'done', op: 'false' as const }],
  }
  const result = computeWidget(bar, records, fields, { range: 'all' }, '2026-10-29')
  assert.equal(result.kind, 'chart')
  if (result.kind !== 'chart') return
  assert.deepEqual(
    result.chart.categories.map(category => category.label),
    ['Acme', 'Globex'],
  )
  assert.deepEqual(result.chart.series[0].values, [1, 1])

  // Report filters: client, and dates on the field the widget chose.
  const metric = { ...newWidget('metric', { x: 0, y: 0 }), filters: [], dateField: 'dateRaised' }
  const inRange = computeWidget(
    metric,
    records,
    fields,
    { range: 'custom', from: '2026-10-10', to: '2026-10-31' },
    '2026-10-29',
  )
  assert.deepEqual(inRange.kind === 'metric' && inRange.value, 1)
  const forClient = computeWidget(
    { ...metric, dateField: undefined },
    records,
    fields,
    { range: 'all', clientId: 'c1' },
    '2026-10-29',
  )
  assert.deepEqual(forClient.kind === 'metric' && forClient.value, 2)

  // % of rows where a condition holds.
  const percent = {
    ...metric,
    dateField: undefined,
    measure: { op: 'percent' as const, where: { field: 'done', op: 'true' as const } },
  }
  const share = computeWidget(percent, records, fields, { range: 'all' }, '2026-10-29')
  assert.equal(share.kind === 'metric' && Math.round(share.value as number), 33)
})

test('people who are not Administrators see their own work only', () => {
  const ben = { id: 'u2', name: 'Ben', role: 'Contributor', status: 'Active' } as any
  const records = sourceRecords('tasks', data({ currentUser: ben }))
  assert.deepEqual(
    records.map(record => record.$id),
    ['t2', 't3'],
  )
  assert.equal(sourceRecords('time', data({ currentUser: ben })).length, 0)
})

test('weekly buckets fill the gaps between weeks', () => {
  const records = sourceRecords('tasks', data())
  const column = {
    ...newWidget('column', { x: 0, y: 0 }),
    groupBy: 'dateRaised',
    bucket: 'week' as const,
    sort: 'label' as const,
  }
  const result = computeWidget(column, records, sourceFields('tasks'), { range: 'all' }, '2026-10-29')
  assert.equal(result.kind, 'chart')
  if (result.kind !== 'chart') return
  assert.deepEqual(
    result.chart.categories.map(category => category.key),
    ['2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19'],
  )
  assert.deepEqual(result.chart.series[0].values, [2, 0, 0, 1])
})

test('fill-in tables: dates, choices and numbers are kept the way they were typed', () => {
  assert.equal(readDate('Nov 4, 2025'), '2025-11-04')
  assert.equal(readDate('4 Nov 2025'), '2025-11-04')
  assert.equal(readDate('11/4/2025'), '2025-11-04')
  assert.equal(readDate('2025-11-04 00:00:00'), '2025-11-04')
  assert.equal(readDate('2/30/2025'), null)
  const date = { id: 'd', name: 'Due', type: 'date' as const }
  assert.equal(enterCell(date, 'Sep 22, 2025').value, '2025-09-22')
  assert.equal(enterCell(date, 'TBA').value, 'TBA')
  const number = { id: 'n', name: 'Qty', type: 'number' as const }
  assert.equal(enterCell(number, '1,250').value, '1250')
  const status = {
    id: 's',
    name: 'Status',
    type: 'choice' as const,
    options: [{ label: 'Completed', color: 'green' as const }],
  }
  assert.equal(enterCell(status, 'completed').value, 'Completed')
  const added = enterCell(status, 'On Hold')
  assert.deepEqual(
    added.column.options?.map(option => option.label),
    ['Completed', 'On Hold'],
  )
})

test('pasting rows copied from Excel fills the table from the cell, adding rows', () => {
  const grid = parseClipboard('PUMA TRINOMA\tConfigured\tNov 4, 2025\r\n"PUMA ""PITX""\nannex"\tNo Mall Integ\tTBA\r\n')
  assert.deepEqual(grid, [
    ['PUMA TRINOMA', 'Configured', 'Nov 4, 2025'],
    ['PUMA "PITX"\nannex', 'No Mall Integ', 'TBA'],
  ])
  const table = {
    columns: [
      { id: 'a', name: 'Location', type: 'text' as const },
      {
        id: 'b',
        name: 'Mall sending',
        type: 'choice' as const,
        options: [{ label: 'Configured', color: 'green' as const }],
      },
      { id: 'c', name: 'Target', type: 'date' as const },
    ],
    rows: [{ id: 'r1', cells: {} }],
  }
  const pasted = pasteInto(table, 0, 0, grid)
  assert.equal(pasted.rows.length, 2)
  assert.deepEqual(pasted.rows[0].cells, { a: 'PUMA TRINOMA', b: 'Configured', c: '2025-11-04' })
  assert.equal(pasted.rows[1].cells.c, 'TBA')
  assert.deepEqual(
    pasted.columns[1].options?.map(option => option.label),
    ['Configured', 'No Mall Integ'],
  )
  assert.equal(table.rows.length, 1, 'the original table is not changed')
})

test('the weekly roll-out report: details filled, tables counted, timeline coloured by health', () => {
  const report = fillDetails(rolloutReport(), { 'client name': 'Cougar Athletic Trends, Inc.' })
  const tidy = cleanDefinition(report)
  assert.equal(tidy.widgets.length, report.widgets.length)
  noOverlap(tidy.widgets)
  const details = report.widgets.find(widget => widget.title === 'Project details')!
  const [label, value] = details.table!.columns
  assert.equal(
    details.table!.rows.find(row => row.cells[label.id] === 'Client name')!.cells[value.id],
    'Cougar Athletic Trends, Inc.',
  )

  // A copy for a new report keeps its charts pointed at its own tables.
  const copy = reidentify(report)
  const goLive = copy.widgets.find(widget => widget.title === 'Go-live schedule')!
  const live = copy.widgets.find(widget => widget.title === 'Live')!
  assert.notEqual(goLive.id, report.widgets.find(widget => widget.title === 'Go-live schedule')!.id)
  assert.equal(live.tableId, goLive.id)

  // Type two branches, one live: the counts follow.
  const [location, , target, status] = goLive.table!.columns
  goLive.table = pasteInto(goLive.table!, 0, 0, [
    ['PUMA TRINOMA', 'Configured', 'Nov 4, 2025', 'Completed'],
    ['FTS RIVERBANKS', 'No mall integ', 'TBA', 'On hold'],
  ])
  assert.equal(goLive.table.rows[1].cells[target.id], 'TBA')
  const fields = sourceFields('table', undefined, goLive.table)
  const records = sourceRecords('table', data(), '', goLive.table)
  assert.equal(records.length, 2, 'rows nobody typed into are not counted')
  const count = (widget: Widget) => {
    const result = computeWidget(widget, records, fields, { range: 'all' }, '2026-10-29')
    return result.kind === 'metric' ? result.value : null
  }
  assert.equal(count(copy.widgets.find(widget => widget.title === 'Branches')!), 2)
  assert.equal(count(live), 1)
  assert.equal(count(copy.widgets.find(widget => widget.title === 'On hold or for reset')!), 1)
  assert.ok(fields.find(field => field.key === `d.${status.id}`)?.colors?.Completed === 'green')
  assert.ok(location)

  // The timeline draws phases that have dates, coloured by their health.
  const phases = copy.widgets.find(widget => widget.title === 'Activity by month')!
  phases.table = pasteInto(phases.table!, 0, 1, [['Aug 18, 2025', 'Aug 22, 2025', 'On track']])
  const gantt = copy.widgets.find(widget => widget.kind === 'gantt')!
  assert.equal(gantt.tableId, phases.id)
  const timeline = computeWidget(
    gantt,
    sourceRecords('table', data(), '', phases.table),
    sourceFields('table', undefined, phases.table),
    { range: 'all' },
    '2026-10-29',
  )
  assert.equal(timeline.kind, 'gantt')
  if (timeline.kind === 'gantt')
    assert.deepEqual(
      timeline.bars.map(bar => [bar.label, bar.start, bar.end, bar.group]),
      [['Kick off', '2025-08-18', '2025-08-22', 'On track']],
    )
})
