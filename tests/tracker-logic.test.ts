import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  TRACKER_LIMITS,
  cleanCell,
  cleanSecret,
  normalizeColumns,
  normalizeViews,
  validDate,
  type TrackerColumn,
  type TrackerRow,
} from '../src/features/trackers/trackerModel'
import {
  filterRows,
  groupRows,
  makeLookup,
  rowTitle,
  searchRows,
  shown,
  signoffSummary,
  sortRows,
  visibleRows,
} from '../src/features/trackers/trackerQuery'
import { csvField, exportCsv, exportFileName } from '../src/features/trackers/trackerExport'
import { TRACKER_TEMPLATES, templateById } from '../src/features/trackers/trackerTemplates'
import {
  defaultMappings,
  guessColumn,
  looksDayFirst,
  parseLooseDate,
  parseTable,
  planImport,
  toSource,
} from '../src/features/trackers/trackerImport'

const TODAY = '2026-10-23'

const col = (
  id: string,
  name: string,
  type: TrackerColumn['type'],
  extra: Partial<TrackerColumn> = {},
): TrackerColumn => ({ id, name, type, ...extra })
const status = col('c_status', 'Status', 'select', {
  options: [
    { id: 'o_new', label: 'New', color: 'blue' },
    { id: 'o_live', label: 'Live', color: 'green' },
    { id: 'o_late', label: 'Delayed', color: 'amber' },
  ],
})
const columns: TrackerColumn[] = [
  col('c_site', 'Site', 'text'),
  col('c_go', 'Go-live', 'date'),
  status,
  col('c_cost', 'Cost', 'number'),
  col('c_owner', 'Owner', 'person'),
  col('c_task', 'Task status', 'task_status'),
  col('c_sign', 'Sign-off', 'signoff'),
  col('c_files', 'Drive files', 'drive_files'),
  col('c_pw', 'Admin login', 'secret', { revealBy: 'editors' }),
  col('c_ok', 'COR', 'checkbox'),
]
const row = (id: string, cells: TrackerRow['cells'], extra: Partial<TrackerRow> = {}): TrackerRow => ({
  id,
  position: 1,
  cells,
  secretSet: {},
  taskId: '',
  version: 1,
  updatedAt: '',
  ...extra,
})

const task = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, title: id, status: 'In Progress', ...extra }) as any
const items = [
  task('t1', {
    status: 'Done',
    dueDate: '2026-10-01',
    owner: 'Free text owner',
    docHubDocuments: [{ id: 'd1', title: 'Contract', status: 'COMPLETED', signed: 2, total: 2, documentUrl: '' }],
    driveFiles: [{ id: 'f1' }],
  }),
  task('t2', {
    status: 'In Progress',
    dueDate: '2026-10-01',
    assignedToUserId: 'u1',
    docHubDocuments: [{ id: 'd2', title: 'Form', status: 'PARTIALLY_SIGNED', signed: 1, total: 3, documentUrl: '' }],
  }),
  task('t2a', { parentTaskId: 't2', driveFiles: [{ id: 'f2' }, { id: 'f3' }] }),
]
const lookup = makeLookup(items, [{ id: 'u1', name: 'Ana Reyes', username: 'ana' }], TODAY)

// ---- model ----

test('cells are cleaned the way the server expects', () => {
  const cost = col('c', 'Cost', 'number')
  assert.deepEqual(cleanCell(cost, '1,250.50'), { ok: true, value: 1250.5 })
  assert.deepEqual(cleanCell(cost, ''), { ok: true, value: null })
  assert.equal(cleanCell(cost, 'abc').ok, false)
  assert.equal(cleanCell(col('c', 'D', 'date'), '2026-02-30').ok, false)
  assert.deepEqual(cleanCell(col('c', 'L', 'link'), 'example.com/a'), { ok: true, value: 'https://example.com/a' })
  assert.equal(cleanCell(col('c', 'L', 'link'), 'javascript:alert(1)').ok, false)
  assert.equal(cleanCell(col('c', 'L', 'link'), 'localhost').ok, false)
  assert.equal(
    cleanCell(col('c', 'Pw', 'secret'), 'x').ok,
    false,
    'secrets are set through the secret route, never as a normal cell',
  )
  assert.equal(cleanCell(col('c', 'T', 'task_status'), 'x').ok, false, 'connected columns cannot be written')
  assert.equal(cleanSecret(col('c', 'Pw', 'secret'), 'x'.repeat(TRACKER_LIMITS.secret + 1)).ok, false)
  assert.equal(validDate('2026-13-01'), false)
})

