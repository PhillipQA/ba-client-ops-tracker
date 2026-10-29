import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { registerCustomReportRoutes } from '../server/reports/custom-reports'
import { REPORT_TEMPLATES } from '../src/features/reports/custom/reportModel'

type Row = Record<string, any>
const KEYS: Record<string, string[]> = { tenant_reports: ['tenant_id', 'id'] }
function memoryDb(missing = false) {
  const tables: Record<string, Row[]> = { tenant_reports: [] }
  class Query {
    action = 'read'
    values: Row[] = []
    filters: ((row: Row) => boolean)[] = []
    counted = false
    head = false
    one = false
    sorts: [string, boolean][] = []
    constructor(public table: string) {}
    select(_c = '*', o: { count?: string; head?: boolean } = {}) {
      this.counted = o.count === 'exact'
      this.head = Boolean(o.head)
      return this
    }
    insert(v: Row) {
      this.action = 'insert'
      this.values = [v]
      return this
    }
    upsert(v: Row) {
      this.action = 'upsert'
      this.values = [v]
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
    order(c: string, o: { ascending?: boolean } = {}) {
      this.sorts.push([c, o.ascending !== false])
      return this
    }
    limit() {
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
      if (missing) return { data: null, error: new Error('relation does not exist'), count: null }
      const rows = tables[this.table],
        key = (r: Row) => KEYS[this.table].map(k => r[k]).join('|')
      if (this.action === 'insert') {
        rows.push(structuredClone(this.values[0]))
        return { data: null, error: null }
      }
      if (this.action === 'upsert') {
        const at = rows.findIndex(r => key(r) === key(this.values[0]))
        if (at >= 0) rows[at] = { ...rows[at], ...this.values[0] }
        else rows.push(structuredClone(this.values[0]))
        return { data: null, error: null }
      }
      const matched = rows.filter(r => this.filters.every(f => f(r)))
      if (this.action === 'update') {
        matched.forEach(r => Object.assign(r, this.values[0]))
        return { data: null, error: null }
      }
      if (this.action === 'delete') {
        tables[this.table] = rows.filter(r => !matched.includes(r))
        return { data: null, error: null }
      }
      if (this.head) return { data: null, error: null, count: matched.length }
      return {
        data: this.one ? structuredClone(matched[0] ?? null) : structuredClone(matched),
        error: null,
        count: this.counted ? matched.length : null,
      }
    }
  }
  return { from: (t: string) => new Query(t), tables }
}
async function serve(
  db: any,
  run: (
    ask: (m: string, p: string, b?: any, h?: Record<string, string>) => Promise<{ status: number; body: any }>,
  ) => Promise<void>,
) {
  const app = express()
  app.use(express.json())
  app.use((req: any, _res, next) => {
    const modules = req.headers['x-modules'] === 'none' ? ['clients'] : ['reports']
    req.authUser = {
      id: String(req.headers['x-user'] || 'u1'),
      name: String(req.headers['x-user'] || 'u1') === 'u2' ? 'Ben Cruz' : 'Ana Reyes',
      role: String(req.headers['x-role'] || 'Contributor'),
      organizationId: '11111111-1111-4111-8111-111111111111',
      modules,
      accountType: 'tenant',
    }
    next()
  })
  const pass = (_q: any, _s: any, n: any) => n()
  registerCustomReportRoutes(app as any, { db, requireAuth: pass, requireTenant: pass })
  const server = app.listen(0)
  try {
    const address = server.address() as any
    await run(async (m, p, b, h = {}) => {
      const r = await fetch(`http://127.0.0.1:${address.port}${p}`, {
        method: m,
        headers: { 'content-type': 'application/json', ...h },
        body: b === undefined ? undefined : JSON.stringify(b),
      })
      return { status: r.status, body: await r.json() }
    })
  } finally {
    server.close()
  }
}

const ben = { 'x-user': 'u2' }
const admin = { 'x-user': 'u3', 'x-role': 'Administrator' }

test('reports are private until shared; shared ones are changed by their maker or an Administrator', async () => {
  await serve(memoryDb(), async ask => {
    const definition = REPORT_TEMPLATES.find(item => item.id === 'team')!.build()
    const made = await ask('POST', '/api/reports/custom', { kind: 'report', name: '  Team  week ', definition })
    assert.equal(made.status, 201)
    const report = made.body.item
    assert.equal(report.name, 'Team week')
    assert.equal(report.shared, false)
    assert.equal(report.definition.widgets.length, definition.widgets.length)
    assert.equal((await ask('GET', '/api/reports/custom', undefined, ben)).body.items.length, 0)
    assert.equal((await ask('PATCH', `/api/reports/custom/${report.id}`, { name: 'Mine' }, ben)).status, 404)

    const shared = await ask('PATCH', `/api/reports/custom/${report.id}`, { shared: true })
    assert.equal(shared.body.item.shared, true)
    const seen = (await ask('GET', '/api/reports/custom', undefined, ben)).body.items
    assert.equal(seen.length, 1)
    assert.equal(seen[0].canEdit, false)
    assert.equal((await ask('PATCH', `/api/reports/custom/${report.id}`, { name: 'Mine' }, ben)).status, 403)
    const renamed = await ask('PATCH', `/api/reports/custom/${report.id}`, { name: 'Team (admin)' }, admin)
    assert.equal(renamed.body.item.name, 'Team (admin)')

    // A save based on an old copy is refused, with the current copy.
    const stale = await ask('PATCH', `/api/reports/custom/${report.id}`, { definition, revision: 1 })
    assert.equal(stale.status, 409)
    assert.equal(stale.body.item.name, 'Team (admin)')
  })
})

test('folders: reports move in, and stay when the folder is deleted', async () => {
  await serve(memoryDb(), async ask => {
    const folder = (await ask('POST', '/api/reports/custom', { kind: 'folder', name: 'Clients' })).body.item
    const report = (await ask('POST', '/api/reports/custom', { kind: 'report', name: 'Status', folderId: folder.id }))
      .body.item
    assert.equal(report.folderId, folder.id)
    // Someone else's private folder cannot be used.
    assert.equal(
      (await ask('POST', '/api/reports/custom', { kind: 'report', name: 'X', folderId: folder.id }, ben)).status,
      400,
    )
    assert.equal((await ask('DELETE', `/api/reports/custom/${folder.id}`)).status, 200)
    const items = (await ask('GET', '/api/reports/custom')).body.items
    assert.deepEqual(
      items.map((item: any) => [item.name, item.folderId]),
      [['Status', '']],
    )
  })
})

test('Viewers read, the upgrade is named when missing, and widgets are cleaned', async () => {
  await serve(memoryDb(), async ask => {
    const viewer = { 'x-role': 'Viewer' }
    assert.equal((await ask('POST', '/api/reports/custom', { kind: 'report', name: 'R' }, viewer)).status, 403)
    assert.equal((await ask('GET', '/api/reports/custom', undefined, { 'x-modules': 'none' })).status, 403)
    const made = await ask('POST', '/api/reports/custom', {
      kind: 'report',
      name: 'R',
      definition: {
        widgets: [
          { kind: 'script', id: 'x' },
          { kind: 'metric', id: 'm', title: 'Open' },
        ],
      },
    })
    assert.deepEqual(
      made.body.item.definition.widgets.map((widget: any) => widget.id),
      ['m'],
    )
  })
  await serve(memoryDb(true), async ask => {
    const result = await ask('GET', '/api/reports/custom')
    assert.equal(result.status, 503)
    assert.equal(result.body.needsUpgrade, true)
  })
})
