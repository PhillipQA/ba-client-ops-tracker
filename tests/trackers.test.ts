import assert from 'node:assert/strict'
import { test } from 'node:test'
import express from 'express'
import { registerTrackerRoutes } from '../server/trackers/trackers'
import { TRACKER_LIMITS } from '../src/features/trackers/trackerModel'

type Row = Record<string, any>
const KEYS: Record<string, string[]> = { tenant_trackers: ['tenant_id', 'id'], tenant_tracker_rows: ['tenant_id', 'tracker_id', 'id'], tenant_tracker_changes: ['id'], tenant_tracker_task_links: ['id'] }

/** A small in-memory stand-in for the database client, with the query methods the tracker routes use. */
function memoryDb(options: { failChanges?: boolean } = {}) {
  const tables: Record<string, Row[]> = { tenant_trackers: [], tenant_tracker_rows: [], tenant_tracker_changes: [], tenant_tracker_task_links: [] }
  class Query {
    action = 'read'; values: Row[] = []; filters: ((row: Row) => boolean)[] = []; sorts: [string, boolean][] = []
    take?: number; skip = 0; returning = false; counted = false; head = false; one: 'single' | 'maybe' | null = null
    constructor(public table: string) {}
    select(_columns = '*', opts: { count?: string; head?: boolean } = {}) { if (this.action !== 'read') this.returning = true; this.counted = opts.count === 'exact'; this.head = Boolean(opts.head); return this }
    insert(value: Row | Row[]) { this.action = 'insert'; this.values = Array.isArray(value) ? value : [value]; return this }
    update(value: Row) { this.action = 'update'; this.values = [value]; return this }
    delete() { this.action = 'delete'; return this }
    eq(column: string, value: any) { this.filters.push(row => row[column] === value); return this }
    in(column: string, values: any[]) { this.filters.push(row => values.includes(row[column])); return this }
    order(column: string, o: { ascending?: boolean } = {}) { this.sorts.push([column, o.ascending !== false]); return this }
    limit(n: number) { this.take = n; return this }
    range(a: number, b: number) { this.skip = a; this.take = b - a + 1; return this }
    maybeSingle() { this.one = 'maybe'; this.take = 1; return this }
    single() { this.one = 'single'; this.take = 1; return this }
    then(resolve: any, reject: any) { return Promise.resolve(this.run()).then(resolve, reject) }
    run() {
      const rows = tables[this.table]
      if (this.table === 'tenant_tracker_changes' && options.failChanges && this.action === 'insert') return { data: null, error: new Error('disk full'), count: null }
      if (this.action === 'insert') {
        for (const value of this.values) {
          if (rows.some(row => KEYS[this.table].every(key => row[key] === value[key]))) return { data: null, error: new Error('duplicate key'), count: null }
          if (this.table === 'tenant_tracker_rows' && !tables.tenant_trackers.some(t => t.tenant_id === value.tenant_id && t.id === value.tracker_id)) return { data: null, error: new Error('foreign key'), count: null }
        }
        rows.push(...this.values.map(value => structuredClone(value)))
        return { data: this.returning ? this.values : null, error: null, count: null }
      }
      const matched = rows.filter(row => this.filters.every(filter => filter(row)))
      if (this.action === 'update') { for (const row of matched) Object.assign(row, structuredClone(this.values[0])); return { data: this.returning ? matched.map(row => structuredClone(row)) : null, error: null, count: null } }
      if (this.action === 'delete') {
        const gone = new Set(matched)
        tables[this.table] = rows.filter(row => !gone.has(row))
        if (this.table === 'tenant_trackers') for (const t of matched) tables.tenant_tracker_rows = tables.tenant_tracker_rows.filter(row => !(row.tenant_id === t.tenant_id && row.tracker_id === t.id))
        if (this.table === 'tenant_trackers') for (const t of matched) tables.tenant_tracker_task_links = tables.tenant_tracker_task_links.filter(row => !(row.tenant_id === t.tenant_id && row.tracker_id === t.id))
        return { data: this.returning ? matched : null, error: null, count: null }
      }
      let result = matched.map(row => structuredClone(row))
      for (const [column, asc] of [...this.sorts].reverse()) result.sort((a, b) => (a[column] < b[column] ? -1 : a[column] > b[column] ? 1 : 0) * (asc ? 1 : -1))
      const total = result.length
      result = result.slice(this.skip, this.take === undefined ? undefined : this.skip + this.take)
      if (this.head) return { data: null, error: null, count: total }
      return { data: this.one ? result[0] ?? null : result, error: null, count: this.counted ? total : null }
    }
  }
  return { from: (table: string) => new Query(table), tables }
}