test('a column cannot change type, and names must be unique', () => {
  const before = normalizeColumns([
    { name: 'Site', type: 'text' },
    { name: 'Pw', type: 'secret' },
  ])
  assert.throws(() => normalizeColumns([{ ...before[0], type: 'number' }], before), /cannot change type/)
  assert.throws(
    () =>
      normalizeColumns([
        { name: 'A', type: 'text' },
        { name: 'a', type: 'text' },
      ]),
    /Two columns/,
  )
  assert.throws(
    () =>
      normalizeColumns(Array.from({ length: TRACKER_LIMITS.columns + 1 }, (_, i) => ({ name: `C${i}`, type: 'text' }))),
    /at most/,
  )
  assert.equal(before[1].revealBy, 'editors')
})

test('views drop references to columns that are gone', () => {
  const views = normalizeViews(
    [
      {
        name: 'Mine',
        filters: [
          { columnId: 'c_status', op: 'is', value: 'o_new' },
          { columnId: 'gone', op: 'is', value: 'x' },
        ],
        sort: { columnId: 'gone', dir: 'desc' },
        groupBy: 'gone',
        hidden: ['c_go', 'gone'],
      },
    ],
    columns,
  )
  assert.equal(views[0].filters.length, 1)
  assert.equal(views[0].sort, null)
  assert.equal(views[0].groupBy, '')
  assert.deepEqual(views[0].hidden, ['c_go'])
})

// ---- query ----

test('connected cells come from the linked task and its subtasks', () => {
  const linked = row('r1', {}, { taskId: 't2' })
  assert.deepEqual(shown(columns[5], linked, lookup).text, 'In Progress')
  assert.equal(shown(columns[6], linked, lookup).text, '1 of 3 signed')
  assert.equal(shown(columns[7], linked, lookup).text, '2 files', 'files on subtasks count')
  const done = row('r2', {}, { taskId: 't1' })
  assert.equal(shown(columns[5], done, lookup).tone, 'green')
  assert.equal(shown(columns[6], done, lookup).text, 'Signed')
  assert.equal(shown(columns[7], done, lookup).text, '1 file')
})

test('connected cells say so when there is no task or the task is gone', () => {
  assert.equal(shown(columns[5], row('r', {}), lookup).note, 'unlinked')
  assert.equal(shown(columns[5], row('r', {}, { taskId: 'missing' }), lookup).note, 'removed')
})

test('a past due date is red unless the task is done', () => {
  const dueCol = col('c_due', 'Due', 'task_due')
  assert.equal(shown(dueCol, row('r', {}, { taskId: 't2' }), lookup).tone, 'red')
  assert.equal(shown(dueCol, row('r', {}, { taskId: 't1' }), lookup).tone, undefined)
})

test('task owner prefers the assigned account over free text', () => {
  const ownerCol = col('c_o', 'Task owner', 'task_owner')
  assert.equal(shown(ownerCol, row('r', {}, { taskId: 't2' }), lookup).text, 'Ana Reyes')
  assert.equal(shown(ownerCol, row('r', {}, { taskId: 't1' }), lookup).text, 'Free text owner')
})

