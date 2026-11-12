import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { readFileSync } from 'node:fs'
import { registerTrackerRoutes } from '../server/trackers/trackers'
import { TRACKER_TEMPLATES, templateRows } from '../src/features/trackers/trackerTemplates'

type Row = Record<string, any>
const KEYS: Record<string, string[]> = {
  tenant_trackers: ['tenant_id', 'id'],
  tenant_tracker_rows: ['tenant_id', 'tracker_id', 'id'],
  tenant_tracker_changes: ['id'],
  tenant_tracker_task_links: ['id'],
  tenant_tracker_sources: ['tenant_id', 'tracker_id'],
}
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
    sorts: [string, boolean][] = []
    take?: number
    skip = 0
    counted = false
    head = false
    one = false
    returning = false
    constructor(public table: string) {}
    select(_c = '*', o: { count?: string; head?: boolean } = {}) {
      if (this.action !== 'read') this.returning = true
      this.counted = o.count === 'exact'
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
    order(c: string, o: { ascending?: boolean } = {}) {
      this.sorts.push([c, o.ascending !== false])
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
      this.take = 1
      return this
    }
    then(resolve: any, reject: any) {
      return Promise.resolve(this.run()).then(resolve, reject)
    }
    run() {
      const rows = tables[this.table]
      if (this.action === 'insert') {
        for (const v of this.values)
          if (rows.some(r => KEYS[this.table].every(k => r[k] === v[k])))
            return { data: null, error: new Error('duplicate') }
        rows.push(...this.values.map(v => structuredClone(v)))
        return { data: this.returning ? this.values : null, error: null }
      }
      const matched = rows.filter(r => this.filters.every(f => f(r)))
      if (this.action === 'update') {
        matched.forEach(r => Object.assign(r, structuredClone(this.values[0])))
        return { data: this.returning ? matched.map(r => structuredClone(r)) : null, error: null }
      }
      if (this.action === 'delete') {
        tables[this.table] = rows.filter(r => !matched.includes(r))
        return { data: matched, error: null }
      }
      let out = matched.map(r => structuredClone(r))
      for (const [c, asc] of [...this.sorts].reverse())
        out.sort((a, b) => (a[c] < b[c] ? -1 : a[c] > b[c] ? 1 : 0) * (asc ? 1 : -1))
      const total = out.length
      out = out.slice(this.skip, this.take === undefined ? undefined : this.skip + this.take)
      if (this.head) return { data: null, error: null, count: total }
      return { data: this.one ? (out[0] ?? null) : out, error: null, count: this.counted ? total : null }
    }
  }
  return { from: (t: string) => new Query(t), tables }
}

// Google, simulated: one Sheet with a tab whose values the test changes between syncs.
const SHEET = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'
const EXCEL = '1l9l1Q5vTHvyElzeUsmyXcXFWbejlSqFG'
const PRIVATE_XLSX = '1PrivateExcelFileIdAbCdEfGhIjKlMn'
const API_OFF = '1ApiOffSheetIdAbCdEfGhIjKlMnOpQrStUvWxYz012'
let grid: string[][] = []
// The Sheet's data validation per requested column range, in request order (null: no dropdown there).
let dropdowns: (any | null)[] = []
const dropdownRanges: string[] = []
let canOpen = new Set(['u1', 'u2'])
/** An Excel workbook kept in Drive (tab "Sites & Go-live": Site, Go-live, Status…). */
const XLSX = readFileSync(new URL('./fixtures/sites.xlsx', import.meta.url))
const DRIVE_READ = 'https://www.googleapis.com/auth/drive.readonly'
/** The scopes each fake token was given, so the Drive download can check them. */
const tokenScopes = new Map<string, string>()
const scopeOf = (token: string) => tokenScopes.get(token) || ''
const NEW_SHEET = '1NewSheetMadeFromATracker0123456789abcdef'
const created: any[] = []
const formatted: any[] = []
let newSheetTabs: any[] = [{ properties: { sheetId: 7, title: 'Tracker', gridProperties: { rowCount: 1000 } } }]
// The made Sheet as stored (numbers, date serials) next to `grid` as shown; and what its Gantt tab shows.
let rawGrid: any[][] = []
let rawOwner: unknown = null
let ganttShown: any[][] = []
const writtenValues: any[] = []
const cellValueOf = (cell: any) => {
  const value = cell?.userEnteredValue || {}
  return value.numberValue ?? value.stringValue ?? value.boolValue ?? ''
}
const isoOfSerial = (serial: number) => new Date((serial - 25569) * 86_400_000).toISOString().slice(0, 10)
const shownOf = (value: any) =>
  typeof value === 'number' && value > 40000 && value < 60000
    ? isoOfSerial(value)
    : typeof value === 'boolean'
      ? value
        ? 'TRUE'
        : 'FALSE'
      : String(value ?? '')
const setRaw = (rows: any[][]) => {
  rawGrid = rows
  grid = rows.map(row => row.map(shownOf))
  rawOwner = grid
}
let lastToken = ''
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input)
  if (!url.startsWith('https://')) return realFetch(input, init)
  const token = String(init?.headers?.Authorization || '').replace('Bearer ', '')
  lastToken = token
  const reply = (status: number, body: any) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  if (!canOpen.has(token.replace('token-', '')))
    return reply(403, { error: { message: 'The caller does not have permission' } })
  // An Excel file kept in Drive: the Sheets API refuses it, Drive says what it is.
  if (url.includes(`/spreadsheets/${EXCEL}`))
    return reply(400, {
      error: { message: 'This operation is not supported for this document', status: 'FAILED_PRECONDITION' },
    })
  // Downloading it needs Drive read access.
  if (url.includes(`/drive/v3/files/${EXCEL}?alt=media`))
    return /drive\.readonly/.test(scopeOf(token))
      ? new Response(new Uint8Array(XLSX).buffer, { status: 200 })
      : reply(403, { error: { message: 'Request had insufficient authentication scopes.' } })
  if (url.includes(`/drive/v3/files/${EXCEL}`))
    return reply(200, {
      name: 'Branches.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      modifiedTime: '2026-11-12T00:00:00Z',
      size: String(XLSX.length),
    })
  if (url.includes(`/spreadsheets/${PRIVATE_XLSX}`))
    return reply(403, { error: { message: 'The caller does not have permission', status: 'PERMISSION_DENIED' } })
  if (url.includes(`/drive/v3/files/${PRIVATE_XLSX}`))
    return reply(200, { name: 'Rollout.xlsx', mimeType: 'application/vnd.ms-excel' })
  if (url.includes(`/spreadsheets/${API_OFF}`))
    return reply(403, {
      error: {
        message: 'Google Sheets API has not been used in project 123 before or it is disabled.',
        status: 'PERMISSION_DENIED',
        details: [{ reason: 'SERVICE_DISABLED' }],
      },
    })
  if (url.includes('/drive/v3/files'))
    return reply(200, {
      files: [
        {
          id: SHEET,
          name: 'Card Indo Remote',
          modifiedTime: '2026-10-24T00:00:00Z',
          owners: [{ displayName: 'Jay' }],
          shared: true,
        },
      ],
    })
  if (url.includes('includeGridData=true')) {
    const ranges = new URL(url).searchParams.getAll('ranges')
    dropdownRanges.push(...ranges)
    return reply(200, {
      sheets: [
        {
          data: ranges.map((_, at) => ({
            rowData: dropdowns[at] ? [{ values: [{ dataValidation: dropdowns[at] }] }, { values: [{}] }] : [],
          })),
        },
      ],
    })
  }
  if (url.includes('UNFORMATTED_VALUE'))
    return reply(200, {
      values: url.includes(encodeURIComponent("'Gantt chart'")) ? ganttShown : rawOwner === grid ? rawGrid : grid,
    })
  if (url.includes('/values:batchUpdate')) {
    const body = JSON.parse(String(init.body))
    writtenValues.push(body)
    const next = rawGrid.map(row => [...row])
    for (const entry of body.data) {
      const [, letter, row] = /!([A-Z]+)(\d+)$/.exec(entry.range) || []
      const column = letter.split('').reduce((n: number, ch: string) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1
      const text = String(entry.values[0][0])
      const date = /^\d{4}-\d{2}-\d{2}$/.test(text) ? Date.parse(`${text}T00:00:00Z`) / 86_400_000 + 25569 : null
      while (next.length < Number(row)) next.push([])
      next[Number(row) - 1][column] = date ?? (text !== '' && !Number.isNaN(Number(text)) ? Number(text) : text)
    }
    setRaw(next)
    return reply(200, {})
  }
  if (url.includes('/values/Lists')) return reply(200, { values: [['Pending'], ['Ongoing'], ['Done'], ['On hold']] })
  if (url.includes('/values/')) return reply(200, { values: grid })
  if (url.includes(`/spreadsheets/${SHEET}?`))
    return reply(200, {
      properties: { title: 'Card Indo Remote' },
      sheets: [{ properties: { title: 'Branches', index: 0, gridProperties: { rowCount: 100, columnCount: 6 } } }],
    })
  // Making a new Sheet: what was sent is kept, and the new Sheet's values are what a sync reads back.
  if (url === 'https://sheets.googleapis.com/v4/spreadsheets' && init?.method === 'POST') {
    const body = JSON.parse(String(init.body))
    created.push(body)
    const shown = (cell: any) => {
      const value = cell?.userEnteredValue || {}
      if ('boolValue' in value) return value.boolValue ? 'TRUE' : 'FALSE'
      if ('numberValue' in value) return String(value.numberValue)
      return String(value.stringValue ?? '')
    }
    grid = body.sheets[0].data[0].rowData.map((row: any) => row.values.map(shown))
    setRaw(body.sheets[0].data[0].rowData.map((row: any) => row.values.map(cellValueOf)))
    return reply(200, { spreadsheetId: NEW_SHEET, sheets: [{ properties: { sheetId: 7, title: 'Tracker' } }] })
  }
  if (url.includes(`/spreadsheets/${NEW_SHEET}?fields=`)) return reply(200, { sheets: newSheetTabs })
  if (url.includes(`/spreadsheets/${NEW_SHEET}:batchUpdate`)) {
    const body = JSON.parse(String(init.body))
    for (const request of body.requests || [])
      if (request.updateCells?.range.startRowIndex === 6)
        ganttShown = request.updateCells.rows.map((row: any) => (row.values || []).map(cellValueOf))
    formatted.push(JSON.parse(String(init.body)))
    return reply(200, {})
  }
  return reply(404, { error: { message: 'not found' } })
}) as any

