import test from 'node:test'
import assert from 'node:assert/strict'
import { registerTrackerRoutes } from '../server/trackers/trackers'
import { planAppend, planCellWrites, sheetTextOf } from '../src/features/trackers/trackerTwoWay'
import type { TrackerColumn } from '../src/features/trackers/trackerModel'

const columns: TrackerColumn[] = [
  { id: 'c_key', name: 'Branch #', type: 'text', synced: true },
  {
    id: 'c_status',
    name: 'Status',
    type: 'select',
    synced: true,
    options: [
      { id: 'o_pending', label: 'Pending', color: 'gray' },
      { id: 'o_done', label: 'Done', color: 'green' },
    ],
  },
  { id: 'c_live', name: 'Go-live', type: 'date', synced: true },
  { id: 'c_owner', name: 'Owner', type: 'person', synced: true },
  { id: 'c_notes', name: 'Our notes', type: 'longtext' },
]
const headerMap = { 'Branch #': 'c_key', Status: 'c_status', 'Go-live': 'c_live', Owner: 'c_owner' }
const people = [{ id: 'u1', name: 'Ana Reyes' }]

test('tracker values become Sheet text; text is written as typed, numbers and dates are read by Google', () => {
  assert.deepEqual(sheetTextOf(columns[1], 'o_done', people), { text: 'Done', input: 'RAW' })
  assert.deepEqual(sheetTextOf(columns[2], '2026-11-30', people), { text: '2026-11-30', input: 'USER_ENTERED' })
  assert.deepEqual(sheetTextOf(columns[3], 'u1', people), { text: 'Ana Reyes', input: 'RAW' })
  assert.deepEqual(sheetTextOf(columns[0], '=57', people), { text: '=57', input: 'RAW' })
  assert.deepEqual(sheetTextOf({ id: 'n', name: 'Qty', type: 'number' }, 3, people), {
    text: '3',
    input: 'USER_ENTERED',
  })
  assert.deepEqual(sheetTextOf({ id: 'b', name: 'Ok', type: 'checkbox' }, true, people, 'No'), {
    text: 'Yes',
    input: 'USER_ENTERED',
  })
  assert.deepEqual(sheetTextOf(columns[1], '', people), { text: '', input: 'RAW' })
})

test('cell writes find the row by name and order, and stop at a cell changed in the Sheet', () => {
  const grid = [
    ['Branch #', 'Status', 'Go-live', 'Owner'],
    ['57', 'Pending', '11/25/2026', ''],
    ['58', 'Ongoing', '', ''],
  ]
  const base = { grid, keyHeader: 'Branch #', headerMap, columns, people, overwrite: false }
  const ok = planCellWrites({
    ...base,
    sourceKey: '57',
    cells: { c_status: 'o_done', c_owner: 'u1' },
    baseline: { Status: 'Pending', Owner: '' },
  })
  assert.ok(!('error' in ok))
  if ('error' in ok) return
  assert.equal(ok.row, 2)
  assert.deepEqual(
    ok.writes.map(write => [write.header, write.text]),
    [
      ['Status', 'Done'],
      ['Owner', 'Ana Reyes'],
    ],
  )
  const clash = planCellWrites({
    ...base,
    sourceKey: '58',
    cells: { c_status: 'o_done' },
    baseline: { Status: 'Pending' },
  })
  if ('error' in clash) return assert.fail(clash.error)
  assert.deepEqual(clash.conflicts, [
    { columnId: 'c_status', name: 'Status', header: 'Status', sheet: 'Ongoing', mine: 'Done' },
  ])
  assert.equal(clash.writes.length, 0)
  const forced = planCellWrites({
    ...base,
    sourceKey: '58',
    cells: { c_status: 'o_done' },
    baseline: { Status: 'Pending' },
    overwrite: true,
  })
  if ('error' in forced) return assert.fail(forced.error)
  assert.equal(forced.writes.length, 1, 'keeping my edit overwrites the Sheet')
  assert.deepEqual(planCellWrites({ ...base, sourceKey: '99', cells: {}, baseline: {} }), { error: 'no_row' })
})

