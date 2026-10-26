import test from 'node:test'
import assert from 'node:assert/strict'
import { registerTrackerRoutes } from '../server/trackers/trackers'
import {
  columnLetter,
  completionChanges,
  locateSheetCell,
  planAutoDone,
  sheetTextFor,
  sheetTextMatches,
} from '../src/features/trackers/trackerAutoDone'
import { normalizeColumns, type TrackerColumn } from '../src/features/trackers/trackerModel'

const statuses = [
  { id: 'open', label: 'Open', closed: false },
  { id: 'done', label: 'Done', closed: true },
]
const checkbox: TrackerColumn = { id: 'c_done', name: 'Done', type: 'checkbox', autoDone: {} }
const choice: TrackerColumn = {
  id: 'c_status',
  name: 'Status',
  type: 'select',
  options: [
    { id: 'o_open', label: 'Open', color: 'gray' },
    { id: 'o_block', label: 'Blocked', color: 'red' },
    { id: 'o_done', label: 'Done', color: 'green' },
  ],
  autoDone: { done: 'o_done', undone: 'o_open' },
}

test('the setting is kept for Checkbox and Choice columns only, on one column at most', () => {
  const columns = normalizeColumns([
    { id: 'c_name', name: 'Name', type: 'text', autoDone: {} },
    { ...checkbox },
    { ...choice },
  ])
  assert.equal(columns[0].autoDone, undefined, 'a text column cannot mark done')
  assert.deepEqual(columns[1].autoDone, {})
  assert.equal(columns[2].autoDone, undefined, 'only the first column that asks keeps it')
  const [select] = normalizeColumns([{ ...choice, autoDone: { done: 'o_gone', undone: 'o_open' } }])
  assert.equal(select.autoDone, undefined, 'a done option that does not exist turns it off')
  const [kept] = normalizeColumns([{ ...choice, autoDone: { done: 'o_done', undone: 'o_done' } }])
  assert.deepEqual(kept.autoDone, { done: 'o_done' }, 'the not-done option cannot be the done option')
})

test('completion changes compare saves using the workspace statuses', () => {
  const before = {
    taskSettings: { statuses },
    items: [
      { id: 't1', status: 'Open' },
      { id: 't2', status: 'Done' },
      { id: 't3', status: 'Open' },
      { id: 'gone', status: 'Open' },
    ],
  }
  const after = {
    taskSettings: { statuses },
    items: [
      { id: 't1', status: 'Done' },
      { id: 't2', status: 'Open' },
      { id: 't3', status: 'Open' },
      { id: 'new', status: 'Done' },
    ],
  }
  assert.deepEqual(
    [...completionChanges(before, after)],
    [
      ['t1', true],
      ['t2', false],
      ['new', true],
    ],
  )
  assert.equal(completionChanges(after, after).size, 0)
})

test('a row is done only when every linked task is, and a reopen only undoes a done mark', () => {
  const closed = (map: Record<string, boolean>) => (id: string) => map[id]
  const changes = (entries: [string, boolean][]) => new Map(entries)
  // Two linked subtasks; one completes while the other is still open: nothing yet.
  assert.equal(
    planAutoDone({
      column: checkbox,
      current: false,
      linked: ['s1', 's2'],
      closed: closed({ s1: true, s2: false }),
      changes: changes([['s1', true]]),
    }),
    null,
  )
  // The second completes: ticked.
  assert.deepEqual(
    planAutoDone({
      column: checkbox,
      current: false,
      linked: ['s1', 's2'],
      closed: closed({ s1: true, s2: true }),
      changes: changes([['s2', true]]),
    }),
    { value: true, reason: 'done', taskIds: ['s2'] },
  )
  // A deleted linked task does not hold the row back.
  assert.equal(
    planAutoDone({
      column: checkbox,
      current: false,
      linked: ['s1', 'deleted'],
      closed: closed({ s1: true }),
      changes: changes([['s1', true]]),
    })?.value,
    true,
  )
  // Reopened: unticked.
  assert.deepEqual(
    planAutoDone({
      column: checkbox,
      current: true,
      linked: ['s1', 's2'],
      closed: closed({ s1: false, s2: true }),
      changes: changes([['s1', false]]),
    }),
    { value: false, reason: 'reopened', taskIds: ['s1'] },
  )
  // Choice: done sets Done; a reopen sets Open, but leaves a value someone picked by hand.
  assert.equal(
    planAutoDone({
      column: choice,
      current: 'o_open',
      linked: ['t1'],
      closed: closed({ t1: true }),
      changes: changes([['t1', true]]),
    })?.value,
    'o_done',
  )
  assert.equal(
    planAutoDone({
      column: choice,
      current: 'o_done',
      linked: ['t1'],
      closed: closed({ t1: false }),
      changes: changes([['t1', false]]),
    })?.value,
    'o_open',
  )
  assert.equal(
    planAutoDone({
      column: choice,
      current: 'o_block',
      linked: ['t1'],
      closed: closed({ t1: false }),
      changes: changes([['t1', false]]),
    }),
    null,
  )
  // Already done: nothing to change.
  assert.equal(
    planAutoDone({
      column: choice,
      current: 'o_done',
      linked: ['t1'],
      closed: closed({ t1: true }),
      changes: changes([['t1', true]]),
    }),
    null,
  )
})

