import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { registerTrackerRoutes } from '../server/trackers/trackers'

type Row = Record<string, any>
const KEYS: Record<string, string[]> = { tenant_trackers: ['tenant_id', 'id'], tenant_tracker_rows: ['tenant_id', 'tracker_id', 'id'], tenant_tracker_changes: ['id'], tenant_tracker_task_links: ['id'], tenant_tracker_sources: ['tenant_id', 'tracker_id'] }
function memoryDb() {
  const tables: Record<string, Row[]> = { tenant_trackers: [], tenant_tracker_rows: [], tenant_tracker_changes: [], tenant_tracker_task_links: [], tenant_tracker_sources: [] }
  class Query {
    action = 'read'; values: Row[] = []; filters: ((row: Row) => boolean)[] = []; sorts: [string, boolean][] = []
    take?: number; skip = 0; counted = false; head = false; one = false; returning = false
    constructor(public table: string) {}
    select(_c = '*', o: { count?: string; head?: boolean } = {}) { if (this.action !== 'read') this.returning = true; this.counted = o.count === 'exact'; this.head = Boolean(o.head); return this }
    insert(v: Row | Row[]) { this.action = 'insert'; this.values = Array.isArray(v) ? v : [v]; return this }
    update(v: Row) { this.action = 'update'; this.values = [v]; return this }
    delete() { this.action = 'delete'; return this }
    eq(c: string, v: any) { this.filters.push(r => r[c] === v); return this }
    in(c: string, v: any[]) { this.filters.push(r => v.includes(r[c])); return this }
    order(c: string, o: { ascending?: boolean } = {}) { this.sorts.push([c, o.ascending !== false]); return this }
    limit(n: number) { this.take = n; return this }
    range(a: number, b: number) { this.skip = a; this.take = b - a + 1; return this }
    maybeSingle() { this.one = true; this.take = 1; return this }
    then(resolve: any, reject: any) { return Promise.resolve(this.run()).then(resolve, reject) }
    run() {
      const rows = tables[this.table]
      if (this.action === 'insert') {
        for (const v of this.values) if (rows.some(r => KEYS[this.table].every(k => r[k] === v[k]))) return { data: null, error: new Error('duplicate') }
        rows.push(...this.values.map(v => structuredClone(v))); return { data: this.returning ? this.values : null, error: null }
      }
      const matched = rows.filter(r => this.filters.every(f => f(r)))
      if (this.action === 'update') { matched.forEach(r => Object.assign(r, structuredClone(this.values[0]))); return { data: this.returning ? matched.map(r => structuredClone(r)) : null, error: null } }
      if (this.action === 'delete') { tables[this.table] = rows.filter(r => !matched.includes(r)); return { data: matched, error: null } }
      let out = matched.map(r => structuredClone(r))
      for (const [c, asc] of [...this.sorts].reverse()) out.sort((a, b) => (a[c] < b[c] ? -1 : a[c] > b[c] ? 1 : 0) * (asc ? 1 : -1))
      const total = out.length
      out = out.slice(this.skip, this.take === undefined ? undefined : this.skip + this.take)
      if (this.head) return { data: null, error: null, count: total }
      return { data: this.one ? out[0] ?? null : out, error: null, count: this.counted ? total : null }
    }
  }
  return { from: (t: string) => new Query(t), tables }
}