test('new rows are added with their task name; rows without one wait', () => {
  const grid = [
    ['Branch #', 'Status', 'Go-live'],
    ['57', 'Pending', ''],
  ]
  const plan = planAppend({
    grid,
    keyHeader: 'Branch #',
    headerMap,
    columns,
    people,
    rows: [
      { id: 'r1', cells: { c_key: '60', c_status: 'o_pending', c_live: '2026-12-01' } },
      { id: 'r2', cells: { c_status: 'o_done' } },
      { id: 'r3', cells: { c_key: '57' } },
    ],
  })
  assert.deepEqual(plan.skipped, ['r2'])
  assert.deepEqual(plan.appends[0].line, ['60', 'Pending', ''], 'dates are written afterwards so Google reads them')
  assert.deepEqual(plan.appends[0].typed, [{ column: 2, text: '2026-12-01' }])
  assert.equal(plan.appends[0].key, '60')
  assert.equal(plan.appends[1].key, '57\u001f2', 'a repeated name is the second row with that name')
})

// ---- End to end through the routes, with Google simulated ----

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
    skip = 0
    one = false
    returning = false
    head = false
    constructor(public table: string) {}
    select(_c = '*', o: { head?: boolean } = {}) {
      if (this.action !== 'read') this.returning = true
      this.head = Boolean(o.head)
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
    delete() {
      this.action = 'delete'
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
      this.skip = a
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
        for (const r of matched) Object.assign(r, structuredClone(this.values[0]))
        return { data: this.returning ? matched.map(r => structuredClone(r)) : null, error: null }
      }
      if (this.action === 'delete') {
        tables[this.table] = rows.filter(r => !matched.includes(r))
        return { data: matched, error: null }
      }
      const out = matched
        .map(r => structuredClone(r))
        .slice(this.skip, this.take === undefined ? undefined : this.skip + this.take)
      if (this.head) return { data: null, error: null, count: matched.length }
      return { data: this.one ? (out[0] ?? null) : out, error: null, count: matched.length }
    }
  }
  return { from: (t: string) => new Query(t), tables }
}

/** Express-shaped enough for the routes: records handlers and runs them for a request. */
function fakeApp() {
  const routes: { method: string; pattern: RegExp; keys: string[]; handlers: any[] }[] = []
  const add =
    (method: string) =>
    (path: string, ...handlers: any[]) => {
      const keys: string[] = []
      const pattern = new RegExp(
        `^${path.replace(/:(\w+)/g, (_, key) => {
          keys.push(key)
          return '([^/]+)'
        })}$`,
      )
      routes.push({ method, pattern, keys, handlers })
    }
  const app: any = {
    get: add('GET'),
    post: add('POST'),
    put: add('PUT'),
    patch: add('PATCH'),
    delete: add('DELETE'),
    use() {},
  }
  app.ask = async (method: string, path: string, body?: any, userId = 'u1') => {
    const route = routes.find(r => r.method === method && r.pattern.test(path))
    if (!route) throw new Error(`No route ${method} ${path}`)
    const match = route.pattern.exec(path)!
    const req: any = {
      method,
      body,
      query: {},
      headers: {},
      params: Object.fromEntries(route.keys.map((key, at) => [key, decodeURIComponent(match[at + 1])])),
      authUser: {
        id: userId,
        name: userId === 'u1' ? 'Ana Reyes' : 'Ben Cruz',
        role: 'Contributor',
        organizationId: TENANT,
        modules: ['trackers'],
        accountType: 'tenant',
      },
    }
    return new Promise<{ status: number; body: any }>(resolve => {
      let status = 200
      const res: any = {
        status(code: number) {
          status = code
          return res
        },
        json(payload: any) {
          resolve({ status, body: payload })
        },
        setHeader() {},
      }
      const run = (at: number) => route.handlers[at]?.(req, res, () => run(at + 1))
      run(0)
    })
  }
  return app
}

