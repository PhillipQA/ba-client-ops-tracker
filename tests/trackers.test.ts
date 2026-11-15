import assert from 'node:assert/strict'
import { test } from 'node:test'
import express from 'express'
import { registerTrackerRoutes } from '../server/trackers/trackers'
import { TRACKER_LIMITS } from '../src/features/trackers/trackerModel'

type Row = Record<string, any>
const KEYS: Record<string, string[]> = {
  tenant_trackers: ['tenant_id', 'id'],
  tenant_tracker_rows: ['tenant_id', 'tracker_id', 'id'],
  tenant_tracker_changes: ['id'],
  tenant_tracker_task_links: ['id'],
}

/** A small in-memory stand-in for the database client, with the query methods the tracker routes use. */
function memoryDb(options: { failChanges?: boolean } = {}) {
  const tables: Record<string, Row[]> = {
    tenant_trackers: [],
    tenant_tracker_rows: [],
    tenant_tracker_changes: [],
    tenant_tracker_task_links: [],
  }
  class Query {
    action = 'read'
    values: Row[] = []
    filters: ((row: Row) => boolean)[] = []
    sorts: [string, boolean][] = []
    take?: number
    skip = 0
    returning = false
    counted = false
    head = false
    one: 'single' | 'maybe' | null = null
    constructor(public table: string) {}
    select(_columns = '*', opts: { count?: string; head?: boolean } = {}) {
      if (this.action !== 'read') this.returning = true
      this.counted = opts.count === 'exact'
      this.head = Boolean(opts.head)
      return this
    }
    insert(value: Row | Row[]) {
      this.action = 'insert'
      this.values = Array.isArray(value) ? value : [value]
      return this
    }
    update(value: Row) {
      this.action = 'update'
      this.values = [value]
      return this
    }
    delete() {
      this.action = 'delete'
      return this
    }
    eq(column: string, value: any) {
      this.filters.push(row => row[column] === value)
      return this
    }
    in(column: string, values: any[]) {
      this.filters.push(row => values.includes(row[column]))
      return this
    }
    order(column: string, o: { ascending?: boolean } = {}) {
      this.sorts.push([column, o.ascending !== false])
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
      this.one = 'maybe'
      this.take = 1
      return this
    }
    single() {
      this.one = 'single'
      this.take = 1
      return this
    }
    then(resolve: any, reject: any) {
      return Promise.resolve(this.run()).then(resolve, reject)
    }
    run() {
      const rows = tables[this.table]
      if (this.table === 'tenant_tracker_changes' && options.failChanges && this.action === 'insert')
        return { data: null, error: new Error('disk full'), count: null }
      if (this.action === 'insert') {
        for (const value of this.values) {
          if (rows.some(row => KEYS[this.table].every(key => row[key] === value[key])))
            return { data: null, error: new Error('duplicate key'), count: null }
          if (
            this.table === 'tenant_tracker_rows' &&
            !tables.tenant_trackers.some(t => t.tenant_id === value.tenant_id && t.id === value.tracker_id)
          )
            return { data: null, error: new Error('foreign key'), count: null }
        }
        rows.push(...this.values.map(value => structuredClone(value)))
        return { data: this.returning ? this.values : null, error: null, count: null }
      }
      const matched = rows.filter(row => this.filters.every(filter => filter(row)))
      if (this.action === 'update') {
        for (const row of matched) Object.assign(row, structuredClone(this.values[0]))
        return { data: this.returning ? matched.map(row => structuredClone(row)) : null, error: null, count: null }
      }
      if (this.action === 'delete') {
        const gone = new Set(matched)
        tables[this.table] = rows.filter(row => !gone.has(row))
        if (this.table === 'tenant_trackers')
          for (const t of matched)
            tables.tenant_tracker_rows = tables.tenant_tracker_rows.filter(
              row => !(row.tenant_id === t.tenant_id && row.tracker_id === t.id),
            )
        if (this.table === 'tenant_trackers')
          for (const t of matched)
            tables.tenant_tracker_task_links = tables.tenant_tracker_task_links.filter(
              row => !(row.tenant_id === t.tenant_id && row.tracker_id === t.id),
            )
        return { data: this.returning ? matched : null, error: null, count: null }
      }
      let result = matched.map(row => structuredClone(row))
      // Rows written in the same millisecond tie on created_at: newest first keeps the later write first.
      for (const [column, asc] of [...this.sorts].reverse()) {
        if (!asc) result.reverse()
        result.sort((a, b) => (a[column] < b[column] ? -1 : a[column] > b[column] ? 1 : 0) * (asc ? 1 : -1))
      }
      const total = result.length
      result = result.slice(this.skip, this.take === undefined ? undefined : this.skip + this.take)
      if (this.head) return { data: null, error: null, count: total }
      return { data: this.one ? (result[0] ?? null) : result, error: null, count: this.counted ? total : null }
    }
  }
  return { from: (table: string) => new Query(table), tables }
}

