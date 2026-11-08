import assert from 'node:assert/strict'
import test from 'node:test'
import { activeAssignments, scopedState, scopeFor } from '../src/shared/access'
import { matchKey, nameSimilarity, seedsStatusFor, type SeedsSnapshot } from '../src/shared/seeds'
import { cleanSeedsBaseUrl, httpSeedsSource, parseSeeds } from '../server/seeds/seeds-client'
import { personalSnapshot, registerSeedsRoutes } from '../server/seeds/seeds-routes'
import { assertLifecycleMutation } from '../src/features/tasks/lifecycle'
import { decideSeedsMatch, planSeedsSync, SEEDS_ACTOR } from '../server/seeds/seeds-sync'
import { roleForSeedsTitle } from '../src/shared/roles'

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
    seeds: { connected: true },
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
      { personId: 'sp-bea', email: 'bea@company.com', role: 'BA', projectId: 's-portal' },
      { personId: 'sp-pao', email: 'paolo@company.com', role: 'PM', clientId: 's-new' },
      { personId: 'sp-x', email: 'xavier@company.com', role: 'BA', projectId: 's-core' },
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

  // Seeds tasks are a pick-list on the project for subtasks; no tasks are created or linked.
  assert.deepEqual(portal.seedsTasks, [
    { id: 's-docs', name: 'Documentation' },
    { id: 's-uat', name: 'UAT Support' },
  ])
  assert.deepEqual(state.items, existing().items, 'tasks and subtasks stay as they are')

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
  assert.equal(counts.created, 3, 'Nimbus, Core Banking and Internal')
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
  assert.equal(
    state.projects.find((p: any) => p.id === 'p-old').seedsTasks,
    undefined,
    'archived projects are left alone',
  )
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

test('only assignments with the person’s email count, whatever its case', () => {
  const { state } = planSeedsSync(existing(), snapshot(), { ...options, userId: 'u-pao' })
  assert.deepEqual(
    activeAssignments(state, 'u-pao').map(a => a.role),
    ['PM'],
  )
  const bea = planSeedsSync(existing(), snapshot(), options).state
  assert.deepEqual(
    activeAssignments(bea, 'u-bea').map(a => a.role),
    ['BA'],
    'Bea@Company.com here is bea@company.com in Seeds',
  )
  const nobody = snapshot({ assignments: [{ personId: 'sp-bea', role: 'BA', projectId: 's-portal' }] })
  assert.deepEqual(
    activeAssignments(planSeedsSync(existing(), nobody, options).state, 'u-bea'),
    [],
    'no email, no assignment',
  )
})

test('one person’s part of the account snapshot is their projects, those clients and those tasks', () => {
  const mine = personalSnapshot(snapshot(), 'bea@company.com')
  assert.deepEqual(
    [mine.projects.map(p => p.id), mine.clients.map(c => c.id), mine.tasks.map(t => t.id)],
    [['s-portal'], ['s-acme'], ['s-uat', 's-docs']],
  )
  assert.deepEqual(personalSnapshot(snapshot(), 'nobody@company.com').projects, [])
})

test('Seeds titles map to job roles; unknown titles are reported, not guessed', () => {
  const { state } = planSeedsSync(
    existing(),
    snapshot({
      assignments: [
        { personId: 'sp-bea', email: 'bea@company.com', role: 'QA Engineer', projectId: 's-portal' },
        { personId: 'sp-bea', email: 'bea@company.com', role: 'Scrum Wizard', clientId: 's-new' },
      ],
    }),
    options,
  )
  assert.deepEqual(
    activeAssignments(state, 'u-bea').map(a => a.role),
    ['QA'],
  )
  assert.deepEqual(state.seeds.users['u-bea'].unknownRoles, ['Scrum Wizard'])
})

