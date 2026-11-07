import assert from 'node:assert/strict'
import test from 'node:test'
import { activeAssignments, scopedState, scopeFor } from '../src/shared/access'
import { matchKey, nameSimilarity, seedsStatusFor, type SeedsSnapshot } from '../src/shared/seeds'
import { cleanSeedsBaseUrl, httpSeedsSource, parseSeedsSnapshot, seedsRole } from '../server/seeds/seeds-client'
import { registerSeedsRoutes } from '../server/seeds/seeds-routes'
import { assertLifecycleMutation } from '../src/features/tasks/lifecycle'
import { decideSeedsMatch, planSeedsSync, SEEDS_ACTOR } from '../server/seeds/seeds-sync'

const options = {
  now: '2026-11-07T08:00:00.000Z',
  today: '2026-11-07',
  openStatus: 'Open',
  waitingOn: 'Internal',
  userId: 'u-bea',
}
let counter = 0
const sequential = () => `new-${++counter}`

function existing() {
  return {
    clients: [
      {
        id: 'c-acme',
        name: 'Acme Corporation',
        contact: '',
        email: '',
        status: 'Active',
        health: 'Good',
        notes: 'keep',
      },
      { id: 'c-bolt', name: 'Bolt Logistic', contact: '', email: '', status: 'Active', health: 'Good', notes: '' },
    ],
    projects: [{ id: 'p-portal', name: 'Customer Portal', status: 'Active', targetDate: '', summary: 'keep me' }],
    items: [
      { id: 't-uat', title: 'UAT Support', projectId: 'p-portal', clientId: 'c-acme', type: 'Task' },
      { id: 't-sub', title: 'Prepare UAT script', projectId: 'p-portal', clientId: 'c-acme', parentTaskId: 't-uat' },
      { id: 't-local', title: 'Internal notes', projectId: 'p-portal', clientId: 'c-acme', type: 'Task' },
    ],
    accounts: [
      { id: 'u-bea', name: 'Bea', email: 'Bea@Company.com', role: 'Contributor', status: 'Active' },
      { id: 'u-pao', name: 'Paolo', email: 'paolo@company.com', role: 'Contributor', status: 'Active' },
    ],
    access: {
      strictVisibility: true,
      assignments: [{ id: 'm1', userId: 'u-bea', role: 'BA', clientId: 'c-bolt', source: 'manual' }],
    },
    taskSettings: { statuses: [] },
    // An Administrator has turned Seeds on (the route tests start with it off).
    seeds: { connected: true, baseUrl: 'https://seeds.example.com/api' },
  }
}

function snapshot(overrides: Partial<SeedsSnapshot> = {}): SeedsSnapshot {
  return {
    people: [
      { id: 'sp-bea', name: 'Bea', email: 'bea@company.com' },
      { id: 'sp-pao', name: 'Paolo', email: 'paolo@company.com' },
      { id: 'sp-x', name: 'Xavier', email: 'xavier@company.com' },
    ],
    clients: [
      { id: 's-acme', name: 'ACME Corp.' },
      { id: 's-bolt', name: 'Bolt Logistics' },
      { id: 's-new', name: 'Nimbus Bank' },
    ],
    projects: [
      { id: 's-portal', clientId: 's-acme', name: 'Customer Portal', contractNumber: 'CN-2026-014' },
      { id: 's-core', clientId: 's-new', name: 'Core Banking', contractNumber: 'CN-2026-020' },
      { id: 's-internal', clientId: '', name: 'Internal', contractNumber: '' },
    ],
    tasks: [
      { id: 's-uat', projectId: 's-portal', name: 'UAT Support' },
      { id: 's-docs', projectId: 's-portal', name: 'Documentation' },
    ],
    assignments: [
      { personId: 'sp-bea', role: 'BA', projectId: 's-portal' },
      { personId: 'sp-pao', role: 'PM', clientId: 's-new' },
      { personId: 'sp-x', role: 'BA', projectId: 's-core' },
    ],
    ...overrides,
  }
}