function harness(options: { failChanges?: boolean; createTasks?: any; commit?: any } = {}) {
  const db = memoryDb(options)
  const state = {
    clients: [{ id: 'c1', name: 'Acme' }],
    projects: [
      { id: 'p1', name: 'Rollout' },
      { id: 'p2', name: 'Rollout phase 2' },
    ],
    items: [
      { id: 't1', title: 'Davao store' },
      { id: 't2', title: 'Train the staff', parentTaskId: 't1' },
    ],
  }
  const app = express()
  app.use(express.json({ limit: '10mb' }))
  app.use((req: any, _res, next) => {
    const modules = req.headers['x-modules'] === 'none' ? ['clients'] : ['clients', 'trackers']
    req.authUser = {
      id: String(req.headers['x-user'] || 'u1'),
      name: String(req.headers['x-name'] || 'Ana Reyes'),
      role: String(req.headers['x-role'] || 'Contributor'),
      organizationId: '11111111-1111-4111-8111-111111111111',
      modules,
      accountType: req.headers['x-platform'] ? 'platform' : 'tenant',
    }
    next()
  })
  const pass = (_req: any, _res: any, next: any) => next()
  const hooks = registerTrackerRoutes(app as any, {
    db,
    requireAuth: pass,
    requireTenant: pass,
    load: async () => ({ data: state }),
    key: Buffer.alloc(32, 7),
    reminderTimer: false,
    ...(options.createTasks ? { createTasks: options.createTasks } : {}),
    ...(options.commit ? { commit: options.commit } : {}),
  })
  return { app, db, state, hooks }
}
async function serve(
  h: ReturnType<typeof harness>,
  run: (
    ask: (
      method: string,
      path: string,
      body?: any,
      headers?: Record<string, string>,
    ) => Promise<{ status: number; body: any }>,
  ) => Promise<void>,
) {
  const server = h.app.listen(0)
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No port')
    await run(async (method, path, body, headers = {}) => {
      const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      return { status: response.status, body: await response.json() }
    })
  } finally {
    server.close()
  }
}
const sample = () => [
  { name: 'Site', type: 'text' },
  { name: 'Go-live', type: 'date' },
  { name: 'Status', type: 'select', options: [{ label: 'Not started' }, { label: 'Live' }] },
  { name: 'Admin login', type: 'secret' },
  { name: 'Task status', type: 'task_status' },
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
    assert.equal(tracker.rowCount, 0)
    assert.equal(tracker.revision, 1)
    assert.equal(tracker.clientId, 'c1')
    assert.equal(tracker.canManage, true)
    assert.deepEqual(
      tracker.columns.map((c: any) => c.type),
      ['text', 'date', 'select', 'secret', 'task_status'],
    )
    assert.ok(
      tracker.columns.every((c: any) => /^[a-z0-9_]{3,40}$/i.test(c.id)),
      'Every column gets a stable id',
    )
    assert.deepEqual(
      tracker.columns[2].options.map((o: any) => o.label),
      ['Not started', 'Live'],
    )
    assert.equal((await ask('POST', '/api/trackers', { name: 'Bad', clientId: 'nope' })).status, 400)
    assert.equal((await ask('POST', '/api/trackers', { name: '   ' })).status, 400)
    assert.equal(
      (
        await ask('POST', '/api/trackers', {
          name: 'X',
          columns: [
            { name: 'A', type: 'text' },
            { name: 'a', type: 'number' },
          ],
        })
      ).status,
      400,
      'Column names are unique',
    )
    assert.equal((await ask('GET', '/api/trackers')).body.trackers.length, 1)
    const renamed = await ask('PATCH', `/api/trackers/${tracker.id}`, { name: 'Rollout sites' })
    assert.equal(renamed.body.tracker.name, 'Rollout sites')
    // Several projects of the client (each with its own contract); the first is the default.
    const both = await ask('PATCH', `/api/trackers/${tracker.id}`, { projectIds: ['p2', 'p1', 'p2'] })
    assert.deepEqual(both.body.tracker.projectIds, ['p2', 'p1'])
    assert.equal(both.body.tracker.projectId, 'p2')
    assert.equal((await ask('PATCH', `/api/trackers/${tracker.id}`, { projectIds: ['nope'] })).status, 400)
    assert.equal((await ask('PATCH', `/api/trackers/${tracker.id}`, { projectIds: 'p1' })).status, 400)
    const one = await ask('PATCH', `/api/trackers/${tracker.id}`, { projectId: 'p1' })
    assert.deepEqual(one.body.tracker.projectIds, ['p1'])
    // Only the creator or an Administrator archives; anyone else is refused.
    assert.equal(
      (await ask('PATCH', `/api/trackers/${tracker.id}`, { archived: true }, { 'x-user': 'u2' })).status,
      403,
    )
    assert.equal(
      (await ask('DELETE', `/api/trackers/${tracker.id}`)).status,
      409,
      'A tracker must be archived before it can be deleted',
    )
    assert.equal((await ask('PATCH', `/api/trackers/${tracker.id}`, { archived: true })).body.tracker.archived, true)
    assert.equal(
      (await ask('POST', `/api/trackers/${tracker.id}/rows`, { rows: [{ cells: {} }] })).status,
      409,
      'An archived tracker is read-only',
    )
    assert.equal(
      (
        await ask('PUT', `/api/trackers/${tracker.id}/columns`, {
          columns: tracker.columns,
          revision: tracker.revision,
        })
      ).status,
      409,
      'Columns cannot change while archived',
    )
    assert.equal(
      (await ask('PUT', `/api/trackers/${tracker.id}/views`, { views: [], revision: tracker.revision })).status,
      409,
      'Views cannot change while archived',
    )
    assert.equal((await ask('DELETE', `/api/trackers/${tracker.id}`, undefined, { 'x-user': 'u2' })).status, 403)
    assert.equal(
      (await ask('DELETE', `/api/trackers/${tracker.id}`, undefined, { 'x-user': 'u2', 'x-role': 'Administrator' }))
        .status,
      200,
    )
    assert.equal((await ask('GET', `/api/trackers/${tracker.id}`)).status, 404)
    assert.equal(h.db.tables.tenant_trackers.length, 0)
  })
})

test('a private tracker does not exist for anyone but its creator', async () => {
  const h = harness()
  await serve(h, async ask => {
    const mine = await makeTracker(ask, { private: true })
    assert.equal((await ask('GET', '/api/trackers', undefined, { 'x-user': 'u2' })).body.trackers.length, 0)
    assert.equal(
      (await ask('GET', `/api/trackers/${mine.id}`, undefined, { 'x-user': 'u2', 'x-role': 'Administrator' })).status,
      404,
    )
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
    const next = [...tracker.columns].reverse().map((c: any) => (c.name === 'Site' ? { ...c, name: 'Store' } : c))
    next.push({ name: 'Owner', type: 'person' })
    const saved = await ask('PUT', `/api/trackers/${tracker.id}/columns`, { columns: next, revision: 1 })
    assert.equal(saved.status, 200, JSON.stringify(saved.body))
    const t2 = saved.body.tracker
    assert.equal(t2.revision, 2)
    assert.deepEqual(
      t2.columns.map((c: any) => c.name),
      ['Task status', 'Admin login', 'Status', 'Go-live', 'Store', 'Owner'],
    )
    assert.equal(idOf(t2, 'Store'), idOf(tracker, 'Site'), 'A renamed column keeps its id, so its values stay')
    // The wrong revision is a conflict and returns the current tracker.
    const stale = await ask('PUT', `/api/trackers/${tracker.id}/columns`, { columns: next, revision: 1 })
    assert.equal(stale.status, 409)
    assert.equal(stale.body.tracker.revision, 2)
    // A different type for an existing column is refused.
    const retyped = t2.columns.map((c: any) => (c.name === 'Go-live' ? { ...c, type: 'text' } : c))
    const refused = await ask('PUT', `/api/trackers/${tracker.id}/columns`, { columns: retyped, revision: 2 })
    assert.equal(refused.status, 400)
    assert.match(refused.body.error, /cannot change type/)
    assert.equal((await ask('PUT', `/api/trackers/${tracker.id}/columns`, { columns: [], revision: 2 })).status, 400)
    const tooMany = Array.from({ length: TRACKER_LIMITS.columns + 1 }, (_, i) => ({ name: `C${i}`, type: 'text' }))
    assert.equal(
      (await ask('PUT', `/api/trackers/${tracker.id}/columns`, { columns: tooMany, revision: 2 })).status,
      400,
    )
    const trimmed = await ask('PUT', `/api/trackers/${tracker.id}/columns`, {
      columns: t2.columns.filter((c: any) => c.name !== 'Owner'),
      revision: 2,
    })
    assert.equal(trimmed.body.tracker.columns.length, 5)
  })
})

