import test from 'node:test'
import assert from 'node:assert/strict'
import {
  queryParams,
  referencedTables,
  resolveTableIdentifierParams,
  tableIdentifierParams,
  runQuery,
  SqlError,
  type SqlTable,
} from '../src/features/reports/explorer/sqlEngine'

const tables: Record<string, SqlTable> = {
  clients: {
    name: 'clients',
    columns: [
      { name: 'id', type: 'text' },
      { name: 'name', type: 'text' },
    ],
    rows: [
      { id: 'c1', name: 'Cougar' },
      { id: 'c2', name: 'Acme' },
      { id: 'c3', name: 'Initech' },
    ],
  },
  tasks: {
    name: 'tasks',
    columns: [
      { name: 'id', type: 'text' },
      { name: 'title', type: 'text' },
      { name: 'client_id', type: 'text' },
      { name: 'status', type: 'text' },
      { name: 'due_date', type: 'date' },
      { name: 'hours', type: 'number' },
      { name: 'done', type: 'bool' },
    ],
    rows: [
      {
        id: 't1',
        title: 'Kick off',
        client_id: 'c1',
        status: 'Completed',
        due_date: '2025-11-03',
        hours: 2,
        done: true,
      },
      {
        id: 't2',
        title: 'BPM',
        client_id: 'c1',
        status: 'In progress',
        due_date: '2025-11-12',
        hours: 5.5,
        done: false,
      },
      {
        id: 't3',
        title: 'UAT',
        client_id: 'c2',
        status: 'In progress',
        due_date: '2025-11-20',
        hours: null,
        done: false,
      },
      { id: 't4', title: "O'Brien's form", client_id: '', status: 'On hold', due_date: null, hours: 1, done: false },
    ],
  },
}
const run = (sql: string, params?: Record<string, string>) => runQuery(sql, tables, { params, today: '2025-11-14' })

test('select, filter, order and limit', () => {
  const result = run("SELECT title, hours FROM tasks WHERE status = 'in progress' ORDER BY hours DESC LIMIT 5")
  assert.deepEqual(result.columns, ['title', 'hours'])
  assert.deepEqual(result.rows, [
    ['BPM', 5.5],
    ['UAT', null],
  ])
  assert.deepEqual(run('SELECT title FROM tasks ORDER BY title LIMIT 2 OFFSET 1').rows, [
    ['Kick off'],
    ["O'Brien's form"],
  ])
  assert.equal(run("SELECT * FROM tasks WHERE title LIKE '%o%'").rows.length, 2)
  assert.equal(run('SELECT title FROM tasks WHERE due_date IS NULL').rows[0][0], "O'Brien's form")
  assert.equal(run("SELECT title FROM tasks WHERE title = 'O''Brien''s form'").rows.length, 1)
})

test('group by, aggregates, having, aliases and positions', () => {
  const result = run(
    'SELECT status, COUNT(*) AS n, SUM(hours) AS total, AVG(hours) avg_hours FROM tasks GROUP BY status HAVING n >= 1 ORDER BY n DESC, status',
  )
  assert.deepEqual(result.rows, [
    ['In progress', 2, 5.5, 5.5],
    ['Completed', 1, 2, 2],
    ['On hold', 1, 1, 1],
  ])
  assert.deepEqual(run('SELECT COUNT(*), COUNT(DISTINCT status), MIN(due_date), MAX(due_date) FROM tasks').rows, [
    [4, 3, '2025-11-03', '2025-11-20'],
  ])
  assert.deepEqual(run('SELECT status, COUNT(*) FROM tasks GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 1').rows, [
    ['In progress', 2],
  ])
  assert.deepEqual(run("SELECT COUNT(*) FROM tasks WHERE status = 'nothing'").rows, [[0]])
})

test('joins, left joins and CASE', () => {
  const inner = run(
    'SELECT c.name, COUNT(*) AS tasks FROM tasks t JOIN clients c ON t.client_id = c.id GROUP BY c.name ORDER BY tasks DESC',
  )
  assert.deepEqual(inner.rows, [
    ['Cougar', 2],
    ['Acme', 1],
  ])
  const left = run(
    'SELECT c.name, COUNT(t.id) AS open FROM clients c LEFT JOIN tasks t ON t.client_id = c.id AND t.done = false GROUP BY c.name ORDER BY c.name',
  )
  assert.deepEqual(left.rows, [
    ['Acme', 1],
    ['Cougar', 1],
    ['Initech', 0],
  ])
  const labelled = run(
    "SELECT title, CASE WHEN done THEN 'Done' WHEN due_date < CURRENT_DATE THEN 'Late' ELSE 'Open' END AS state FROM tasks ORDER BY id",
  )
  assert.deepEqual(
    labelled.rows.map(row => row[1]),
    ['Done', 'Late', 'Open', 'Open'],
  )
})

