import test from 'node:test'
import assert from 'node:assert/strict'
import { explorerCatalog, explorerTables, type ExplorerInput } from '../src/features/reports/explorer/explorerTables'
import { builderSql, emptyBuilder, joinsFrom } from '../src/features/reports/explorer/queryBuilder'
import { paramsForReport, reportFiltersIgnored, reportQueryParams } from '../src/features/reports/explorer/reportParams'
import { resultChart, resultCsv, resultNumber } from '../src/features/reports/explorer/resultView'
import { queryParams, runQuery } from '../src/features/reports/explorer/sqlEngine'
import { cleanDefinition } from '../src/features/reports/custom/reportModel'

const ana = { id: 'u1', name: 'Ana', role: 'Contributor', status: 'Active', email: 'ana@example.com' } as any
const input = (overrides: Partial<ExplorerInput> = {}): ExplorerInput => ({
  clients: [
    { id: 'c1', name: 'Acme' },
    { id: 'c2', name: 'Globex' },
  ] as any,
  projects: [{ id: 'p1', name: 'Portal', status: 'Active' }] as any,
  items: [
    {
      id: 't1',
      title: 'One',
      clientId: 'c1',
      projectId: 'p1',
      status: 'Open',
      waitingOn: 'Me',
      dateRaised: '2026-10-01',
      dueDate: '2026-10-05',
      followUpDate: '',
      assignedToUserId: 'u1',
      timeEntries: [
        { id: 'e1', date: '2026-10-02', hours: 2, category: 'Analysis', note: '', userId: 'u1', userName: 'Ana' },
        { id: 'e2', date: '2026-10-03', hours: 3, category: 'Testing', note: '', userId: 'u2', userName: 'Ben' },
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
      status: 'Open',
      waitingOn: 'Client',
      dateRaised: '2026-10-20',
      followUpDate: '',
      assignedToUserId: 'u2',
    },
  ] as any,
  planner: [],
  workEvents: [],
  accounts: [ana, { id: 'u2', name: 'Ben', role: 'Contributor', status: 'Active' }] as any,
  taskSettings: {
    statuses: [
      { label: 'Open', closed: false },
      { label: 'Resolved', closed: true },
    ],
    visibleColumns: [],
  } as any,
  today: '2026-10-29',
  currentUser: ana,
  trackers: [],
  trackerRows: {},
  messages: null,
  wholeAccount: true,
  ...overrides,
})
const run = (sql: string, tables = explorerTables(input()), params: Record<string, string> = {}) =>
  runQuery(sql, tables, { params, today: '2026-10-29' })

test('the tables hold the account, read-only, and join up', () => {
  const tables = explorerTables(input())
  assert.deepEqual(Object.keys(tables).sort(), [
    'activities',
    'activity_log',
    'clients',
    'projects',
    'tasks',
    'time_entries',
    'users',
  ])
  const byClient = run(
    `SELECT c.name, COUNT(*) AS tasks, SUM(CASE WHEN t.done THEN 0 ELSE 1 END) AS open
     FROM tasks t JOIN clients c ON c.id = t.client_id GROUP BY c.name ORDER BY tasks DESC`,
    tables,
  )
  assert.deepEqual(byClient.columns, ['name', 'tasks', 'open'])
  assert.deepEqual(byClient.rows, [
    ['Acme', 2, 1],
    ['Globex', 1, 1],
  ])
  const hours = run('SELECT user, SUM(hours) AS hours FROM time_entries GROUP BY user ORDER BY user', tables)
  assert.deepEqual(hours.rows, [
    ['Ana', 2],
    ['Ben', 3],
  ])
  const overdue = run("SELECT id FROM tasks WHERE overdue AND project = 'portal'", tables)
  assert.deepEqual(overdue.rows, [['t1']])
  assert.throws(() => run('DELETE FROM tasks', tables), /read-only/)
})

test('people without Data explorer get their own work in query widgets', () => {
  const tables = explorerTables(input({ wholeAccount: false }))
  assert.deepEqual(run('SELECT id FROM tasks ORDER BY id', tables).rows, [['t1']])
  assert.deepEqual(run('SELECT id FROM time_entries', tables).rows, [['e1']])
})

test('messages never carry their body, and tracker tables need their rows loaded', () => {
  const catalog = explorerCatalog({ trackers: [], clients: [], messages: [] })
  const messages = catalog.find(table => table.name === 'messages')
  assert.ok(messages)
  assert.equal(
    messages?.columns.some(column => /body|text|content/.test(column.name)),
    false,
  )
  assert.equal(
    explorerCatalog({ trackers: [], clients: [], messages: null }).some(table => table.name === 'messages'),
    false,
  )
  const tables = explorerTables(
    input({
      messages: [
        {
          id: 'm1',
          source: 'gmail',
          subject: 'Hello',
          sender: 'a@b.c',
          status: 'New',
          received_at: '2026-10-28T03:00:00Z',
        },
      ],
    }),
  )
  assert.deepEqual(run('SELECT subject, received_date FROM messages', tables).rows, [['Hello', '2026-10-28']])
})

test('the builder writes SQL that runs; values asked each time may be left empty', () => {
  const catalog = explorerCatalog({ trackers: [], clients: [], messages: null })
  const tables = explorerTables(input())
  const counted = builderSql(emptyBuilder('tasks'), catalog)
  assert.match(counted, /^SELECT tasks\.status, COUNT\(\*\) AS count\nFROM tasks\nGROUP BY tasks\.status/)
  assert.deepEqual(run(counted, tables).rows, [
    ['Open', 2],
    ['Resolved', 1],
  ])

  const join = joinsFrom('tasks').find(item => item.table === 'clients')
  assert.ok(join)
  const asked = builderSql(
    {
      ...emptyBuilder('tasks'),
      join: join?.key || '',
      groupBy: ['tasks.status'],
      filters: [{ column: 'clients.name', op: 'is', value: '', ask: true }],
    },
    catalog,
  )
  assert.deepEqual(queryParams(asked), ['client'])
  assert.equal(run(asked, tables, { client: '' }).rows.length, 2)
  assert.deepEqual(run(asked, tables, { client: 'Globex' }).rows, [['Open', 1]])

  const byMonth = builderSql(
    { ...emptyBuilder('time_entries'), summary: 'sum', measure: 'time_entries.hours', groupBy: ['time_entries.date'] },
    catalog,
  )
  assert.deepEqual(run(byMonth, tables).rows, [['2026-10-01', 5]])
  const rows = builderSql(
    {
      ...emptyBuilder('tasks'),
      summary: 'rows',
      columns: ['tasks.id', 'tasks.title'],
      filters: [{ column: 'tasks.done', op: 'false', value: '', ask: false }],
    },
    catalog,
  )
  assert.deepEqual(run(rows, tables).rows, [
    ['t1', 'One'],
    ['t3', 'Three'],
  ])
})

test('on a report, empty parameters take the report filters', () => {
  const query = {
    sql: 'SELECT * FROM tasks WHERE client = {{client}} AND date_raised >= {{from}} AND status = {{status}}',
    view: 'table' as const,
    params: { client: '', status: 'Open' },
  }
  assert.deepEqual(
    reportQueryParams(query, {
      range: { from: '2026-10-01', to: '2026-10-31' },
      client: 'Acme',
      project: '',
      person: '',
    }),
    { client: 'Acme', from: '2026-10-01', status: 'Open' },
  )
  assert.deepEqual(
    reportQueryParams(
      { ...query, params: { client: 'Globex' } },
      { range: null, client: 'Acme', project: '', person: '' },
    ),
    {
      client: 'Globex',
      from: '',
      status: '',
    },
  )
})

test('results become charts, a number and CSV; saved queries are cleaned', () => {
  const result = run(
    'SELECT client, COUNT(*) AS tasks, SUM(hours_logged) AS hours FROM tasks GROUP BY client ORDER BY client',
  )
  const chart = resultChart(result)
  assert.ok(chart)
  assert.equal(chart?.chart.series.length, 2)
  assert.deepEqual(resultNumber(run('SELECT COUNT(*) AS open FROM tasks WHERE NOT done')), { value: 2, label: 'open' })
  assert.deepEqual(resultCsv(result)[0], ['client', 'tasks', 'hours'])
  const cleaned = cleanDefinition({
    widgets: [],
    query: { sql: 'x'.repeat(30000), view: 'radar', params: { ok: '1', 'not ok': '2', Upper: '3' } },
  })
  assert.equal(cleaned.query?.sql.length, 20000)
  assert.equal(cleaned.query?.view, 'table')
  assert.deepEqual(cleaned.query?.params, { ok: '1' })
})

test('a builder condition waiting for its value does not hide every row', () => {
  const catalog = explorerCatalog({ trackers: [], clients: [], messages: null })
  const sql = builderSql(
    { ...emptyBuilder('tasks'), filters: [{ column: 'tasks.client', op: 'is', value: ' ', ask: false }] },
    catalog,
  )
  assert.doesNotMatch(sql, /WHERE/)
  assert.equal(run(sql).rows.length, 2)
})

test('report filters fill the parameters "Ask each time" makes, by name or id', () => {
  const sql =
    'SELECT * FROM tasks WHERE ({{client_id}} IS NULL OR client_id = {{client_id}}) AND assignee = {{assignee}}' +
    ' AND due_date >= {{due_date_from}} AND due_date <= {{due_date_to}} AND sent_to = {{sent_to}}'
  const filters = {
    range: { from: '2026-10-01', to: '2026-10-31' },
    client: 'Acme',
    project: '',
    person: 'Ana',
    clientId: 'c1',
    projectId: '',
    personId: 'u1',
  }
  assert.deepEqual(reportQueryParams({ sql, view: 'table', params: {} }, filters), {
    client_id: 'c1',
    assignee: 'Ana',
    due_date_from: '2026-10-01',
    due_date_to: '2026-10-31',
    sent_to: '',
  })
  assert.deepEqual(reportFiltersIgnored(sql.split('WHERE')[1], { ...filters, project: 'Apollo' }), ['Project'])
})

test('adding a query to a report drops the values tried in the explorer for report-filled parameters', () => {
  const query = {
    sql: 'SELECT * FROM tasks WHERE client = {{client}} AND status = {{status}}',
    view: 'table' as const,
    params: { client: 'Globex', status: 'Open' },
  }
  assert.deepEqual(paramsForReport(query).params, { client: '', status: 'Open' })
})

test('the builder gives each end of a date range its own parameter', () => {
  const builder = {
    ...emptyBuilder('tasks'),
    groupBy: [],
    filters: [
      { column: 'tasks.due_date', op: 'gte' as const, value: '', ask: true },
      { column: 'tasks.due_date', op: 'lte' as const, value: '', ask: true },
      { column: 'tasks.client_id', op: 'is' as const, value: '', ask: true },
    ],
  }
  const sql = builderSql(builder, explorerCatalog({ trackers: [], clients: [], messages: null }))
  assert.match(sql, /\{\{due_date_from\}\}/)
  assert.match(sql, /\{\{due_date_to\}\}/)
  assert.match(sql, /\{\{client_id\}\}/)
})