test('rows are validated against the columns, stored, paged and counted', async () => {
  const h = harness()
  await serve(h, async ask => {
    const t = await makeTracker(ask)
    const site = idOf(t, 'Site'),
      live = idOf(t, 'Go-live'),
      status = idOf(t, 'Status'),
      login = idOf(t, 'Admin login'),
      taskStatus = idOf(t, 'Task status')
    const live1 = t.columns[2].options[1].id
    const created = await ask('POST', `/api/trackers/${t.id}/rows`, {
      rows: [
        { cells: { [site]: '  Store 001 · Makati ', [live]: '2026-10-12', [status]: live1 } },
        { cells: { [site]: 'Store 002 · Cebu' }, taskId: 't1' },
      ],
    })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    assert.deepEqual(
      created.body.rows.map((r: any) => r.position),
      [1, 2],
    )
    assert.deepEqual(created.body.rows[0].cells, {
      [site]: 'Store 001 · Makati',
      [live]: '2026-10-12',
      [status]: live1,
    })
    assert.equal(created.body.rows[1].taskId, 't1')
    assert.equal(created.body.rows[0].version, 1)
    const bad = async (cells: any, pattern: RegExp, extra: any = {}) => {
      const r = await ask('POST', `/api/trackers/${t.id}/rows`, { rows: [{ cells, ...extra }] })
      assert.equal(r.status, 400, JSON.stringify(r.body))
      assert.match(r.body.error, pattern)
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
    assert.equal(page.body.total, 2)
    assert.equal(page.body.rows.length, 1)
    assert.equal(page.body.rows[0].cells[site], 'Store 002 · Cebu')
    assert.equal((await ask('GET', '/api/trackers')).body.trackers[0].rowCount, 2)
    // Several rows at once: the message says which row is wrong, and nothing is saved.
    const batch = await ask('POST', `/api/trackers/${t.id}/rows`, {
      rows: [{ cells: { [site]: 'ok' } }, { cells: { [live]: 'bad' } }],
    })
    assert.equal(batch.status, 400)
    assert.match(batch.body.error, /^Row 2: /)
    assert.equal((await ask('GET', `/api/trackers/${t.id}/rows`)).body.total, 2)
    assert.equal(
      (
        await ask('POST', `/api/trackers/${t.id}/rows`, {
          rows: Array.from({ length: TRACKER_LIMITS.importBatch + 1 }, () => ({ cells: {} })),
        })
      ).status,
      400,
    )
  })
})

test('a tracker stops at its row limit', async () => {
  const h = harness()
  await serve(h, async ask => {
    const t = await makeTracker(ask)
    const site = idOf(t, 'Site')
    for (let i = 0; i < TRACKER_LIMITS.rows / TRACKER_LIMITS.importBatch; i++) {
      const r = await ask('POST', `/api/trackers/${t.id}/rows`, {
        rows: Array.from({ length: TRACKER_LIMITS.importBatch }, (_, n) => ({
          cells: { [site]: `Row ${i * 1000 + n}` },
        })),
      })
      assert.equal(r.status, 201)
    }
    const over = await ask('POST', `/api/trackers/${t.id}/rows`, { rows: [{ cells: { [site]: 'one too many' } }] })
    assert.equal(over.status, 409)
    assert.match(over.body.error, /at most 5,000 rows/)
    assert.equal(
      (await ask('GET', `/api/trackers/${t.id}/rows?limit=5000`)).body.rows.length,
      1000,
      'A page is at most 1,000 rows',
    )
  })
})

test('a cell edit checks the row version, keeps a history and ignores no-op saves', async () => {
  const h = harness()
  await serve(h, async ask => {
    const t = await makeTracker(ask)
    const site = idOf(t, 'Site'),
      status = idOf(t, 'Status'),
      live = t.columns[2].options[1].id
    const row = (await ask('POST', `/api/trackers/${t.id}/rows`, { rows: [{ cells: { [site]: 'Store 003' } }] })).body
      .rows[0]
    const url = `/api/trackers/${t.id}/rows/${row.id}`
    const same = await ask('PATCH', url, { version: 1, cells: { [site]: 'Store 003' } })
    assert.equal(same.body.row.version, 1, 'Saving the same value is not a change')
    const edited = await ask('PATCH', url, { version: 1, cells: { [status]: live, [site]: 'Store 003 · Davao' } })
    assert.equal(edited.status, 200, JSON.stringify(edited.body))
    assert.equal(edited.body.row.version, 2)
    assert.deepEqual(edited.body.row.cells, { [site]: 'Store 003 · Davao', [status]: live })
    // Someone else holding version 1 is told, and gets the current row back.
    const conflict = await ask(
      'PATCH',
      url,
      { version: 1, cells: { [site]: 'Mine' } },
      { 'x-user': 'u2', 'x-name': 'Ben Lim' },
    )
    assert.equal(conflict.status, 409)
    assert.equal(conflict.body.row.cells[site], 'Store 003 · Davao')
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
    assert.deepEqual(history.map((c: any) => c.kind).reverse(), [
      'row_created',
      'cells',
      'cells',
      'task_linked',
      'task_unlinked',
    ])
    const firstEdit = [...history]
      .reverse()
      .find((c: any) => c.kind === 'cells' && c.detail.cells.some((x: any) => x.name === 'Status'))
    assert.deepEqual(
      firstEdit.detail.cells.find((x: any) => x.name === 'Status'),
      { columnId: status, name: 'Status', from: '', to: 'Live' },
    )
    assert.equal(history[0].actorName, 'Ana Reyes')
    assert.equal((await ask('PATCH', `/api/trackers/${t.id}/rows/not-a-uuid`, { version: 1, cells: {} })).status, 404)
  })
})

test('rows can be deleted in bulk', async () => {
  const h = harness()
  await serve(h, async ask => {
    const t = await makeTracker(ask)
    const site = idOf(t, 'Site')
    const rows = (
      await ask('POST', `/api/trackers/${t.id}/rows`, { rows: ['a', 'b', 'c'].map(v => ({ cells: { [site]: v } })) })
    ).body.rows
    const removed = await ask('POST', `/api/trackers/${t.id}/rows/delete`, { ids: [rows[0].id, rows[2].id] })
    assert.equal(removed.body.deleted, 2)
    const left = (await ask('GET', `/api/trackers/${t.id}/rows`)).body
    assert.deepEqual(
      left.rows.map((r: any) => r.cells[site]),
      ['b'],
    )
    assert.equal(left.total, 1)
    assert.equal((await ask('POST', `/api/trackers/${t.id}/rows/delete`, { ids: ['nope'] })).status, 400)
    assert.equal(
      (await ask('POST', `/api/trackers/${t.id}/rows/delete`, { ids: [rows[1].id] }, { 'x-role': 'Viewer' })).status,
      403,
    )
  })
})

test('Secret cells are encrypted, never returned, and only shown through a logged reveal', async () => {
  const h = harness()
  await serve(h, async ask => {
    const t = await makeTracker(ask)
    const site = idOf(t, 'Site'),
      login = idOf(t, 'Admin login')
    const created = await ask('POST', `/api/trackers/${t.id}/rows`, {
      rows: [{ cells: { [site]: 'Store 001' }, secrets: { [login]: 'correct horse battery' } }],
    })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    const row = created.body.rows[0]
    assert.deepEqual(row.secretSet, { [login]: true })
    const everything = JSON.stringify([
      created.body,
      (await ask('GET', `/api/trackers/${t.id}/rows`)).body,
      (await ask('GET', `/api/trackers/${t.id}`)).body,
    ])
    assert.ok(!everything.includes('correct horse'), 'The value is never in a response')
    const stored = JSON.stringify(h.db.tables.tenant_tracker_rows)
    assert.ok(!stored.includes('correct horse'), 'The value is not stored in plain text')
    assert.match(h.db.tables.tenant_tracker_rows[0].secrets[login], /^v1\./)
    // A reveal returns the value and leaves a record of who looked.
    const url = `/api/trackers/${t.id}/rows/${row.id}`
    const revealed = await ask('POST', `${url}/reveal`, { columnId: login }, { 'x-name': 'Ben Lim', 'x-user': 'u2' })
    assert.equal(revealed.body.value, 'correct horse battery')
    const history = (await ask('GET', `${url}/history`)).body.changes
    assert.deepEqual(
      history.filter((c: any) => c.kind === 'reveal').map((c: any) => [c.actorName, c.detail.name]),
      [['Ben Lim', 'Admin login']],
    )
    // Changing the value is logged without the value.
    const changed = await ask('PATCH', url, { version: 1, secrets: { [login]: 'another one' } })
    assert.equal(changed.body.row.version, 2)
    assert.ok(!JSON.stringify((await ask('GET', `${url}/history`)).body).includes('another one'))
    assert.equal((await ask('POST', `${url}/reveal`, { columnId: login })).body.value, 'another one')
    assert.equal(
      (await ask('POST', `${url}/reveal`, { columnId: site })).status,
      404,
      'Only Secret columns can be revealed',
    )
    assert.equal((await ask('POST', `${url}/reveal`, { columnId: login }, { 'x-role': 'Viewer' })).status, 403)
    // Clearing the value removes it.
    const cleared = await ask('PATCH', url, { version: 2, secrets: { [login]: null } })
    assert.deepEqual(cleared.body.row.secretSet, {})
    assert.equal((await ask('POST', `${url}/reveal`, { columnId: login })).status, 404)
    assert.equal(
      (await ask('POST', `/api/trackers/${t.id}/rows`, { rows: [{ secrets: { [site]: 'x' } }] })).status,
      400,
      'Plain columns do not take secrets',
    )
    assert.equal(
      (
        await ask('POST', `/api/trackers/${t.id}/rows`, {
          rows: [{ secrets: { [login]: 'x'.repeat(TRACKER_LIMITS.secret + 1) } }],
        })
      ).status,
      400,
    )
  })
})

test('a column limited to administrators cannot be revealed by anyone else', async () => {
  const h = harness()
  await serve(h, async ask => {
    const t = await makeTracker(ask, {
      columns: [
        { name: 'Site', type: 'text' },
        { name: 'Root login', type: 'secret', revealBy: 'admins' },
      ],
    })
    const login = idOf(t, 'Root login')
    const row = (await ask('POST', `/api/trackers/${t.id}/rows`, { rows: [{ secrets: { [login]: 'topsecret' } }] }))
      .body.rows[0]
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
    const row = (await ask('POST', `/api/trackers/${t.id}/rows`, { rows: [{ secrets: { [login]: 'hunter2' } }] })).body
      .rows[0]
    const result = await ask('POST', `/api/trackers/${t.id}/rows/${row.id}/reveal`, { columnId: login })
    assert.equal(result.status, 503)
    assert.ok(!JSON.stringify(result.body).includes('hunter2'))
  })
})

test('removing a Secret column removes its encrypted values', async () => {
  const h = harness()
  await serve(h, async ask => {
    const t = await makeTracker(ask)
    const login = idOf(t, 'Admin login')
    await ask('POST', `/api/trackers/${t.id}/rows`, {
      rows: [{ secrets: { [login]: 'one' } }, { secrets: { [login]: 'two' } }],
    })
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
    const status = idOf(t, 'Status'),
      site = idOf(t, 'Site')
    const views = [
      {
        name: 'Delayed',
        filters: [
          { columnId: status, op: 'is', value: 'x' },
          { columnId: 'gone', op: 'is', value: 'y' },
        ],
        sort: { columnId: site, dir: 'desc' },
        groupBy: 'gone',
        hidden: [site, 'gone'],
      },
    ]
    const saved = await ask('PUT', `/api/trackers/${t.id}/views`, { views, revision: 1 })
    assert.equal(saved.status, 200, JSON.stringify(saved.body))
    const view = saved.body.tracker.views[0]
    assert.equal(view.filters.length, 1)
    assert.deepEqual(view.sort, { columnId: site, dir: 'desc' })
    assert.equal(view.groupBy, '')
    assert.deepEqual(view.hidden, [site])
    assert.equal(
      (await ask('PUT', `/api/trackers/${t.id}/views`, { views: [{ name: 'A' }, { name: 'a' }], revision: 2 })).status,
      400,
    )
    // Deleting a column also removes it from saved views.
    const trimmed = await ask('PUT', `/api/trackers/${t.id}/columns`, {
      columns: t.columns.filter((c: any) => c.id !== status),
      revision: 2,
    })
    assert.equal(trimmed.body.tracker.views[0].filters.length, 0)
  })
})

test('a row or one of its cells can be linked to many tasks and subtasks, and the links follow the row', async () => {
  const h = harness()
  await serve(h, async ask => {
    const tracker = await makeTracker(ask)
    const made = await ask('POST', `/api/trackers/${tracker.id}/rows`, {
      rows: [{ cells: { [idOf(tracker, 'Site')]: 'Davao' } }, { cells: { [idOf(tracker, 'Site')]: 'Cebu' } }],
    })
    const [davao, cebu] = made.body.rows
    const link = (body: any, headers?: Record<string, string>) =>
      ask('POST', `/api/trackers/${tracker.id}/links`, body, headers)
    const row = await link({ rowId: davao.id, taskId: 't1' })
    assert.equal(row.status, 201, JSON.stringify(row.body))
    assert.equal(row.body.link.rowTitle, 'Davao')
    assert.equal(row.body.link.columnId, '')
    const cell = await link({ rowId: davao.id, taskId: 't2', columnId: idOf(tracker, 'Go-live') })
    assert.equal(cell.status, 201)
    assert.equal(cell.body.link.columnName, 'Go-live')
    assert.equal(cell.body.links.length, 2, 'The row now has two links')
    assert.equal(
      (await link({ rowId: davao.id, taskId: 't2', columnId: idOf(tracker, 'Go-live') })).status,
      409,
      'The same task is not linked twice to one cell',
    )
    assert.equal(
      (await link({ rowId: davao.id, taskId: 't2' })).status,
      201,
      'The same task can also be linked to the whole row',
    )
    assert.equal((await link({ rowId: davao.id, taskId: 'nope' })).status, 400)
    assert.equal((await link({ rowId: davao.id, taskId: 't1', columnId: 'missing' })).status, 400)
    assert.equal((await link({ rowId: cebu.id, taskId: 't2' }, { 'x-role': 'Viewer' })).status, 403)
    await link({ rowId: cebu.id, taskId: 't2' })
    const all = await ask('GET', '/api/trackers/task-links')
    assert.equal(all.status, 200)
    assert.equal(all.body.links.filter((l: any) => l.taskId === 't2').length, 3)
    assert.deepEqual(
      all.body.links.filter((l: any) => l.rowId === cebu.id).map((l: any) => l.trackerName),
      ['Site rollout'],
    )
    const history = await ask('GET', `/api/trackers/${tracker.id}/rows/${davao.id}/history`)
    assert.ok(history.body.changes.some((c: any) => c.kind === 'subtask_linked'))
    const gone = await ask('DELETE', `/api/trackers/${tracker.id}/links/${row.body.link.id}`)
    assert.equal(gone.body.removed, 1)
    assert.equal((await ask('GET', `/api/trackers/${tracker.id}/links`)).body.links.length, 3)
    await ask('POST', `/api/trackers/${tracker.id}/rows/delete`, { ids: [davao.id] })
    assert.deepEqual(
      (await ask('GET', '/api/trackers/task-links')).body.links.map((l: any) => l.rowId),
      [cebu.id],
      'Deleting a row removes its links',
    )
  })
})

test('links to a private tracker are visible only to its creator', async () => {
  const h = harness()
  await serve(h, async ask => {
    const tracker = await makeTracker(ask, { private: true }, { 'x-user': 'u1' })
    const rows = await ask('POST', `/api/trackers/${tracker.id}/rows`, { rows: [{ cells: {} }] }, { 'x-user': 'u1' })
    await ask(
      'POST',
      `/api/trackers/${tracker.id}/links`,
      { rowId: rows.body.rows[0].id, taskId: 't1' },
      { 'x-user': 'u1' },
    )
    assert.equal((await ask('GET', '/api/trackers/task-links', undefined, { 'x-user': 'u1' })).body.links.length, 1)
    assert.equal((await ask('GET', '/api/trackers/task-links', undefined, { 'x-user': 'u2' })).body.links.length, 0)
    assert.equal(
      (
        await ask(
          'POST',
          `/api/trackers/${tracker.id}/links`,
          { rowId: rows.body.rows[0].id, taskId: 't2' },
          { 'x-user': 'u2' },
        )
      ).status,
      404,
    )
  })
})

test('a tracker can follow several clients, and older single-client calls still work', async () => {
  const h = harness()
  h.state.clients.push({ id: 'c2', name: 'Northwind' })
  await serve(h, async ask => {
    const tracker = await makeTracker(ask, { clientIds: ['c1', 'c2', 'c1'] })
    assert.deepEqual(tracker.clientIds, ['c1', 'c2'])
    assert.equal(tracker.clientId, 'c1')
    assert.equal((await ask('POST', '/api/trackers', { name: 'Bad', clientIds: ['c1', 'nope'] })).status, 400)
    assert.equal((await ask('POST', '/api/trackers', { name: 'Bad', clientIds: 'c1' })).status, 400)
    const one = await ask('PATCH', `/api/trackers/${tracker.id}`, { clientIds: ['c2'] })
    assert.deepEqual(one.body.tracker.clientIds, ['c2'])
    const legacy = await ask('PATCH', `/api/trackers/${tracker.id}`, { clientId: 'c1' })
    assert.deepEqual(legacy.body.tracker.clientIds, ['c1'])
    const none = await ask('PATCH', `/api/trackers/${tracker.id}`, { clientIds: [] })
    assert.deepEqual(none.body.tracker.clientIds, [])
    assert.equal(none.body.tracker.clientId, '')
  })
})

test('many rows can be linked to their tasks at once', async () => {
  const h = harness()
  await serve(h, async ask => {
    const tracker = await makeTracker(ask)
    const made = await ask('POST', `/api/trackers/${tracker.id}/rows`, { rows: [{ cells: {} }, { cells: {} }] })
    const [a, b] = made.body.rows
    const linked = await ask('POST', `/api/trackers/${tracker.id}/rows/tasks`, {
      links: [
        { rowId: a.id, taskId: 't1' },
        { rowId: b.id, taskId: 't2' },
      ],
    })
    assert.equal(linked.status, 200, JSON.stringify(linked.body))
    assert.deepEqual(linked.body.rows.map((row: any) => row.taskId).sort(), ['t1', 't2'])
    assert.ok(
      linked.body.rows.every((row: any) => row.version === 2),
      'each linked row gets a new version',
    )
    assert.equal(
      (await ask('POST', `/api/trackers/${tracker.id}/rows/tasks`, { links: [{ rowId: a.id, taskId: 'nope' }] }))
        .status,
      400,
    )
    assert.equal((await ask('POST', `/api/trackers/${tracker.id}/rows/tasks`, { links: [] })).status, 400)
    assert.equal(
      (
        await ask(
          'POST',
          `/api/trackers/${tracker.id}/rows/tasks`,
          { links: [{ rowId: a.id, taskId: 't1' }] },
          { 'x-role': 'Viewer' },
        )
      ).status,
      403,
    )
    const history = await ask('GET', `/api/trackers/${tracker.id}/rows/${a.id}/history`)
    assert.ok(history.body.changes.some((c: any) => c.kind === 'task_linked'))
  })
})

test('Calculated columns are saved by id and refuse values typed into them', async () => {
  const h = harness()
  await serve(h, async ask => {
    const created = await ask('POST', '/api/trackers', {
      name: 'Costs',
      columns: [
        { name: 'Item', type: 'text' },
        { name: 'Qty', type: 'number' },
        { name: 'Price', type: 'number' },
        { name: 'Amount', type: 'formula', formula: '[Qty] * [Price]', total: 'sum' },
      ],
    })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    const tracker = created.body.tracker
    assert.equal(tracker.columns[3].formula, `{${tracker.columns[1].id}} * {${tracker.columns[2].id}}`)
    assert.equal(
      (await ask('POST', `/api/trackers/${tracker.id}/rows`, { rows: [{ cells: { [tracker.columns[3].id]: 5 } }] }))
        .status,
      400,
    )
    assert.equal(
      (
        await ask('POST', '/api/trackers', {
          name: 'Bad',
          columns: [
            { name: 'A', type: 'text' },
            { name: 'B', type: 'formula', formula: '[A] * 2' },
          ],
        })
      ).status,
      400,
    )
  })
})

test('the AI assistant reads only trackers the person can open, never Secret values, and rows only of those picked', async () => {
  const h = harness()
  await serve(h, async ask => {
    const shared = await makeTracker(ask)
    const site = idOf(shared, 'Site')
    const login = idOf(shared, 'Admin login')
    const status = idOf(shared, 'Status')
    const live = shared.columns.find((c: any) => c.id === status).options.find((o: any) => o.label === 'Live').id
    const added = await ask('POST', `/api/trackers/${shared.id}/rows`, {
      rows: [
        { cells: { [site]: 'Store 001', [status]: live }, secrets: { [login]: 'correct horse battery' } },
        { cells: { [site]: 'Store 002' } },
      ],
    })
    assert.equal(added.status, 201, JSON.stringify(added.body))
    const mine = await makeTracker(ask, { name: 'My notes', private: true })
    const theirs = await makeTracker(ask, { name: 'Ben private', private: true }, { 'x-user': 'u2' })
    const old = await makeTracker(ask, { name: 'Old rollout' })
    assert.equal((await ask('PATCH', `/api/trackers/${old.id}`, { archived: true })).status, 200)

    const offered: string[][] = []
    const tenant = '11111111-1111-4111-8111-111111111111'
    const read = await h.hooks.trackersFor(tenant, { id: 'u1', name: 'Ana Reyes', role: 'Contributor' }, all => {
      offered.push(all.map(tracker => tracker.name))
      return [shared.id, theirs.id]
    })
    assert.deepEqual(offered[0].sort(), ['My notes', 'Site rollout'], 'not archived, not someone else’s private one')
    assert.deepEqual(read.trackers.map(tracker => tracker.id).sort(), [mine.id, shared.id].sort())
    assert.equal(read.loaded.length, 1, 'only picked trackers the person can open are read')
    const [loaded] = read.loaded
    assert.equal(loaded.tracker.id, shared.id)
    assert.equal(loaded.tracker.rowCount, 2)
    assert.deepEqual(
      loaded.rows.map(row => row.cells[site]),
      ['Store 001', 'Store 002'],
    )
    assert.equal(loaded.rows[0].cells[status], live)
    assert.ok(!JSON.stringify(read).includes('correct horse battery'), 'Secret values are never read into rows')
    assert.equal(loaded.rows[0].cells[login], undefined)

    const ben = await h.hooks.trackersFor(tenant, { id: 'u2', name: 'Ben Cruz', role: 'Administrator' }, () => [
      mine.id,
    ])
    assert.deepEqual(
      ben.trackers.map(tracker => tracker.name).sort(),
      ['Ben private', 'Site rollout'],
      'a private tracker stays private, even from an Administrator',
    )
    assert.equal(ben.loaded.length, 0)
  })
})

test('only the tracker’s owner or an Administrator changes who can reveal a Secret column, or deletes one', async () => {
  const h = harness()
  await serve(h, async ask => {
    const owner = { 'x-user': 'owner', 'x-role': 'Contributor' }
    const mallory = { 'x-user': 'mallory', 'x-role': 'Contributor' }
    const admin = { 'x-user': 'boss', 'x-role': 'Administrator' }
    const made = await ask(
      'POST',
      '/api/trackers',
      {
        name: 'Servers',
        columns: [
          { name: 'Host', type: 'text' },
          { name: 'Root password', type: 'secret', revealBy: 'admins' },
        ],
      },
      owner,
    )
    const tracker = made.body.tracker
    const [host, secret] = tracker.columns.map((c: any) => c.id)
    const row = (
      await ask(
        'POST',
        `/api/trackers/${tracker.id}/rows`,
        { rows: [{ cells: { [host]: 'db1' }, secrets: { [secret]: 'hunter2-prod' } }] },
        owner,
      )
    ).body.rows[0]
    const save = async (headers: Record<string, string>, change: (columns: any[]) => any[]) => {
      const current = (await ask('GET', `/api/trackers/${tracker.id}`, undefined, headers)).body.tracker
      return ask(
        'PUT',
        `/api/trackers/${tracker.id}/columns`,
        { revision: current.revision, columns: change(current.columns) },
        headers,
      )
    }
    const loosen = (columns: any[]) => columns.map(c => (c.id === secret ? { ...c, revealBy: 'editors' } : c))

    // Someone else who edits the tracker cannot loosen the rule, so cannot then reveal the value.
    const refused = await save(mallory, loosen)
    assert.equal(refused.status, 403, JSON.stringify(refused.body))
    assert.match(refused.body.error, /owner or an Administrator/)
    assert.equal(
      (await ask('POST', `/api/trackers/${tracker.id}/rows/${row.id}/reveal`, { columnId: secret }, mallory)).status,
      403,
    )
    // Nor delete the column, which would erase every stored value.
    assert.equal((await save(mallory, columns => columns.filter(c => c.id !== secret))).status, 403)
    assert.ok(h.db.tables.tenant_tracker_rows[0].secrets?.[secret], 'the stored value is still there')
    // Renaming it, or adding another Secret column, is still fine for anyone who edits the tracker.
    const renamed = await save(mallory, columns => [
      ...columns.map(c => (c.id === secret ? { ...c, name: 'Root pw' } : c)),
      { name: 'API key', type: 'secret', revealBy: 'admins' },
    ])
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body))

    // The owner may change the rule; the change is recorded.
    assert.equal((await save(owner, loosen)).status, 200)
    const logged = h.db.tables.tenant_tracker_changes.find((c: any) => c.detail?.revealRules)
    assert.deepEqual(logged?.detail.revealRules, [{ name: 'Root pw', from: 'admins', to: 'editors' }])
    // An Administrator may delete it.
    assert.equal((await save(admin, columns => columns.filter(c => c.id !== secret))).status, 200)
  })
})