function harness(options: { failChanges?: boolean } = {}) {
  const db = memoryDb(options)
  const state = { clients: [{ id: 'c1', name: 'Acme' }], projects: [{ id: 'p1', name: 'Rollout' }], items: [{ id: 't1', title: 'Davao store' }, { id: 't2', title: 'Train the staff', parentTaskId: 't1' }] }
  const app = express(); app.use(express.json({ limit: '10mb' }))
  app.use((req: any, _res, next) => {
    const modules = req.headers['x-modules'] === 'none' ? ['clients'] : ['clients', 'trackers']
    req.authUser = { id: String(req.headers['x-user'] || 'u1'), name: String(req.headers['x-name'] || 'Ana Reyes'), role: String(req.headers['x-role'] || 'Contributor'), organizationId: '11111111-1111-4111-8111-111111111111', modules, accountType: req.headers['x-platform'] ? 'platform' : 'tenant' }
    next()
  })
  const pass = (_req: any, _res: any, next: any) => next()
  registerTrackerRoutes(app as any, { db, requireAuth: pass, requireTenant: pass, load: async () => ({ data: state }), key: Buffer.alloc(32, 7) })
  return { app, db, state }
}
async function serve(h: ReturnType<typeof harness>, run: (ask: (method: string, path: string, body?: any, headers?: Record<string, string>) => Promise<{ status: number; body: any }>) => Promise<void>) {
  const server = h.app.listen(0)
  try {
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port')
    await run(async (method, path, body, headers = {}) => {
      const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
      return { status: response.status, body: await response.json() }
    })
  } finally { server.close() }
}
const sample = () => [
  { name: 'Site', type: 'text' }, { name: 'Go-live', type: 'date' },
  { name: 'Status', type: 'select', options: [{ label: 'Not started' }, { label: 'Live' }] },
  { name: 'Admin login', type: 'secret' }, { name: 'Task status', type: 'task_status' },
]
const idOf = (tracker: any, name: string) => tracker.columns.find((c: any) => c.name === name).id
async function makeTracker(ask: any, extra: any = {}, headers?: Record<string, string>) {
  const created = await ask('POST', '/api/trackers', { name: 'Site rollout', columns: sample(), ...extra }, headers)
  assert.equal(created.status, 201, JSON.stringify(created.body))
  return created.body.tracker
}

test('only people with the Trackers module can use it, and viewers can only look', async () => {
  const h = harness()
  await serve(h, async ask => {
    assert.equal((await ask('GET', '/api/trackers', undefined, { 'x-modules': 'none' })).status, 403)
    assert.equal((await ask('GET', '/api/trackers', undefined, { 'x-platform': '1' })).status, 403)
    assert.equal((await ask('POST', '/api/trackers', { name: 'X' }, { 'x-role': 'Viewer' })).status, 403)
    assert.equal((await ask('GET', '/api/trackers', undefined, { 'x-role': 'Viewer' })).status, 200)
    const tracker = await makeTracker(ask)
    const viewer = { 'x-role': 'Viewer', 'x-user': 'v1' }
    assert.equal((await ask('GET', `/api/trackers/${tracker.id}`, undefined, viewer)).body.tracker.canEdit, false)
    assert.equal((await ask('POST', `/api/trackers/${tracker.id}/rows`, { rows: [{ cells: {} }] }, viewer)).status, 403)
  })
})