test('sign-off summary covers drafts, voided and attention states', () => {
  const doc = (status: string, signed = 0, total = 1, id = status) => ({ id, status, signed, total }) as any
  const wrap = (...docs: any[]) => [task('x', { docHubDocuments: docs })]
  assert.equal(signoffSummary(wrap()).text, 'Not sent')
  assert.equal(signoffSummary(wrap(doc('VOIDED'))).text, 'Not sent')
  assert.equal(signoffSummary(wrap(doc('READY_TO_REVIEW'))).text, 'Draft, not sent')
  assert.equal(signoffSummary(wrap(doc('SENT'), doc('REJECTED'))).text, 'Needs attention')
  assert.equal(signoffSummary(wrap(doc('DONE', 2, 2, 'a'), doc('COMPLETE', 1, 1, 'b'))).text, 'All 2 signed')
  assert.equal(
    signoffSummary([
      task('x', { docHubDocuments: [doc('SENT', 0, 2, 'same')] }),
      task('y', { docHubDocuments: [doc('SENT', 0, 2, 'same')] }),
    ]).text,
    '0 of 2 signed',
    'the same document is not counted twice',
  )
})

test('search needs every word, ignores secrets and hidden columns', () => {
  const rows = [
    row('a', { c_site: 'Makati branch', c_go: '2026-11-01' }, { secretSet: { c_pw: true } }),
    row('b', { c_site: 'Cebu branch' }),
  ]
  assert.deepEqual(
    searchRows(rows, columns, 'branch makati', lookup).map(r => r.id),
    ['a'],
  )
  assert.deepEqual(
    searchRows(rows, columns, 'set', lookup).map(r => r.id),
    [],
    'the word "Set" shown for a secret is not searchable',
  )
  assert.deepEqual(
    searchRows(rows, columns, '2026-11', lookup, ['c_go']).map(r => r.id),
    [],
  )
  assert.equal(searchRows(rows, columns, '   ', lookup).length, 2)
})

test('filters work per column type', () => {
  const rows = [
    row('a', { c_site: 'A', c_cost: 100, c_go: '2026-10-01', c_status: 'o_new', c_ok: true }),
    row('b', { c_site: 'B', c_cost: 300, c_go: '2026-12-01', c_status: 'o_live' }),
    row('c', { c_site: 'C' }),
  ]
  const ids = (filters: any[]) => filterRows(rows, columns, filters, lookup).map(r => r.id)
  assert.deepEqual(ids([{ columnId: 'c_cost', op: 'gt', value: '150' }]), ['b'])
  assert.deepEqual(ids([{ columnId: 'c_cost', op: 'lt', value: '150' }]), ['a'])
  assert.deepEqual(ids([{ columnId: 'c_cost', op: 'is_empty', value: '' }]), ['c'])
  assert.deepEqual(ids([{ columnId: 'c_go', op: 'before', value: '2026-11-01' }]), ['a'])
  assert.deepEqual(ids([{ columnId: 'c_go', op: 'after', value: '2026-11-01' }]), ['b'])
  assert.deepEqual(ids([{ columnId: 'c_status', op: 'is', value: 'o_new' }]), ['a'])
  assert.deepEqual(ids([{ columnId: 'c_status', op: 'is_not', value: 'o_new' }]), ['b', 'c'])
  assert.deepEqual(ids([{ columnId: 'c_ok', op: 'checked', value: '' }]), ['a'])
  assert.deepEqual(ids([{ columnId: 'c_ok', op: 'unchecked', value: '' }]), ['b', 'c'])
  assert.deepEqual(
    ids([
      { columnId: 'c_site', op: 'contains', value: 'b' },
      { columnId: 'c_cost', op: 'gt', value: '1' },
    ]),
    ['b'],
    'filters combine with AND',
  )
  assert.deepEqual(
    ids([{ columnId: 'gone', op: 'is', value: 'x' }]),
    ['a', 'b', 'c'],
    'a filter on a deleted column does nothing',
  )
  assert.deepEqual(ids([{ columnId: 'c_pw', op: 'is_empty', value: '' }]), ['a', 'b', 'c'])
})