test('a tracker’s users: creator, people on its project, and people its creator adds', async () => {
  const h = harness()
  Object.assign(h.state, {
    accounts: [
      { id: 'u1', name: 'Ana Reyes', status: 'Active' },
      { id: 'u2', name: 'Ben Cruz', status: 'Active' },
      { id: 'u3', name: 'Carla Diaz', status: 'Active' },
      { id: 'u4', name: 'Former', status: 'Disabled' },
    ],
    access: { assignments: [{ userId: 'u2', role: 'BA', projectId: 'p1', source: 'manual' }] },
  })
  await serve(h, async ask => {
    const tracker = await makeTracker(ask, { clientId: 'c1', projectId: 'p1' })
    const listed = (await ask('GET', '/api/trackers')).body.trackers[0]
    assert.deepEqual(listed.users, ['u1', 'u2'], 'the creator and the person on its project')
    assert.deepEqual(listed.members, [])

    const notOwner = await ask('PATCH', `/api/trackers/${tracker.id}`, { members: ['u3'] }, { 'x-user': 'u2' })
    assert.equal(notOwner.status, 403)
    assert.equal((await ask('PATCH', `/api/trackers/${tracker.id}`, { members: ['u4'] })).status, 400)
    const added = await ask('PATCH', `/api/trackers/${tracker.id}`, { members: ['u3', 'u1'] })
    assert.equal(added.status, 200, JSON.stringify(added.body))
    assert.deepEqual(added.body.tracker.members, ['u3'], 'the creator is never stored as added')
    assert.deepEqual(added.body.tracker.users, ['u1', 'u2', 'u3'])
    assert.deepEqual((await ask('GET', `/api/trackers/${tracker.id}`)).body.tracker.users, ['u1', 'u2', 'u3'])
    const byAdmin = await ask(
      'PATCH',
      `/api/trackers/${tracker.id}`,
      { members: [] },
      { 'x-user': 'u2', 'x-role': 'Administrator' },
    )
    assert.deepEqual(byAdmin.body.tracker.users, ['u1', 'u2'])
  })
})