const TENANT = '11111111-1111-4111-8111-111111111111'
const TRACKER = '22222222-2222-4222-8222-222222222222'
const ROW_57 = '33333333-3333-4333-8333-333333333333'
const SHEET = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'
const WRITE = 'https://www.googleapis.com/auth/spreadsheets'
let sheet: string[][] = []
const calls: string[] = []
/** Google accounts that may only view the Sheet; Google refuses their writes. */
const viewOnly = new Set<string>()
/** The account each Sheets request was made with. */
const tokens: string[] = []
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input)
  if (!url.startsWith('https://sheets.googleapis.com/')) return realFetch(input, init)
  const token = String(init?.headers?.Authorization || '').replace('Bearer ', '')
  tokens.push(token)
  if (init?.method === 'POST' && viewOnly.has(token))
    return new Response(
      JSON.stringify({ error: { message: 'The caller does not have permission', status: 'PERMISSION_DENIED' } }),
      {
        status: 403,
        headers: { 'content-type': 'application/json' },
      },
    )
  const reply = (body: any) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  const cellAt = (range: string) => {
    const [, letters, digits] = /!([A-Z]+)(\d+)$/.exec(range)!
    return { column: letters.charCodeAt(0) - 65, row: Number(digits) - 1 }
  }
  if (url.includes(':append')) {
    const body = JSON.parse(init.body)
    calls.push(`append ${new URL(url).searchParams.get('valueInputOption')}`)
    const start = sheet.length + 1
    sheet.push(...body.values.map((line: string[]) => [...line]))
    return reply({ updates: { updatedRange: `'Branches'!A${start}:D${sheet.length}` } })
  }
  if (url.endsWith('/values:batchUpdate')) {
    const body = JSON.parse(init.body)
    calls.push(`write ${body.valueInputOption}`)
    const responses = body.data.map((entry: any) => {
      const { column, row } = cellAt(entry.range)
      while (sheet.length <= row) sheet.push([])
      // Google shows an entered ISO date in the cell's own date format.
      const text = /^\d{4}-\d{2}-\d{2}$/.test(entry.values[0][0])
        ? entry.values[0][0].replace(
            /^(\d{4})-(\d{2})-(\d{2})$/,
            (_: string, y: string, m: string, d: string) => `${+m}/${+d}/${y}`,
          )
        : entry.values[0][0]
      sheet[row][column] = text
      return { updatedData: { range: entry.range, values: [[text]] } }
    })
    return reply({ responses })
  }
  if (url.includes('/values/')) return reply({ values: sheet })
  if (url.includes('includeGridData')) return reply({ sheets: [{ data: [] }] })
  return reply({ properties: { title: 'Card Indo Remote' } })
}) as any

function setup(mode: 'one_way' | 'two_way', scope = WRITE, scopes: Record<string, string> = {}) {
  const db = memoryDb()
  const app = fakeApp()
  const pass = (_q: any, _s: any, n: any) => n()
  registerTrackerRoutes(app, {
    db,
    requireAuth: pass,
    requireTenant: pass,
    load: async () => ({ data: { accounts: [{ id: 'u1', name: 'Ana Reyes' }], items: [], clients: [], projects: [] } }),
    key: Buffer.alloc(32, 7),
    googleAccess: async (_tenant, userId) => ({
      token: `token-${userId}`,
      scope: scopes[userId] ?? scope,
      email: `${userId}@example.com`,
    }),
  })
  db.tables.tenant_trackers.push({
    tenant_id: TENANT,
    id: TRACKER,
    name: 'Rollout',
    columns,
    views: [],
    revision: 1,
    archived_at: null,
    created_by: 'u1',
  })
  db.tables.tenant_tracker_rows.push({
    tenant_id: TENANT,
    tracker_id: TRACKER,
    id: ROW_57,
    position: 1,
    data: { c_key: '57', c_status: 'o_pending', c_live: '2026-11-25' },
    secrets: {},
    task_id: '',
    version: 1,
    source_key: '57',
    source_values: { 'Branch #': '57', Status: 'Pending', 'Go-live': '11/25/2026', Owner: '' },
  })
  db.tables.tenant_tracker_sources.push({
    tenant_id: TENANT,
    tracker_id: TRACKER,
    spreadsheet_id: SHEET,
    tab: 'Branches',
    key_header: 'Branch #',
    header_map: headerMap,
    mode,
    connected_by: 'u1',
    connected_by_name: 'Ana Reyes',
  })
  const rowOf = (id: string) => db.tables.tenant_tracker_rows.find(row => row.id === id)!
  return { app, db, rowOf }
}
const fresh = () => {
  sheet = [
    ['Branch #', 'Status', 'Go-live', 'Owner'],
    ['57', 'Pending', '11/25/2026', ''],
  ]
  calls.length = 0
}

