import assert from 'node:assert/strict'
import test from 'node:test'
import { activeAssignments, scopedState, scopeFor } from '../src/shared/access'
import {
  keepSeedsFields,
  matchKey,
  moveToBeforeSeeds,
  nameSimilarity,
  seedsStatusFor,
  type SeedsSnapshot,
} from '../src/shared/seeds'
import { cleanSeedsBaseUrl, httpSeedsSource, parseSeeds } from '../server/seeds/seeds-client'
import { personalSnapshot, registerSeedsRoutes } from '../server/seeds/seeds-routes'
import { assertLifecycleMutation } from '../src/features/tasks/lifecycle'
import { planSeedsSync, SEEDS_ACTOR } from '../server/seeds/seeds-sync'
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

const byName = (records: any[], name: string) => records.find(record => record.name === name)

test('Seeds is the source of truth: a sync adds Seeds records fresh and leaves existing work alone', () => {
  counter = 0
  const before = existing()
  const { state, counts, pending } = planSeedsSync(before, snapshot(), { ...options, id: sequential })
  assert.deepEqual(pending, [], 'nothing is matched by name, so there is nothing to confirm')
  assert.deepEqual(
    state.clients.slice(0, 2),
    before.clients,
    'Acme Corporation is not merged with ACME Corp.: existing clients stay as they were',
  )
  const acme = byName(state.clients, 'ACME Corp.')
  assert.equal(acme.seedsId, 's-acme')
  assert.deepEqual(state.projects[0], before.projects[0], 'the existing Customer Portal is left alone')
  const portal = state.projects.find((p: any) => p.seedsId === 's-portal')
  assert.notEqual(portal.id, 'p-portal')
  assert.deepEqual([portal.clientId, portal.contractNumber], [acme.id, 'CN-2026-014'])
  const internal = state.projects.find((p: any) => p.seedsId === 's-internal')
  assert.equal(internal.clientId, undefined, 'internal projects have no client')
  // Seeds tasks are what tasks and subtasks link to; no tasks are created.
  assert.deepEqual(portal.seedsTasks, [
    { id: 's-docs', name: 'Documentation' },
    { id: 's-uat', name: 'UAT Support' },
  ])
  assert.deepEqual(state.items, before.items, 'tasks and subtasks stay as they are')
  assert.deepEqual(
    activeAssignments(state, 'u-bea').map(a => [a.userId, a.role, a.projectId]),
    [['u-bea', 'BA', portal.id]],
    'only Bea’s own assignments, although Seeds also listed her colleagues’',
  )
  assert.equal(state.seeds.users['u-bea'].lastSuccessAt, options.now)
  assert.equal(counts.created, 6, 'three clients and three projects')
})

test('a second sync changes nothing; renames, moves and archiving follow by Seeds id', () => {
  const first = planSeedsSync(existing(), snapshot(), { ...options, id: sequential }).state
  const again = planSeedsSync(first, snapshot(), { ...options, id: sequential })
  assert.equal(again.counts.created, 0)
  assert.deepEqual(again.state.clients, first.clients)
  assert.deepEqual(again.state.projects, first.projects)

  // A task added here under the Seeds project; then Seeds moves the project to another parent.
  const portal = first.projects.find((p: any) => p.seedsId === 's-portal')
  const acme = first.clients.find((c: any) => c.seedsId === 's-acme')
  const withTask = {
    ...first,
    items: [
      ...first.items,
      { id: 't-go', title: 'Go-live prep', projectId: portal.id, clientId: acme.id, type: 'Task', status: 'Open' },
      { id: 't-go-1', title: 'Check printers', projectId: portal.id, clientId: acme.id, parentTaskId: 't-go' },
    ],
  }
  const moved = planSeedsSync(
    withTask,
    snapshot({
      clients: [{ id: 's-acme', name: 'Acme Holdings', archived: true }, ...snapshot().clients.slice(1)],
      projects: [{ ...snapshot().projects[0], clientId: 's-new' }, ...snapshot().projects.slice(1)],
    }),
    { ...options, id: sequential },
  ).state
  const renamed = moved.clients.find((c: any) => c.seedsId === 's-acme')
  assert.deepEqual([renamed.name, renamed.seedsArchived], ['Acme Holdings', true])
  const nimbus = moved.clients.find((c: any) => c.seedsId === 's-new')
  assert.equal(moved.projects.find((p: any) => p.seedsId === 's-portal').clientId, nimbus.id)
  assert.deepEqual(
    moved.items.filter((i: any) => i.id.startsWith('t-go')).map((i: any) => i.clientId),
    [nimbus.id, nimbus.id],
    'its tasks and subtasks follow the project',
  )
  assert.equal(moved.items.find((i: any) => i.id === 't-uat').clientId, 'c-acme', 'work before Seeds is not moved')
})