test('new Seeds projects of a tracker’s client become rows with their task, on trackers switched on for it', async () => {
  const made: any[] = []
  const h = harness({
    createTasks: async (_tenant: string, drafts: any[], actor: any) => {
      assert.equal(actor.id, 'system:seeds')
      made.push(...drafts)
      return drafts.map((_draft, at) => ({ id: `new-${made.length - drafts.length + at}` }))
    },
  })
  const tenant = '11111111-1111-4111-8111-111111111111'
  await serve(h, async ask => {
    const columns = [...sample(), { name: 'Hardware', type: 'checkbox' }]
    const on = (
      await ask('POST', '/api/trackers', {
        name: 'PCI rollout',
        columns,
        clientId: 'c1',
        projectId: 'p1',
        template: 'site-rollout',
      })
    ).body.tracker
    const off = await makeTracker(ask, { clientId: 'c1', projectId: 'p1', template: 'site-rollout' })
    const switched = await ask('PATCH', `/api/trackers/${on.id}`, { seedsRows: true })
    assert.equal(switched.status, 200, JSON.stringify(switched.body))
    assert.equal(switched.body.tracker.seedsRows, true)

    const before = { projects: [{ id: 'p1', name: 'Rollout' }] }
    const after = {
      projects: [
        ...before.projects,
        {
          id: 'p9',
          name: 'PCI - SM Tarlac',
          seedsId: '77',
          clientId: 'c1',
          status: 'Active',
          contractNumber: 'SLSS-9',
        },
        { id: 'p8', name: 'Other client store', seedsId: '78', clientId: 'c2', status: 'Active' },
        { id: 'p7', name: 'Made here', clientId: 'c1', status: 'Active' },
      ],
      accounts: [{ id: 'u1', name: 'Ana Reyes', status: 'Active' }],
    }
    await h.hooks.onWorkspaceSaved(tenant, before, after, null)

    const rows = (await ask('GET', `/api/trackers/${on.id}/rows`)).body.rows
    assert.equal(rows.length, 1)
    assert.equal(rows[0].cells[idOf(on, 'Site')], 'PCI - SM Tarlac')
    assert.equal(rows[0].taskId, 'new-0')
    assert.deepEqual(
      made.map(draft => [draft.title, draft.projectId, draft.clientId, draft.parentIndex, draft.assignedToUserId]),
      [
        ['PCI - SM Tarlac', 'p9', 'c1', undefined, 'u1'],
        ['Hardware', 'p9', 'c1', 0, 'u1'],
      ],
    )
    const links = h.db.tables.tenant_tracker_task_links.filter((link: any) => link.tracker_id === on.id)
    assert.deepEqual(
      links.map((link: any) => [link.column_id, link.task_id]),
      [[idOf(on, 'Hardware'), 'new-1']],
    )
    const tracker = (await ask('GET', `/api/trackers/${on.id}`)).body.tracker
    assert.deepEqual(tracker.projectIds, ['p1', 'p9'], 'The project joins the tracker; the default stays first')
    assert.equal((await ask('GET', `/api/trackers/${off.id}/rows`)).body.rows.length, 0, 'Not switched on')

    // The same save seen again adds nothing twice.
    await h.hooks.onWorkspaceSaved(tenant, before, after, null)
    assert.equal((await ask('GET', `/api/trackers/${on.id}/rows`)).body.rows.length, 1)
  })
})