test('names match whatever their case, punctuation or company suffix', () => {
  assert.equal(matchKey('ACME Corp.'), matchKey('Acme Corporation'))
  assert.ok(nameSimilarity('Bolt Logistic', 'Bolt Logistics') >= 0.75)
  assert.ok(nameSimilarity('Acme', 'Nimbus Bank') < 0.5)
})

test('a first sync links what exists, adds what is new and holds close names for confirmation', () => {
  counter = 0
  const { state, counts, pending } = planSeedsSync(existing(), snapshot(), { ...options, id: sequential })
  const acme = state.clients.find((c: any) => c.id === 'c-acme')
  assert.equal(acme.seedsId, 's-acme')
  assert.equal(acme.name, 'ACME Corp.', 'the name follows Seeds')
  assert.equal(acme.notes, 'keep', 'app-owned details stay')
  // Bolt Logistic vs Bolt Logistics: close, so it waits rather than being guessed or duplicated.
  assert.deepEqual(
    pending.map(match => [match.kind, match.seedsId, match.appId]),
    [['client', 's-bolt', 'c-bolt']],
  )
  assert.equal(state.clients.find((c: any) => c.id === 'c-bolt').seedsId, undefined)
  assert.ok(state.clients.some((c: any) => c.seedsId === 's-new' && c.name === 'Nimbus Bank'))

  const portal = state.projects.find((p: any) => p.id === 'p-portal')
  assert.deepEqual(
    [portal.seedsId, portal.clientId, portal.contractNumber, portal.summary],
    ['s-portal', 'c-acme', 'CN-2026-014', 'keep me'],
  )
  const internal = state.projects.find((p: any) => p.seedsId === 's-internal')
  assert.equal(internal.clientId, undefined, 'internal projects have no client')

  const uat = state.items.find((i: any) => i.id === 't-uat')
  assert.equal(uat.seedsId, 's-uat')
  const docs = state.items.find((i: any) => i.seedsId === 's-docs')
  assert.deepEqual(
    [docs.projectId, docs.clientId, docs.status, docs.parentTaskId],
    ['p-portal', 'c-acme', 'Open', undefined],
  )
  assert.equal(state.items.find((i: any) => i.id === 't-local').seedsId, undefined, 'work not in Seeds keeps working')
  assert.equal(state.items.find((i: any) => i.id === 't-sub').seedsId, undefined, 'subtasks stay in this app')

  // Only Bea's own assignments, although Seeds also listed her colleagues'.
  assert.deepEqual(
    activeAssignments(state, 'u-bea').map(a => [a.userId, a.role, a.projectId || a.clientId]),
    [['u-bea', 'BA', 'p-portal']],
  )
  assert.deepEqual(activeAssignments(state, 'u-pao'), [], 'Paolo has not connected his Seeds')
  assert.equal(
    state.access.assignments.some((a: any) => a.id === 'm1'),
    true,
    'hand-entered ones are kept, unused',
  )
  assert.equal(state.seeds.users['u-bea'].lastSuccessAt, options.now)
  assert.equal(counts.created, 4, 'Nimbus, Core Banking, Internal and Documentation')
})

test('a second sync changes nothing; renames and archiving follow by Seeds id', () => {
  const first = planSeedsSync(existing(), snapshot(), { ...options, id: sequential }).state
  const again = planSeedsSync(first, snapshot(), { ...options, id: sequential })
  assert.equal(again.counts.created, 0)
  assert.deepEqual(again.state.clients, first.clients)
  assert.deepEqual(again.state.items, first.items)
  const renamed = planSeedsSync(
    first,
    snapshot({ clients: [{ id: 's-acme', name: 'Acme Holdings', archived: true }], projects: [], tasks: [] }),
    options,
  ).state
  const acme = renamed.clients.find((c: any) => c.id === 'c-acme')
  assert.deepEqual([acme.name, acme.seedsArchived], ['Acme Holdings', true])
})