test('Sheet cells are found by task name and order, and written in the Sheet’s own style', () => {
  const grid = [
    ['Branch #', 'Branch', 'Done'],
    ['57', 'Batch 5', 'No'],
    ['', '', ''],
    ['58', 'Sta. Rosa', ''],
    ['', 'Under 58', 'x'],
  ]
  assert.deepEqual(locateSheetCell(grid, 'Branch #', '58', 'Done'), { row: 4, column: 2, text: '' })
  assert.deepEqual(locateSheetCell(grid, 'Branch #', '58\u001e1', 'done '), { row: 5, column: 2, text: 'x' })
  assert.deepEqual(locateSheetCell(grid, 'Branch #', '99', 'Done'), { error: 'no_row' })
  assert.deepEqual(locateSheetCell(grid, 'Branch #', '57', 'Missing'), { error: 'no_header' })
  assert.equal(columnLetter(0), 'A')
  assert.equal(columnLetter(25), 'Z')
  assert.equal(columnLetter(27), 'AB')
  assert.equal(sheetTextFor(checkbox, true, 'No'), 'Yes')
  assert.equal(sheetTextFor(checkbox, false, 'YES'), 'NO')
  assert.equal(sheetTextFor(checkbox, true, 'FALSE'), 'TRUE')
  assert.equal(sheetTextFor(checkbox, false, 'x'), '')
  assert.equal(sheetTextFor(checkbox, true, ''), 'TRUE')
  assert.equal(sheetTextFor(choice, 'o_done', 'Open'), 'Done')
  assert.equal(sheetTextFor(choice, '', 'Done'), '')
  assert.ok(sheetTextMatches(checkbox, 'yes', true))
  assert.ok(sheetTextMatches(checkbox, '', false))
  assert.ok(sheetTextMatches(choice, 'done', 'o_done'))
  assert.ok(!sheetTextMatches(choice, 'Open', 'o_done'))
})

// ---- End to end: a workspace save completes subtasks; the linked row is ticked here and in the Sheet. ----

type Row = Record<string, any>
function memoryDb() {
  const tables: Record<string, Row[]> = {
    tenant_trackers: [],
    tenant_tracker_rows: [],
    tenant_tracker_changes: [],
    tenant_tracker_task_links: [],
    tenant_tracker_sources: [],
  }
  class Query {
    action = 'read'
    values: Row[] = []
    filters: ((row: Row) => boolean)[] = []
    take?: number
    one = false
    returning = false
    constructor(public table: string) {}
    select() {
      if (this.action !== 'read') this.returning = true
      return this
    }
    insert(v: Row | Row[]) {
      this.action = 'insert'
      this.values = Array.isArray(v) ? v : [v]
      return this
    }
    update(v: Row) {
      this.action = 'update'
      this.values = [v]
      return this
    }
    eq(c: string, v: any) {
      this.filters.push(r => r[c] === v)
      return this
    }
    in(c: string, v: any[]) {
      this.filters.push(r => v.includes(r[c]))
      return this
    }
    order() {
      return this
    }
    limit(n: number) {
      this.take = n
      return this
    }
    range(a: number, b: number) {
      this.take = b - a + 1
      return this
    }
    maybeSingle() {
      this.one = true
      return this
    }
    then(resolve: any, reject: any) {
      return Promise.resolve(this.run()).then(resolve, reject)
    }
    run() {
      const rows = tables[this.table]
      if (this.action === 'insert') {
        rows.push(...this.values.map(v => structuredClone(v)))
        return { data: null, error: null }
      }
      const matched = rows.filter(r => this.filters.every(f => f(r)))
      if (this.action === 'update') {
        matched.forEach(r => Object.assign(r, structuredClone(this.values[0])))
        return { data: this.returning ? matched.map(r => structuredClone(r)) : null, error: null }
      }
      const out = matched.map(r => structuredClone(r)).slice(0, this.take)
      return { data: this.one ? (out[0] ?? null) : out, error: null }
    }
  }
  return { from: (t: string) => new Query(t), tables }
}