test('sorting puts empty values last in both directions and numbers sort as numbers', () => {
  const rows = [row('a', { c_cost: 10 }), row('b', {}), row('c', { c_cost: 9 }), row('d', { c_cost: 100 })]
  assert.deepEqual(
    sortRows(rows, columns, { columnId: 'c_cost', dir: 'asc' }, lookup).map(r => r.id),
    ['c', 'a', 'd', 'b'],
  )
  assert.deepEqual(
    sortRows(rows, columns, { columnId: 'c_cost', dir: 'desc' }, lookup).map(r => r.id),
    ['d', 'a', 'c', 'b'],
  )
  const sites = [row('a', { c_site: 'Site 10' }), row('b', { c_site: 'Site 9' })]
  assert.deepEqual(
    sortRows(sites, columns, { columnId: 'c_site', dir: 'asc' }, lookup).map(r => r.id),
    ['b', 'a'],
    'Site 9 comes before Site 10',
  )
  assert.equal(sortRows(rows, columns, null, lookup), rows)
})

test('select columns sort in option order, not alphabetically', () => {
  const rows = [
    row('late', { c_status: 'o_late' }),
    row('new', { c_status: 'o_new' }),
    row('live', { c_status: 'o_live' }),
  ]
  assert.deepEqual(
    sortRows(rows, columns, { columnId: 'c_status', dir: 'asc' }, lookup).map(r => r.id),
    ['new', 'live', 'late'],
  )
  assert.deepEqual(
    groupRows(rows, status, lookup).map(g => g.label),
    ['New', 'Live', 'Delayed'],
  )
})

test('groups put empty last', () => {
  const rows = [row('a', {}), row('b', { c_status: 'o_live' }), row('c', { c_status: 'o_live' })]
  const groups = groupRows(rows, status, lookup)
  assert.deepEqual(
    groups.map(g => [g.label, g.rows.length]),
    [
      ['Live', 2],
      ['Empty', 1],
    ],
  )
})

test('visibleRows applies search, then filters, then sort', () => {
  const rows = [
    row('a', { c_site: 'Alpha', c_cost: 5 }),
    row('b', { c_site: 'Alpha two', c_cost: 1 }),
    row('c', { c_site: 'Beta', c_cost: 3 }),
  ]
  const result = visibleRows(
    rows,
    columns,
    { search: 'alpha', filters: [], sort: { columnId: 'c_cost', dir: 'asc' } },
    lookup,
  )
  assert.deepEqual(
    result.map(r => r.id),
    ['b', 'a'],
  )
})

test('a row is named by its first text column', () => {
  assert.equal(rowTitle(columns, row('a', { c_site: 'Makati' })), 'Makati')
  assert.equal(rowTitle(columns, row('a', {})), 'Untitled row')
})

// ---- export ----

test('CSV export leaves out secrets, guards formulas and quotes properly', () => {
  const rows = [
    row(
      'a',
      { c_site: '=HYPERLINK("x")', c_cost: -5, c_go: '2026-11-01', c_status: 'o_live' },
      { taskId: 't1', secretSet: { c_pw: true } },
    ),
    row('b', { c_site: 'Has, comma\nand newline' }),
  ]
  const csv = exportCsv(columns, rows, lookup)
  assert.ok(csv.startsWith('﻿'))
  assert.ok(!csv.includes('Admin login'), 'secret columns are not exported')
  const lines = csv.slice(1).split('\r\n')
  assert.equal(lines[0], 'Site,Go-live,Status,Cost,Owner,Task status,Sign-off,Drive files,COR')
  assert.equal(
    lines[1],
    `"'=HYPERLINK(""x"")",2026-11-01,Live,-5,,Done,Signed,1 file,No`,
    'text is guarded, a negative number is not',
  )
  assert.ok(csv.includes('"Has, comma\nand newline"'))
  assert.ok(csv.endsWith('\r\n'))
})