test('Seeds answers are read leniently', () => {
  assert.equal(roleForSeedsTitle({}, 'business_analyst'), 'BA')
  assert.equal(roleForSeedsTitle({}, 'Project Manager'), 'PM')
  assert.equal(roleForSeedsTitle({}, 'am'), 'AM')
  assert.equal(roleForSeedsTitle({}, 'Software Engineer'), 'DEV')
  assert.equal(roleForSeedsTitle({}, 'Tester'), 'QA')
  assert.equal(roleForSeedsTitle({}, 'Product Owner'), 'PO')
  assert.equal(roleForSeedsTitle({}, 'Janitor'), null)
  const custom = {
    jobRoles: [{ id: 'BO', name: 'Business Owner', modules: ['action'], edit: [], seedsTitles: ['Sponsor'] }],
  }
  assert.equal(roleForSeedsTitle(custom, 'sponsor'), 'BO')
  assert.deepEqual(parseSeeds.person({ userId: 7, firstName: 'Bea', lastName: 'Cruz', email: 'Bea@Co' }), {
    id: '7',
    name: 'Bea Cruz',
    email: 'bea@co',
    title: '',
  })
  assert.deepEqual(parseSeeds.parent({ parent_id: 1, parent_name: 'Think Library, Inc.', status: 'Archived' }), {
    id: '1',
    name: 'Think Library, Inc.',
    archived: true,
  })
  assert.deepEqual(
    parseSeeds.project({ id: 2, parent: { id: 1 }, projectName: 'Portal', contract: { contractNumber: 'CN-1' } }),
    { id: '2', clientId: '1', seedsClientId: '', name: 'Portal', contractNumber: 'CN-1' },
  )
  assert.deepEqual(parseSeeds.task({ taskId: 3, name: 'UAT', isActive: false }, '2'), {
    id: '3',
    projectId: '2',
    name: 'UAT',
    archived: true,
  })
  assert.deepEqual(parseSeeds.member({ id: 90, userId: 7, role: { name: 'Business Analyst' } }), {
    personId: '7',
    email: '',
    role: 'Business Analyst',
  })
})