const TENANT = '11111111-1111-4111-8111-111111111111'
const TRACKER = '22222222-2222-4222-8222-222222222222'
const ROW_57 = '33333333-3333-4333-8333-333333333333'
const ROW_58 = '44444444-4444-4444-8444-444444444444'
const SHEET = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'
const WRITE = 'https://www.googleapis.com/auth/spreadsheets'
const READ = 'https://www.googleapis.com/auth/spreadsheets.readonly'

let sheet: string[][] = []
const writes: any[] = []
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input)
  if (!url.startsWith('https://sheets.googleapis.com/')) return realFetch(input, init)
  const reply = (status: number, body: any) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  if (url.endsWith('/values:batchUpdate') && init?.method === 'POST') {
    const body = JSON.parse(init.body)
    writes.push(body)
    for (const entry of body.data) {
      const [, cell] = /!([A-Z]+\d+)$/.exec(entry.range) || []
      const column = cell.charCodeAt(0) - 65,
        row = Number(cell.slice(1)) - 1
      while (sheet.length <= row) sheet.push([])
      sheet[row][column] = entry.values[0][0]
    }
    return reply(200, { totalUpdatedCells: body.data.length })
  }
  if (url.includes('/values/')) return reply(200, { values: sheet })
  return reply(404, { error: { message: 'not found' } })
}) as any

function setup(scope = WRITE) {
  const db = memoryDb()
  const noop = () => undefined
  const app = { get: noop, post: noop, put: noop, patch: noop, delete: noop, use: noop }
  const engine = registerTrackerRoutes(app as any, {
    db,
    requireAuth: noop as any,
    requireTenant: noop as any,
    load: async () => ({ data: {} }),
    key: Buffer.alloc(32, 7),
    googleAccess: async (_tenant, userId) => ({ token: `token-${userId}`, scope: `${scope}` }),
  })
  const column: TrackerColumn = { id: 'c_done', name: 'Done', type: 'checkbox', synced: true, autoDone: {} }
  db.tables.tenant_trackers.push({
    tenant_id: TENANT,
    id: TRACKER,
    name: 'Rollout',
    columns: [{ id: 'c_branch', name: 'Branch #', type: 'text', synced: true }, column],
    views: [],
    revision: 1,
    archived_at: null,
  })
  const row = (id: string, key: string, done: string) => ({
    tenant_id: TENANT,
    tracker_id: TRACKER,
    id,
    position: 1,
    data: { c_branch: key },
    secrets: {},
    task_id: '',
    version: 1,
    source_key: key,
    source_values: { 'Branch #': key, Done: done },
  })
  db.tables.tenant_tracker_rows.push(row(ROW_57, '57', 'No'), row(ROW_58, '58', ''))
  db.tables.tenant_tracker_sources.push({
    tenant_id: TENANT,
    tracker_id: TRACKER,
    spreadsheet_id: SHEET,
    tab: 'Branches',
    key_header: 'Branch #',
    header_map: { 'Branch #': 'c_branch', Done: 'c_done' },
    connected_by: 'u1',
    connected_by_name: 'Ana Reyes',
  })
  const link = (rowId: string, taskId: string, n: number) => ({
    id: `55555555-5555-4555-8555-55555555555${n}`,
    tenant_id: TENANT,
    tracker_id: TRACKER,
    row_id: rowId,
    column_id: '',
    task_id: taskId,
  })
  db.tables.tenant_tracker_task_links.push(link(ROW_57, 's1', 1), link(ROW_57, 's2', 2), link(ROW_58, 's3', 3))
  const state = (s1: string, s2: string, s3: string) => ({
    taskSettings: { statuses },
    items: [
      { id: 's1', title: 'DRF', status: s1 },
      { id: 's2', title: 'UAT', status: s2 },
      { id: 's3', title: 'Go-live', status: s3 },
    ],
  })
  const rowOf = (id: string) => db.tables.tenant_tracker_rows.find(item => item.id === id)!
  return { db, engine, state, rowOf }
}