test('csvField guards every formula starter in text', () => {
  for (const start of ['=', '+', '-', '@', '\t'])
    assert.ok(csvField(`${start}1`, true).startsWith(start === '\t' ? "'" : "'"), start)
  assert.equal(csvField('-5', false), '-5')
})

test('export file names are safe', () => {
  assert.equal(exportFileName('Site: rollout/2026?', TODAY), 'Site rollout 2026 2026-10-23.csv')
  assert.equal(exportFileName('...', TODAY), 'Tracker 2026-10-23.csv')
})

// ---- templates ----

test('every template builds valid columns and the blank one has a single text column', () => {
  assert.ok(TRACKER_TEMPLATES.length >= 5)
  for (const template of TRACKER_TEMPLATES) {
    const built = normalizeColumns(template.columns.map(c => ({ ...c })))
    assert.equal(built.length, template.columns.length, template.id)
    assert.equal(built[0].type, 'text', `${template.id} starts with a text column`)
  }
  assert.deepEqual(
    templateById('blank')?.columns.map(c => c.type),
    ['text'],
  )
  assert.equal(templateById('nope'), undefined)
})

test('no template stores a secret value or an invented credential', () => {
  const json = JSON.stringify(TRACKER_TEMPLATES)
  assert.ok(!/password\s*[:=]/i.test(json))
  for (const template of TRACKER_TEMPLATES)
    for (const column of template.columns) if (column.type === 'secret') assert.equal(column.options, undefined)
})

// ---- import: reading ----

test('pasted sheets and CSV files are both read', () => {
  assert.deepEqual(parseTable('Site\tCost\nA\t1\nB\t2'), [
    ['Site', 'Cost'],
    ['A', '1'],
    ['B', '2'],
  ])
  assert.deepEqual(parseTable('Site,Cost\r\nA,1\r\nB,2\r\n'), [
    ['Site', 'Cost'],
    ['A', '1'],
    ['B', '2'],
  ])
  assert.deepEqual(parseTable('Site;Cost\nA;1'), [
    ['Site', 'Cost'],
    ['A', '1'],
  ])
  assert.deepEqual(parseTable('﻿Site,Note\n"A, Inc","He said ""hi"""\n"line\nbreak",x'), [
    ['Site', 'Note'],
    ['A, Inc', 'He said "hi"'],
    ['line\nbreak', 'x'],
  ])
  assert.deepEqual(parseTable(''), [])
})

test('toSource trims, drops empty rows and columns, and numbers missing headers', () => {
  const ok = toSource(
    [
      ['Site', '', 'Cost', ''],
      ['A', '', '1'],
      ['', '', '', ''],
      ['B', '', '2', ''],
    ],
    true,
  )
  assert.ok(ok.ok)
  if (ok.ok) {
    assert.deepEqual(ok.source.headers, ['Site', 'Cost'])
    assert.deepEqual(ok.source.rows, [
      ['A', '1'],
      ['B', '2'],
    ])
  }
  const noHeader = toSource(
    [
      ['A', '1'],
      ['B', '2'],
    ],
    false,
  )
  assert.ok(noHeader.ok && noHeader.source.headers.join() === 'Column 1,Column 2' && noHeader.source.rows.length === 2)
  assert.equal(toSource([], true).ok, false)
  assert.equal(toSource([['Only a header']], true).ok, false)
  assert.equal(
    toSource(
      [
        Array.from({ length: TRACKER_LIMITS.columns + 1 }, (_, i) => `H${i}`),
        Array.from({ length: TRACKER_LIMITS.columns + 1 }, () => 'x'),
      ],
      true,
    ).ok,
    false,
  )
})