test('the Seeds address must be public https', () => {
  assert.equal(cleanSeedsBaseUrl('https://seeds.iripple.com/api/v1/'), 'https://seeds.iripple.com/api/v1')
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

/** A fake Seeds Open API: `{ data }` answers, cursor paging, members and tasks per project. */
function fakeSeeds(overrides: Record<string, any> = {}) {
  const calls: { url: string; auth: string }[] = []
  const answers: Record<string, any> = {
    '/users?limit=100': { data: [{ id: 1, name: 'Bea', email: 'Bea@Company.com' }], nextCursor: 'c2' },
    '/users?limit=100&cursor=c2': { data: [{ id: 2, name: 'Paolo', email: 'paolo@company.com', position: 'PM' }] },
    '/parents?limit=100': { data: [{ id: 5, name: 'Think Library, Inc.' }] },
    '/clients?limit=100': { data: [{ id: 10, parentId: 5 }] },
    '/projects?limit=100': {
      data: [
        { id: 20, parentId: 5, name: 'Curated Meeple OPC', contractNumber: 'CN-1' },
        { id: 21, clientId: 10, name: 'Nobody here' },
      ],
    },
    '/projects/20/members': { data: [{ userId: 1, role: 'Business Analyst' }, { userId: 2 }] },
    '/projects/21/members': { data: [{ userId: 99, role: 'BA' }] },
    '/projects/20/tasks': { data: [{ id: 30, name: 'UAT' }] },
    ...overrides,
  }
  const fetcher = (async (url: string, init: any) => {
    calls.push({ url, auth: init.headers.Authorization })
    const path = url.replace('https://seeds.iripple.com/api/v1', '')
    const body = answers[path]
    return {
      ok: body !== undefined && !body?.error,
      status: body === undefined ? 404 : body?.status || 200,
      headers: new Headers(),
      json: async () => body ?? { error: { code: 'not_found', message: 'Not found' } },
    } as any
  }) as any
  return { calls, fetcher }
}

test('the HTTP reader sends the token, follows cursors and reads only the projects people here are on', async () => {
  const { calls, fetcher } = fakeSeeds()
  const { snapshot: read, fields } = await httpSeedsSource('secret-token', undefined, fetcher).read(
    new Set(['bea@company.com', 'paolo@company.com']),
  )
  assert.ok(calls.every(call => call.auth === 'Bearer secret-token'))
  assert.deepEqual(
    read.people.map(p => p.name),
    ['Bea', 'Paolo'],
  )
  assert.deepEqual(read.assignments, [
    { personId: '1', email: 'bea@company.com', role: 'Business Analyst', projectId: '20' },
    { personId: '2', email: 'paolo@company.com', role: 'PM', projectId: '20' },
  ])
  assert.deepEqual(read.tasks, [{ id: '30', projectId: '20', name: 'UAT' }])
  assert.deepEqual(read.clients, [{ id: '5', name: 'Think Library, Inc.' }], 'Seeds parents are the clients')
  assert.deepEqual(
    read.projects.map(p => [p.id, p.clientId]),
    [
      ['20', '5'],
      ['21', '5'],
    ],
    'a project naming a Seeds client gets that client’s parent',
  )
  assert.ok(!calls.some(call => call.url.endsWith('/projects/21/tasks')), 'no tasks for projects nobody here is on')
  assert.deepEqual(fields.members, ['userId', 'role'])

  const denied = fakeSeeds({ '/parents?limit=100': { status: 403, error: { code: 'forbidden', message: 'No grant' } } })
  await assert.rejects(
    httpSeedsSource('t', undefined, denied.fetcher).read(new Set()),
    /not allowed to read parents.*No grant/,
  )
  const odd = fakeSeeds({ '/projects?limit=100': { data: { what: 1 } } })
  await assert.rejects(httpSeedsSource('t', undefined, odd.fetcher).read(new Set()), /unexpected answer for projects/)
})

// ---- Routes, with a fake Seeds and an in-memory workspace ----

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

/** What Seeds holds for the route tests: Bea is a BA on the portal, Paolo the PM on core banking. */
const account = () =>
  snapshot({
    assignments: [
      { personId: 'sp-bea', email: 'bea@company.com', role: 'BA', projectId: 's-portal' },
      { personId: 'sp-pao', email: 'paolo@company.com', role: 'PM', projectId: 's-core' },
      { personId: 'sp-x', email: 'xavier@company.com', role: 'BA', projectId: 's-core' },
    ],
  })

function setup(source: () => Promise<SeedsSnapshot> = async () => account(), token = 'app-token') {
  let stored: any = { ...existing(), seeds: undefined }
  const app = fakeApp()
  const pass = (_req: any, _res: any, next: () => void) => next()
  const asked: Set<string>[] = []
  registerSeedsRoutes(app, {
    db: { from: () => ({ select: () => ({ is: async () => ({ data: [{ id: 'org' }], error: null }) }) }) },
    requireAuth: pass,
    requireTenant: pass,
    load: async () => ({ data: stored }),
    commit: async (_id, state) => {
      stored = state
    },
    raced: () => false,
    openStatus: () => 'Open',
    today: () => '2026-11-07',
    token: () => token,
    apiUrl: () => 'https://seeds.iripple.com/api/v1',
    source: (given, url) => {
      assert.equal(given, 'app-token')
      assert.equal(url, 'https://seeds.iripple.com/api/v1')
      return {
        read: async emails => {
          asked.push(emails)
          return { snapshot: await source(), fields: { users: ['id', 'email'] } }
        },
      }
    },
  })
  return { app, asked, state: () => stored }
}
const admin = { id: 'admin', role: 'Administrator', modules: ['settings'], organizationId: 'org' }
const bea = { id: 'u-bea', role: 'Contributor', modules: ['items'], organizationId: 'org' }
const pao = { id: 'u-pao', role: 'Contributor', modules: ['items'], organizationId: 'org' }
const turnOn = (app: any) => app.ask('PUT', '/api/account/seeds', admin, {})

test('an Administrator turns Seeds on; one sync matches everyone by email', async () => {
  const { app, asked, state } = setup()
  assert.equal((await app.ask('PUT', '/api/account/seeds', bea, {})).status, 403)
  assert.equal((await app.ask('POST', '/api/seeds/sync', bea)).status, 409, 'not before Seeds is on')
  const on = await turnOn(app)
  assert.equal(on.status, 200, JSON.stringify(on.body))
  assert.equal(on.body.sync.ok, true)
  assert.deepEqual([on.body.sync.matched, on.body.sync.unmatched], [2, 0])
  assert.deepEqual([...asked[0]].sort(), ['bea@company.com', 'paolo@company.com'])
  assert.deepEqual(
    activeAssignments(state(), 'u-bea').map(a => a.role),
    ['BA'],
  )
  assert.deepEqual(
    activeAssignments(state(), 'u-pao').map(a => a.role),
    ['PM'],
  )
  assert.ok(!state().projects.some((p: any) => p.seedsId === 's-internal'), 'projects nobody here is on stay out')
  const overview = await app.ask('GET', '/api/account/seeds', admin)
  assert.equal(overview.body.tokenReady, true)
  assert.deepEqual(overview.body.sync.fields, { users: ['id', 'email'] })
  assert.ok(!JSON.stringify(overview.body).includes('app-token'), 'the token never goes to the browser')
  assert.deepEqual(
    overview.body.people
      .filter((p: any) => p.connected)
      .map((p: any) => p.name)
      .sort(),
    ['Bea', 'Paolo'],
  )

  const off = await app.ask('DELETE', '/api/account/seeds', admin)
  assert.equal(off.status, 200)
  assert.deepEqual(activeAssignments(state(), 'u-pao'), [], 'Seeds off: hand-entered access counts (none for Paolo)')
})

test('someone Seeds does not list keeps their hand-entered access', async () => {
  const { app, state } = setup(async () => snapshot({ assignments: [] }))
  const on = await turnOn(app)
  assert.deepEqual([on.body.sync.matched, on.body.sync.unmatched], [0, 2])
  assert.deepEqual(
    activeAssignments(state(), 'u-bea').map(a => a.id),
    ['m1'],
  )
})

test('without a server token Seeds cannot be turned on', async () => {
  const { app } = setup(undefined, '')
  const on = await turnOn(app)
  assert.equal(on.status, 503)
  assert.match(on.body.error, /SEEDS_API_TOKEN/)
})

test('when Seeds is down the last synced access stays and the error shows', async () => {
  let down = false
  const { app, state } = setup(async () => {
    if (down) throw new Error('ECONNREFUSED')
    return account()
  })
  await turnOn(app)
  const before = activeAssignments(state(), 'u-bea')
  down = true
  const result = await app.ask('POST', '/api/seeds/sync', bea)
  assert.equal(result.body.ok, false)
  assert.deepEqual(activeAssignments(state(), 'u-bea'), before)
  assert.ok(state().seeds.sync.lastError)
  assert.ok(state().seeds.sync.lastSuccessAt, 'the last good sync is still known')
})

test('a reviewer confirms a match', async () => {
  const { app, state } = setup(async () =>
    snapshot({
      projects: [...snapshot().projects, { id: 's-ship', clientId: 's-bolt', name: 'Shipping', contractNumber: '' }],
      assignments: [
        { personId: 'sp-bea', email: 'bea@company.com', role: 'BA', projectId: 's-portal' },
        { personId: 'sp-pao', email: 'paolo@company.com', role: 'PM', projectId: 's-ship' },
      ],
    }),
  )
  await turnOn(app)
  const match = state().seeds.pendingMatches.find((m: any) => m.id === 'client:s-bolt')
  assert.ok(match, JSON.stringify(state().seeds.pendingMatches))
  assert.equal(
    (await app.ask('POST', '/api/seeds/matches/client:s-bolt', bea, { decision: 'confirm' })).status,
    403,
    'BAs do not confirm matches',
  )
  const done = await app.ask('POST', '/api/seeds/matches/client:s-bolt', admin, { decision: 'confirm' })
  assert.equal(done.status, 200, JSON.stringify(done.body))
  assert.equal(state().clients.find((c: any) => c.id === 'c-bolt').seedsId, 's-bolt')
  assert.ok(!state().seeds.pendingMatches.some((m: any) => m.id === 'client:s-bolt'))
})

test('hand-entered assignments: Administrators only, names only, checked', async () => {
  const { app, state } = setup()
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