test('completing the last linked subtask ticks the row and writes Yes to the Sheet', async () => {
  sheet = [
    ['Branch #', 'Done'],
    ['57', 'No'],
    ['58', ''],
  ]
  writes.length = 0
  const { db, engine, state, rowOf } = setup()
  const actor = { id: 'u2', name: 'Ben Cruz' } as any

  await engine.onWorkspaceSaved(TENANT, state('Open', 'Open', 'Open'), state('Done', 'Open', 'Open'), actor)
  assert.equal(rowOf(ROW_57).data.c_done, undefined, 'one of two subtasks done: not yet')
  assert.equal(writes.length, 0)

  await engine.onWorkspaceSaved(TENANT, state('Done', 'Open', 'Open'), state('Done', 'Done', 'Open'), actor)
  assert.equal(rowOf(ROW_57).data.c_done, true)
  assert.equal(rowOf(ROW_57).version, 2)
  assert.equal(sheet[1][1], 'Yes', 'the Sheet keeps its Yes/No style')
  assert.deepEqual(writes[0].data, [{ range: "'Branches'!B2", values: [['Yes']] }])
  assert.equal(rowOf(ROW_57).source_values.Done, 'Yes', 'the next sync sees no change in the Sheet')
  const history = db.tables.tenant_tracker_changes.filter(change => change.row_id === ROW_57)
  assert.equal(history.at(-1).kind, 'auto_done')
  assert.equal(history.at(-1).actor_name, 'Ben Cruz')
  assert.deepEqual(history.at(-1).detail.tasks, ['UAT'])

  // Reopening one subtask unticks it in both places.
  await engine.onWorkspaceSaved(TENANT, state('Done', 'Done', 'Open'), state('Done', 'Open', 'Open'), actor)
  assert.equal(rowOf(ROW_57).data.c_done, undefined)
  assert.equal(sheet[1][1], 'No')
})

test('a cell changed in the Sheet since the last sync is not overwritten; the row says why', async () => {
  sheet = [
    ['Branch #', 'Done'],
    ['57', 'No'],
    ['58', 'Pending'],
  ]
  writes.length = 0
  const { engine, state, rowOf } = setup()
  await engine.onWorkspaceSaved(TENANT, state('Open', 'Open', 'Open'), state('Open', 'Open', 'Done'), null)
  assert.equal(writes.length, 0)
  assert.equal(sheet[2][1], 'Pending')
  assert.equal(rowOf(ROW_58).data.c_done, undefined, 'the tracker keeps showing what the Sheet has')
  assert.equal(rowOf(ROW_58).sheet_issue.code, 'conflict')
  assert.equal(rowOf(ROW_58).sheet_issue.value, true)
})

test('without permission to edit Sheets nothing is written and each row says so', async () => {
  sheet = [
    ['Branch #', 'Done'],
    ['57', 'No'],
    ['58', ''],
  ]
  writes.length = 0
  const { engine, state, rowOf } = setup(READ)
  await engine.onWorkspaceSaved(TENANT, state('Open', 'Open', 'Open'), state('Open', 'Open', 'Done'), null)
  assert.equal(writes.length, 0)
  assert.equal(rowOf(ROW_58).sheet_issue.code, 'no_access')
})

test('a column the Sheet does not fill is updated in the tracker only', async () => {
  sheet = [['Branch #'], ['57'], ['58']]
  writes.length = 0
  const { db, engine, state, rowOf } = setup()
  const tracker = db.tables.tenant_trackers[0]
  tracker.columns = tracker.columns.map((column: TrackerColumn) =>
    column.id === 'c_done' ? { ...column, synced: undefined } : column,
  )
  await engine.onWorkspaceSaved(TENANT, state('Open', 'Open', 'Open'), state('Open', 'Open', 'Done'), null)
  assert.equal(rowOf(ROW_58).data.c_done, true)
  assert.equal(writes.length, 0)
  assert.equal(db.tables.tenant_tracker_changes.at(-1).actor_name, 'Automatic')
})