test('a sync passes the workspace rules: versions move on, archived work is left alone', () => {
  const before: any = existing()
  before.projects.push({
    id: 'p-old',
    name: 'Old Rollout',
    status: 'Closed',
    targetDate: '',
    summary: '',
    archived: true,
  })
  const base = snapshot()
  const { state } = planSeedsSync(
    before,
    snapshot({
      projects: [...base.projects, { id: 's-old', clientId: 's-acme', name: 'Old Rollout', contractNumber: '' }],
      tasks: [...base.tasks, { id: 's-late', projectId: 's-old', name: 'Late task' }],
    }),
    options,
  )
  assert.doesNotThrow(() => assertLifecycleMutation(before, state, SEEDS_ACTOR as any))
  assert.equal(state.clients.find((c: any) => c.id === 'c-acme').lifecycleVersion, 1)
  assert.equal(
    state.clients.find((c: any) => c.id === 'c-bolt').lifecycleVersion,
    undefined,
    'untouched records keep theirs',
  )
  assert.ok(!state.items.some((i: any) => i.seedsId === 's-late'), 'no new work under an archived project')
  const confirmed = decideSeedsMatch(state, 'client:s-bolt', 'confirm')
  assert.doesNotThrow(() => assertLifecycleMutation(state, confirmed?.state, SEEDS_ACTOR as any))
})

test('Seeds assignments decide visibility once synced', () => {
  const state = planSeedsSync(existing(), snapshot(), { ...options, id: sequential }).state
  const bea = scopedState(state, scopeFor(state, 'u-bea'))
  assert.deepEqual(
    bea.items.map((item: any) => item.id).sort(),
    [...state.items.filter((i: any) => i.projectId === 'p-portal').map((i: any) => i.id)].sort(),
  )
  assert.ok(!bea.clients.some((c: any) => c.id === 'c-bolt'), 'the hand-entered Bolt assignment no longer counts')
})

test('confirming a match links it; turning it down adds a new record next time', () => {
  const first = planSeedsSync(existing(), snapshot(), { ...options, id: sequential }).state
  const confirmed = decideSeedsMatch(first, 'client:s-bolt', 'confirm')
  assert.ok(confirmed)
  const bolt = confirmed.state.clients.find((c: any) => c.id === 'c-bolt')
  assert.deepEqual([bolt.seedsId, bolt.name], ['s-bolt', 'Bolt Logistics'])
  assert.deepEqual(confirmed.state.seeds.pendingMatches, [])

  const rejected = decideSeedsMatch(first, 'client:s-bolt', 'reject')
  const next = planSeedsSync(rejected?.state, snapshot(), { ...options, id: sequential }).state
  assert.equal(next.clients.find((c: any) => c.id === 'c-bolt').seedsId, undefined)
  assert.ok(next.clients.some((c: any) => c.seedsId === 's-bolt' && c.id !== 'c-bolt'))
  assert.equal(decideSeedsMatch(first, 'client:missing', 'confirm'), null)
})

test('only reviewers see matches, and only matches on records they can see', () => {
  const bea = planSeedsSync(existing(), snapshot(), { ...options, id: sequential }).state
  const state = planSeedsSync(bea, snapshot(), { ...options, userId: 'u-pao', id: sequential }).state
  assert.equal(seedsStatusFor(state, { id: 'admin', role: 'Administrator' }).pendingMatches.length, 1)
  assert.equal(seedsStatusFor(state, { id: 'u-bea', role: 'Contributor' }).canReview, false)
  const pm = seedsStatusFor(state, { id: 'u-pao', role: 'Contributor' })
  assert.equal(pm.canReview, true, 'Paolo is PM in his own Seeds')
  assert.deepEqual(pm.pendingMatches, [], 'Paolo manages Nimbus, not Bolt')
  assert.equal(pm.people, undefined, 'only Administrators see who has connected')
  assert.equal(seedsStatusFor(state, { id: 'admin', role: 'Administrator' }).people?.length, 2)
})

