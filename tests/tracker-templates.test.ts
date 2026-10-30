import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { registerTrackerTemplateRoutes } from '../server/trackers/tracker-templates'
import { templateChoices, templateById, columnsForTemplate } from '../src/features/trackers/trackerTemplates'

type Row = Record<string, any>
const KEYS: Record<string, string[]> = { tenant_tracker_templates: ['tenant_id', 'id'] }
function memoryDb(missing = false, refusedKinds: string[] = []) {
  const tables: Record<string, Row[]> = { tenant_tracker_templates: [] }
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
    const modules = asked === 'none' ? ['clients'] : ['trackers']
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
  registerTrackerTemplateRoutes(app as any, { db, requireAuth: pass, requireTenant: pass })
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
const columns = [
  { name: 'Terminal/Site', type: 'text' },
  {
    name: 'Status',
    type: 'select',
    options: [
      { label: 'Live', color: 'green' },
      { label: 'Pre Live', color: 'purple' },
    ],
  },
  { name: 'Hardware', type: 'checkbox', autoDone: {} },
]

test('tracker templates: private to their maker; Administrators share, change, hide and reset built-in ones', async () => {
  await serve(memoryDb(), async ask => {
    const mine = await ask('POST', '/api/tracker-templates', { name: 'My rollout', columns })
    assert.equal(mine.status, 201)
    assert.equal(mine.body.template.shared, false)
    assert.equal(mine.body.template.columns.length, 3)
    assert.ok(mine.body.template.columns[1].options[0].id)
    assert.deepEqual(mine.body.template.columns[2].autoDone, {})
    assert.equal((await ask('GET', '/api/tracker-templates', undefined, ben)).body.templates.length, 0)
    assert.equal(
      (await ask('PATCH', `/api/tracker-templates/${mine.body.template.id}`, { name: 'X' }, ben)).status,
      404,
    )
    assert.equal((await ask('POST', '/api/tracker-templates', { name: 'S', columns, shared: true })).status, 403)
    assert.equal(
      (await ask('POST', '/api/tracker-templates', { name: 'Site rollout', columns, templateKey: 'site-rollout' }))
        .status,
      403,
    )
    assert.equal((await ask('POST', '/api/tracker-templates', { name: 'Bad', columns: [] })).status, 400)
    assert.equal(
      (
        await ask('POST', '/api/tracker-templates', {
          name: 'Bad',
          columns: [
            { name: 'A', type: 'text' },
            { name: 'a', type: 'text' },
          ],
        })
      ).status,
      400,
    )
    assert.equal(
      (await ask('POST', '/api/tracker-templates', { name: 'K', columns, templateKey: 'nope' }, admin)).status,
      400,
    )

    // An Administrator's copy of a built-in template is for everyone; there is one per built-in template.
    const copy = await ask(
      'POST',
      '/api/tracker-templates',
      { name: 'Site rollout', columns, templateKey: 'site-rollout' },
      admin,
    )
    assert.equal(copy.status, 201)
    assert.equal(copy.body.template.shared, true)
    const again = await ask(
      'POST',
      '/api/tracker-templates',
      { name: 'Site rollout', columns, templateKey: 'site-rollout' },
      admin,
    )
    assert.equal(again.status, 409)
    assert.equal(again.body.template.id, copy.body.template.id)
    const seen = await ask('GET', '/api/tracker-templates', undefined, ben)
    assert.deepEqual(
      seen.body.templates.map((item: any) => [item.templateKey, item.canEdit]),
      [['site-rollout', false]],
    )
    assert.equal(
      (await ask('PATCH', `/api/tracker-templates/${copy.body.template.id}`, { name: 'X' }, ben)).status,
      403,
    )
    assert.equal(
      (await ask('PATCH', `/api/tracker-templates/${copy.body.template.id}`, { shared: false }, admin)).status,
      400,
    )
    const stale = await ask(
      'PATCH',
      `/api/tracker-templates/${copy.body.template.id}`,
      { name: 'Y', revision: 9 },
      admin,
    )
    assert.equal(stale.status, 409)
    const hidden = await ask('PATCH', `/api/tracker-templates/${copy.body.template.id}`, { hidden: true }, admin)
    assert.equal(hidden.body.template.hidden, true)
    assert.equal((await ask('GET', '/api/tracker-templates', undefined, ben)).body.templates.length, 0)
    assert.equal((await ask('GET', '/api/tracker-templates', undefined, admin)).body.templates.length, 1)
    assert.equal((await ask('PATCH', `/api/tracker-templates/${mine.body.template.id}`, { hidden: true })).status, 403)
    assert.equal((await ask('DELETE', `/api/tracker-templates/${copy.body.template.id}`, undefined, admin)).status, 200)
    assert.equal((await ask('DELETE', `/api/tracker-templates/${mine.body.template.id}`)).status, 200)
    assert.equal(
      (await ask('POST', '/api/tracker-templates', { name: 'V', columns }, { 'x-role': 'Viewer' })).status,
      403,
    )
    assert.equal((await ask('GET', '/api/tracker-templates', undefined, { 'x-modules': 'none' })).status, 403)
  })
  await serve(memoryDb(true), async ask => {
    const result = await ask('GET', '/api/tracker-templates')
    assert.equal(result.status, 503)
    assert.equal(result.body.needsUpgrade, true)
    assert.match(result.body.error, /schema-v34-tracker-templates/)
  })
})

test('New tracker offers changed built-in templates in place, then the account ones; hidden ones are left out', () => {
  const site = templateById('site-rollout')
  assert.ok(site)
  assert.equal(site?.columns[0].name, 'Terminal/Site')
  assert.equal(site?.columns.length, 25)
  const saved = (over: any) => ({
    id: over.id,
    name: over.name,
    about: '',
    columns: over.columns || [{ id: 'c_a', name: 'Name', type: 'text' }],
    shared: Boolean(over.shared),
    hidden: Boolean(over.hidden),
    templateKey: over.templateKey || '',
    revision: 1,
    createdBy: 'u1',
    createdByName: 'Ana',
    updatedByName: 'Ana',
    updatedAt: '',
    canEdit: true,
  })
  const choices = templateChoices([
    saved({ id: '1', name: 'My site rollout', templateKey: 'site-rollout', shared: true }),
    saved({ id: '2', name: 'Defects (hidden)', templateKey: 'defects', shared: true, hidden: true }),
    saved({ id: '3', name: 'Zeta', shared: false }),
    saved({ id: '4', name: 'Alpha', shared: true }),
  ])
  const ids = choices.map(choice => choice.id)
  assert.equal(ids[0], 'site-rollout')
  assert.equal(choices[0].name, 'My site rollout')
  assert.equal(choices[0].columns.length, 1)
  assert.equal(ids.includes('defects'), false)
  assert.deepEqual(ids.slice(-3), ['saved:4', 'saved:3', 'blank'])
  // The project timeline keeps its starter rows and schedule when an Administrator changes its columns.
  const timeline = templateChoices([
    saved({ id: '5', name: 'Timeline', templateKey: 'project-timeline', shared: true }),
  ]).find(choice => choice.id === 'project-timeline')
  assert.ok(timeline?.rows?.length)
  assert.equal(timeline?.name, 'Timeline')
  assert.deepEqual(
    columnsForTemplate([{ id: 'c1', name: 'A', type: 'text', width: 300, frozen: true, synced: true }]),
    [{ id: 'c1', name: 'A', type: 'text' }],
  )
})