test('dates and functions', () => {
  assert.deepEqual(
    run(
      "SELECT WEEK_START('2025-11-14'), MONTH_START('2025-11-14'), DAYS_BETWEEN('2025-11-01', '2025-11-14'), DATE_ADD('2025-11-14', 7), '2025-11-14' - 3, YEAR('2025-11-14'), QUARTER('2025-11-14')",
    ).rows,
    [['2025-11-10', '2025-11-01', 13, '2025-11-21', '2025-11-11', 2025, 4]],
  )
  assert.deepEqual(
    run(
      "SELECT UPPER('a') || LOWER('B'), COALESCE(NULL, '', 'x'), ROUND(2.345, 2), LENGTH('abc'), SUBSTR('abcdef', 2, 3)",
    ).rows,
    [['Ab', 'x', 2.35, 3, 'bcd']],
  )
  assert.deepEqual(run('SELECT 7 / 2, 7 % 2, 1 / 0').rows, [[3.5, 1, null]])
  assert.equal(
    run(
      "SELECT title FROM tasks WHERE due_date BETWEEN '2025-11-01' AND '2025-11-15' AND status IN ('Completed', 'in progress')",
    ).rows.length,
    2,
  )
})

test('parameters fill in values; missing ones are asked for', () => {
  const sql =
    'SELECT title FROM tasks t JOIN clients c ON c.id = t.client_id WHERE c.name = {{Client}} AND t.due_date >= {{from}}'
  assert.deepEqual(queryParams(sql), ['client', 'from'])
  assert.deepEqual(referencedTables(sql), ['tasks', 'clients'])
  assert.deepEqual(run(sql, { client: 'cougar', from: '2025-11-05' }).rows, [['BPM']])
  assert.throws(() => run(sql, { client: 'Cougar' }), /Fill in \{\{from\}\}/)
})

test('mistakes are explained, and nothing but SELECT runs', () => {
  const message = (sql: string) => {
    try {
      run(sql)
      return ''
    } catch (error) {
      assert.ok(error instanceof SqlError)
      return error.message
    }
  }
  assert.match(message('DELETE FROM tasks'), /read-only/)
  assert.match(message('SELECT * FROM nope'), /no table called nope/)
  assert.match(message('SELECT nope FROM tasks'), /no column called nope/)
  assert.match(message('SELECT id FROM tasks t JOIN clients c ON c.id = t.client_id'), /more than one table/)
  assert.match(message('SELECT title FROM tasks WHERE COUNT(*) > 1'), /HAVING/)
  assert.match(message('SELECT 1; SELECT 2'), /one SELECT/)
  assert.match(message("SELECT 'open"), /closing quote/)
  assert.match(message('SELECT FOO(1)'), /not a function/)
})

test('table identifier parameters resolve only to allow-listed tables', () => {
  const sql = 'SELECT title FROM {{table_name}} WHERE status = {{status}}'
  const allowed = ['tracker_gingersnaps_new_site_rollout', 'tracker_mci_festival_mall']
  assert.deepEqual(tableIdentifierParams(sql), ['table_name'])
  assert.deepEqual(tableIdentifierParams('SELECT * FROM tasks t JOIN {{other_table}} o ON o.id = t.id'), [
    'other_table',
  ])
  assert.equal(
    resolveTableIdentifierParams(sql, { table_name: allowed[0], status: 'Open' }, allowed),
    'SELECT title FROM tracker_gingersnaps_new_site_rollout WHERE status = {{status}}',
  )
  assert.throws(
    () => resolveTableIdentifierParams(sql, { table_name: 'tasks; DROP TABLE tasks', status: 'Open' }, allowed),
    /not an available table/,
  )
  assert.throws(() => resolveTableIdentifierParams(sql, { status: 'Open' }, allowed), /Choose a table/)
})

test('UNION ALL appends SELECT branches and preserves duplicate rows', () => {
  const result = run(`
    SELECT 'Client Name' AS Field, COALESCE(MAX(name), 'TBA') AS Value
    FROM clients
    UNION ALL
    SELECT 'Project Manager', 'Ma. Lourdes Angeles'
    UNION ALL
    SELECT 'Project Manager', 'Ma. Lourdes Angeles'
    UNION ALL
    SELECT 'Project ID', COALESCE(MAX(id), 'TBA')
    FROM clients
  `)
  assert.deepEqual(result.columns, ['Field', 'Value'])
  assert.deepEqual(result.rows, [
    ['Client Name', 'Initech'],
    ['Project Manager', 'Ma. Lourdes Angeles'],
    ['Project Manager', 'Ma. Lourdes Angeles'],
    ['Project ID', 'c3'],
  ])
})

test('UNION ALL collects table references and parameters from every branch', () => {
  const sql = `
    SELECT 'Client Name' AS Field, MAX(name) AS Value
    FROM {{table_name}}
    UNION ALL
    SELECT 'Project Manager', {{manager}}
  `
  assert.deepEqual(referencedTables(sql), ['table_name'])
  assert.deepEqual(queryParams(sql), ['table_name', 'manager'])
  assert.deepEqual(tableIdentifierParams(sql), ['table_name'])
  const resolved = resolveTableIdentifierParams(sql, { table_name: 'clients' }, ['clients'])
  assert.deepEqual(referencedTables(resolved), ['clients'])
  assert.deepEqual(run(resolved, { manager: 'Ma. Lourdes Angeles' }).rows, [
    ['Client Name', 'Initech'],
    ['Project Manager', 'Ma. Lourdes Angeles'],
  ])
})

test('UNION ALL requires every branch to return the same number of columns', () => {
  assert.throws(
    () => run('SELECT 1 AS Field UNION ALL SELECT 2, 3'),
    /same number of columns/,
  )
})

test('UNION without ALL is rejected with a helpful message', () => {
  assert.throws(
    () => run("SELECT 'A' AS Field UNION SELECT 'B'"),
    /Only UNION ALL is supported/,
  )
})
