import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import type { BuiltinCount, CountTile } from '../src/shared/actionCenterSettings'
import { builtinValue, customValue } from '../src/features/action-center/countTiles'
import {
  builtinItems,
  drillCsvRows,
  recordRows,
  searchRows,
  sortRows,
  type TileInput,
  tileDrill,
  widgetDrillRecords,
} from '../src/features/action-center/drillDown'
import { computeWidget, type ReportData, sourceFields, sourceRecords } from '../src/features/reports/custom/reportData'
import { newWidget } from '../src/features/reports/custom/reportModel'

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const today = '2026-11-22'
const task = (id: string, extra: Record<string, unknown> = {}) =>
  ({
    id,
    title: `Task ${id}`,
    status: 'Open',
    type: 'Task',
    priority: 'Medium',
    clientId: 'barter',
    projectId: 'bxi',
    assignedToUserId: 'u1',
    dueDate: '',
    followUpDate: '',
    waitingOn: '',
    dateRaised: '2026-11-01',
    ...extra,
  }) as any
const items = [
  task('late', { dueDate: '2026-11-20' }),
  task('today', { followUpDate: today, waitingOn: 'Client' }),
  task('dev', { waitingOn: 'Developer', followUpDate: '2026-11-21', clientId: 'acme' }),
  task('ask', { type: 'Inquiry' }),
  task('done', { status: 'Done', dueDate: '2026-11-01' }),
  task('hours', {
    timeEntries: [
      { id: 't1', userId: 'u1', date: today, hours: 2.5, forSeeds: true, note: 'UAT' },
      { id: 't2', userId: 'u1', date: today, hours: 1, forSeeds: true, seedsEntryId: 'sent' },
      { id: 't3', userId: 'u2', date: today, hours: 4, forSeeds: true },
    ],
  }),
]
const open = items.filter(item => item.status !== 'Done')
const input: TileInput = {
  open,
  allItems: items,
  taskSettings: { statuses: [{ label: 'Open' }, { label: 'Done', closed: true }] } as any,
  today,
  meId: 'u1',
  waitingTitle: 'Waiting on Developer',
  waitingDev: open.filter(item => item.waitingOn === 'Developer'),
  activities: [
    {
      id: 'm1',
      title: 'Barter standup',
      date: today,
      startTime: '09:00',
      endTime: '09:15',
      allDay: false,
      source: 'Google Calendar',
      status: 'Planned',
      notes: '',
      clientId: 'barter',
    },
  ] as any,
  followUps: open.filter(item => item.followUpDate === today),
}
const context = {
  clients: [
    { id: 'barter', name: 'Barter' },
    { id: 'acme', name: 'Acme' },
  ] as any,
  projects: [{ id: 'bxi', name: 'BXI' }] as any,
  accounts: [{ id: 'u1', name: 'Phillip' }] as any,
  today,
}
const none = { records: [], fields: [] }

test('each task tile lists exactly the tasks its number counts', () => {
  const builtin: BuiltinCount[] = ['attention', 'waitingDev', 'waitingClient', 'overdue', 'dueToday', 'inquiries']
  for (const id of builtin) {
    const counted = builtinValue(id, {
      ...input,
      activitiesToday: { meetings: 0, tracker: 0, followUps: 0 },
    })
    const listed = builtinItems(id, input) || []
    assert.equal(String(listed.length), counted.value, id)
    assert.equal(tileDrill({ id, builtin: id }, counted.title, input, context, none).rows.length, listed.length, id)
  }
  assert.deepEqual(
    builtinItems('overdue', input)?.map(item => item.id),
    ['late', 'dev'],
  )
})

test('a task row shows the task, client, project, status, dates and assignee, and opens the task', () => {
  const drill = tileDrill({ id: 'overdue', builtin: 'overdue' }, 'Overdue', input, context, none)
  const late = drill.rows.find(row => row.id === 'late')!
  assert.equal(late.taskId, 'late')
  assert.equal(late.cells.client, 'Barter')
  assert.equal(late.cells.project, 'BXI')
  assert.equal(late.cells.due, '2026-11-20 · late')
  assert.equal(late.cells.assignee, 'Phillip')
  assert.deepEqual(drill.tasks, { date: 'overdue' }, 'Tasks can show the same list')
  assert.deepEqual(tileDrill({ id: 'w', builtin: 'waitingClient' }, 'W', input, context, none).tasks, {
    waitingOn: 'Client',
  })
  assert.deepEqual(tileDrill({ id: 'd', builtin: 'waitingDev' }, 'D', input, context, none).tasks, {
    waitingOn: 'Developer',
  })
  assert.equal(tileDrill({ id: 'a', builtin: 'attention' }, 'A', input, context, none).tasks, undefined)
})