test('loose dates', () => {
  assert.equal(parseLooseDate('2026-11-05', TODAY), '2026-11-05')
  assert.equal(parseLooseDate('2026/1/5', TODAY), '2026-01-05')
  assert.equal(parseLooseDate('11/05/2026', TODAY), '2026-11-05')
  assert.equal(parseLooseDate('11/05/2026', TODAY, true), '2026-05-11')
  assert.equal(parseLooseDate('25/12/26', TODAY, true), '2026-12-25')
  assert.equal(parseLooseDate('Nov 5', TODAY), '2026-11-05')
  assert.equal(parseLooseDate('November 5, 2027', TODAY), '2027-11-05')
  assert.equal(parseLooseDate('5th Nov 2026', TODAY), '2026-11-05')
  assert.equal(parseLooseDate('12/25', TODAY), '2026-12-25')
  assert.equal(parseLooseDate('13/25/2026', TODAY), '')
  assert.equal(parseLooseDate('2026-02-30', TODAY), '')
  assert.equal(parseLooseDate('soon', TODAY), '')
  assert.equal(parseLooseDate('Foo 5', TODAY), '')
  assert.equal(looksDayFirst(['25/12/2026', '01/02/2026']), true)
  assert.equal(looksDayFirst(['12/25/2026']), false)
})

test('type guessing', () => {
  const g = (header: string, values: string[], first = false) => guessColumn(header, values, first, TODAY).type
  assert.equal(g('Admin password', ['a', 'b']), 'secret')
  assert.equal(g('Compass', ['north', 'south']), 'text', 'compass is not a password')
  assert.equal(g('Passenger', ['a', 'b']), 'text')
  assert.equal(g('Name', ['x', 'y'], true), 'text', 'the first column stays text')
  assert.equal(g('Go live', ['2026-11-01', 'Nov 5']), 'date')
  assert.equal(g('Cost', ['1,200', '$30.50', '7']), 'number')
  assert.equal(g('Store ID', ['001', '002']), 'text', 'ids with leading zeros stay text')
  assert.equal(g('COR', ['Yes', 'no', 'yes']), 'checkbox')
  assert.equal(g('Repo', ['https://git.example.com/a/1', 'https://git.example.com/a/2']), 'link')
  assert.equal(g('Notes', ['one\ntwo', 'x']), 'longtext')
  assert.equal(g('Status', ['New', 'Live', 'New', 'Live', 'New']), 'select')
  assert.equal(g('Status', ['New', 'Live']), 'text', 'too few rows to call it a list of options')
  assert.equal(g('Anything', []), 'text')
  const select = guessColumn('Status', ['New', 'live', 'New', 'Live', 'Delayed'], false, TODAY)
  assert.deepEqual(select.options, ['New', 'live', 'Delayed'], 'options ignore capitalisation differences')
})

// ---- import: planning ----

const people = [{ id: 'u1', name: 'Ana Reyes', email: 'ana@example.com', username: 'ana' }]
const planFor = (
  grid: string[][],
  existing: TrackerColumn[],
  tweak?: (m: ReturnType<typeof defaultMappings>) => void,
  capacity = 5000,
) => {
  const parsed = toSource(grid, true)
  assert.ok(parsed.ok)
  if (!parsed.ok) throw new Error()
  const mappings = defaultMappings(parsed.source, existing, TODAY)
  tweak?.(mappings)
  return {
    plan: planImport(parsed.source, mappings, existing, { today: TODAY, people, capacity, firstRowIsHeader: true }),
    mappings,
  }
}