test('one-way: Sheet columns stay read-only for Sheet rows', async () => {
  fresh()
  const { app } = setup('one_way')
  const result = await app.ask('PATCH', `/api/trackers/${TRACKER}/rows/${ROW_57}`, {
    version: 1,
    cells: { c_status: 'o_done' },
  })
  assert.equal(result.status, 409)
  assert.match(result.body.error, /comes from the connected Google Sheet/)
  assert.equal(sheet[1][1], 'Pending')
})

test('two-way: an edit is written to its Sheet cell, then saved here with the new baseline', async () => {
  fresh()
  const { app, rowOf } = setup('two_way')
  const result = await app.ask('PATCH', `/api/trackers/${TRACKER}/rows/${ROW_57}`, {
    version: 1,
    cells: { c_status: 'o_done', c_live: '2026-11-30', c_owner: 'u1' },
  })
  assert.equal(result.status, 200, JSON.stringify(result.body))
  assert.deepEqual(sheet[1], ['57', 'Done', '11/30/2026', 'Ana Reyes'])
  assert.deepEqual(calls, ['write RAW', 'write USER_ENTERED'], 'labels as typed, dates read by Google')
  const row = rowOf(ROW_57)
  assert.equal(row.data.c_status, 'o_done')
  assert.equal(row.version, 2)
  assert.deepEqual(row.source_values, { 'Branch #': '57', Status: 'Done', 'Go-live': '11/30/2026', Owner: 'Ana Reyes' })
  // A tracker-only column never touches the Sheet.
  calls.length = 0
  const note = await app.ask('PATCH', `/api/trackers/${TRACKER}/rows/${ROW_57}`, {
    version: 2,
    cells: { c_notes: 'Hi' },
  })
  assert.equal(note.status, 200)
  assert.deepEqual(calls, [])
})

test('two-way: a cell changed in the Sheet since the last sync is a conflict until the person keeps their edit', async () => {
  fresh()
  sheet[1][1] = 'Ongoing'
  const { app, rowOf } = setup('two_way')
  const clash = await app.ask('PATCH', `/api/trackers/${TRACKER}/rows/${ROW_57}`, {
    version: 1,
    cells: { c_status: 'o_done' },
  })
  assert.equal(clash.status, 409)
  assert.deepEqual(
    clash.body.conflicts.map((c: any) => [c.name, c.sheet, c.mine]),
    [['Status', 'Ongoing', 'Done']],
  )
  assert.equal(sheet[1][1], 'Ongoing', 'nothing written')
  assert.equal(rowOf(ROW_57).data.c_status, 'o_pending', 'nothing saved')
  const kept = await app.ask('PATCH', `/api/trackers/${TRACKER}/rows/${ROW_57}`, {
    version: 1,
    cells: { c_status: 'o_done' },
    overwrite: true,
  })
  assert.equal(kept.status, 200, JSON.stringify(kept.body))
  assert.equal(sheet[1][1], 'Done')
})

test('two-way: without permission to edit Sheets nothing changes', async () => {
  fresh()
  const { app, rowOf } = setup('two_way', 'https://www.googleapis.com/auth/spreadsheets.readonly')
  const result = await app.ask('PATCH', `/api/trackers/${TRACKER}/rows/${ROW_57}`, {
    version: 1,
    cells: { c_status: 'o_done' },
  })
  assert.equal(result.status, 409)
  assert.equal(result.body.needsWrite, true)
  assert.equal(rowOf(ROW_57).data.c_status, 'o_pending')
  const mode = await app.ask('POST', `/api/trackers/${TRACKER}/source/mode`, { mode: 'two_way' })
  assert.equal(mode.status, 409, 'switching on needs edit permission too')
})