function harness(
  scopes: Record<string, string> = {},
  extra: Partial<Parameters<typeof registerTrackerRoutes>[1]> = {},
) {
  const db = memoryDb()
  const state = {
    clients: [{ id: 'c1', name: 'Card Indogrosir' }],
    projects: [],
    items: [
      { id: 't1', title: 'Roll out' },
      { id: 's1', title: 'DRF', parentTaskId: 't1' },
    ],
    accounts: [{ id: 'u1', name: 'Ana Reyes' }],
  }
  const app = express()
  app.use(express.json({ limit: '10mb' }))
  app.use((req: any, _res, next) => {
    req.authUser = {
      id: String(req.headers['x-user'] || 'u1'),
      name: String(req.headers['x-user'] || 'u1') === 'u2' ? 'Ben Cruz' : 'Ana Reyes',
      role: String(req.headers['x-role'] || 'Contributor'),
      organizationId: '11111111-1111-4111-8111-111111111111',
      modules: ['trackers'],
      accountType: 'tenant',
    }
    next()
  })
  const pass = (_q: any, _s: any, n: any) => n()
  const googleAccess = async (_tenant: string, userId: string) => {
    if (userId === 'nobody') throw Object.assign(new Error('Connect your Google account again'), { status: 409 })
    const scope =
      scopes[userId] ??
      'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/spreadsheets.readonly https://www.googleapis.com/auth/drive.metadata.readonly'
    tokenScopes.set(`token-${userId}`, scope)
    return { token: `token-${userId}`, scope, email: `${userId}@example.com` }
  }
  const hooks = registerTrackerRoutes(app as any, {
    db,
    requireAuth: pass,
    requireTenant: pass,
    load: async () => ({ data: state }),
    key: Buffer.alloc(32, 7),
    googleAccess,
    ...extra,
  })
  return { app, db, hooks }
}
async function serve(
  h: ReturnType<typeof harness>,
  run: (
    ask: (m: string, p: string, b?: any, hd?: Record<string, string>) => Promise<{ status: number; body: any }>,
  ) => Promise<void>,
) {
  const server = h.app.listen(0)
  try {
    const port = (server.address() as any).port
    await run(async (m, p, b, hd = {}) => {
      const r = await realFetch(`http://127.0.0.1:${port}${p}`, {
        method: m,
        headers: { 'content-type': 'application/json', ...hd },
        body: b === undefined ? undefined : JSON.stringify(b),
      })
      return { status: r.status, body: await r.json() }
    })
  } finally {
    server.close()
  }
}
const columns = [
  { name: 'Branch #', type: 'text' },
  { name: 'Branch', type: 'text' },
  { name: 'Go-live', type: 'date' },
  { name: 'Our notes', type: 'longtext' },
]