test('a tracker is created with its columns, listed, renamed, linked, archived and deleted', async () => {
  const h = harness()
  await serve(h, async ask => {
    const tracker = await makeTracker(ask, { clientId: 'c1', projectId: 'p1', template: 'site-rollout' })
    assert.equal(tracker.rowCount, 0);assert.equal(tracker.revision, 1);assert.equal(tracker.clientId, 'c1');assert.equal(tracker.canManage, true)
    assert.deepEqual(tracker.columns.map((c: any) => c.type), ['text', 'date', 'select', 'secret', 'task_status'])
    assert.ok(tracker.columns.every((c: any) => /^[a-z0-9_]{3,40}$/i.test(c.id)), 'Every column gets a stable id')
    assert.deepEqual(tracker.columns[2].options.map((o: any) => o.label), ['Not started', 'Live'])
    assert.equal((await ask('POST', '/api/trackers', { name: 'Bad', clientId: 'nope' })).status, 400)
    assert.equal((await ask('POST', '/api/trackers', { name: '   ' })).status, 400)
    assert.equal((await ask('POST', '/api/trackers', { name: 'X', columns: [{ name: 'A', type: 'text' }, { name: 'a', type: 'number' }] })).status, 400, 'Column names are unique')
    assert.equal((await ask('GET', '/api/trackers')).body.trackers.length, 1)
    const renamed = await ask('PATCH', `/api/trackers/${tracker.id}`, { name: 'Rollout sites' })
    assert.equal(renamed.body.tracker.name, 'Rollout sites')
    // Only the creator or an Administrator archives; anyone else is refused.
    assert.equal((await ask('PATCH', `/api/trackers/${tracker.id}`, { archived: true }, { 'x-user': 'u2' })).status, 403)
    assert.equal((await ask('DELETE', `/api/trackers/${tracker.id}`)).status, 409, 'A tracker must be archived before it can be deleted')
    assert.equal((await ask('PATCH', `/api/trackers/${tracker.id}`, { archived: true })).body.tracker.archived, true)
    assert.equal((await ask('POST', `/api/trackers/${tracker.id}/rows`, { rows: [{ cells: {} }] })).status, 409, 'An archived tracker is read-only')
    assert.equal((await ask('PUT', `/api/trackers/${tracker.id}/columns`, { columns: tracker.columns, revision: tracker.revision })).status, 409, 'Columns cannot change while archived')
    assert.equal((await ask('PUT', `/api/trackers/${tracker.id}/views`, { views: [], revision: tracker.revision })).status, 409, 'Views cannot change while archived')
    assert.equal((await ask('DELETE', `/api/trackers/${tracker.id}`, undefined, { 'x-user': 'u2' })).status, 403)
    assert.equal((await ask('DELETE', `/api/trackers/${tracker.id}`, undefined, { 'x-user': 'u2', 'x-role': 'Administrator' })).status, 200)
    assert.equal((await ask('GET', `/api/trackers/${tracker.id}`)).status, 404)
    assert.equal(h.db.tables.tenant_trackers.length, 0)
  })
})

test('a private tracker does not exist for anyone but its creator', async () => {
  const h = harness()
  await serve(h, async ask => {
    const mine = await makeTracker(ask, { private: true })
    assert.equal((await ask('GET', '/api/trackers', undefined, { 'x-user': 'u2' })).body.trackers.length, 0)
    assert.equal((await ask('GET', `/api/trackers/${mine.id}`, undefined, { 'x-user': 'u2', 'x-role': 'Administrator' })).status, 404)
    assert.equal((await ask('GET', `/api/trackers/${mine.id}/rows`, undefined, { 'x-user': 'u2' })).status, 404)
    assert.equal((await ask('GET', '/api/trackers')).body.trackers.length, 1)
    assert.equal((await ask('PATCH', `/api/trackers/${mine.id}`, { private: false })).body.tracker.private, false)
    assert.equal((await ask('GET', '/api/trackers', undefined, { 'x-user': 'u2' })).body.trackers.length, 1)
  })
})

test('columns can be added, renamed, reordered and removed, but never change type', async () => {
  const h = harness()
  await serve(h, async ask => {
    const tracker = await makeTracker(ask)
    const next = [...tracker.columns].reverse().map((c: any) => c.name === 'Site' ? { ...c, name: 'Store' } : c)
    next.push({ name: 'Owner', type: 'person' })
    const saved = await ask('PUT', `/api/trackers/${tracker.id}/columns`, { columns: next, revision: 1 })
    assert.equal(saved.status, 200, JSON.stringify(saved.body))
    const t2 = saved.body.tracker
    assert.equal(t2.revision, 2);assert.deepEqual(t2.columns.map((c: any) => c.name), ['Task status', 'Admin login', 'Status', 'Go-live', 'Store', 'Owner'])
    assert.equal(idOf(t2, 'Store'), idOf(tracker, 'Site'), 'A renamed column keeps its id, so its values stay')
    // The wrong revision is a conflict and returns the current tracker.
    const stale = await ask('PUT', `/api/trackers/${tracker.id}/columns`, { columns: next, revision: 1 })
    assert.equal(stale.status, 409);assert.equal(stale.body.tracker.revision, 2)
    // A different type for an existing column is refused.
    const retyped = t2.columns.map((c: any) => c.name === 'Go-live' ? { ...c, type: 'text' } : c)
    const refused = await ask('PUT', `/api/trackers/${tracker.id}/columns`, { columns: retyped, revision: 2 })
    assert.equal(refused.status, 400);assert.match(refused.body.error, /cannot change type/)
    assert.equal((await ask('PUT', `/api/trackers/${tracker.id}/columns`, { columns: [], revision: 2 })).status, 400)
    const tooMany = Array.from({ length: TRACKER_LIMITS.columns + 1 }, (_, i) => ({ name: `C${i}`, type: 'text' }))
    assert.equal((await ask('PUT', `/api/trackers/${tracker.id}/columns`, { columns: tooMany, revision: 2 })).status, 400)
    const trimmed = await ask('PUT', `/api/trackers/${tracker.id}/columns`, { columns: t2.columns.filter((c: any) => c.name !== 'Owner'), revision: 2 })
    assert.equal(trimmed.body.tracker.columns.length, 5)
  })
})