test('two-way: a new row goes to the Sheet once it has a task name', async () => {
  fresh()
  const { app, rowOf } = setup('two_way')
  const blank = await app.ask('POST', `/api/trackers/${TRACKER}/rows`, { rows: [{}] })
  assert.equal(blank.status, 201, JSON.stringify(blank.body))
  const id = blank.body.rows[0].id
  assert.equal(sheet.length, 2, 'no name yet: not in the Sheet')
  const named = await app.ask('PATCH', `/api/trackers/${TRACKER}/rows/${id}`, {
    version: 1,
    cells: { c_key: '60', c_live: '2026-12-01' },
  })
  assert.equal(named.status, 200, JSON.stringify(named.body))
  assert.deepEqual(sheet[2], ['60', '', '12/1/2026', ''])
  assert.equal(rowOf(id).source_key, '60')
  assert.equal(rowOf(id).source_values['Go-live'], '12/1/2026')
  assert.equal(named.body.row.sourceKey, '60')
  // Rows added with a name (an import or a paste) go straight in.
  const pasted = await app.ask('POST', `/api/trackers/${TRACKER}/rows`, {
    rows: [{ cells: { c_key: '61', c_status: 'o_pending' } }],
  })
  assert.equal(pasted.status, 201)
  assert.deepEqual(sheet[3], ['61', 'Pending', '', ''])
  assert.equal(pasted.body.rows[0].sourceKey, '61')
})

test('switching modes is recorded and needs edit permission only for two-way', async () => {
  fresh()
  const { app, db } = setup('one_way')
  const on = await app.ask('POST', `/api/trackers/${TRACKER}/source/mode`, { mode: 'two_way' })
  assert.equal(on.status, 200, JSON.stringify(on.body))
  assert.equal(on.body.source.mode, 'two_way')
  assert.equal(db.tables.tenant_tracker_sources[0].mode, 'two_way')
  const off = await app.ask('POST', `/api/trackers/${TRACKER}/source/mode`, { mode: 'one_way' })
  assert.equal(off.body.source.mode, 'one_way')
})

test('two-way writes as the person editing: Google sharing decides, not the connector', async () => {
  fresh()
  tokens.length = 0
  const READ = 'https://www.googleapis.com/auth/spreadsheets.readonly'
  // u1 connected the Sheet and may edit; u2 has only let the app read Sheets.
  const { app, rowOf } = setup('two_way', WRITE, { u2: READ })
  const refused = await app.ask(
    'PATCH',
    `/api/trackers/${TRACKER}/rows/${ROW_57}`,
    { version: 1, cells: { c_status: 'o_done' } },
    'u2',
  )
  assert.equal(refused.status, 409)
  assert.equal(refused.body.needsWrite, true)
  assert.match(refused.body.error, /Your Google account has not allowed this app to edit Google Sheets/)
  assert.equal(sheet[1][1], 'Pending', 'the connector’s access is not borrowed')
  // u3 let the app edit Sheets, but the Sheet is only shared with them as a viewer.
  const viewer = setup('two_way', WRITE)
  viewOnly.add('token-u3')
  const denied = await viewer.app.ask(
    'PATCH',
    `/api/trackers/${TRACKER}/rows/${ROW_57}`,
    { version: 1, cells: { c_status: 'o_done' } },
    'u3',
  )
  viewOnly.clear()
  assert.equal(denied.status, 403)
  assert.match(denied.body.error, /Your Google account \(u3@example.com\) can open this Sheet but not edit it/)
  assert.equal(viewer.rowOf(ROW_57).data.c_status, 'o_pending', 'nothing saved')
  // An editor's change goes through with their own account.
  tokens.length = 0
  const ok = await app.ask(
    'PATCH',
    `/api/trackers/${TRACKER}/rows/${ROW_57}`,
    { version: 1, cells: { c_status: 'o_done' } },
    'u1',
  )
  assert.equal(ok.status, 200)
  assert.ok(tokens.length > 0 && tokens.every(token => token === 'token-u1'))
  assert.equal(rowOf(ROW_57).data.c_status, 'o_done')
})

test('turning on two-way needs the switching person’s own permission to edit Sheets', async () => {
  fresh()
  const { app, db } = setup('one_way', WRITE, { u2: 'https://www.googleapis.com/auth/spreadsheets.readonly' })
  const refused = await app.ask('POST', `/api/trackers/${TRACKER}/source/mode`, { mode: 'two_way' }, 'u2')
  assert.equal(refused.status, 409)
  assert.equal(refused.body.needsWrite, true)
  assert.equal(db.tables.tenant_tracker_sources[0].mode, 'one_way')
  const on = await app.ask('POST', `/api/trackers/${TRACKER}/source/mode`, { mode: 'two_way' }, 'u1')
  assert.equal(on.status, 200)
  assert.equal(on.body.source.youCanWrite, true)
})