test('row comments: posted, listed apart from history, edited and deleted by their author, mentions notify', async () => {
  const saved: any[] = []
  const h = harness({
    commit: async (_tenant: string, next: any) => {
      saved.push(next)
    },
  })
  ;(h.state as any).accounts = [
    { id: 'u1', name: 'Ana Reyes', status: 'Active', role: 'Contributor' },
    { id: 'u2', name: 'Jun Perez', status: 'Active', role: 'Contributor' },
    { id: 'u3', name: 'Gone Person', status: 'Inactive', role: 'Contributor' },
  ]
  await serve(h, async ask => {
    const t = await makeTracker(ask)
    const row = (
      await ask('POST', `/api/trackers/${t.id}/rows`, { rows: [{ cells: { [idOf(t, 'Site')]: 'Makati T1' } }] })
    ).body.rows[0]
    const url = `/api/trackers/${t.id}/rows/${row.id}/comments`
    const empty = await ask('GET', url)
    assert.deepEqual(empty.body.comments, [])
    assert.deepEqual(empty.body.mentionable, [{ id: 'u2', name: 'Jun Perez' }], 'Active people, without yourself')
    assert.equal((await ask('POST', url, { text: '   ' })).status, 400)

    const posted = await ask('POST', url, {
      text: 'Permit is out. @Jun Perez please book the crew',
      mentions: ['u2', 'u3'],
    })
    assert.equal(posted.status, 201, JSON.stringify(posted.body))
    assert.deepEqual(posted.body.comment.mentions, ['u2'])
    assert.equal(saved.length, 1, 'The mention was saved as a notification')
    const note = saved[0].notifications[0]
    assert.equal(note.recipientUserId, 'u2')
    assert.equal(note.trackerId, t.id)
    assert.equal(note.trackerRowId, row.id)
    assert.match(note.message, /^Makati T1: Permit is out/)

    assert.equal((await ask('GET', url)).body.comments.length, 1)
    assert.deepEqual((await ask('GET', `/api/trackers/${t.id}/comment-counts`)).body.counts, { [row.id]: 1 })
    const history = (await ask('GET', `/api/trackers/${t.id}/rows/${row.id}/history`)).body.changes
    assert.ok(!history.some((change: any) => change.kind === 'comment'), 'Comments are not in the history list')

    // Only the author edits; the author or an Administrator deletes; a viewer cannot comment.
    const one = `/api/trackers/${t.id}/comments/${posted.body.comment.id}`
    assert.equal((await ask('PATCH', one, { text: 'mine now' }, { 'x-user': 'u2' })).status, 403)
    const edited = await ask('PATCH', one, { text: 'Permit is out.' })
    assert.equal(edited.body.comment.text, 'Permit is out.')
    assert.ok(edited.body.comment.editedAt)
    assert.deepEqual(edited.body.comment.mentions, [])
    assert.equal((await ask('POST', url, { text: 'hi' }, { 'x-role': 'Viewer' })).status, 403)
    assert.equal((await ask('DELETE', one, undefined, { 'x-user': 'u2' })).status, 403)
    assert.equal((await ask('DELETE', one, undefined, { 'x-user': 'u2', 'x-role': 'Administrator' })).status, 200)
    assert.deepEqual((await ask('GET', url)).body.comments, [])
  })
})