test('rows are validated against the columns, stored, paged and counted', async () => {
  const h = harness()
  await serve(h, async ask => {
    const t = await makeTracker(ask)
    const site = idOf(t, 'Site'), live = idOf(t, 'Go-live'), status = idOf(t, 'Status'), login = idOf(t, 'Admin login'), taskStatus = idOf(t, 'Task status')
    const live1 = t.columns[2].options[1].id
    const created = await ask('POST', `/api/trackers/${t.id}/rows`, { rows: [{ cells: { [site]: '  Store 001 · Makati ', [live]: '2026-10-12', [status]: live1 } }, { cells: { [site]: 'Store 002 · Cebu' }, taskId: 't1' }] })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    assert.deepEqual(created.body.rows.map((r: any) => r.position), [1, 2])
    assert.deepEqual(created.body.rows[0].cells, { [site]: 'Store 001 · Makati', [live]: '2026-10-12', [status]: live1 })
    assert.equal(created.body.rows[1].taskId, 't1');assert.equal(created.body.rows[0].version, 1)
    const bad = async (cells: any, pattern: RegExp, extra: any = {}) => {
      const r = await ask('POST', `/api/trackers/${t.id}/rows`, { rows: [{ cells, ...extra }] })
      assert.equal(r.status, 400, JSON.stringify(r.body));assert.match(r.body.error, pattern)
    }
    await bad({ [live]: '12/10/2026' }, /needs a date/)
    await bad({ [live]: '2026-02-30' }, /needs a date/)
    await bad({ [status]: 'nope' }, /no such option/)
    await bad({ nothere: 'x' }, /no longer exists/)
    await bad({ [login]: 'hunter2' }, /Secret column/)
    await bad({ [taskStatus]: 'Done' }, /fills itself/)
    await bad({ [site]: 'x'.repeat(TRACKER_LIMITS.text + 1) }, /at most 2000/)
    await bad({}, /task was not found/, { taskId: 'missing' })
    const page = await ask('GET', `/api/trackers/${t.id}/rows?offset=1&limit=1`)
    assert.equal(page.body.total, 2);assert.equal(page.body.rows.length, 1);assert.equal(page.body.rows[0].cells[site], 'Store 002 · Cebu')
    assert.equal((await ask('GET', '/api/trackers')).body.trackers[0].rowCount, 2)
    // Several rows at once: the message says which row is wrong, and nothing is saved.
    const batch = await ask('POST', `/api/trackers/${t.id}/rows`, { rows: [{ cells: { [site]: 'ok' } }, { cells: { [live]: 'bad' } }] })
    assert.equal(batch.status, 400);assert.match(batch.body.error, /^Row 2: /)
    assert.equal((await ask('GET', `/api/trackers/${t.id}/rows`)).body.total, 2)
    assert.equal((await ask('POST', `/api/trackers/${t.id}/rows`, { rows: Array.from({ length: TRACKER_LIMITS.importBatch + 1 }, () => ({ cells: {} })) })).status, 400)
  })
})

test('a tracker stops at its row limit', async () => {
  const h = harness()
  await serve(h, async ask => {
    const t = await makeTracker(ask)
    const site = idOf(t, 'Site')
    for (let i = 0; i < TRACKER_LIMITS.rows / TRACKER_LIMITS.importBatch; i++) {
      const r = await ask('POST', `/api/trackers/${t.id}/rows`, { rows: Array.from({ length: TRACKER_LIMITS.importBatch }, (_, n) => ({ cells: { [site]: `Row ${i * 1000 + n}` } })) })
      assert.equal(r.status, 201)
    }
    const over = await ask('POST', `/api/trackers/${t.id}/rows`, { rows: [{ cells: { [site]: 'one too many' } }] })
    assert.equal(over.status, 409);assert.match(over.body.error, /at most 5,000 rows/)
    assert.equal((await ask('GET', `/api/trackers/${t.id}/rows?limit=5000`)).body.rows.length, 1000, 'A page is at most 1,000 rows')
  })
})