// Google, simulated: one Sheet with a tab whose values the test changes between syncs.
const SHEET = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'
let grid: string[][] = []
let canOpen = new Set(['u1', 'u2'])
let lastToken = ''
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input)
  if (!url.startsWith('https://')) return realFetch(input, init)
  const token = String(init?.headers?.Authorization || '').replace('Bearer ', ''); lastToken = token
  const reply = (status: number, body: any) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  if (!canOpen.has(token.replace('token-', ''))) return reply(403, { error: { message: 'The caller does not have permission' } })
  if (url.includes('/drive/v3/files')) return reply(200, { files: [{ id: SHEET, name: 'Card Indo Remote', modifiedTime: '2026-10-24T00:00:00Z', owners: [{ displayName: 'Jay' }], shared: true }] })
  if (url.includes('/values/')) return reply(200, { values: grid })
  if (url.includes(`/spreadsheets/${SHEET}?`)) return reply(200, { properties: { title: 'Card Indo Remote' }, sheets: [{ properties: { title: 'Branches', index: 0, gridProperties: { rowCount: 100, columnCount: 6 } } }] })
  return reply(404, { error: { message: 'not found' } })
}) as any

function harness(scopes: Record<string, string> = {}) {
  const db = memoryDb()
  const state = { clients: [{ id: 'c1', name: 'Card Indogrosir' }], projects: [], items: [{ id: 't1', title: 'Roll out' }, { id: 's1', title: 'DRF', parentTaskId: 't1' }], accounts: [{ id: 'u1', name: 'Ana Reyes' }] }
  const app = express(); app.use(express.json({ limit: '10mb' }))
  app.use((req: any, _res, next) => { req.authUser = { id: String(req.headers['x-user'] || 'u1'), name: String(req.headers['x-user'] || 'u1') === 'u2' ? 'Ben Cruz' : 'Ana Reyes', role: String(req.headers['x-role'] || 'Contributor'), organizationId: '11111111-1111-4111-8111-111111111111', modules: ['trackers'], accountType: 'tenant' }; next() })
  const pass = (_q: any, _s: any, n: any) => n()
  const googleAccess = async (_tenant: string, userId: string) => {
    if (userId === 'nobody') throw Object.assign(new Error('Connect your Google account again'), { status: 409 })
    return { token: `token-${userId}`, scope: scopes[userId] ?? 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/spreadsheets.readonly https://www.googleapis.com/auth/drive.metadata.readonly', email: `${userId}@example.com` }
  }
  registerTrackerRoutes(app as any, { db, requireAuth: pass, requireTenant: pass, load: async () => ({ data: state }), key: Buffer.alloc(32, 7), googleAccess })
  return { app, db }
}
async function serve(h: ReturnType<typeof harness>, run: (ask: (m: string, p: string, b?: any, hd?: Record<string, string>) => Promise<{ status: number; body: any }>) => Promise<void>) {
  const server = h.app.listen(0)
  try {
    const port = (server.address() as any).port
    await run(async (m, p, b, hd = {}) => { const r = await realFetch(`http://127.0.0.1:${port}${p}`, { method: m, headers: { 'content-type': 'application/json', ...hd }, body: b === undefined ? undefined : JSON.stringify(b) }); return { status: r.status, body: await r.json() } })
  } finally { server.close() }
}
const columns = [{ name: 'Branch #', type: 'text' }, { name: 'Branch', type: 'text' }, { name: 'Go-live', type: 'date' }, { name: 'Our notes', type: 'longtext' }]

test('a person lists, opens and connects a Sheet; the first sync brings every row in for review', async () => {
  grid = [['Branch #', 'Branch', 'Go-live'], ['57', 'Batch 5', '11/25/2026'], ['58', 'Sta. Rosa', '12/01/2026']]
  const h = harness()
  await serve(h, async ask => {
    assert.deepEqual((await ask('GET', '/api/trackers/sheets/status')).body, { available: true, connected: true, email: 'u1@example.com' })
    const files = await ask('GET', '/api/trackers/sheets/files?q=card')
    assert.equal(files.body.files[0].name, 'Card Indo Remote'); assert.equal(files.body.files[0].shared, true)
    const tabs = await ask('GET', `/api/trackers/sheets/${encodeURIComponent(`https://docs.google.com/spreadsheets/d/${SHEET}/edit`)}/tabs`)
    assert.equal(tabs.status, 200, JSON.stringify(tabs.body)); assert.equal(tabs.body.tabs[0].title, 'Branches')
    const values = await ask('GET', `/api/trackers/sheets/${SHEET}/values?tab=Branches`)
    assert.deepEqual(values.body.grid[0], ['Branch #', 'Branch', 'Go-live'])
    const tracker = (await ask('POST', '/api/trackers', { name: 'Card Indo', columns })).body.tracker
    const [cKey, cName, cLive, cNotes] = tracker.columns.map((c: any) => c.id)
    assert.equal((await ask('POST', `/api/trackers/${tracker.id}/source`, { spreadsheetId: SHEET, tab: 'Branches', keyHeader: 'Branch #', headerMap: { 'Branch #': cKey, Branch: cName, 'Go-live': cLive }, mode: 'two_way' })).status, 400, 'two-way is not switched on yet')
    const connected = await ask('POST', `/api/trackers/${tracker.id}/source`, { spreadsheetId: SHEET, tab: 'Branches', keyHeader: 'Branch #', headerMap: { 'Branch #': cKey, Branch: cName, 'Go-live': cLive } })
    assert.equal(connected.status, 200, JSON.stringify(connected.body))
    assert.equal(connected.body.report.added, 2)
    assert.equal(connected.body.tracker.source.spreadsheetName, 'Card Indo Remote'); assert.equal(connected.body.tracker.source.mode, 'one_way')
    assert.deepEqual(connected.body.tracker.columns.filter((c: any) => c.synced).map((c: any) => c.name), ['Branch #', 'Branch', 'Go-live'])
    const rows = (await ask('GET', `/api/trackers/${tracker.id}/rows?offset=0&limit=50`)).body.rows
    assert.equal(rows.length, 2); assert.ok(rows.every((r: any) => r.review && r.sourceKey))
    assert.equal(rows[0].cells[cLive], '2026-11-25')
    // Sheet columns are read-only for Sheet rows; tracker-only columns are not
    const sta = rows.find((r: any) => r.sourceKey === '58')
    assert.equal((await ask('PATCH', `/api/trackers/${tracker.id}/rows/${sta.id}`, { version: sta.version, cells: { [cName]: 'Changed here' } })).status, 409)
    const noted = await ask('PATCH', `/api/trackers/${tracker.id}/rows/${sta.id}`, { version: sta.version, cells: { [cNotes]: 'Our note' } }); assert.equal(noted.status, 200, JSON.stringify(noted.body))
    // the next sync: one changed, one removed, one new; the note survives
    grid = [['Branch', 'Branch #', 'Go-live'], ['Batch 5', '57', '11/30/2026'], ['Calamba', '60', '']]
    const quick = await ask('POST', `/api/trackers/${tracker.id}/source/sync`, {})
    assert.equal(quick.body.skipped, true, 'automatic syncs wait at least a minute')
    const synced = await ask('POST', `/api/trackers/${tracker.id}/source/sync`, { force: true })
    assert.deepEqual([synced.body.report.added, synced.body.report.updated, synced.body.report.missing], [1, 1, 1])
    const after = (await ask('GET', `/api/trackers/${tracker.id}/rows?offset=0&limit=50`)).body.rows
    assert.equal(after.find((r: any) => r.sourceKey === '57').cells[cLive], '2026-11-30')
    const gone = after.find((r: any) => r.sourceKey === '58')
    assert.equal(gone.sourceMissing, true, 'kept and flagged'); assert.equal(gone.cells[cNotes], 'Our note')
    // review is cleared for rows that were dealt with
    assert.equal((await ask('POST', `/api/trackers/${tracker.id}/rows/review`, { ids: after.map((r: any) => r.id) })).body.reviewed, 3)
    assert.ok((await ask('GET', `/api/trackers/${tracker.id}/rows?offset=0&limit=50`)).body.rows.every((r: any) => !r.review))
    const history = (await ask('GET', `/api/trackers/${tracker.id}/rows/${gone.id}/history`)).body.changes
    assert.ok(Array.isArray(history))
  })
})

test('when the connector loses access, sync says so and someone else can reconnect', async () => {
  grid = [['Branch #', 'Branch'], ['1', 'A']]
  const h = harness()
  await serve(h, async ask => {
    const tracker = (await ask('POST', '/api/trackers', { name: 'T', columns: [{ name: 'Branch #', type: 'text' }, { name: 'Branch', type: 'text' }] })).body.tracker
    const [cKey, cName] = tracker.columns.map((c: any) => c.id)
    await ask('POST', `/api/trackers/${tracker.id}/source`, { spreadsheetId: SHEET, tab: 'Branches', keyHeader: 'Branch #', headerMap: { 'Branch #': cKey, Branch: cName } })
    canOpen = new Set(['u2'])
    const failed = await ask('POST', `/api/trackers/${tracker.id}/source/sync`, { force: true })
    assert.equal(failed.status, 403); assert.equal(failed.body.noAccess, true)
    const source = (await ask('GET', `/api/trackers/${tracker.id}`)).body.tracker.source
    assert.equal(source.lastStatus, 'error'); assert.match(source.lastError, /cannot open/)
    const reconnected = await ask('POST', `/api/trackers/${tracker.id}/source/reconnect`, {}, { 'x-user': 'u2' })
    assert.equal(reconnected.status, 200, JSON.stringify(reconnected.body)); assert.equal(reconnected.body.source.connectedByName, 'Ben Cruz')
    assert.equal(lastToken, 'token-u2', 'syncs now run as the person who reconnected')
    canOpen = new Set(['u1', 'u2'])
    const stopped = await ask('DELETE', `/api/trackers/${tracker.id}/source`)
    assert.equal(stopped.body.tracker.source, null); assert.ok(stopped.body.tracker.columns.every((c: any) => !c.synced), 'columns become editable again')
  })
})

test('without the Sheets permission, the tracker asks for it', async () => {
  const h = harness({ u1: 'https://www.googleapis.com/auth/gmail.readonly' })
  await serve(h, async ask => {
    assert.equal((await ask('GET', '/api/trackers/sheets/status')).body.connected, false)
    const tracker = (await ask('POST', '/api/trackers', { name: 'T', columns: [{ name: 'Branch #', type: 'text' }] })).body.tracker
    const r = await ask('POST', `/api/trackers/${tracker.id}/source`, { spreadsheetId: SHEET, tab: 'Branches', keyHeader: 'Branch #', headerMap: { 'Branch #': tracker.columns[0].id } })
    assert.equal(r.status, 403); assert.equal(r.body.needsGoogle, true)
    assert.equal((await ask('POST', `/api/trackers/${tracker.id}/source`, { spreadsheetId: 'not a link', tab: 'x', keyHeader: 'y', headerMap: {} })).status, 400)
  })
})

test('subtasks made from a review are linked to their cells in one call', async () => {
  const h = harness()
  await serve(h, async ask => {
    const tracker = (await ask('POST', '/api/trackers', { name: 'T', columns: [{ name: 'Branch', type: 'text' }, { name: 'DRF', type: 'date' }] })).body.tracker
    const row = (await ask('POST', `/api/trackers/${tracker.id}/rows`, { rows: [{ cells: {} }] })).body.rows[0]
    const r = await ask('POST', `/api/trackers/${tracker.id}/links/bulk`, { links: [{ rowId: row.id, columnId: tracker.columns[1].id, taskId: 's1' }, { rowId: row.id, columnId: tracker.columns[1].id, taskId: 's1' }] })
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.links.length, 1, 'duplicates are skipped')
    assert.equal((await ask('POST', `/api/trackers/${tracker.id}/links/bulk`, { links: [{ rowId: row.id, columnId: 'nope', taskId: 's1' }] })).status, 400)
  })
})