test('a sync passes the workspace rules: versions move on, archived work is left alone', () => {
  const first = planSeedsSync(existing(), snapshot(), { ...options, id: sequential }).state
  const archived = {
    ...first,
    projects: first.projects.map((p: any) =>
      p.seedsId === 's-portal' ? { ...p, archived: true, status: 'Closed', seedsTasks: undefined } : p,
    ),
  }
  const { state } = planSeedsSync(
    archived,
    snapshot({ clients: [{ id: 's-acme', name: 'Acme Holdings' }, ...snapshot().clients.slice(1)] }),
    options,
  )
  assert.doesNotThrow(() => assertLifecycleMutation(archived, state, SEEDS_ACTOR as any))
  const acme = state.clients.find((c: any) => c.seedsId === 's-acme')
  assert.equal(acme.lifecycleVersion, 1, 'renamed, so its version moves on')
  assert.equal(
    state.clients.find((c: any) => c.id === 'c-bolt').lifecycleVersion,
    undefined,
    'untouched records keep theirs',
  )
  assert.equal(
    state.projects.find((p: any) => p.seedsId === 's-portal').seedsTasks,
    undefined,
    'archived projects are left alone',
  )
})

test('turning Seeds on moves everything that exists to Before Seeds, once; everyone can open and change it', () => {
  const before: any = { ...existing(), seeds: { connected: true } }
  const moved = moveToBeforeSeeds(before, options.now)
  assert.deepEqual(
    [...moved.clients, ...moved.projects].map((r: any) => [r.id, r.beforeSeeds, r.lifecycleVersion]),
    [
      ['c-acme', true, 1],
      ['c-bolt', true, 1],
      ['p-portal', true, 1],
    ],
  )
  assert.equal(moved.seeds.cutoverAt, options.now)
  assert.doesNotThrow(() => assertLifecycleMutation(before, moved, SEEDS_ACTOR as any))
  assert.equal(moveToBeforeSeeds(moved, 'later'), moved, 'only the first time')

  // Synced: Seeds records come in beside Before Seeds; nothing old is touched.
  const synced = planSeedsSync(moved, snapshot(), { ...options, id: sequential }).state
  assert.equal(synced.clients.filter((c: any) => c.beforeSeeds).length, 2)
  assert.ok(!synced.clients.some((c: any) => c.seedsId && c.beforeSeeds))

  // Paolo has no assignment there, yet sees and can change all of Before Seeds.
  const scope = scopeFor(synced, 'u-pao')
  assert.ok(scope.fullClients.has('c-acme') && scope.writeClients.has('c-bolt'))
  assert.ok(scope.writeProjects.has('p-portal'))
  assert.ok(['t-uat', 't-sub', 't-local'].every(id => scope.writableItems.has(id)))
  // …but not Bea's Seeds project.
  const portal = synced.projects.find((p: any) => p.seedsId === 's-portal')
  assert.ok(!scope.fullProjects.has(portal.id))

  // The browser cannot take a record out of Before Seeds, or put one in.
  const kept = keepSeedsFields(synced, {
    ...synced,
    clients: synced.clients.map((c: any) =>
      c.id === 'c-acme' ? { ...c, beforeSeeds: undefined } : c.seedsId ? { ...c, beforeSeeds: true } : c,
    ),
  })
  assert.equal(kept.clients.find((c: any) => c.id === 'c-acme').beforeSeeds, true)
  assert.ok(!kept.clients.some((c: any) => c.seedsId && c.beforeSeeds))
})