test('a personal key that names its owner picks only their assignments', () => {
  const { state } = planSeedsSync(existing(), snapshot({ me: { id: 'sp-pao', name: 'Paolo', email: 'p@x' } }), {
    ...options,
    userId: 'u-pao',
  })
  assert.deepEqual(
    activeAssignments(state, 'u-pao').map(a => a.role),
    ['PM'],
  )
  const anonymous = snapshot({ people: [], assignments: [{ personId: '', role: 'BA', projectId: 's-portal' }] })
  const own = planSeedsSync(existing(), anonymous, options).state
  assert.deepEqual(
    activeAssignments(own, 'u-bea').map(a => a.role),
    ['BA'],
    'without person ids, everything the key returns is the owner’s',
  )
})

test('Seeds answers are read leniently', () => {
  assert.equal(seedsRole('Business Analyst'), 'BA')
  assert.equal(seedsRole('project_manager'), 'PM')
  assert.equal(seedsRole('am'), 'AM')
  assert.equal(seedsRole('Developer'), null)
  const parsed = parseSeedsSnapshot({
    people: [
      { person_id: 7, full_name: 'Bea', email_address: 'bea@co' },
      { id: 8, name: 'No email' },
    ],
    clients: [{ client_id: 1, client_name: 'Acme', status: 'Archived' }],
    projects: [{ project_id: 2, client: { id: 1 }, project_name: 'Portal', contract_no: 'CN-1' }],
    tasks: [
      { task_id: 3, project_id: 2, title: 'UAT' },
      { task_id: 4, title: 'No project' },
    ],
    assignments: [
      { user_id: 7, role: 'Business Analyst', project_id: 2 },
      { user_id: 7, role: 'Developer', project_id: 2 },
    ],
  })
  assert.deepEqual(parsed.people, [{ id: '7', name: 'Bea', email: 'bea@co' }])
  assert.deepEqual(parsed.clients, [{ id: '1', name: 'Acme', archived: true }])
  assert.deepEqual(parsed.projects, [{ id: '2', clientId: '1', name: 'Portal', contractNumber: 'CN-1' }])
  assert.deepEqual(parsed.tasks, [{ id: '3', projectId: '2', name: 'UAT' }])
  assert.deepEqual(parsed.assignments, [{ personId: '7', role: 'BA', projectId: '2' }])
})

test('the Seeds address must be public https', () => {
  assert.equal(cleanSeedsBaseUrl('https://seeds.example.com/api/v1/'), 'https://seeds.example.com/api/v1')
  for (const bad of [
    'http://seeds.example.com',
    'https://localhost/api',
    'https://10.0.0.5/api',
    'https://[::1]/',
    'https://db.internal',
    'nope',
  ])
    assert.throws(() => cleanSeedsBaseUrl(bad), /https/, bad)
})