test('a person lists, opens and connects a Sheet; the first sync brings every row in for review', async () => {
  grid = [
    ['Branch #', 'Branch', 'Go-live'],
    ['57', 'Batch 5', '11/25/2026'],
    ['58', 'Sta. Rosa', '12/01/2026'],
  ]
  const h = harness()
  await serve(h, async ask => {
    assert.deepEqual((await ask('GET', '/api/trackers/sheets/status')).body, {
      available: true,
      connected: true,
      canWrite: false,
      canReadExcel: false,
      email: 'u1@example.com',
    })
    const files = await ask('GET', '/api/trackers/sheets/files?q=card')
    assert.equal(files.body.files[0].name, 'Card Indo Remote')
    assert.equal(files.body.files[0].shared, true)
    const tabs = await ask(
      'GET',
      `/api/trackers/sheets/${encodeURIComponent(`https://docs.google.com/spreadsheets/d/${SHEET}/edit`)}/tabs`,
    )
    assert.equal(tabs.status, 200, JSON.stringify(tabs.body))
    assert.equal(tabs.body.tabs[0].title, 'Branches')
    const values = await ask('GET', `/api/trackers/sheets/${SHEET}/values?tab=Branches`)
    assert.deepEqual(values.body.grid[0], ['Branch #', 'Branch', 'Go-live'])
    const tracker = (await ask('POST', '/api/trackers', { name: 'Card Indo', columns })).body.tracker
    const [cKey, cName, cLive, cNotes] = tracker.columns.map((c: any) => c.id)
    assert.equal(
      (
        await ask('POST', `/api/trackers/${tracker.id}/source`, {
          spreadsheetId: SHEET,
          tab: 'Branches',
          keyHeader: 'Branch #',
          headerMap: { 'Branch #': cKey, Branch: cName, 'Go-live': cLive },
          mode: 'two_way',
        })
      ).status,
      403,
      'two-way needs permission to edit Sheets, which this account has not given',
    )
    const connected = await ask('POST', `/api/trackers/${tracker.id}/source`, {
      spreadsheetId: SHEET,
      tab: 'Branches',
      keyHeader: 'Branch #',
      headerMap: { 'Branch #': cKey, Branch: cName, 'Go-live': cLive },
    })
    assert.equal(connected.status, 200, JSON.stringify(connected.body))
    assert.equal(connected.body.report.added, 2)
    assert.equal(connected.body.tracker.source.spreadsheetName, 'Card Indo Remote')
    assert.equal(connected.body.tracker.source.mode, 'one_way')
    assert.deepEqual(
      connected.body.tracker.columns.filter((c: any) => c.synced).map((c: any) => c.name),
      ['Branch #', 'Branch', 'Go-live'],
    )
    const rows = (await ask('GET', `/api/trackers/${tracker.id}/rows?offset=0&limit=50`)).body.rows
    assert.equal(rows.length, 2)
    assert.ok(rows.every((r: any) => r.review && r.sourceKey))
    assert.equal(rows[0].cells[cLive], '2026-11-25')
    // Sheet columns are read-only for Sheet rows; tracker-only columns are not
    const sta = rows.find((r: any) => r.sourceKey === '58')
    assert.equal(
      (
        await ask('PATCH', `/api/trackers/${tracker.id}/rows/${sta.id}`, {
          version: sta.version,
          cells: { [cName]: 'Changed here' },
        })
      ).status,
      409,
    )
    const noted = await ask('PATCH', `/api/trackers/${tracker.id}/rows/${sta.id}`, {
      version: sta.version,
      cells: { [cNotes]: 'Our note' },
    })
    assert.equal(noted.status, 200, JSON.stringify(noted.body))
    // the next sync: one changed, one removed, one new; the note survives
    grid = [
      ['Branch', 'Branch #', 'Go-live'],
      ['Batch 5', '57', '11/30/2026'],
      ['Calamba', '60', ''],
    ]
    const quick = await ask('POST', `/api/trackers/${tracker.id}/source/sync`, {})
    assert.equal(quick.body.skipped, true, 'automatic syncs wait at least a minute')
    const synced = await ask('POST', `/api/trackers/${tracker.id}/source/sync`, { force: true })
    assert.deepEqual([synced.body.report.added, synced.body.report.updated, synced.body.report.missing], [1, 1, 1])
    const after = (await ask('GET', `/api/trackers/${tracker.id}/rows?offset=0&limit=50`)).body.rows
    assert.equal(after.find((r: any) => r.sourceKey === '57').cells[cLive], '2026-11-30')
    const gone = after.find((r: any) => r.sourceKey === '58')
    assert.equal(gone.sourceMissing, true, 'kept and flagged')
    assert.equal(gone.cells[cNotes], 'Our note')
    // review is cleared for rows that were dealt with
    assert.equal(
      (await ask('POST', `/api/trackers/${tracker.id}/rows/review`, { ids: after.map((r: any) => r.id) })).body
        .reviewed,
      3,
    )
    assert.ok(
      (await ask('GET', `/api/trackers/${tracker.id}/rows?offset=0&limit=50`)).body.rows.every((r: any) => !r.review),
    )
    const history = (await ask('GET', `/api/trackers/${tracker.id}/rows/${gone.id}/history`)).body.changes
    assert.ok(Array.isArray(history))
  })
})

test('when the connector loses access, sync says so and someone else can reconnect', async () => {
  grid = [
    ['Branch #', 'Branch'],
    ['1', 'A'],
  ]
  const h = harness()
  await serve(h, async ask => {
    const tracker = (
      await ask('POST', '/api/trackers', {
        name: 'T',
        columns: [
          { name: 'Branch #', type: 'text' },
          { name: 'Branch', type: 'text' },
        ],
      })
    ).body.tracker
    const [cKey, cName] = tracker.columns.map((c: any) => c.id)
    await ask('POST', `/api/trackers/${tracker.id}/source`, {
      spreadsheetId: SHEET,
      tab: 'Branches',
      keyHeader: 'Branch #',
      headerMap: { 'Branch #': cKey, Branch: cName },
    })
    canOpen = new Set(['u2'])
    const failed = await ask('POST', `/api/trackers/${tracker.id}/source/sync`, { force: true })
    assert.equal(failed.status, 403)
    assert.equal(failed.body.noAccess, true)
    const source = (await ask('GET', `/api/trackers/${tracker.id}`)).body.tracker.source
    assert.equal(source.lastStatus, 'error')
    assert.match(source.lastError, /cannot open/)
    const reconnected = await ask('POST', `/api/trackers/${tracker.id}/source/reconnect`, {}, { 'x-user': 'u2' })
    assert.equal(reconnected.status, 200, JSON.stringify(reconnected.body))
    assert.equal(reconnected.body.source.connectedByName, 'Ben Cruz')
    assert.equal(lastToken, 'token-u2', 'syncs now run as the person who reconnected')
    canOpen = new Set(['u1', 'u2'])
    const stopped = await ask('DELETE', `/api/trackers/${tracker.id}/source`)
    assert.equal(stopped.body.tracker.source, null)
    assert.ok(
      stopped.body.tracker.columns.every((c: any) => !c.synced),
      'columns become editable again',
    )
  })
})

test('without the Sheets permission, the tracker asks for it', async () => {
  const h = harness({ u1: 'https://www.googleapis.com/auth/gmail.readonly' })
  await serve(h, async ask => {
    assert.equal((await ask('GET', '/api/trackers/sheets/status')).body.connected, false)
    const tracker = (await ask('POST', '/api/trackers', { name: 'T', columns: [{ name: 'Branch #', type: 'text' }] }))
      .body.tracker
    const r = await ask('POST', `/api/trackers/${tracker.id}/source`, {
      spreadsheetId: SHEET,
      tab: 'Branches',
      keyHeader: 'Branch #',
      headerMap: { 'Branch #': tracker.columns[0].id },
    })
    assert.equal(r.status, 403)
    assert.equal(r.body.needsGoogle, true)
    assert.equal(
      (
        await ask('POST', `/api/trackers/${tracker.id}/source`, {
          spreadsheetId: 'not a link',
          tab: 'x',
          keyHeader: 'y',
          headerMap: {},
        })
      ).status,
      400,
    )
  })
})

test('subtasks made from a review are linked to their cells in one call', async () => {
  const h = harness()
  await serve(h, async ask => {
    const tracker = (
      await ask('POST', '/api/trackers', {
        name: 'T',
        columns: [
          { name: 'Branch', type: 'text' },
          { name: 'DRF', type: 'date' },
        ],
      })
    ).body.tracker
    const row = (await ask('POST', `/api/trackers/${tracker.id}/rows`, { rows: [{ cells: {} }] })).body.rows[0]
    const r = await ask('POST', `/api/trackers/${tracker.id}/links/bulk`, {
      links: [
        { rowId: row.id, columnId: tracker.columns[1].id, taskId: 's1' },
        { rowId: row.id, columnId: tracker.columns[1].id, taskId: 's1' },
      ],
    })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.links.length, 1, 'duplicates are skipped')
    assert.equal(
      (
        await ask('POST', `/api/trackers/${tracker.id}/links/bulk`, {
          links: [{ rowId: row.id, columnId: 'nope', taskId: 's1' }],
        })
      ).status,
      400,
    )
  })
})

test('Excel files and a switched-off Sheets API get their own messages', async () => {
  const h = harness()
  await serve(h, async ask => {
    const excel = await ask('GET', `/api/trackers/sheets/${EXCEL}/tabs`)
    assert.equal(excel.status, 403, 'an Excel file asks for permission to read Drive files first')
    assert.equal(excel.body.needsExcel, true)
    assert.match(excel.body.error, /Allow reading Excel files/)
    const privateExcel = await ask('GET', `/api/trackers/sheets/${PRIVATE_XLSX}/tabs`)
    assert.equal(privateExcel.status, 422, 'Drive still names the file when the Sheets API says no access')
    assert.match(privateExcel.body.error, /Rollout\.xlsx/)
    const off = await ask('GET', `/api/trackers/sheets/${API_OFF}/tabs`)
    assert.equal(off.status, 503)
    assert.equal(off.body.apiDisabled, true)
    assert.match(off.body.error, /Google Sheets API is turned off/)
    canOpen = new Set(['u2'])
    const shared = await ask('GET', `/api/trackers/sheets/${SHEET}/tabs`)
    assert.equal(shared.status, 403, 'a real Google Sheet that is not shared keeps the access message')
    assert.match(shared.body.error, /cannot open/)
    canOpen = new Set(['u1', 'u2'])
  })
})