test('activities, and time not sent to Seeds, have lists of their own', () => {
  const activities = tileDrill({ id: 'x', builtin: 'activities' }, 'Activities', input, context, none)
  assert.deepEqual(
    activities.rows.map(row => [row.cells.kind, row.cells.what, row.taskId || '']),
    [
      ['Meeting', 'Barter standup', ''],
      ['Follow-up', 'Task today', 'today'],
    ],
  )
  const time = tileDrill({ id: 'y', builtin: 'unsentTime' }, 'Unsent time', input, context, none)
  assert.deepEqual(
    time.rows.map(row => [row.cells.task, row.cells.hours, row.cells.note]),
    [['Task hours', '2.5', 'UAT']],
    'only your own entries not yet sent',
  )
})

const data: ReportData = {
  clients: context.clients,
  projects: context.projects,
  items,
  planner: [],
  workEvents: [],
  accounts: [{ id: 'u1', name: 'Phillip', role: 'Administrator' }] as any,
  taskSettings: input.taskSettings,
  today,
  currentUser: { id: 'u1', name: 'Phillip', role: 'Administrator' } as any,
  trackers: {},
  dateOf: iso => iso.slice(0, 10),
}
const records = sourceRecords('tasks', data)
const fields = sourceFields('tasks')

test('a person’s own tile lists the tasks its filters count', () => {
  const tile: CountTile = { id: 'mine', title: 'Barter open', filters: [{ field: 'client', op: 'is', value: 'Barter' }] }
  const value = customValue(tile, records, fields, today, 'u1')
  const drill = tileDrill(tile, 'Barter open', input, context, { records, fields })
  assert.equal(String(drill.rows.length), value.value)
  assert.ok(drill.rows.every(row => row.cells.client === 'Barter'))
})

test('a bar, slice or point lists its records; Other lists the groups not drawn; a metric lists all', () => {
  const widget = { ...newWidget('bar', { x: 0, y: 0 }), groupBy: 'client', limit: 2 }
  const chart = computeWidget(widget, records, fields, { range: 'all' }, today)
  assert.equal(chart.kind, 'chart')
  const barter = widgetDrillRecords(widget, records, fields, { range: 'all' }, today, 'Barter')
  assert.ok(barter.length > 0 && barter.every(record => record.client === 'Barter'))
  const all = widgetDrillRecords(widget, records, fields, { range: 'all' }, today, null)
  const other = widgetDrillRecords(widget, records, fields, { range: 'all' }, today, '__other')
  const drawn = (chart as any).chart.categories.filter((c: any) => c.key !== '__other').map((c: any) => c.key)
  assert.ok(other.every(record => !drawn.includes(record.client)))
  assert.equal(
    all.length,
    drawn.reduce(
      (sum: number, key: string) =>
        sum + widgetDrillRecords(widget, records, fields, { range: 'all' }, today, key).length,
      0,
    ) + other.length,
    'every record is in exactly one group',
  )
  const { columns, rows } = recordRows(barter, fields, widget, true)
  assert.ok(columns.length > 0 && columns.length <= 10)
  assert.equal(rows[0].taskId, barter[0].$id, 'task records open their task')
  assert.equal(recordRows(barter, fields, widget, false).rows[0].taskId, undefined)
})

test('the panel searches, sorts and exports what it shows', () => {
  const drill = tileDrill({ id: 'a', builtin: 'attention' }, 'All', input, context, none)
  assert.deepEqual(
    searchRows(drill.rows, 'acme').map(row => row.id),
    ['dev'],
  )
  assert.equal(searchRows(drill.rows, '').length, drill.rows.length)
  const byDue = sortRows(drill.rows, 'due', 'asc')
  assert.equal(byDue[0].id, 'late', 'dates sort as dates; no date last')
  assert.deepEqual(
    sortRows(drill.rows, 'task', 'desc').map(row => row.id)[0],
    'today',
  )
  const csv = drillCsvRows(drill, byDue.slice(0, 1))
  assert.deepEqual(csv[0], ['Task', 'Client', 'Project', 'Status', 'Due', 'Follow-up', 'Assignee'])
  assert.equal(csv[1][0], 'Task late')
})

test('tiles and report widgets open the panel; SQL widgets do not', () => {
  const page = read('src/features/action-center/ActionCenterPage.tsx')
  assert.match(page, /onOpen=\{editing \? undefined : openTile\}/)
  assert.match(page, /<DrillPanel/)
  assert.match(page, /onDrill=\{editing \? undefined : setDrill\}/)
  const reports = read('src/features/action-center/ActionCenterReports.tsx')
  assert.match(reports, /\['metric', 'bar', 'column', 'line', 'pie', 'table'\]\.includes\(widget\.kind\)/)
  const charts = read('src/features/reports/custom/ReportWidgets.tsx')
  assert.match(charts, /onClick=\{onPick \? \(\) => onPick\(category\.key, category\.label\) : undefined\}/)
  assert.match(read('src/features/action-center/ActionCenterCounts.tsx'), /className=\{`\$\{className\} ac-tile-open`\}/)
})
