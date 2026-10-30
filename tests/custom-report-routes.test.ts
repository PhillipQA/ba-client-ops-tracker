import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { registerCustomReportRoutes } from '../server/reports/custom-reports'
import { REPORT_TEMPLATES } from '../src/features/reports/custom/reportModel'

type Row = Record<string, any>
const KEYS: Record<string, string[]> = { tenant_reports: ['tenant_id', 'id'] }
function memoryDb(missing = false, refusedKinds: string[] = []) {
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
        // A database before an upgrade: its check constraint refuses kinds it does not know.
        if (refusedKinds.includes(this.values[0].kind))
          return { data: null, error: new Error('violates check constraint "tenant_reports_kind_check"') }
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
    const asked = String(req.headers['x-modules'] || '')
    const modules =
      asked === 'none'
        ? ['clients']
        : asked === 'explorer' || (!asked && req.headers['x-role'] === 'Administrator')
          ? ['reports', 'explorer']
          : ['reports']
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

test('templates: anyone keeps their own; Administrators change, hide and reset the account ones', async () => {
  await serve(memoryDb(), async ask => {
    const definition = REPORT_TEMPLATES[0].build()
    // Contributors keep private templates, and cannot make or change the account's.
    const mine = await ask('POST', '/api/reports/custom', { kind: 'template', name: 'My week', definition }, ben)
    assert.equal(mine.status, 201)
    assert.equal(mine.body.item.shared, false)
    assert.equal(mine.body.item.canEdit, true)
    assert.equal(
      (await ask('POST', '/api/reports/custom', { kind: 'template', name: 'Ours', shared: true }, ben)).status,
      403,
    )
    assert.equal(
      (await ask('POST', '/api/reports/custom', { kind: 'template', name: 'Team', templateKey: 'team' }, ben)).status,
      403,
    )
    assert.equal((await ask('GET', '/api/reports/custom', undefined, admin)).body.items.length, 0)

    // An Administrator changes a suggested template: the account's copy is stored with its key, once.
    const changed = await ask(
      'POST',
      '/api/reports/custom',
      { kind: 'template', name: 'Team workload', templateKey: 'team', definition },
      admin,
    )
    assert.equal(changed.status, 201)
    assert.equal(changed.body.item.shared, true)
    assert.equal(changed.body.item.templateKey, 'team')
    const again = await ask('POST', '/api/reports/custom', { kind: 'template', name: 'X', templateKey: 'team' }, admin)
    assert.equal(again.status, 409)
    assert.equal(again.body.item.id, changed.body.item.id)
    assert.equal(
      (await ask('POST', '/api/reports/custom', { kind: 'template', name: 'X', templateKey: 'nope' }, admin)).status,
      400,
    )
    const id = changed.body.item.id

    // Everyone sees it; only Administrators change it.
    const seen = (await ask('GET', '/api/reports/custom', undefined, ben)).body.items
    assert.deepEqual(
      seen.map((item: any) => [item.name, item.canEdit]),
      [
        ['My week', true],
        ['Team workload', false],
      ].sort(),
    )
    assert.equal((await ask('PATCH', `/api/reports/custom/${id}`, { name: 'Ours now' }, ben)).status, 403)
    assert.equal((await ask('PATCH', `/api/reports/custom/${id}`, { shared: false }, admin)).status, 400)

    // Hidden: gone for everyone but Administrators.
    assert.equal((await ask('PATCH', `/api/reports/custom/${id}`, { hidden: true }, ben)).status, 403)
    assert.equal((await ask('PATCH', `/api/reports/custom/${id}`, { hidden: true }, admin)).body.item.hidden, true)
    assert.equal(
      (await ask('GET', '/api/reports/custom', undefined, ben)).body.items.some((item: any) => item.id === id),
      false,
    )
    assert.equal(
      (await ask('GET', '/api/reports/custom', undefined, admin)).body.items.find((item: any) => item.id === id).hidden,
      true,
    )

    // Reset: the account's copy is deleted, so the suggested one is used again.
    assert.equal((await ask('DELETE', `/api/reports/custom/${id}`, undefined, admin)).status, 200)
    assert.equal((await ask('GET', '/api/reports/custom', undefined, admin)).body.items.length, 0)
  })
})

test('saved queries: only for Data explorer, private to their maker; Administrators share them as templates', async () => {
  await serve(memoryDb(), async ask => {
    const ana = { 'x-modules': 'explorer' }
    const benExplores = { 'x-user': 'u2', 'x-modules': 'explorer' }
    const query = (sql: string, params: Record<string, string> = {}) => ({
      widgets: [],
      filters: { range: 'all' },
      query: { sql, view: 'bar', params },
    })
    // Without the module, saved queries cannot be made.
    const refused = await ask('POST', '/api/reports/custom', {
      kind: 'query',
      name: 'Q',
      definition: query('SELECT 1'),
    })
    assert.equal(refused.status, 403)
    assert.equal(
      (await ask('POST', '/api/reports/custom', { kind: 'query', name: 'Q', definition: query(' ') }, ana)).status,
      400,
    )
    const shared = await ask(
      'POST',
      '/api/reports/custom',
      { kind: 'query', name: 'Q', shared: true, definition: query('SELECT 1') },
      ana,
    )
    assert.equal(shared.status, 403)

    const mine = await ask(
      'POST',
      '/api/reports/custom',
      {
        kind: 'query',
        name: 'Open by client',
        definition: query('SELECT client, COUNT(*) AS open FROM tasks WHERE client = {{client}} GROUP BY client', {
          client: 'Acme',
          'bad name': 'x',
        }),
      },
      ana,
    )
    assert.equal(mine.status, 201)
    assert.equal(mine.body.item.kind, 'query')
    assert.equal(mine.body.item.canEdit, true)
    assert.deepEqual(mine.body.item.definition.query.params, { client: 'Acme' })
    assert.equal(mine.body.item.definition.query.view, 'bar')

    // Private: Ben does not see Ana's query, and people without Data explorer see no queries at all.
    const benList = await ask('GET', '/api/reports/custom', undefined, benExplores)
    assert.equal(benList.body.items.filter((item: any) => item.kind === 'query').length, 0)
    const template = await ask(
      'POST',
      '/api/reports/custom',
      {
        kind: 'query',
        name: 'Hours by person',
        shared: true,
        definition: query('SELECT user, SUM(hours) FROM time_entries GROUP BY user'),
      },
      admin,
    )
    assert.equal(template.status, 201)
    const seen = await ask('GET', '/api/reports/custom', undefined, benExplores)
    const sharedQuery = seen.body.items.find((item: any) => item.id === template.body.item.id)
    assert.equal(sharedQuery.canEdit, false)
    const without = await ask('GET', '/api/reports/custom', undefined, ben)
    assert.equal(without.body.items.filter((item: any) => item.kind === 'query').length, 0)
    assert.equal((await ask('PATCH', `/api/reports/custom/${template.body.item.id}`, { name: 'X' }, ben)).status, 404)

    // Only Administrators change the account's query templates; only their maker changes a private one.
    const change = { definition: query('SELECT 2') }
    assert.equal((await ask('PATCH', `/api/reports/custom/${template.body.item.id}`, change, benExplores)).status, 403)
    assert.equal((await ask('PATCH', `/api/reports/custom/${mine.body.item.id}`, { shared: true }, ana)).status, 403)
    assert.equal((await ask('PATCH', `/api/reports/custom/${mine.body.item.id}`, change, benExplores)).status, 404)
    const edited = await ask('PATCH', `/api/reports/custom/${mine.body.item.id}`, change, ana)
    assert.equal(edited.status, 200)
    assert.equal(edited.body.item.definition.query.sql, 'SELECT 2')
    assert.equal((await ask('PATCH', `/api/reports/custom/${template.body.item.id}`, change, admin)).status, 200)
    assert.equal(
      (await ask('DELETE', `/api/reports/custom/${template.body.item.id}`, undefined, benExplores)).status,
      403,
    )
    assert.equal((await ask('DELETE', `/api/reports/custom/${mine.body.item.id}`, undefined, ana)).status, 200)

    // A report keeps its query widgets, with the query that runs in them.
    const report = await ask('POST', '/api/reports/custom', {
      kind: 'report',
      name: 'With a query',
      definition: {
        widgets: [{ kind: 'query', id: 'q', title: 'Open', query: { sql: 'SELECT 1', view: 'nope', params: {} } }],
      },
    })
    assert.equal(report.status, 201)
    assert.equal(report.body.item.definition.widgets[0].kind, 'query')
    assert.equal(report.body.item.definition.widgets[0].query.sql, 'SELECT 1')
    assert.equal(report.body.item.definition.widgets[0].query.view, 'table')
  })
  // Before the v33 upgrade, saving a query names the upgrade, and the rest of Reports keeps working.
  await serve(memoryDb(false, ['query']), async ask => {
    const result = await ask(
      'POST',
      '/api/reports/custom',
      { kind: 'query', name: 'Q', definition: { widgets: [], query: { sql: 'SELECT 1', view: 'table', params: {} } } },
      admin,
    )
    assert.equal(result.status, 503)
    assert.match(result.body.error, /schema-v33-data-explorer/)
    assert.equal(result.body.needsUpgrade, undefined)
    assert.equal((await ask('POST', '/api/reports/custom', { kind: 'report', name: 'R' })).status, 201)
  })
})
