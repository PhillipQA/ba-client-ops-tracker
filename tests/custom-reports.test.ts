import test from 'node:test'
import assert from 'node:assert/strict'
import {
  cleanDefinition,
  freeSpot,
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
  unsupportedReportFilters,
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

test('tracker widgets follow report client, project, person, and date filters when matching columns exist', () => {
  const tracker = {
    id: 'tr1',
    name: 'Rollout',
    columns: [
      { id: 'client', name: 'Client', type: 'text' },
      { id: 'project', name: 'Project', type: 'text' },
      { id: 'person', name: 'Person', type: 'person' },
      { id: 'go-live', name: 'Go Live Date', type: 'date' },
      { id: 'status', name: 'Status', type: 'text' },
    ],
  } as any
  const input = data({
    projects: [
      { id: 'p1', name: 'Rollout A' },
      { id: 'p2', name: 'Rollout B' },
    ] as any,
    trackers: {
      tr1: {
        tracker,
        rows: [
          {
            id: 'r1',
            updatedAt: '2026-10-25T00:00:00.000Z',
            cells: { client: 'Acme', project: 'Rollout A', person: 'u1', 'go-live': '2026-10-25', status: 'Ready' },
          },
          {
            id: 'r2',
            updatedAt: '2026-10-25T00:00:00.000Z',
            cells: { client: 'Globex', project: 'Rollout B', person: 'u2', 'go-live': '2026-10-25', status: 'Pending' },
          },
          {
            id: 'r3',
            updatedAt: '2026-09-25T00:00:00.000Z',
            cells: { client: 'Acme', project: 'Rollout A', person: 'u1', 'go-live': '2026-09-25', status: 'Pending' },
          },
        ],
      },
    } as any,
  })
  const records = sourceRecords('tracker', input, 'tr1')
  const fields = sourceFields('tracker', tracker)
  const widget = {
    ...newWidget('metric'),
    source: 'tracker' as const,
    trackerId: 'tr1',
    dateField: 'c.go-live',
  }
  const filters = {
    range: 'custom' as const,
    from: '2026-10-01',
    to: '2026-10-31',
    clientId: 'c1',
    projectId: 'p1',
    userId: 'u1',
  }
  const result = computeWidget(widget, records, fields, filters, '2026-10-29')
  assert.equal(result.kind === 'metric' ? result.value : null, 1)
  assert.deepEqual(unsupportedReportFilters(widget, filters, fields, '2026-10-29'), [])
})

test('tracker widgets explain report filters with no matching tracker columns', () => {
  const tracker = {
    id: 'tr2',
    name: 'Status only',
    columns: [{ id: 'status', name: 'Status', type: 'text' }],
  } as any
  const widget = { ...newWidget('metric'), source: 'tracker' as const, trackerId: 'tr2' }
  const filters = { range: 'this_month' as const, clientId: 'c1', projectId: 'p1', userId: 'u1' }
  assert.deepEqual(unsupportedReportFilters(widget, filters, sourceFields('tracker', tracker), '2026-10-29'), [
    'Dates',
    'Client',
    'Project',
    'Person',
  ])
})