test('the HTTP reader sends the key, follows pages and stops at other hosts', async () => {
  const calls: { url: string; auth: string }[] = []
  const pages: Record<string, any> = {
    'https://seeds.example.com/api/people': {
      data: [{ id: 1, name: 'Bea', email: 'bea@co' }],
      next: '/api/people?page=2',
    },
    'https://seeds.example.com/api/people?page=2': { data: [{ id: 2, name: 'Paolo', email: 'paolo@co' }] },
    'https://seeds.example.com/api/clients': [{ id: 1, name: 'Acme' }],
    'https://seeds.example.com/api/projects': { projects: [] },
    'https://seeds.example.com/api/tasks': [],
    'https://seeds.example.com/api/assignments': [],
    'https://seeds.example.com/api/me': { data: { id: 1, name: 'Bea', email: 'bea@co' } },
  }
  const fetcher = (async (url: string, init: any) => {
    calls.push({ url, auth: init.headers.Authorization })
    const body = pages[url]
    return { ok: Boolean(body), status: body ? 200 : 404, json: async () => body } as any
  }) as any
  const result = await httpSeedsSource('https://seeds.example.com/api', 'secret-key', fetcher).snapshot()
  assert.deepEqual(
    result.people.map(p => p.name),
    ['Bea', 'Paolo'],
  )
  assert.equal(result.me?.id, '1')
  assert.ok(calls.every(call => call.auth === 'Bearer secret-key'))
  delete pages['https://seeds.example.com/api/me']
  delete pages['https://seeds.example.com/api/people?page=2']
  pages['https://seeds.example.com/api/people'] = undefined
  const minimal = await httpSeedsSource('https://seeds.example.com/api', 'secret-key', fetcher).snapshot()
  assert.deepEqual([minimal.me, minimal.people], [undefined, []], 'people and me are optional')

  pages['https://seeds.example.com/api/people'] = { data: [], next: 'https://elsewhere.example.com/steal' }
  await assert.rejects(httpSeedsSource('https://seeds.example.com/api', 'k', fetcher).snapshot(), /another address/)
  const denied = (async () => ({ ok: false, status: 401, json: async () => ({}) })) as any
  await assert.rejects(httpSeedsSource('https://seeds.example.com/api', 'k', denied).snapshot(), /API key/)
})

// ---- Routes, with a fake Seeds and an in-memory workspace ----

function fakeDb() {
  const rows: any[] = []
  class Query {
    filters: [string, unknown][] = []
    action: 'select' | 'update' | 'delete' | 'upsert' = 'select'
    payload: any
    select() {
      return this
    }
    eq(column: string, value: unknown) {
      this.filters.push([column, value])
      return this
    }
    update(payload: any) {
      this.action = 'update'
      this.payload = payload
      return this
    }
    delete() {
      this.action = 'delete'
      return this
    }
    upsert(payload: any) {
      this.action = 'upsert'
      this.payload = payload
      return this
    }
    matches(row: any) {
      return this.filters.every(([column, value]) => row[column] === value)
    }
    run() {
      if (this.action === 'upsert') {
        const at = rows.findIndex(r => r.tenant_id === this.payload.tenant_id && r.user_id === this.payload.user_id)
        if (at >= 0) rows[at] = this.payload
        else rows.push(this.payload)
        return { data: null, error: null }
      }
      if (this.action === 'update') {
        for (const row of rows) if (this.matches(row)) Object.assign(row, this.payload)
        return { data: null, error: null }
      }
      if (this.action === 'delete') {
        for (let at = rows.length - 1; at >= 0; at--) if (this.matches(rows[at])) rows.splice(at, 1)
        return { data: null, error: null }
      }
      return { data: rows.filter(row => this.matches(row)), error: null }
    }
    maybeSingle() {
      const result = this.run()
      return Promise.resolve({ data: (result.data as any[])?.[0] || null, error: null })
    }
    then(resolve: any, reject: any) {
      return Promise.resolve(this.run()).then(resolve, reject)
    }
  }
  return { rows, from: () => new Query() }
}