test('importing into a new tracker creates typed columns and rows', () => {
  const grid = [
    ['Site', 'Go live', 'Cost', 'Status', 'Admin password', 'Owner'],
    ['Makati', '11/25/2026', '$1,200', 'New', 'Not-a-real-password-1', 'Ana Reyes'],
    ['Cebu', 'Nov 30', '900', 'Live', 'Not-a-real-password-2', 'ana@example.com'],
    ['Davao', '12/05/2026', '15', 'New', '', 'Nobody Known'],
    ['Iloilo', '12/15/2026', '20', 'Live', '', ''],
  ]
  const { plan, mappings } = planFor(grid, [])
  assert.equal(plan.fatal, '')
  assert.deepEqual(
    mappings.map(m => m.type),
    ['text', 'date', 'number', 'select', 'secret', 'text'],
    'owner is plain text until the user picks Person',
  )
  const { plan: withPerson } = planFor(grid, [], m => {
    m[5].type = 'person'
  })
  assert.equal(withPerson.fatal, '')
  assert.equal(withPerson.rows.length, 4)
  const byName = (name: string) => withPerson.columns.find(c => c.name === name)!
  assert.equal(withPerson.rows[0].cells[byName('Go live').id], '2026-11-25')
  assert.equal(withPerson.rows[0].cells[byName('Cost').id], 1200)
  assert.equal(withPerson.rows[0].cells[byName('Owner').id], 'u1')
  assert.equal(withPerson.rows[1].cells[byName('Owner').id], 'u1', 'matched by email')
  assert.equal(withPerson.rows[2].cells[byName('Owner').id], undefined)
  assert.equal(withPerson.rows[0].secrets[byName('Admin password').id], 'Not-a-real-password-1')
  assert.equal(byName('Admin password').revealBy, 'editors')
  assert.equal(byName('Status').options?.length, 2)
  assert.equal(
    withPerson.rows[0].cells[byName('Status').id],
    withPerson.rows[2].cells[byName('Status').id],
    'same label, same option',
  )
  assert.ok(withPerson.warnings.some(w => w.includes('Nobody Known')))
  assert.equal(withPerson.added.length, 6)
  assert.ok(
    !JSON.stringify(withPerson.columns).includes('Not-a-real-password'),
    'no secret value is placed in the column list',
  )
})

test('secret values never appear in cells', () => {
  const { plan } = planFor(
    [
      ['Site', 'Password'],
      ['A', 'Not-a-real-password-1'],
      ['B', 'Not-a-real-password-2'],
    ],
    [],
  )
  for (const imported of plan.rows) assert.ok(!JSON.stringify(imported.cells).includes('Not-a-real-password'))
  assert.equal(Object.keys(plan.rows[0].secrets).length, 1)
})

test('bad cells are left empty and listed with the sheet row number', () => {
  const { plan } = planFor(
    [
      ['Site', 'Go live'],
      ['A', '2026-11-01'],
      ['B', 'soon'],
      ['C', ''],
    ],
    [col('c_site', 'Site', 'text'), col('c_go', 'Go live', 'date')],
  )
  assert.equal(plan.fatal, '')
  assert.equal(plan.rows.length, 3)
  assert.deepEqual(
    plan.problems.map(p => [p.row, p.column, p.value]),
    [[3, 'Go live', 'soon']],
  )
  assert.equal(plan.rows[1].cells.c_go, undefined)
})

test('headers match existing columns regardless of case and punctuation', () => {
  const existing = [
    col('c_site', 'Site', 'text'),
    col('c_go', 'Go-live', 'date'),
    col('c_task', 'Task status', 'task_status'),
  ]
  const parsed = toSource(
    [
      ['site', 'GO LIVE', 'Task status'],
      ['A', '2026-11-01', 'Done'],
    ],
    true,
  )
  assert.ok(parsed.ok)
  if (!parsed.ok) return
  const mappings = defaultMappings(parsed.source, existing, TODAY)
  assert.deepEqual(
    mappings.map(m => m.target),
    ['c_site', 'c_go', 'new'],
    'a connected column is never a match target',
  )
})

test('a connected column cannot receive sheet data, and two sheet columns cannot share a target', () => {
  const existing = [col('c_site', 'Site', 'text'), col('c_task', 'Task status', 'task_status')]
  const parsed = toSource(
    [
      ['A', 'B'],
      ['x', 'y'],
    ],
    true,
  )
  assert.ok(parsed.ok)
  if (!parsed.ok) return
  const base = defaultMappings(parsed.source, existing, TODAY)
  assert.match(
    planImport(
      parsed.source,
      base.map((m, i) => (i === 1 ? { ...m, target: 'c_task' } : m)),
      existing,
      { today: TODAY, people, capacity: 10, firstRowIsHeader: true },
    ).fatal,
    /fills itself/,
  )
  assert.match(
    planImport(
      parsed.source,
      base.map(m => ({ ...m, target: 'c_site' })),
      existing,
      { today: TODAY, people, capacity: 10, firstRowIsHeader: true },
    ).fatal,
    /Two sheet columns/,
  )
  assert.match(
    planImport(
      parsed.source,
      base.map(m => ({ ...m, type: 'task_due' as const })),
      existing,
      { today: TODAY, people, capacity: 10, firstRowIsHeader: true },
    ).fatal,
    /fills itself/,
  )
})