test('an Excel file in Drive is followed one-way and read only, matching rows the tracker already has', async () => {
  const readExcel = `https://www.googleapis.com/auth/spreadsheets.readonly ${DRIVE_READ}`
  const h = harness({ u1: readExcel })
  await serve(h, async ask => {
    const files = await ask('GET', '/api/trackers/sheets/files?q=')
    assert.equal(files.status, 200)
    const tabs = await ask(
      'GET',
      `/api/trackers/sheets/${encodeURIComponent(`https://docs.google.com/spreadsheets/d/${EXCEL}/edit?rtpof=true`)}/tabs`,
    )
    assert.equal(tabs.status, 200, JSON.stringify(tabs.body))
    assert.equal(tabs.body.excel, true)
    assert.equal(tabs.body.name, 'Branches.xlsx')
    assert.deepEqual(
      tabs.body.tabs.map((tab: any) => tab.title),
      ['Sites & Go-live', 'Notes'],
    )
    const values = await ask('GET', `/api/trackers/sheets/${EXCEL}/values?tab=${encodeURIComponent('Sites & Go-live')}`)
    assert.deepEqual(values.body.grid[1], ['Makati branch', '2026-11-25', 'New', '25%', 'FALSE'])

    const tracker = (
      await ask('POST', '/api/trackers', {
        name: 'Sites',
        columns: [
          { name: 'Site', type: 'text' },
          { name: 'Go-live', type: 'date' },
          { name: 'Status', type: 'text' },
        ],
      })
    ).body.tracker
    const [cSite, cLive, cStatus] = tracker.columns.map((c: any) => c.id)
    const added = await ask('POST', `/api/trackers/${tracker.id}/rows`, {
      rows: [{ cells: { [cSite]: 'Cebu <IT>', [cStatus]: 'Ongoing' } }],
    })
    assert.equal(added.status, 201, JSON.stringify(added.body))
    const body = {
      spreadsheetId: EXCEL,
      tab: 'Sites & Go-live',
      keyHeader: 'Site',
      headerMap: { Site: cSite, 'Go-live': cLive, Status: cStatus },
    }
    const twoWay = await ask('POST', `/api/trackers/${tracker.id}/source`, { ...body, mode: 'two_way' })
    assert.equal(twoWay.status, 409, 'an Excel file is never written to')
    assert.equal(twoWay.body.excel, true)

    const connected = await ask('POST', `/api/trackers/${tracker.id}/source`, body)
    assert.equal(connected.status, 200, JSON.stringify(connected.body))
    assert.equal(connected.body.adopted, 1, 'the Cebu row the tracker had is matched, not added again')
    assert.equal(connected.body.report.added, 1)
    assert.equal(connected.body.tracker.source.excel, true)
    assert.equal(connected.body.tracker.source.spreadsheetName, 'Branches.xlsx')
    const rows = (await ask('GET', `/api/trackers/${tracker.id}/rows?offset=0&limit=50`)).body.rows
    assert.equal(rows.length, 2)
    const cebu = rows.find((row: any) => row.cells[cSite] === 'Cebu <IT>')
    assert.equal(cebu.cells[cStatus], 'Done', 'the Excel file wins on a synced column')
    assert.equal(cebu.cells[cLive], '2026-11-26')

    const mode = await ask('POST', `/api/trackers/${tracker.id}/source/mode`, { mode: 'two_way' })
    assert.equal(mode.status, 409)
    assert.match(mode.body.error, /Excel file/)
    const sync = await ask('POST', `/api/trackers/${tracker.id}/source/sync`, {})
    assert.ok([200, 429].includes(sync.status), JSON.stringify(sync.body))
  })
})

test('a sync brings in every choice of the Sheet’s dropdown, including ones no row uses yet', async () => {
  grid = [
    ['Branch #', 'Status', 'Phase'],
    ['57', 'Ongoing', 'Build'],
    ['58', 'Ongoing', ''],
  ]
  dropdownRanges.length = 0
  dropdowns = [
    null,
    {
      condition: {
        type: 'ONE_OF_LIST',
        values: [{ userEnteredValue: 'Pending' }, { userEnteredValue: 'Ongoing' }, { userEnteredValue: 'Done' }],
      },
    },
    { condition: { type: 'ONE_OF_RANGE', values: [{ userEnteredValue: '=Lists!$A$1:$A$4' }] } },
  ]
  const h = harness()
  await serve(h, async ask => {
    const tracker = (
      await ask('POST', '/api/trackers', {
        name: 'Statuses',
        columns: [
          { name: 'Branch #', type: 'text' },
          { name: 'Status', type: 'select', options: [{ label: 'Blocked' }] },
          { name: 'Phase', type: 'select' },
        ],
      })
    ).body.tracker
    const [cKey, cStatus, cPhase] = tracker.columns.map((c: any) => c.id)
    const connected = await ask('POST', `/api/trackers/${tracker.id}/source`, {
      spreadsheetId: SHEET,
      tab: 'Branches',
      keyHeader: 'Branch #',
      headerMap: { 'Branch #': cKey, Status: cStatus, Phase: cPhase },
    })
    assert.equal(connected.status, 200, JSON.stringify(connected.body))
    assert.deepEqual(dropdownRanges, ["'Branches'!A2:A50", "'Branches'!B2:B50", "'Branches'!C2:C50"])
    assert.equal(
      connected.body.tracker.columns.find((c: any) => c.id === cKey).type,
      'text',
      'a Text column whose Sheet column has no dropdown stays Text',
    )
    const columns = connected.body.tracker.columns
    const status = columns.find((c: any) => c.id === cStatus)
    assert.deepEqual(
      status.options.map((o: any) => o.label),
      ['Pending', 'Ongoing', 'Done', 'Blocked'],
      'the Sheet’s order first; an option only the tracker has stays',
    )
    const phase = columns.find((c: any) => c.id === cPhase)
    assert.deepEqual(
      phase.options.map((o: any) => o.label),
      ['Pending', 'Ongoing', 'Done', 'On hold', 'Build'],
      'a dropdown that reads its choices from a range',
    )
    const rows = (await ask('GET', `/api/trackers/${tracker.id}/rows?offset=0&limit=50`)).body.rows
    const ongoing = status.options.find((o: any) => o.label === 'Ongoing').id
    assert.ok(
      rows.every((r: any) => r.cells[cStatus] === ongoing),
      'rows use the same Ongoing option',
    )
  })
  dropdowns = []
})

test('a Text column that follows a Sheet dropdown becomes a Choice column with the same options', async () => {
  grid = [
    ['Branch #', 'Status'],
    ['57', 'Ongoing'],
    ['58', 'done'],
    ['59', ''],
  ]
  dropdownRanges.length = 0
  dropdowns = [
    null,
    {
      condition: {
        type: 'ONE_OF_LIST',
        values: [{ userEnteredValue: 'Pending' }, { userEnteredValue: 'Ongoing' }, { userEnteredValue: 'Done' }],
      },
    },
  ]
  const h = harness()
  await serve(h, async ask => {
    const tracker = (
      await ask('POST', '/api/trackers', {
        name: 'Text statuses',
        columns: [
          { name: 'Branch #', type: 'text' },
          { name: 'Status', type: 'text' },
        ],
      })
    ).body.tracker
    const [cKey, cStatus] = tracker.columns.map((c: any) => c.id)
    const connected = await ask('POST', `/api/trackers/${tracker.id}/source`, {
      spreadsheetId: SHEET,
      tab: 'Branches',
      keyHeader: 'Branch #',
      headerMap: { 'Branch #': cKey, Status: cStatus },
    })
    assert.equal(connected.status, 200, JSON.stringify(connected.body))
    const status = connected.body.tracker.columns.find((c: any) => c.id === cStatus)
    assert.equal(status.type, 'select', 'the tracker gets a dropdown too')
    assert.deepEqual(
      status.options.map((o: any) => o.label),
      ['Pending', 'Ongoing', 'Done'],
    )
    const rows = (await ask('GET', `/api/trackers/${tracker.id}/rows?offset=0&limit=50`)).body.rows
    const id = (label: string) => status.options.find((o: any) => o.label === label).id
    assert.deepEqual(
      rows.map((r: any) => r.cells[cStatus] || ''),
      [id('Ongoing'), id('Done'), ''],
      'values match the options by name, ignoring case',
    )
    const again = await ask('POST', `/api/trackers/${tracker.id}/source/sync`, { force: true })
    assert.equal(again.status, 200, JSON.stringify(again.body))
    assert.equal(again.body.report.updated, 0, 'a second sync changes nothing')
  })
  dropdowns = []
})