test('a cell edit checks the row version, keeps a history and ignores no-op saves', async () => {
  const h = harness()
  await serve(h, async ask => {
    const t = await makeTracker(ask)
    const site = idOf(t, 'Site'), status = idOf(t, 'Status'), live = t.columns[2].options[1].id
    const row = (await ask('POST', `/api/trackers/${t.id}/rows`, { rows: [{ cells: { [site]: 'Store 003' } }] })).body.rows[0]
    const url = `/api/trackers/${t.id}/rows/${row.id}`
    const same = await ask('PATCH', url, { version: 1, cells: { [site]: 'Store 003' } })
    assert.equal(same.body.row.version, 1, 'Saving the same value is not a change')
    const edited = await ask('PATCH', url, { version: 1, cells: { [status]: live, [site]: 'Store 003 · Davao' } })
    assert.equal(edited.status, 200, JSON.stringify(edited.body));assert.equal(edited.body.row.version, 2)
    assert.deepEqual(edited.body.row.cells, { [site]: 'Store 003 · Davao', [status]: live })
    // Someone else holding version 1 is told, and gets the current row back.
    const conflict = await ask('PATCH', url, { version: 1, cells: { [site]: 'Mine' } }, { 'x-user': 'u2', 'x-name': 'Ben Lim' })
    assert.equal(conflict.status, 409);assert.equal(conflict.body.row.cells[site], 'Store 003 · Davao')
    assert.equal((await ask('PATCH', url, { cells: {} })).status, 400, 'A version is required')
    // Emptying a cell removes it.
    const cleared = await ask('PATCH', url, { version: 2, cells: { [status]: '' } })
    assert.deepEqual(cleared.body.row.cells, { [site]: 'Store 003 · Davao' })
    // A link to a task, and removing it.
    const linked = await ask('PATCH', url, { version: 3, taskId: 't1' })
    assert.equal(linked.body.row.taskId, 't1')
    assert.equal((await ask('PATCH', url, { version: 4, taskId: 'nope' })).status, 400)
    assert.equal((await ask('PATCH', url, { version: 4, taskId: null })).body.row.taskId, '')
    const history = (await ask('GET', `${url}/history`)).body.changes
    assert.deepEqual(history.map((c: any) => c.kind).reverse(), ['row_created', 'cells', 'cells', 'task_linked', 'task_unlinked'])
    const firstEdit = [...history].reverse().find((c: any) => c.kind === 'cells' && c.detail.cells.some((x: any) => x.name === 'Status'))
    assert.deepEqual(firstEdit.detail.cells.find((x: any) => x.name === 'Status'), { columnId: status, name: 'Status', from: '', to: 'Live' })
    assert.equal(history[0].actorName, 'Ana Reyes')
    assert.equal((await ask('PATCH', `/api/trackers/${t.id}/rows/not-a-uuid`, { version: 1, cells: {} })).status, 404)
  })
})

test('rows can be deleted in bulk', async () => {
  const h = harness()
  await serve(h, async ask => {
    const t = await makeTracker(ask)
    const site = idOf(t, 'Site')
    const rows = (await ask('POST', `/api/trackers/${t.id}/rows`, { rows: ['a', 'b', 'c'].map(v => ({ cells: { [site]: v } })) })).body.rows
    const removed = await ask('POST', `/api/trackers/${t.id}/rows/delete`, { ids: [rows[0].id, rows[2].id] })
    assert.equal(removed.body.deleted, 2)
    const left = (await ask('GET', `/api/trackers/${t.id}/rows`)).body
    assert.deepEqual(left.rows.map((r: any) => r.cells[site]), ['b']);assert.equal(left.total, 1)
    assert.equal((await ask('POST', `/api/trackers/${t.id}/rows/delete`, { ids: ['nope'] })).status, 400)
    assert.equal((await ask('POST', `/api/trackers/${t.id}/rows/delete`, { ids: [rows[1].id] }, { 'x-role': 'Viewer' })).status, 403)
  })
})