test('capacity, column limit and empty selections stop the import with a reason', () => {
  assert.match(planFor([['A'], ['1'], ['2'], ['3']], [], undefined, 2).plan.fatal, /room for 2 more rows/)
  assert.match(
    planFor(
      [
        ['A', 'B'],
        ['1', '2'],
      ],
      [],
      m =>
        m.forEach(x => {
          x.include = false
        }),
    ).plan.fatal,
    /at least one column/,
  )
  const wide = Array.from({ length: TRACKER_LIMITS.columns }, (_, i) => col(`c${i}_x`, `Existing ${i}`, 'text'))
  assert.match(planFor([['New one'], ['1']], wide).plan.fatal, /limit is 100/)
})

test('new column names never clash with existing ones', () => {
  const { plan } = planFor(
    [
      ['Site', 'Site'],
      ['A', 'B'],
    ],
    [col('c_site', 'Site', 'text')],
    m => {
      m[0].target = 'new'
      m[1].target = 'new'
    },
  )
  const names = plan.columns.map(c => c.name.toLowerCase())
  assert.equal(new Set(names).size, names.length)
})

test('multi select cells split on commas and add options', () => {
  const tags = col('c_tags', 'Tags', 'multiselect', { options: [{ id: 'o_a', label: 'Alpha', color: 'blue' }] })
  const { plan } = planFor([['Tags'], ['alpha, Beta'], ['Beta;Gamma']], [tags])
  assert.equal(plan.columns[0].options?.length, 3)
  assert.deepEqual(plan.rows[0].cells.c_tags, ['o_a', plan.columns[0].options![1].id])
})

test('importing does not change the columns it was given', () => {
  const status2 = col('c_s', 'Status', 'select', { options: [{ id: 'o_a', label: 'A', color: 'blue' }] })
  const before = JSON.stringify([status2])
  planFor([['Status'], ['B']], [status2])
  assert.equal(JSON.stringify([status2]), before)
})

test('rows with nothing readable are skipped, and an all-empty sheet is refused', () => {
  const { plan } = planFor(
    [
      ['Site', 'Cost'],
      ['A', '1'],
      ['', ''],
      ['', 'x'],
    ],
    [col('c_site', 'Site', 'text'), col('c_cost', 'Cost', 'number')],
  )
  assert.equal(plan.rows.length, 1)
  assert.equal(plan.problems.length, 1)
  const empty = planFor([['Cost'], ['x']], [col('c_cost', 'Cost', 'number')]).plan
  assert.match(empty.fatal, /No rows could be read/)
})

test('headers with a blank cell are named and listed, counted after empty columns are dropped', () => {
  // Column B is empty everywhere and is dropped; column D has data but no header.
  const parsed = toSource(
    [
      ['Site', '', 'Status', '', 'Go-live'],
      ['Makati', '', 'Pre Live', 'note', '11/19/2026'],
    ],
    true,
  )
  assert.ok(parsed.ok)
  if (!parsed.ok) return
  assert.deepEqual(parsed.source.headers, ['Site', 'Status', 'Column 3', 'Go-live'])
  assert.deepEqual(parsed.source.unnamed, [2], '“Column 3” is headers[2], not the Sheet’s third column')
  const noHeader = toSource([['a', 'b']], false)
  assert.ok(!noHeader.ok || noHeader.source.unnamed?.length === 0)
})