test('a box ticked or unticked in the Sheet completes or reopens the subtask in that cell', async () => {
  grid = [
    ['Site', 'Signed DRF', 'Notes'],
    ['Batch 5', 'FALSE', ''],
    ['Calamba', 'FALSE', ''],
  ]
  dropdowns = []
  const calls: { tenant: string; patches: any[]; actor: any; from: string }[] = []
  const h = harness(
    {},
    {
      updateTasks: async (tenant, patches, actor, from) => {
        calls.push({ tenant, patches, actor, from })
        return patches.length
      },
    },
  )
  await serve(h, async ask => {
    const tracker = (
      await ask('POST', '/api/trackers', {
        name: 'Rollout',
        columns: [
          { name: 'Site', type: 'text' },
          { name: 'Signed DRF', type: 'checkbox' },
          { name: 'Notes', type: 'text' },
        ],
      })
    ).body.tracker
    const [cSite, cSigned, cNotes] = tracker.columns.map((c: any) => c.id)
    const connected = await ask('POST', `/api/trackers/${tracker.id}/source`, {
      spreadsheetId: SHEET,
      tab: 'Branches',
      keyHeader: 'Site',
      headerMap: { Site: cSite, 'Signed DRF': cSigned, Notes: cNotes },
    })
    assert.equal(connected.status, 200, JSON.stringify(connected.body))
    const rows = (await ask('GET', `/api/trackers/${tracker.id}/rows?offset=0&limit=50`)).body.rows
    const batch = rows.find((r: any) => r.sourceKey === 'Batch 5')
    // Only Batch 5's box holds a subtask; Calamba's has none.
    const linked = await ask('POST', `/api/trackers/${tracker.id}/links`, {
      rowId: batch.id,
      columnId: cSigned,
      taskId: 's1',
    })
    assert.equal(linked.status, 201, JSON.stringify(linked.body))
    const sync = () => ask('POST', `/api/trackers/${tracker.id}/source/sync`, { force: true })

    grid = [
      ['Site', 'Signed DRF', 'Notes'],
      ['Batch 5', 'TRUE', ''],
      ['Calamba', 'TRUE', ''],
    ]
    const ticked = await sync()
    assert.equal(ticked.status, 200, JSON.stringify(ticked.body))
    assert.equal(ticked.body.tasks, 1, 'the browser is told to reload the workspace')
    assert.deepEqual(calls.length, 1)
    assert.deepEqual(calls[0].patches, [{ id: 's1', done: true }], 'only the box that holds a subtask counts')
    assert.equal(calls[0].from, 'the Google Sheet')
    assert.equal(calls[0].actor.id, 'u1', 'as the person who synced')

    // Nothing changed in the Sheet: nothing to follow.
    const again = await sync()
    assert.equal(again.body.tasks, undefined)
    assert.equal(calls.length, 1)

    // Other columns changing do not touch the subtask.
    grid = [
      ['Site', 'Signed DRF', 'Notes'],
      ['Batch 5', 'TRUE', 'Waiting on client'],
      ['Calamba', 'TRUE', ''],
    ]
    await sync()
    assert.equal(calls.length, 1)

    grid = [
      ['Site', 'Signed DRF', 'Notes'],
      ['Batch 5', 'FALSE', 'Waiting on client'],
      ['Calamba', 'TRUE', ''],
    ]
    const unticked = await sync()
    assert.equal(unticked.body.tasks, 1)
    assert.deepEqual(calls[1].patches, [{ id: 's1', done: false }], 'unticking reopens it')
    const after = (await ask('GET', `/api/trackers/${tracker.id}/rows?offset=0&limit=50`)).body.rows
    assert.notEqual(after.find((r: any) => r.id === batch.id).cells[cSigned], true, 'the box shows unticked')
  })
})

test('a sync still succeeds when completing the subtasks fails', async () => {
  grid = [
    ['Site', 'Signed DRF'],
    ['Batch 5', 'FALSE'],
  ]
  dropdowns = []
  const h = harness(
    {},
    {
      updateTasks: async () => {
        throw new Error('The workspace could not be saved.')
      },
    },
  )
  const quiet = console.error
  console.error = () => undefined
  try {
    await serve(h, async ask => {
      const tracker = (
        await ask('POST', '/api/trackers', {
          name: 'Rollout',
          columns: [
            { name: 'Site', type: 'text' },
            { name: 'Signed DRF', type: 'checkbox' },
          ],
        })
      ).body.tracker
      const [cSite, cSigned] = tracker.columns.map((c: any) => c.id)
      await ask('POST', `/api/trackers/${tracker.id}/source`, {
        spreadsheetId: SHEET,
        tab: 'Branches',
        keyHeader: 'Site',
        headerMap: { Site: cSite, 'Signed DRF': cSigned },
      })
      const row = (await ask('GET', `/api/trackers/${tracker.id}/rows?offset=0&limit=50`)).body.rows[0]
      await ask('POST', `/api/trackers/${tracker.id}/links`, { rowId: row.id, columnId: cSigned, taskId: 's1' })
      grid = [
        ['Site', 'Signed DRF'],
        ['Batch 5', 'TRUE'],
      ]
      const synced = await ask('POST', `/api/trackers/${tracker.id}/source/sync`, { force: true })
      assert.equal(synced.status, 200, JSON.stringify(synced.body))
      assert.equal(synced.body.report.updated, 1)
      assert.equal(synced.body.tasks, undefined)
    })
  } finally {
    console.error = quiet
  }
})

test('a Checkbox column that follows a Sheet dropdown becomes a Choice column showing the Sheet’s value', async () => {
  grid = [
    ['Branch #', 'COR'],
    ['57', 'Done'],
    ['58', 'Pending'],
  ]
  dropdownRanges.length = 0
  dropdowns = [
    null,
    {
      condition: {
        type: 'ONE_OF_LIST',
        values: [{ userEnteredValue: 'Pending' }, { userEnteredValue: 'Ongoing' }, { userEnteredValue: 'Done' }],
      },
    },
  ]
  const h = harness()
  await serve(h, async ask => {
    const tracker = (
      await ask('POST', '/api/trackers', {
        name: 'Checkbox statuses',
        columns: [
          { name: 'Branch #', type: 'text' },
          { name: 'COR', type: 'checkbox' },
        ],
      })
    ).body.tracker
    const [cKey, cCor] = tracker.columns.map((c: any) => c.id)
    const connected = await ask('POST', `/api/trackers/${tracker.id}/source`, {
      spreadsheetId: SHEET,
      tab: 'Branches',
      keyHeader: 'Branch #',
      headerMap: { 'Branch #': cKey, COR: cCor },
    })
    assert.equal(connected.status, 200, JSON.stringify(connected.body))
    const cor = connected.body.tracker.columns.find((c: any) => c.id === cCor)
    assert.equal(cor.type, 'select', 'the tracker shows a dropdown, not a checkbox')
    assert.deepEqual(
      cor.options.map((o: any) => o.label),
      ['Pending', 'Ongoing', 'Done'],
    )
    const rows = (await ask('GET', `/api/trackers/${tracker.id}/rows?offset=0&limit=50`)).body.rows
    const id = (label: string) => cor.options.find((o: any) => o.label === label).id
    assert.deepEqual(
      rows.map((r: any) => r.cells[cCor]),
      [id('Done'), id('Pending')],
    )
  })
  dropdowns = []
})

