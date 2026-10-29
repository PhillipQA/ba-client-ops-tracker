import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { registerTrackerRoutes } from '../server/trackers/trackers'

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
  if (url.includes(`/drive/v3/files/${EXCEL}`))
    return reply(200, {
      name: 'Branches.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
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
  if (url.includes('/values/Lists')) return reply(200, { values: [['Pending'], ['Ongoing'], ['Done'], ['On hold']] })
  if (url.includes('/values/')) return reply(200, { values: grid })
  if (url.includes(`/spreadsheets/${SHEET}?`))
    return reply(200, {
      properties: { title: 'Card Indo Remote' },
      sheets: [{ properties: { title: 'Branches', index: 0, gridProperties: { rowCount: 100, columnCount: 6 } } }],
    })
  return reply(404, { error: { message: 'not found' } })
}) as any

function harness(scopes: Record<string, string> = {}) {
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
    return {
      token: `token-${userId}`,
      scope:
        scopes[userId] ??
        'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/spreadsheets.readonly https://www.googleapis.com/auth/drive.metadata.readonly',
      email: `${userId}@example.com`,
    }
  }
  registerTrackerRoutes(app as any, {
    db,
    requireAuth: pass,
    requireTenant: pass,
    load: async () => ({ data: state }),
    key: Buffer.alloc(32, 7),
    googleAccess,
  })
  return { app, db }
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
    assert.equal(excel.status, 422)
    assert.equal(excel.body.notASheet, true)
    assert.match(excel.body.error, /Branches\.xlsx" is an Excel file .* Save as Google Sheets/)
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