test('date reminders: the morning check adds each due reminder once, to people who can see the tracker; snooze holds it', async () => {
  const saved: any[] = []
  const h = harness({
    commit: async (_tenant: string, next: any) => {
      saved.push(next)
      Object.assign(h.state, next)
    },
  })
  ;(h.state as any).accounts = [
    { id: 'u1', name: 'Ana Reyes', status: 'Active', role: 'Contributor' },
    { id: 'u2', name: 'Jun Perez', status: 'Active', role: 'Contributor' },
    { id: 'u3', name: 'Gone Person', status: 'Inactive', role: 'Contributor' },
  ]
  await serve(h, async ask => {
    const t = await makeTracker(ask)
    const goId = idOf(t, 'Go-live')
    const added = await ask('POST', `/api/trackers/${t.id}/rows`, {
      rows: [
        { cells: { [idOf(t, 'Site')]: 'Festival Mall', [goId]: '2026-11-19' } },
        { cells: { [idOf(t, 'Site')]: 'Later', [goId]: '2026-12-19' } },
      ],
    })
    const festival = added.body.rows[0]
    const timeline = await ask('PUT', `/api/trackers/${t.id}/timeline`, {
      timeline: {
        reminders: [
          { id: 'm_soon', dateId: goId, when: 'before', days: 3, to: { people: ['u2', 'u3'], creator: true } },
        ],
      },
    })
    assert.equal(timeline.status, 200, JSON.stringify(timeline.body))
    const tenant = '11111111-1111-4111-8111-111111111111'
    assert.equal(
      await h.hooks.reminders.runTenant(tenant, '2026-11-16'),
      2,
      'The creator and Jun; not the inactive person',
    )
    const notes = saved[0].notifications
    assert.deepEqual(notes.map((note: any) => note.recipientUserId).sort(), ['u1', 'u2'])
    assert.equal(notes[0].title, 'Festival Mall: Go-live in 3 days')
    assert.equal(notes[0].trackerRowId, festival.id)
    assert.equal(notes[0].trackerReminderId, 'm_soon')
    assert.equal(await h.hooks.reminders.runTenant(tenant, '2026-11-16'), 0, 'Never twice the same day')
    assert.equal(await h.hooks.reminders.runTenant(tenant, '2026-11-17'), 0, 'Not due the next day')

    // Snoozed by Jun: the next due day skips him only.
    const snooze = await ask(
      'POST',
      `/api/trackers/${t.id}/reminders/snooze`,
      { rowId: festival.id, reminderId: 'm_soon', days: 30 },
      { 'x-user': 'u2' },
    )
    assert.equal(snooze.status, 200, JSON.stringify(snooze.body))
    await ask('PATCH', `/api/trackers/${t.id}/rows/${festival.id}`, {
      cells: { [goId]: '2026-11-20' },
      version: festival.version,
    })
    const added2 = await h.hooks.reminders.runTenant(tenant, '2026-11-17')
    assert.equal(added2, 1, 'Only the creator: Jun snoozed it')
  })
})