test('Secret cells are encrypted, never returned, and only shown through a logged reveal', async () => {
  const h = harness()
  await serve(h, async ask => {
    const t = await makeTracker(ask)
    const site = idOf(t, 'Site'), login = idOf(t, 'Admin login')
    const created = await ask('POST', `/api/trackers/${t.id}/rows`, { rows: [{ cells: { [site]: 'Store 001' }, secrets: { [login]: 'correct horse battery' } }] })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    const row = created.body.rows[0]
    assert.deepEqual(row.secretSet, { [login]: true })
    const everything = JSON.stringify([created.body, (await ask('GET', `/api/trackers/${t.id}/rows`)).body, (await ask('GET', `/api/trackers/${t.id}`)).body])
    assert.ok(!everything.includes('correct horse'), 'The value is never in a response')
    const stored = JSON.stringify(h.db.tables.tenant_tracker_rows)
    assert.ok(!stored.includes('correct horse'), 'The value is not stored in plain text')
    assert.match(h.db.tables.tenant_tracker_rows[0].secrets[login], /^v1\./)
    // A reveal returns the value and leaves a record of who looked.
    const url = `/api/trackers/${t.id}/rows/${row.id}`
    const revealed = await ask('POST', `${url}/reveal`, { columnId: login }, { 'x-name': 'Ben Lim', 'x-user': 'u2' })
    assert.equal(revealed.body.value, 'correct horse battery')
    const history = (await ask('GET', `${url}/history`)).body.changes
    assert.deepEqual(history.filter((c: any) => c.kind === 'reveal').map((c: any) => [c.actorName, c.detail.name]), [['Ben Lim', 'Admin login']])
    // Changing the value is logged without the value.
    const changed = await ask('PATCH', url, { version: 1, secrets: { [login]: 'another one' } })
    assert.equal(changed.body.row.version, 2)
    assert.ok(!JSON.stringify((await ask('GET', `${url}/history`)).body).includes('another one'))
    assert.equal((await ask('POST', `${url}/reveal`, { columnId: login })).body.value, 'another one')
    assert.equal((await ask('POST', `${url}/reveal`, { columnId: site })).status, 404, 'Only Secret columns can be revealed')
    assert.equal((await ask('POST', `${url}/reveal`, { columnId: login }, { 'x-role': 'Viewer' })).status, 403)
    // Clearing the value removes it.
    const cleared = await ask('PATCH', url, { version: 2, secrets: { [login]: null } })
    assert.deepEqual(cleared.body.row.secretSet, {})
    assert.equal((await ask('POST', `${url}/reveal`, { columnId: login })).status, 404)
    assert.equal((await ask('POST', `/api/trackers/${t.id}/rows`, { rows: [{ secrets: { [site]: 'x' } }] })).status, 400, 'Plain columns do not take secrets')
    assert.equal((await ask('POST', `/api/trackers/${t.id}/rows`, { rows: [{ secrets: { [login]: 'x'.repeat(TRACKER_LIMITS.secret + 1) } }] })).status, 400)
  })
})

test('a column limited to administrators cannot be revealed by anyone else', async () => {
  const h = harness()
  await serve(h, async ask => {
    const t = await makeTracker(ask, { columns: [{ name: 'Site', type: 'text' }, { name: 'Root login', type: 'secret', revealBy: 'admins' }] })
    const login = idOf(t, 'Root login')
    const row = (await ask('POST', `/api/trackers/${t.id}/rows`, { rows: [{ secrets: { [login]: 'topsecret' } }] })).body.rows[0]
    const url = `/api/trackers/${t.id}/rows/${row.id}/reveal`
    assert.equal((await ask('POST', url, { columnId: login })).status, 403)
    assert.equal((await ask('POST', url, { columnId: login }, { 'x-role': 'Administrator' })).body.value, 'topsecret')
  })
})

test('nothing is revealed when the reveal cannot be recorded', async () => {
  const h = harness({ failChanges: true })
  await serve(h, async ask => {
    const t = await makeTracker(ask)
    const login = idOf(t, 'Admin login')
    const row = (await ask('POST', `/api/trackers/${t.id}/rows`, { rows: [{ secrets: { [login]: 'hunter2' } }] })).body.rows[0]
    const result = await ask('POST', `/api/trackers/${t.id}/rows/${row.id}/reveal`, { columnId: login })
    assert.equal(result.status, 503);assert.ok(!JSON.stringify(result.body).includes('hunter2'))
  })
})

test('removing a Secret column removes its encrypted values', async () => {
  const h = harness()
  await serve(h, async ask => {
    const t = await makeTracker(ask)
    const login = idOf(t, 'Admin login')
    await ask('POST', `/api/trackers/${t.id}/rows`, { rows: [{ secrets: { [login]: 'one' } }, { secrets: { [login]: 'two' } }] })
    assert.equal(h.db.tables.tenant_tracker_rows.filter(r => r.secrets[login]).length, 2)
    const without = t.columns.filter((c: any) => c.id !== login)
    const saved = await ask('PUT', `/api/trackers/${t.id}/columns`, { columns: without, revision: 1 })
    assert.equal(saved.status, 200)
    assert.equal(h.db.tables.tenant_tracker_rows.filter(r => Object.keys(r.secrets).length).length, 0)
  })
})