test('a tracker makes its own Google Sheet, connected two-way, without adding its rows twice', async () => {
  const WRITE = 'https://www.googleapis.com/auth/spreadsheets'
  created.length = 0
  formatted.length = 0
  dropdowns = []
  const h = harness({ u1: WRITE })
  await serve(h, async ask => {
    const tracker = (
      await ask('POST', '/api/trackers', {
        name: 'HeroHub schedule',
        columns: [
          { name: 'Task', type: 'text' },
          { name: 'Status', type: 'select', options: [{ label: 'Pending' }, { label: 'Done' }] },
          { name: 'Signed', type: 'checkbox' },
          { name: 'Hours', type: 'number' },
        ],
      })
    ).body.tracker
    const [cTask, cStatus, cSigned, cHours] = tracker.columns.map((c: any) => c.id)
    const done = tracker.columns[1].options.find((o: any) => o.label === 'Done').id
    const added = await ask('POST', `/api/trackers/${tracker.id}/rows`, {
      rows: [
        { cells: { [cTask]: 'Kickoff', [cStatus]: done, [cSigned]: true, [cHours]: 8 } },
        { cells: { [cTask]: 'BPM', [cHours]: 4 } },
        { cells: { [cTask]: 'Kickoff' } },
        { cells: {} },
      ],
    })
    assert.equal(added.status, 201, JSON.stringify(added.body))

    const viewer = await ask('POST', `/api/trackers/${tracker.id}/source/create`, {}, { 'x-role': 'Viewer' })
    assert.equal(viewer.status, 403)
    const noWrite = await ask('POST', `/api/trackers/${tracker.id}/source/create`, {}, { 'x-user': 'u2' })
    assert.equal(noWrite.status, 403)
    assert.equal(noWrite.body.needsWrite, true, 'the person is asked to allow editing Sheets first')

    const made = await ask('POST', `/api/trackers/${tracker.id}/source/create`, { title: 'HeroHub schedule' })
    assert.equal(made.status, 200, JSON.stringify(made.body))
    assert.equal(made.body.url, `https://docs.google.com/spreadsheets/d/${NEW_SHEET}/edit`)
    assert.equal(made.body.rows, 3)
    assert.equal(made.body.emptyRows, 1, 'the empty row is left out')
    assert.equal(created[0].properties.title, 'HeroHub schedule')
    assert.deepEqual(grid[0], ['Task', 'Status', 'Signed', 'Hours'])
    assert.deepEqual(grid[1], ['Kickoff', 'Done', 'TRUE', '8'])
    assert.deepEqual(grid[2], ['BPM', '', 'FALSE', '4'])
    const requests = formatted[0].requests
    assert.ok(
      requests.some(
        (r: any) =>
          r.setDataValidation?.rule.condition.type === 'ONE_OF_LIST' &&
          r.setDataValidation.rule.condition.values.map((v: any) => v.userEnteredValue).join() === 'Pending,Done',
      ),
      'Status gets the same dropdown in the Sheet',
    )
    assert.ok(requests.some((r: any) => r.setDataValidation?.rule.condition.type === 'BOOLEAN'))

    const source = made.body.tracker.source
    assert.equal(source.mode, 'two_way')
    assert.equal(source.keyHeader, 'Task')
    assert.equal(made.body.report.added, 0, 'the first sync finds every row instead of adding it again')
    const rows = (await ask('GET', `/api/trackers/${tracker.id}/rows?offset=0&limit=50`)).body.rows
    assert.equal(rows.length, 4)
    assert.deepEqual(
      rows.map((r: any) => r.sourceKey || ''),
      ['Kickoff', 'BPM', 'Kickoff\u001f2', ''],
    )
    assert.ok(
      made.body.tracker.columns.every((c: any) => c.synced),
      'every column follows the Sheet',
    )

    const again = await ask('POST', `/api/trackers/${tracker.id}/source/create`, {})
    assert.equal(again.status, 409, 'a tracker follows one Sheet at a time')
  })
})

test('timeline settings are shared on the tracker; viewers cannot change them for everyone', async () => {
  const h = harness()
  await serve(h, async ask => {
    const tracker = (
      await ask('POST', '/api/trackers', {
        name: 'Timeline',
        columns: [
          { name: 'Task', type: 'text' },
          { name: 'Start', type: 'date' },
          { name: 'Finish', type: 'date' },
        ],
      })
    ).body.tracker
    const [, cStart, cFinish] = tracker.columns.map((c: any) => c.id)
    const saved = await ask('PUT', `/api/trackers/${tracker.id}/timeline`, {
      timeline: { zoom: 'day', fields: { startId: cFinish, endId: '', progressId: 'c_gone', leadId: cStart } },
    })
    assert.equal(saved.status, 200, JSON.stringify(saved.body))
    assert.deepEqual(saved.body.timeline, { zoom: 'day', fields: { startId: cFinish, endId: '' } })
    const opened = (await ask('GET', `/api/trackers/${tracker.id}`)).body.tracker
    assert.deepEqual(opened.timeline, { zoom: 'day', fields: { startId: cFinish, endId: '' } })
    assert.equal(opened.revision, tracker.revision, 'view settings do not count as a change to the tracker')
    const viewer = await ask('PUT', `/api/trackers/${tracker.id}/timeline`, { timeline: {} }, { 'x-role': 'Viewer' })
    assert.equal(viewer.status, 403)
  })
})

test('a tracker made from the Project timeline template takes its starter rows as they are', async () => {
  const template = TRACKER_TEMPLATES.find(item => item.id === 'project-timeline')!
  const h = harness()
  await serve(h, async ask => {
    const made = await ask('POST', '/api/trackers', {
      name: 'Barter XI - Implementation',
      template: template.id,
      columns: template.columns,
    })
    assert.equal(made.status, 201, JSON.stringify(made.body))
    const tracker = made.body.tracker
    const added = await ask('POST', `/api/trackers/${tracker.id}/rows`, {
      rows: templateRows(template, tracker.columns, '2026-11-02'),
    })
    assert.equal(added.status, 201, JSON.stringify(added.body))
    assert.equal(added.body.rows.length, 22)
  })
})