test('automations run after a save, return the final row, log the run, and never start each other', async () => {
  const saved: any[] = []
  const h = harness({
    commit: async (_tenant: string, next: any) => {
      saved.push(next)
      Object.assign(h.state, next)
    },
  })
  ;(h.state as any).accounts = [
    { id: 'u1', name: 'Ana Reyes', status: 'Active', role: 'Contributor' },
    { id: 'u2', name: 'Jun Perez', status: 'Active', role: 'Contributor' },
  ]
  await serve(h, async ask => {
    const t = await makeTracker(ask)
    const status = t.columns.find((column: any) => column.name === 'Status')
    const live = status.options.find((option: any) => option.label === 'Live').id
    const go = idOf(t, 'Go-live')
    const timeline = await ask('PUT', `/api/trackers/${t.id}/timeline`, {
      timeline: {
        automations: [
          {
            id: 'a_live',
            when: { kind: 'changed', columnId: status.id, to: live },
            then: [
              { kind: 'set', columnId: go, value: '2026-12-01' },
              { kind: 'comment', text: 'Live!' },
              { kind: 'notify', people: ['u2'] },
            ],
          },
          // Would fire if the first automation's change were fed back in.
          { id: 'a_loop', when: { kind: 'changed', columnId: go }, then: [{ kind: 'comment', text: 'loop' }] },
        ],
      },
    })
    assert.equal(timeline.status, 200, JSON.stringify(timeline.body))
    const row = (
      await ask('POST', `/api/trackers/${t.id}/rows`, { rows: [{ cells: { [idOf(t, 'Site')]: 'Makati T1' } }] })
    ).body.rows[0]
    const patched = await ask('PATCH', `/api/trackers/${t.id}/rows/${row.id}`, {
      cells: { [status.id]: live },
      version: row.version,
    })
    assert.equal(patched.status, 200, JSON.stringify(patched.body))
    assert.equal(patched.body.row.cells[go], '2026-12-01', 'The response carries the automation’s change')
    assert.equal(patched.body.row.version, row.version + 2)
    assert.deepEqual(patched.body.automation.done, ['set Go-live', 'notified Jun Perez', 'added a comment'])
    const comments = (await ask('GET', `/api/trackers/${t.id}/rows/${row.id}/comments`)).body.comments
    assert.deepEqual(
      comments.map((comment: any) => [comment.authorName, comment.text]),
      [['Automation', 'Live!']],
    )
    assert.equal(saved.at(-1).notifications[0].recipientUserId, 'u2')
    assert.equal(saved.at(-1).notifications[0].type, 'tracker_automation')
    const runs = (await ask('GET', `/api/trackers/${t.id}/automation-runs`)).body.runs
    assert.equal(runs.length, 1, 'Only the first automation ran')
    assert.equal(runs[0].row, 'Makati T1')
    const history = (await ask('GET', `/api/trackers/${t.id}/rows/${row.id}/history`)).body.changes
    assert.ok(history.some((change: any) => change.kind === 'automation'))
    // The person's next edit uses the version the response gave: no conflict.
    const next = await ask('PATCH', `/api/trackers/${t.id}/rows/${row.id}`, {
      cells: { [idOf(t, 'Site')]: 'Makati Tower 1' },
      version: patched.body.row.version,
    })
    assert.equal(next.status, 200, JSON.stringify(next.body))
  })
})