test('saved views keep only references to columns that exist', async () => {
  const h = harness()
  await serve(h, async ask => {
    const t = await makeTracker(ask)
    const status = idOf(t, 'Status'), site = idOf(t, 'Site')
    const views = [{ name: 'Delayed', filters: [{ columnId: status, op: 'is', value: 'x' }, { columnId: 'gone', op: 'is', value: 'y' }], sort: { columnId: site, dir: 'desc' }, groupBy: 'gone', hidden: [site, 'gone'] }]
    const saved = await ask('PUT', `/api/trackers/${t.id}/views`, { views, revision: 1 })
    assert.equal(saved.status, 200, JSON.stringify(saved.body))
    const view = saved.body.tracker.views[0]
    assert.equal(view.filters.length, 1);assert.deepEqual(view.sort, { columnId: site, dir: 'desc' });assert.equal(view.groupBy, '');assert.deepEqual(view.hidden, [site])
    assert.equal((await ask('PUT', `/api/trackers/${t.id}/views`, { views: [{ name: 'A' }, { name: 'a' }], revision: 2 })).status, 400)
    // Deleting a column also removes it from saved views.
    const trimmed = await ask('PUT', `/api/trackers/${t.id}/columns`, { columns: t.columns.filter((c: any) => c.id !== status), revision: 2 })
    assert.equal(trimmed.body.tracker.views[0].filters.length, 0)
  })
})

test('a row or one of its cells can be linked to many tasks and subtasks, and the links follow the row', async () => {
  const h = harness()
  await serve(h, async ask => {
    const tracker = await makeTracker(ask)
    const made = await ask('POST', `/api/trackers/${tracker.id}/rows`, { rows: [{ cells: { [idOf(tracker, 'Site')]: 'Davao' } }, { cells: { [idOf(tracker, 'Site')]: 'Cebu' } }] })
    const [davao, cebu] = made.body.rows
    const link = (body: any, headers?: Record<string, string>) => ask('POST', `/api/trackers/${tracker.id}/links`, body, headers)
    const row = await link({ rowId: davao.id, taskId: 't1' })
    assert.equal(row.status, 201, JSON.stringify(row.body))
    assert.equal(row.body.link.rowTitle, 'Davao'); assert.equal(row.body.link.columnId, '')
    const cell = await link({ rowId: davao.id, taskId: 't2', columnId: idOf(tracker, 'Go-live') })
    assert.equal(cell.status, 201); assert.equal(cell.body.link.columnName, 'Go-live')
    assert.equal(cell.body.links.length, 2, 'The row now has two links')
    assert.equal((await link({ rowId: davao.id, taskId: 't2', columnId: idOf(tracker, 'Go-live') })).status, 409, 'The same task is not linked twice to one cell')
    assert.equal((await link({ rowId: davao.id, taskId: 't2' })).status, 201, 'The same task can also be linked to the whole row')
    assert.equal((await link({ rowId: davao.id, taskId: 'nope' })).status, 400)
    assert.equal((await link({ rowId: davao.id, taskId: 't1', columnId: 'missing' })).status, 400)
    assert.equal((await link({ rowId: cebu.id, taskId: 't2' }, { 'x-role': 'Viewer' })).status, 403)
    await link({ rowId: cebu.id, taskId: 't2' })
    const all = await ask('GET', '/api/trackers/task-links')
    assert.equal(all.status, 200); assert.equal(all.body.links.filter((l: any) => l.taskId === 't2').length, 3)
    assert.deepEqual(all.body.links.filter((l: any) => l.rowId === cebu.id).map((l: any) => l.trackerName), ['Site rollout'])
    const history = await ask('GET', `/api/trackers/${tracker.id}/rows/${davao.id}/history`)
    assert.ok(history.body.changes.some((c: any) => c.kind === 'subtask_linked'))
    const gone = await ask('DELETE', `/api/trackers/${tracker.id}/links/${row.body.link.id}`)
    assert.equal(gone.body.removed, 1)
    assert.equal((await ask('GET', `/api/trackers/${tracker.id}/links`)).body.links.length, 3)
    await ask('POST', `/api/trackers/${tracker.id}/rows/delete`, { ids: [davao.id] })
    assert.deepEqual((await ask('GET', '/api/trackers/task-links')).body.links.map((l: any) => l.rowId), [cebu.id], 'Deleting a row removes its links')
  })
})