test('a Sheet made from a Project timeline tracker gets a Gantt chart tab, and a connected Sheet can have it drawn again', async () => {
  const WRITE = 'https://www.googleapis.com/auth/spreadsheets'
  created.length = 0
  formatted.length = 0
  dropdowns = []
  const h = harness({ u1: WRITE })
  await serve(h, async ask => {
    const tracker = (
      await ask('POST', '/api/trackers', {
        name: 'Barter XI',
        template: 'project-timeline',
        columns: [
          { name: 'Task', type: 'text' },
          { name: 'Start', type: 'date' },
          { name: 'End', type: 'date' },
          { name: '% Done', type: 'number' },
          { name: 'Status', type: 'select', options: [{ label: 'Pending' }, { label: 'Done' }] },
        ],
      })
    ).body.tracker
    const [cTask, cStart, cEnd, cPct] = tracker.columns.map((c: any) => c.id)
    await ask('POST', `/api/trackers/${tracker.id}/rows`, {
      rows: [{ cells: { [cTask]: 'Kickoff', [cStart]: '2026-11-02', [cEnd]: '2026-11-03', [cPct]: 50 } }],
    })
    const made = await ask('POST', `/api/trackers/${tracker.id}/source/create`, {})
    assert.equal(made.status, 200, JSON.stringify(made.body))
    assert.equal(made.body.gantt, true)
    assert.equal(formatted.length, 2, 'formatting, then the chart')
    const chart = formatted[1].requests
    assert.equal(chart[0].addSheet.properties.title, 'Gantt chart')
    assert.equal(chart[1].updateCells.rows[5].values[0].userEnteredValue.stringValue, 'TASK')
    assert.equal(ganttShown[0][0], 'Kickoff', 'the tab holds the task as a value')

    const viewer = await ask('POST', `/api/trackers/${tracker.id}/source/gantt`, {}, { 'x-role': 'Viewer' })
    assert.equal(viewer.status, 403)
    const noWrite = await ask('POST', `/api/trackers/${tracker.id}/source/gantt`, {}, { 'x-user': 'u2' })
    assert.equal(noWrite.body.needsWrite, true)

    formatted.length = 0
    const added = await ask('POST', `/api/trackers/${tracker.id}/source/gantt`, {})
    assert.equal(added.status, 201, JSON.stringify(added.body))
    assert.equal(added.body.replaced, false)
    assert.match(added.body.url, /#gid=\d+$/)
    assert.equal(formatted[0].requests[0].addSheet.properties.title, 'Gantt chart')

    newSheetTabs = [...newSheetTabs, { properties: { sheetId: 42, title: 'Gantt chart' } }]
    formatted.length = 0
    const again = await ask('POST', `/api/trackers/${tracker.id}/source/gantt`, {})
    assert.equal(again.body.replaced, true)
    assert.deepEqual(formatted[0].requests[0], { deleteSheet: { sheetId: 42 } }, 'the old chart is replaced')
    newSheetTabs = newSheetTabs.slice(0, 1)
  })
})

test('a row that mirrors its task takes the task’s new title, dates and completion after a save', async () => {
  const h = harness()
  await serve(h, async ask => {
    const tracker = (
      await ask('POST', '/api/trackers', {
        name: 'Barter XI',
        template: 'project-timeline',
        columns: [
          { name: 'Task', type: 'text', taskField: 'title' },
          { name: 'Start', type: 'date', taskField: 'start' },
          { name: 'End', type: 'date', taskField: 'due' },
          { name: '% Done', type: 'number', taskField: 'progress' },
          { name: 'Status', type: 'select', options: [{ label: 'Pending' }, { label: 'Done' }] },
        ],
      })
    ).body.tracker
    assert.deepEqual(
      tracker.columns.map((c: any) => c.taskField || ''),
      ['title', 'start', 'due', 'progress', ''],
    )
    const status = tracker.columns[4]
    const [pending, done] = status.options.map((o: any) => o.id)
    const withDone = await ask('PUT', `/api/trackers/${tracker.id}/columns`, {
      revision: tracker.revision,
      columns: tracker.columns.map((c: any) =>
        c.id === status.id ? { ...c, autoDone: { done, undone: pending } } : c,
      ),
    })
    assert.equal(withDone.status, 200, JSON.stringify(withDone.body))
    const [cTask, cStart, cEnd, cPct] = tracker.columns.map((c: any) => c.id)
    const row = (
      await ask('POST', `/api/trackers/${tracker.id}/rows`, {
        rows: [{ cells: { [cTask]: 'DRF', [cStart]: '2026-11-02', [cPct]: 40, [status.id]: pending } }],
      })
    ).body.rows[0]
    const linked = await ask('POST', `/api/trackers/${tracker.id}/rows/tasks`, {
      links: [{ rowId: row.id, taskId: 's1' }],
    })
    assert.equal(linked.status, 200, JSON.stringify(linked.body))

    const tenant = '11111111-1111-4111-8111-111111111111'
    const before = { items: [{ id: 's1', title: 'DRF', parentTaskId: 't1', status: 'Open' }] }
    const after = {
      items: [
        {
          id: 's1',
          title: 'Submission of DRF',
          parentTaskId: 't1',
          status: 'Resolved',
          startDate: '2026-11-05',
          dueDate: '2026-11-09',
        },
      ],
    }
    await h.hooks.onWorkspaceSaved(tenant, before, after, { id: 'u1', name: 'Ana Reyes' } as any)
    const rows = (await ask('GET', `/api/trackers/${tracker.id}/rows?offset=0&limit=50`)).body.rows
    assert.deepEqual(rows[0].cells, {
      [cTask]: 'Submission of DRF',
      [cStart]: '2026-11-05',
      [cEnd]: '2026-11-09',
      [cPct]: 100,
      [status.id]: done,
    })

    // Reopened: back to Pending, and 100% back to 0.
    await h.hooks.onWorkspaceSaved(tenant, after, { items: [{ ...after.items[0], status: 'Open' }] }, null)
    const reopened = (await ask('GET', `/api/trackers/${tracker.id}/rows?offset=0&limit=50`)).body.rows[0]
    assert.equal(reopened.cells[status.id], pending)
    assert.equal(reopened.cells[cPct], 0)
  })
})

test('rows can be highlighted with a colour everyone sees', async () => {
  const h = harness()
  await serve(h, async ask => {
    const tracker = (await ask('POST', '/api/trackers', { name: 'Colours', columns: [{ name: 'Task', type: 'text' }] }))
      .body.tracker
    const rows = (
      await ask('POST', `/api/trackers/${tracker.id}/rows`, {
        rows: [{ cells: { [tracker.columns[0].id]: 'A' } }, { cells: { [tracker.columns[0].id]: 'B' } }],
      })
    ).body.rows
    const painted = await ask('PUT', `/api/trackers/${tracker.id}/rows/highlight`, {
      ids: [rows[0].id],
      color: 'amber',
    })
    assert.equal(painted.status, 200, JSON.stringify(painted.body))
    const read = (await ask('GET', `/api/trackers/${tracker.id}/rows?offset=0&limit=50`)).body.rows
    assert.equal(read[0].highlight, 'amber')
    assert.equal(read[1].highlight, undefined)
    assert.equal(read[0].version, rows[0].version, 'a highlight is not an edit to the row')
    const bad = await ask('PUT', `/api/trackers/${tracker.id}/rows/highlight`, { ids: [rows[0].id], color: 'neon' })
    assert.equal(bad.status, 400)
    const viewer = await ask(
      'PUT',
      `/api/trackers/${tracker.id}/rows/highlight`,
      { ids: [rows[0].id], color: '' },
      { 'x-role': 'Viewer' },
    )
    assert.equal(viewer.status, 403)
    await ask('PUT', `/api/trackers/${tracker.id}/rows/highlight`, { ids: [rows[0].id], color: '' })
    assert.equal(
      (await ask('GET', `/api/trackers/${tracker.id}/rows?offset=0&limit=50`)).body.rows[0].highlight,
      undefined,
    )
  })
})

test('a sync brings in a column added to the Sheet, with its values, on any tracker', async () => {
  dropdowns = []
  grid = [
    ['Branch #', 'Branch', 'Go-live', 'Skipped'],
    ['57', 'Batch 5', '11/25/2026', 'a'],
    ['58', 'Sta. Rosa', '12/01/2026', 'b'],
  ]
  const h = harness()
  await serve(h, async ask => {
    const tracker = (await ask('POST', '/api/trackers', { name: 'Rollout', columns })).body.tracker
    const [cKey, cName, cLive] = tracker.columns.map((c: any) => c.id)
    const connected = await ask('POST', `/api/trackers/${tracker.id}/source`, {
      spreadsheetId: SHEET,
      tab: 'Branches',
      keyHeader: 'Branch #',
      headerMap: { 'Branch #': cKey, Branch: cName, 'Go-live': cLive },
    })
    assert.equal(connected.status, 200, JSON.stringify(connected.body))
    assert.equal(connected.body.tracker.columns.length, 4, 'the column not chosen when connecting stays out')

    grid = [
      ['Branch #', 'Branch', 'Go-live', 'Skipped', 'BIR permit'],
      ['57', 'Batch 5', '11/25/2026', 'a', 'Approved'],
      ['58', 'Sta. Rosa', '12/01/2026', 'b', 'Filed'],
      ['59', 'Calamba', '12/02/2026', 'c', 'Filed'],
      ['60', 'Lipa', '12/03/2026', 'd', 'Approved'],
    ]
    const synced = await ask('POST', `/api/trackers/${tracker.id}/source/sync`, { force: true })
    assert.equal(synced.status, 200, JSON.stringify(synced.body))
    assert.deepEqual(synced.body.report.addedColumns, ['BIR permit'])
    const opened = (await ask('GET', `/api/trackers/${tracker.id}`)).body.tracker
    const permit = opened.columns.find((c: any) => c.name === 'BIR permit')
    assert.equal(permit.type, 'select')
    assert.equal(permit.synced, true)
    assert.equal(
      opened.columns.some((c: any) => c.name === 'Skipped'),
      false,
    )
    const rows = (await ask('GET', `/api/trackers/${tracker.id}/rows?offset=0&limit=50`)).body.rows
    const label = (id: string) => permit.options.find((o: any) => o.id === id)?.label
    assert.deepEqual(
      rows.map((r: any) => label(r.cells[permit.id])),
      ['Approved', 'Filed', 'Filed', 'Approved'],
      'existing rows get the new column’s values, and new rows come in with them',
    )
    const quiet = await ask('POST', `/api/trackers/${tracker.id}/source/sync`, { force: true })
    assert.equal(quiet.body.report.addedColumns, undefined)
  })
})

test('a client edits the Sheet’s Gantt chart tab and the tracker follows', async () => {
  const WRITE = 'https://www.googleapis.com/auth/spreadsheets'
  created.length = 0
  formatted.length = 0
  writtenValues.length = 0
  dropdowns = []
  newSheetTabs = [
    { properties: { sheetId: 7, title: 'Tracker', gridProperties: { rowCount: 1000 } } },
    { properties: { sheetId: 77, title: 'Gantt chart', gridProperties: { rowCount: 300 } } },
  ]
  const h = harness({ u1: WRITE })
  await serve(h, async ask => {
    const tracker = (
      await ask('POST', '/api/trackers', {
        name: 'Barter XI',
        template: 'project-timeline',
        columns: [
          { name: 'Task', type: 'text' },
          { name: 'Phase', type: 'select', options: [{ label: 'Planning' }, { label: 'Build' }] },
          { name: 'Start', type: 'date' },
          { name: 'End', type: 'date' },
          { name: '% Done', type: 'number' },
          { name: 'Status', type: 'select', options: [{ label: 'Pending' }, { label: 'Ongoing' }, { label: 'Done' }] },
        ],
      })
    ).body.tracker
    const [cTask, cPhase, cStart, cEnd, cPct, cStatus] = tracker.columns.map((c: any) => c.id)
    const [planning, build] = tracker.columns[1].options.map((o: any) => o.id)
    const [pending, ongoing] = tracker.columns[5].options.map((o: any) => o.id)
    await ask('POST', `/api/trackers/${tracker.id}/rows`, {
      rows: [
        {
          cells: {
            [cTask]: 'Kickoff',
            [cPhase]: planning,
            [cStart]: '2026-11-02',
            [cEnd]: '2026-11-02',
            [cPct]: 0,
            [cStatus]: pending,
          },
        },
        {
          cells: {
            [cTask]: 'Products',
            [cPhase]: build,
            [cStart]: '2026-11-04',
            [cEnd]: '2026-11-06',
            [cPct]: 0,
            [cStatus]: pending,
          },
        },
      ],
    })
    const made = await ask('POST', `/api/trackers/${tracker.id}/source/create`, {})
    assert.equal(made.status, 200, JSON.stringify(made.body))
    assert.equal(made.body.gantt, true)
    assert.deepEqual(
      ganttShown.map(row => row[0]),
      ['Planning', 'Kickoff', 'Build', 'Products'],
      'phase headings with their tasks',
    )

    // The client moves Products' End to 13 Nov, sets it Ongoing at 50%, in the Gantt tab.
    const products = ganttShown.findIndex(row => row[0] === 'Products')
    ganttShown[products][2] = Date.parse('2026-11-13T00:00:00Z') / 86_400_000 + 25569
    ganttShown[products][3] = 0.5
    ganttShown[products][4] = 'Ongoing'
    const synced = await ask('POST', `/api/trackers/${tracker.id}/source/sync`, { force: true })
    assert.equal(synced.status, 200, JSON.stringify(synced.body))
    assert.equal(writtenValues.length, 1, 'the edits went to the Tracker tab')
    const rows = (await ask('GET', `/api/trackers/${tracker.id}/rows?offset=0&limit=50`)).body.rows
    const row = rows.find((r: any) => r.cells[cTask] === 'Products')
    assert.equal(row.cells[cEnd], '2026-11-13')
    assert.equal(row.cells[cPct], 50)
    assert.equal(row.cells[cStatus], ongoing)
    const after = ganttShown.find(r => r[0] === 'Products')
    assert.equal(JSON.parse(after[5]).v.progress, 0.5, 'the tab was written again with fresh snapshots')

    // Nothing changed since: the next sync writes nothing.
    writtenValues.length = 0
    formatted.length = 0
    await ask('POST', `/api/trackers/${tracker.id}/source/sync`, { force: true })
    assert.equal(writtenValues.length, 0)
    assert.equal(formatted.length, 0, 'the tab is not rewritten when it already shows the data')
  })
  newSheetTabs = newSheetTabs.slice(0, 1)
})

test('only a Project timeline tracker has a Gantt chart in its Sheet: any other tracker gets just its columns and rows', async () => {
  const WRITE = 'https://www.googleapis.com/auth/spreadsheets'
  created.length = 0
  formatted.length = 0
  dropdowns = []
  const h = harness({ u1: WRITE })
  await serve(h, async ask => {
    for (const template of ['site-rollout', 'pos-bir', 'defects', 'client-tickets', 'saved', '']) {
      formatted.length = 0
      const tracker = (
        await ask('POST', '/api/trackers', {
          name: `Rollout ${template || 'plain'}`,
          template,
          columns: [
            { name: 'Terminal/Site', type: 'text' },
            { name: 'Go Live Date', type: 'date' },
            { name: 'BIR Date of Approval', type: 'date' },
            { name: 'Hardware', type: 'checkbox' },
            { name: 'Status', type: 'select', options: [{ label: 'Live' }, { label: 'Pre Live' }] },
          ],
        })
      ).body.tracker
      const [cSite, cGo, cBir, cHw] = tracker.columns.map((c: any) => c.id)
      await ask('POST', `/api/trackers/${tracker.id}/rows`, {
        rows: [{ cells: { [cSite]: 'Robinsons Naga', [cGo]: '2026-11-02', [cBir]: '2026-10-01', [cHw]: true } }],
      })
      const made = await ask('POST', `/api/trackers/${tracker.id}/source/create`, {})
      assert.equal(made.status, 200, JSON.stringify(made.body))
      assert.equal(made.body.gantt, false, `${template || 'plain'}: no Gantt tab`)
      assert.equal(formatted.length, 1, 'formatting only, no chart')
      assert.equal(
        formatted[0].requests.some((request: any) => request.addSheet),
        false,
      )
      // The Sheet follows the tracker: its columns, with a dropdown, a checkbox and dates where the tracker has them.
      assert.deepEqual(
        created[created.length - 1].sheets[0].data[0].rowData[0].values.map(
          (cell: any) => cell.userEnteredValue.stringValue,
        ),
        ['Terminal/Site', 'Go Live Date', 'BIR Date of Approval', 'Hardware', 'Status'],
      )
      assert.equal(formatted[0].requests.filter((request: any) => request.setDataValidation).length, 2)
      assert.equal(
        formatted[0].requests.filter((request: any) => request.repeatCell?.cell?.userEnteredFormat?.numberFormat)
          .length,
        2,
      )
      // And nothing can add one by hand.
      const added = await ask('POST', `/api/trackers/${tracker.id}/source/gantt`, {})
      assert.equal(added.status, 409)
      assert.match(added.body.error, /Project timeline/)
    }
  })
})