test('Administrators see each person’s sync; only they see the list', () => {
  const bea = planSeedsSync(existing(), snapshot(), { ...options, id: sequential }).state
  const state = planSeedsSync(bea, snapshot(), { ...options, userId: 'u-pao', id: sequential }).state
  assert.equal(seedsStatusFor(state, { id: 'u-pao', role: 'Contributor' }).people, undefined)
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

test('when Seeds says to slow down, the reader waits as asked, widens the gap and carries on', async () => {
  const { fetcher } = fakeSeeds()
  let busyOnce = true
  const waits: number[] = []
  const steps: string[] = []
  const slowing = (async (url: string, init: any) => {
    if (busyOnce && url.endsWith('/projects/20/members')) {
      busyOnce = false
      return { ok: false, status: 429, headers: new Headers({ 'retry-after': '7' }), json: async () => ({}) } as any
    }
    return fetcher(url, init)
  }) as any
  const { snapshot: read } = await httpSeedsSource('t', undefined, slowing, 1000, {
    gapMs: 0,
    sleep: async ms => waits.push(ms),
    onProgress: step => steps.push(`${step.step}:${step.done}/${step.total}`),
  }).read(new Set(['bea@company.com']))
  assert.equal(read.assignments.length, 1, 'the sync finished after waiting')
  assert.ok(waits.includes(7000), 'waited as long as Seeds asked')
  assert.deepEqual(steps.slice(0, 4), ['lists:0/3', 'lists:1/3', 'lists:2/3', 'lists:3/3'])
  assert.ok(steps.includes('members:1/2') && steps.includes('tasks:0/1'))

  const always = (async () =>
    ({ ok: false, status: 429, headers: new Headers(), json: async () => ({}) }) as any) as any
  await assert.rejects(
    httpSeedsSource('t', undefined, always, 1000, { gapMs: 0, retries: 2, sleep: async () => {} }).read(new Set()),
    /reads too fast/,
  )
})

test('a long sync answers that it is running, and the card can follow it', async () => {
  const { createSeedsService } = await import('../server/seeds/seeds-routes')
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  let stored: any = { ...existing(), seeds: { connected: true } }
  const service = createSeedsService({
    db: {},
    requireAuth: () => {},
    requireTenant: () => {},
    load: async () => ({ data: stored }),
    commit: async (_id, state) => {
      stored = state
    },
    raced: () => false,
    openStatus: () => 'Open',
    today: () => '2026-11-09',
    token: () => 'app-token',
    apiUrl: () => 'https://seeds.iripple.com/api/v1',
    source: (_token, _url, options) => ({
      read: async () => {
        options.onProgress?.({ step: 'members', done: 3, total: 40 })
        await gate
        return { snapshot: account(), fields: {} }
      },
    }),
  })
  const early: any = await service.syncFor('org', 20)
  assert.equal(early.running, true)
  assert.deepEqual(service.status('org'), {
    running: true,
    progress: { step: 'members', done: 3, total: 40, startedAt: (service.status('org') as any).progress.startedAt },
  })
  release()
  const done: any = await service.sync('org')
  assert.equal(done.ok, true)
  assert.deepEqual(service.status('org'), { running: false })
  assert.equal(stored.seeds.sync.matched, 2)
})

test('Seeds ids: the whole-number field wins; a project Seeds turns down is skipped, not fatal', async () => {
  assert.equal(parseSeeds.project({ id: 'PRJ-0042', projectId: 42, name: 'Portal' }).id, '42')
  assert.equal(parseSeeds.person({ id: 'a1b2', userId: 7, email: 'x@y' }).id, '7')
  const { fetcher } = fakeSeeds({
    '/projects?limit=100': {
      data: [
        { id: 20, parentId: 5, name: 'Curated Meeple OPC' },
        { id: 'not-a-number', parentId: 5, name: 'Odd one' },
        { id: 22, parentId: 5, name: 'Turned down' },
      ],
    },
    '/projects/22/members': { status: 400, error: { code: 'bad', message: 'projectId is invalid' } },
  })
  const read = await httpSeedsSource('t', undefined, fetcher, 1000, { gapMs: 0, sleep: async () => {} }).read(
    new Set(['bea@company.com']),
  )
  assert.deepEqual(read.skipped?.sort(), ['22', 'not-a-number'])
  assert.equal(read.snapshot.assignments.length, 1, 'the rest synced')

  const broken = fakeSeeds({ '/projects?limit=100': { status: 500, error: { code: 'x', message: 'boom' } } })
  await assert.rejects(
    httpSeedsSource('t', undefined, broken.fetcher, 1000, { gapMs: 0, sleep: async () => {} }).read(new Set()),
    (error: any) => Boolean(error.fields?.users && error.fields?.parents),
    'field names read so far are kept on a failure',
  )
})

test('a quick sync reads members only for new, changed and already-linked projects', async () => {
  const projectsList = {
    data: [
      { id: 20, parentId: 5, name: 'Linked already', updatedAt: '2026-01-01T00:00:00Z' },
      { id: 21, parentId: 5, name: 'Old, untouched', updated_at: '2026-01-01T00:00:00Z' },
      { id: 23, parentId: 5, name: 'Changed today', updatedAt: '2026-11-09T01:00:00Z' },
      { id: 24, parentId: 5, name: 'Brand new' },
    ],
  }
  const { calls, fetcher } = fakeSeeds({
    '/projects?limit=100': projectsList,
    '/projects/23/members': { data: [] },
    '/projects/24/members': { data: [] },
  })
  const read = await httpSeedsSource('t', undefined, fetcher, 1000, { gapMs: 0, sleep: async () => {} }).read(
    new Set(['bea@company.com']),
    { since: '2026-11-08T00:00:00Z', known: new Set(['20', '21', '23']), keep: new Set(['20']) },
  )
  const membersRead = calls.map(call => call.url.match(/projects\/(\d+)\/members/)?.[1]).filter(Boolean)
  assert.deepEqual(membersRead, ['20', '23', '24'], 'not 21: known, untouched, nobody from here on it')
  assert.equal(read.checked, 3)
  assert.deepEqual(read.projectIds, ['20', '21', '23', '24'])
  assert.equal(read.snapshot.assignments.length, 1, 'Bea is still on 20')
  assert.ok(!('changedAt' in read.snapshot.projects[0]))

  const full = fakeSeeds({
    '/projects?limit=100': projectsList,
    '/projects/23/members': { data: [] },
    '/projects/24/members': { data: [] },
  })
  await httpSeedsSource('t', undefined, full.fetcher, 1000, { gapMs: 0, sleep: async () => {} }).read(new Set())
  assert.equal(full.calls.filter(call => call.url.includes('/members')).length, 4, 'a full sync reads them all')
})

test('the first sync is full, the next quick, and Full sync forces one', async () => {
  const { createSeedsService } = await import('../server/seeds/seeds-routes')
  let stored: any = { ...existing(), seeds: { connected: true } }
  const plans: any[] = []
  const service = createSeedsService({
    db: {},
    requireAuth: () => {},
    requireTenant: () => {},
    load: async () => ({ data: stored }),
    commit: async (_id, state) => {
      stored = state
    },
    raced: () => false,
    openStatus: () => 'Open',
    today: () => '2026-11-09',
    token: () => 'app-token',
    apiUrl: () => 'https://seeds.iripple.com/api/v1',
    source: () => ({
      read: async (_emails, quick) => {
        plans.push(quick)
        return { snapshot: account(), fields: {}, projectIds: ['s-portal', 's-core', 's-internal'], checked: 3 }
      },
    }),
  })
  await service.sync('org')
  assert.equal(plans[0], undefined, 'first: full')
  assert.equal(stored.seeds.sync.mode, 'full')
  assert.deepEqual(stored.seeds.sync.memberProjects.sort(), ['s-core', 's-portal'])
  await service.sync('org')
  assert.deepEqual([...plans[1].known].sort(), ['s-core', 's-internal', 's-portal'])
  assert.deepEqual([...plans[1].keep].sort(), ['s-core', 's-portal'])
  assert.equal(stored.seeds.sync.mode, 'quick')
  await service.sync('org', true)
  assert.equal(plans[2], undefined, 'Full sync asked for')
})