test('links to a private tracker are visible only to its creator', async () => {
  const h = harness()
  await serve(h, async ask => {
    const tracker = await makeTracker(ask, { private: true }, { 'x-user': 'u1' })
    const rows = await ask('POST', `/api/trackers/${tracker.id}/rows`, { rows: [{ cells: {} }] }, { 'x-user': 'u1' })
    await ask('POST', `/api/trackers/${tracker.id}/links`, { rowId: rows.body.rows[0].id, taskId: 't1' }, { 'x-user': 'u1' })
    assert.equal((await ask('GET', '/api/trackers/task-links', undefined, { 'x-user': 'u1' })).body.links.length, 1)
    assert.equal((await ask('GET', '/api/trackers/task-links', undefined, { 'x-user': 'u2' })).body.links.length, 0)
    assert.equal((await ask('POST', `/api/trackers/${tracker.id}/links`, { rowId: rows.body.rows[0].id, taskId: 't2' }, { 'x-user': 'u2' })).status, 404)
  })
})

test('a tracker can follow several clients, and older single-client calls still work', async () => {
  const h = harness()
  h.state.clients.push({ id: 'c2', name: 'Northwind' })
  await serve(h, async ask => {
    const tracker = await makeTracker(ask, { clientIds: ['c1', 'c2', 'c1'] })
    assert.deepEqual(tracker.clientIds, ['c1', 'c2']); assert.equal(tracker.clientId, 'c1')
    assert.equal((await ask('POST', '/api/trackers', { name: 'Bad', clientIds: ['c1', 'nope'] })).status, 400)
    assert.equal((await ask('POST', '/api/trackers', { name: 'Bad', clientIds: 'c1' })).status, 400)
    const one = await ask('PATCH', `/api/trackers/${tracker.id}`, { clientIds: ['c2'] })
    assert.deepEqual(one.body.tracker.clientIds, ['c2'])
    const legacy = await ask('PATCH', `/api/trackers/${tracker.id}`, { clientId: 'c1' })
    assert.deepEqual(legacy.body.tracker.clientIds, ['c1'])
    const none = await ask('PATCH', `/api/trackers/${tracker.id}`, { clientIds: [] })
    assert.deepEqual(none.body.tracker.clientIds, []); assert.equal(none.body.tracker.clientId, '')
  })
})

test('many rows can be linked to their tasks at once', async () => {
  const h = harness()
  await serve(h, async ask => {
    const tracker = await makeTracker(ask)
    const made = await ask('POST', `/api/trackers/${tracker.id}/rows`, { rows: [{ cells: {} }, { cells: {} }] })
    const [a, b] = made.body.rows
    const linked = await ask('POST', `/api/trackers/${tracker.id}/rows/tasks`, { links: [{ rowId: a.id, taskId: 't1' }, { rowId: b.id, taskId: 't2' }] })
    assert.equal(linked.status, 200, JSON.stringify(linked.body))
    assert.deepEqual(linked.body.rows.map((row: any) => row.taskId).sort(), ['t1', 't2'])
    assert.ok(linked.body.rows.every((row: any) => row.version === 2), 'each linked row gets a new version')
    assert.equal((await ask('POST', `/api/trackers/${tracker.id}/rows/tasks`, { links: [{ rowId: a.id, taskId: 'nope' }] })).status, 400)
    assert.equal((await ask('POST', `/api/trackers/${tracker.id}/rows/tasks`, { links: [] })).status, 400)
    assert.equal((await ask('POST', `/api/trackers/${tracker.id}/rows/tasks`, { links: [{ rowId: a.id, taskId: 't1' }] }, { 'x-role': 'Viewer' })).status, 403)
    const history = await ask('GET', `/api/trackers/${tracker.id}/rows/${a.id}/history`)
    assert.ok(history.body.changes.some((c: any) => c.kind === 'task_linked'))
  })
})

test('Calculated columns are saved by id and refuse values typed into them', async () => {
  const h = harness()
  await serve(h, async ask => {
    const created = await ask('POST', '/api/trackers', { name: 'Costs', columns: [{ name: 'Item', type: 'text' }, { name: 'Qty', type: 'number' }, { name: 'Price', type: 'number' }, { name: 'Amount', type: 'formula', formula: '[Qty] * [Price]', total: 'sum' }] })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    const tracker = created.body.tracker
    assert.equal(tracker.columns[3].formula, `{${tracker.columns[1].id}} * {${tracker.columns[2].id}}`)
    assert.equal((await ask('POST', `/api/trackers/${tracker.id}/rows`, { rows: [{ cells: { [tracker.columns[3].id]: 5 } }] })).status, 400)
    assert.equal((await ask('POST', '/api/trackers', { name: 'Bad', columns: [{ name: 'A', type: 'text' }, { name: 'B', type: 'formula', formula: '[A] * 2' }] })).status, 400)
  })
})