function fakeApp() {
  const routes: { method: string; path: string; handlers: any[] }[] = []
  const add =
    (method: string) =>
    (path: string, ...handlers: any[]) =>
      routes.push({ method, path, handlers })
  const app: any = { get: add('GET'), post: add('POST'), put: add('PUT'), delete: add('DELETE') }
  app.ask = (method: string, path: string, user: any, body?: any) => {
    const route = routes.find(
      r => r.method === method && new RegExp(`^${r.path.replace(/:(\w+)/g, '([^/]+)')}$`).test(path),
    )
    if (!route) throw new Error(`No route ${method} ${path}`)
    const id = new RegExp(`^${route.path.replace(/:(\w+)/g, '([^/]+)')}$`).exec(path)?.[1]
    const req: any = { method, body, params: { id }, authUser: user }
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

function setup(source: () => Promise<SeedsSnapshot>) {
  let stored: any = { ...existing(), seeds: undefined }
  const db = fakeDb()
  const app = fakeApp()
  const pass = (_req: any, _res: any, next: () => void) => next()
  registerSeedsRoutes(app, {
    db,
    requireAuth: pass,
    requireTenant: pass,
    load: async () => ({ data: stored }),
    commit: async (_id, state) => {
      stored = state
    },
    raced: () => false,
    openStatus: () => 'Open',
    today: () => '2026-11-07',
    secrets: {
      encrypt: (secret, owner) => `enc:${owner}:${secret}`,
      decrypt: (value, owner) => value.replace(`enc:${owner}:`, ''),
      ready: () => true,
    },
    source: (baseUrl, apiKey) => {
      assert.equal(baseUrl, 'https://seeds.example.com/api')
      return { snapshot: () => source(apiKey) }
    },
  })
  return { app, db, state: () => stored }
}
const admin = { id: 'admin', role: 'Administrator', modules: ['settings'], organizationId: 'org' }
const bea = { id: 'u-bea', role: 'Contributor', modules: ['items'], organizationId: 'org' }
const pao = { id: 'u-pao', role: 'Contributor', modules: ['items'], organizationId: 'org' }
/** Each person's key reads their own Seeds: Seeds names its owner. */
const personal = (apiKey: string) =>
  snapshot({
    me:
      apiKey === 'bea-key-123456'
        ? { id: 'sp-bea', name: 'Bea', email: 'bea@company.com' }
        : { id: 'sp-pao', name: 'Paolo', email: 'paolo@company.com' },
  })
const turnOn = (app: any) => app.ask('PUT', '/api/account/seeds', admin, { baseUrl: 'https://seeds.example.com/api' })

test('an Administrator turns Seeds on; each person connects their own key and gets their own access', async () => {
  const { app, db, state } = setup(async key => personal(key))
  const denied = await app.ask('PUT', '/api/account/seeds', bea, { baseUrl: 'https://seeds.example.com/api' })
  assert.equal(denied.status, 403)
  const early = await app.ask('PUT', '/api/me/seeds', bea, { apiKey: 'bea-key-123456' })
  assert.equal(early.status, 409, 'not before Seeds is on')
  assert.equal((await turnOn(app)).status, 200)
  assert.equal(state().seeds.baseUrl, 'https://seeds.example.com/api')

  const saved = await app.ask('PUT', '/api/me/seeds', bea, { apiKey: 'bea-key-123456' })
  assert.equal(saved.status, 200, JSON.stringify(saved.body))
  assert.equal(saved.body.sync.ok, true)
  assert.deepEqual(
    db.rows.map((row: any) => [row.user_id, row.encrypted_key, row.connection_status]),
    [['u-bea', 'enc:org:u-bea:bea-key-123456', 'verified']],
  )
  assert.deepEqual(
    activeAssignments(state(), 'u-bea').map(a => a.role),
    ['BA'],
  )
  assert.deepEqual(activeAssignments(state(), 'u-pao'), [], 'Paolo has not connected yet')
  const mine = await app.ask('GET', '/api/me/seeds', bea)
  assert.equal(mine.body.maskedKey, '••••••••3456')
  assert.ok(!JSON.stringify(mine.body).includes('bea-key-123456'), 'the key never comes back')

  await app.ask('PUT', '/api/me/seeds', pao, { apiKey: 'pao-key-123456' })
  assert.deepEqual(
    activeAssignments(state(), 'u-pao').map(a => a.role),
    ['PM'],
  )
  assert.deepEqual(
    activeAssignments(state(), 'u-bea').map(a => a.role),
    ['BA'],
    'one person’s sync leaves the others’ access alone',
  )
  const overview = await app.ask('GET', '/api/account/seeds', admin)
  assert.deepEqual(overview.body.people.map((p: any) => p.name).sort(), ['Bea', 'Paolo'])

  // Disconnecting takes that person's Seeds access with the key.
  assert.equal((await app.ask('DELETE', '/api/me/seeds', bea)).status, 200)
  assert.deepEqual(
    activeAssignments(state(), 'u-bea').map(a => a.id),
    ['m1'],
    'back to hand-entered',
  )
  assert.deepEqual(
    db.rows.map((row: any) => row.user_id),
    ['u-pao'],
  )
  const off = await app.ask('DELETE', '/api/account/seeds', admin)
  assert.equal(off.status, 200)
  assert.deepEqual(activeAssignments(state(), 'u-pao'), [], 'Seeds off: hand-entered access counts (none for Paolo)')
})

test('when Seeds is down your last synced access stays and the error shows', async () => {
  let down = false
  const { app, state } = setup(async key => {
    if (down) throw new Error('ECONNREFUSED')
    return personal(key)
  })
  await turnOn(app)
  await app.ask('PUT', '/api/me/seeds', bea, { apiKey: 'bea-key-123456' })
  const before = activeAssignments(state(), 'u-bea')
  down = true
  const result = await app.ask('POST', '/api/seeds/sync', bea)
  assert.equal(result.body.ok, false)
  assert.deepEqual(activeAssignments(state(), 'u-bea'), before)
  assert.ok(state().seeds.users['u-bea'].lastError)
  assert.equal((await app.ask('POST', '/api/seeds/sync', pao)).status, 409, 'Paolo has no key yet')
})

test('a reviewer confirms a match they can see', async () => {
  const { app, state } = setup(async key => personal(key))
  await turnOn(app)
  await app.ask('PUT', '/api/me/seeds', bea, { apiKey: 'bea-key-123456' })
  await app.ask('PUT', '/api/me/seeds', pao, { apiKey: 'pao-key-123456' })
  assert.equal(
    (await app.ask('POST', '/api/seeds/matches/client:s-bolt', bea, { decision: 'confirm' })).status,
    403,
    'BAs do not confirm matches',
  )
  assert.equal(
    (await app.ask('POST', '/api/seeds/matches/client:s-bolt', pao, { decision: 'confirm' })).status,
    404,
    'Paolo cannot see Bolt',
  )
  const done = await app.ask('POST', '/api/seeds/matches/client:s-bolt', admin, { decision: 'confirm' })
  assert.equal(done.status, 200, JSON.stringify(done.body))
  assert.equal(state().clients.find((c: any) => c.id === 'c-bolt').seedsId, 's-bolt')
  assert.deepEqual(state().seeds.pendingMatches, [])
})

test('hand-entered assignments: Administrators only, names only, checked', async () => {
  const { app, state } = setup(async key => personal(key))
  assert.equal((await app.ask('GET', '/api/access', bea)).status, 403)
  const listed = await app.ask('GET', '/api/access', admin)
  assert.deepEqual(Object.keys(listed.body.clients[0]).sort(), ['id', 'name'])
  assert.ok(!JSON.stringify(listed.body).includes('keep me'), 'no project details')
  const bad = await app.ask('PUT', '/api/access', admin, {
    assignments: [{ userId: 'u-bea', role: 'BA', clientId: 'nope' }],
  })
  assert.equal(bad.status, 400)
  const ok = await app.ask('PUT', '/api/access', admin, {
    strictVisibility: true,
    assignments: [{ userId: 'u-pao', role: 'PM', projectId: 'p-portal', clientId: 'c-acme' }],
  })
  assert.equal(ok.status, 200, JSON.stringify(ok.body))
  assert.deepEqual(state().access.assignments, [
    { id: 'manual:u-pao:PM:p-portal', userId: 'u-pao', role: 'PM', projectId: 'p-portal', source: 'manual' },
  ])
})
