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
import { answerShape, cleanSeedsBaseUrl, httpSeedsSource, nextCursorOf, parseSeeds } from '../server/seeds/seeds-client'
import { personalSnapshot, registerSeedsRoutes } from '../server/seeds/seeds-routes'
import { assertLifecycleMutation } from '../src/features/tasks/lifecycle'
import { planSeedsSync, refreshSeedsClients, refreshSeedsProjects, SEEDS_ACTOR } from '../server/seeds/seeds-sync'
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

test('every open Seeds project is kept here, under its client, with its Seeds tasks', () => {
  let n = 0
  const id = () => `p${++n}`
  const before = {
    clients: [{ id: 'c1', name: 'iRipple Group', seedsId: '1' }],
    projects: [{ id: 'old', name: 'Linked', seedsId: '10', seedsTasks: [] }],
  }
  const after = refreshSeedsProjects(
    before,
    {
      projects: [
        { id: '10', clientId: '1', name: 'Linked', contractNumber: '' },
        { id: '11', clientId: '1', name: 'Company-Wide Programs', contractNumber: '' },
        { id: '12', clientId: '', name: 'PD-ADMIN TASKS', contractNumber: '' },
        { id: '13', clientId: '9', name: 'Under a client not here', contractNumber: '' },
        { id: '14', clientId: '1', name: 'Done', contractNumber: '', archived: true },
      ],
      tasks: [
        { id: 't2', projectId: '11', name: 'Trainings' },
        { id: 't1', projectId: '11', name: 'Meetings' },
        { id: 't3', projectId: '10', name: 'Go Live' },
      ],
    },
    id,
  )
  assert.deepEqual(
    after.projects.map((p: any) => [p.id, p.name, p.clientId || '', (p.seedsTasks || []).map((t: any) => t.name)]),
    [
      ['old', 'Linked', '', ['Go Live']],
      ['p1', 'Company-Wide Programs', 'c1', ['Meetings', 'Trainings']],
      ['p2', 'PD-ADMIN TASKS', '', []],
    ],
  )
})

test('every Seeds client is kept here: added, renamed and closed by Seeds id, never by name', () => {
  let n = 0
  const id = () => `c${++n}`
  const before = {
    clients: [
      { id: 'old', name: 'Emperador (typed by hand)' },
      { id: 'k', name: 'Old name', seedsId: '7' },
    ],
  }
  const after = refreshSeedsClients(
    before,
    [
      { id: '38', name: 'EMPERADOR DISTILLERS, INC.' },
      { id: '7', name: 'New name', archived: true },
      { id: '9', name: 'Gone Co', archived: true },
    ],
    id,
  )
  assert.deepEqual(
    after.clients.map((c: any) => [c.id, c.name, c.seedsId || '', Boolean(c.seedsArchived)]),
    [
      ['old', 'Emperador (typed by hand)', '', false],
      ['k', 'New name', '7', true],
      ['c1', 'EMPERADOR DISTILLERS, INC.', '38', false],
    ],
  )
  assert.equal(refreshSeedsClients(after, [{ id: '38', name: 'EMPERADOR DISTILLERS, INC.' }], id), after, 'no change')
})

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

  assert.deepEqual(
    parseSeeds.person({
      id: '10',
      email: 'jdelfin@iripple.com',
      Employee: [
        {
          firstName: 'JONATHAN',
          lastName: 'DELFIN',
          currentRole: 'Software Engineer - Barter',
          department: { id: 18 },
        },
      ],
    }),
    {
      id: '10',
      name: 'JONATHAN DELFIN',
      email: 'jdelfin@iripple.com',
      title: 'Software Engineer - Barter',
    },
  )
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

test('the HTTP reader sends the token, follows cursors, reads every open project’s members and tasks', async () => {
  const { calls, fetcher } = fakeSeeds()
  const { snapshot: read, fields } = await httpSeedsSource('secret-token', undefined, fetcher, 1000, {
    gapMs: 0,
    sleep: async () => {},
  }).read(new Set(['bea@company.com', 'paolo@company.com']))
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
  assert.ok(
    calls.some(call => call.url.endsWith('/projects/21/tasks')),
    'Seeds tasks of every open project, also one nobody here is on',
  )
  assert.deepEqual(fields.members, ['userId', 'role'])

  const denied = fakeSeeds({ '/parents?limit=100': { status: 403, error: { code: 'forbidden', message: 'No grant' } } })
  await assert.rejects(
    httpSeedsSource('t', undefined, denied.fetcher, 1000, { gapMs: 0, sleep: async () => {} }).read(new Set()),
    /not allowed to read parents.*No grant/,
  )
  const odd = fakeSeeds({ '/projects?limit=100': { data: { what: 1 } } })
  await assert.rejects(
    httpSeedsSource('t', undefined, odd.fetcher, 1000, { gapMs: 0, sleep: async () => {} }).read(new Set()),
    /unexpected answer for projects/,
  )
})

test('the next page is found wherever Seeds marks it, and each list says how it was read', async () => {
  for (const body of [
    { data: [], nextCursor: 'n' },
    { data: [], meta: { next_cursor: 'n' } },
    { data: [], pagination: { nextCursor: 'n' } },
    { data: [], meta: { pagination: { nextCursor: 'n' } } },
    { data: { items: [], nextCursor: 'n' } },
    { data: [], links: { next: '/api/v1/parents?limit=100&cursor=n' } },
    { data: [], paging: { cursors: { after: 'n' } } },
  ])
    assert.equal(nextCursorOf(body), 'n', JSON.stringify(body))
  assert.equal(nextCursorOf({ data: [], links: { next: null } }), '')
  assert.equal(
    answerShape({ success: true, data: [1], meta: { total: 3, page: 1 } }),
    'success, data, meta{total, page}',
  )

  const hundred = Array.from({ length: 100 }, (_, i) => ({ id: i + 100, name: `Parent ${i}` }))
  const { fetcher } = fakeSeeds({
    '/parents?limit=100': { data: hundred, meta: { page: 1, total: 101 } },
  })
  const source = httpSeedsSource('t', undefined, fetcher, 1000, { gapMs: 0, sleep: async () => {} })
  const { fields } = await source.read(new Set())
  assert.deepEqual(fields.paging?.slice(0, 2), [
    'users: 2 in 2 pages',
    'parents: 100 in 1 page (last page full and no next-page marker found; answer: data, meta{page, total})',
  ])
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
  const internal = state().projects.find((p: any) => p.seedsId === 's-internal')
  assert.ok(internal && !internal.clientId, 'a project nobody here is on comes in too, to log time on')
  assert.ok(!state().access.assignments.some((a: any) => a.projectId === internal.id), 'but nobody is assigned to it')
  assert.ok(
    state().clients.some((c: any) => c.seedsId === 's-bolt' && c.name === 'Bolt Logistics'),
    'every Seeds client comes in, also one with no project anyone here is on',
  )
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
  assert.ok(steps.includes('members:1/2') && steps.includes('tasks:0/2'))

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

const since = '2026-11-08T00:00:00.000Z'
const deltaKey = `/projects?limit=100&updatedSince=${encodeURIComponent(since)}`

test('a delta sync reads only the projects Seeds changed, and only their members and tasks', async () => {
  const { calls, fetcher } = fakeSeeds({
    [deltaKey]: {
      data: [
        {
          id: 20,
          parentId: 5,
          name: 'Curated Meeple OPC',
          updatedAt: '2026-11-09T01:00:00Z',
          contractReference: 'REF-77',
          timeEntryRequirements: { productRequired: true, taskRequired: 'required' },
          timeEntryDefaults: { productId: 9, taskId: 30 },
        },
        {
          id: 25,
          parentId: 6,
          parent: { id: 6, name: 'Nimbus Bank' },
          name: 'New store',
          updatedAt: '2026-11-09T02:00:00Z',
        },
        { id: 26, parentId: 7, name: 'Under an unknown parent', updatedAt: '2026-11-09T00:30:00Z' },
        { id: 1059, deleted: true, updatedAt: '2026-11-09T03:00:00Z' },
      ],
    },
    // Members carry email and organizational role now.
    '/projects/20/members': { data: [{ userId: 1, email: 'Bea@Company.com', organizationalRole: 'Business Analyst' }] },
    '/projects/25/members': { data: [{ userId: 2, email: 'paolo@company.com', organizationalRole: 'PM' }] },
    '/projects/26/members': { data: [] },
    '/projects/25/tasks': { data: [{ id: 31, name: 'Go Live' }] },
    '/parents/7': { data: { id: 7, name: 'Seventh Parent' } },
  })
  const read = await httpSeedsSource('t', undefined, fetcher, 1000, { gapMs: 0, sleep: async () => {} }).read(
    new Set(['bea@company.com', 'paolo@company.com']),
    { since, parents: new Set(['5']), products: new Set(['9']) },
  )
  const paths = calls.map(call => call.url.replace('https://seeds.iripple.com/api/v1', ''))
  assert.deepEqual(paths, [
    deltaKey,
    '/parents/7',
    '/projects/20/members',
    '/projects/25/members',
    '/projects/26/members',
    '/projects/20/tasks',
    '/projects/25/tasks',
    '/projects/26/tasks',
  ])
  assert.ok(!paths.some(path => /^\/(users|parents|statuses)\?/.test(path)), 'no full lists in a delta')
  assert.ok(!paths.includes('/projects/1059/members'), 'no members for a deleted project')
  assert.equal(read.mode, 'delta')
  assert.deepEqual(read.projectIds, ['20', '25', '26', '1059'])
  assert.equal(read.watermark, '2026-11-09T03:00:00.000Z', 'the next delta starts from Seeds’ latest change')
  assert.deepEqual(read.snapshot.people, [])
  assert.deepEqual(
    read.snapshot.clients.map(client => client.name).sort(),
    ['Nimbus Bank', 'Seventh Parent'],
    'named on the project, or read by id; a linked parent is not read',
  )
  assert.deepEqual(read.snapshot.assignments, [
    { personId: '1', email: 'bea@company.com', role: 'Business Analyst', projectId: '20' },
    { personId: '2', email: 'paolo@company.com', role: 'PM', projectId: '25' },
  ])
  const portal = read.snapshot.projects.find(project => project.id === '20')
  assert.equal(portal?.contractNumber, 'REF-77', 'the contract reference stands in for a number')
  assert.deepEqual(portal?.timeRules, {
    productRequired: true,
    taskRequired: true,
    defaultProductId: '9',
    defaultTaskId: '30',
  })
  assert.equal(read.snapshot.projects.find(project => project.id === '1059')?.archived, true, 'deleted: closed')
  assert.ok(read.fields.projects?.includes('timeEntryDefaults.productId'), 'nested field names are reported')
})

test('when Seeds turns down updatedSince, the delta becomes a full read', async () => {
  const { calls, fetcher } = fakeSeeds({
    [deltaKey]: { status: 400, error: { code: 'bad_request', message: 'Unknown parameter updatedSince' } },
  })
  const read = await httpSeedsSource('t', undefined, fetcher, 1000, { gapMs: 0, sleep: async () => {} }).read(
    new Set(['bea@company.com']),
    { since },
  )
  assert.equal(read.mode, 'full')
  assert.ok(calls.some(call => call.url.endsWith('/users?limit=100')))
  assert.equal(read.snapshot.assignments.length, 1)
})

test('Seeds’ 20 requests a minute: about 3 seconds between requests', async () => {
  const { SEEDS_GAP_MS } = await import('../server/seeds/seeds-client')
  assert.ok(SEEDS_GAP_MS >= 3000)
  const { fetcher } = fakeSeeds({ [deltaKey]: { data: [] } })
  const waits: number[] = []
  let clock = 0
  const realNow = Date.now
  Date.now = () => clock
  try {
    const source = httpSeedsSource('t', undefined, fetcher, 1000, {
      sleep: async ms => {
        waits.push(ms)
        clock += ms
      },
    })
    await source.read(new Set(), { since })
    await source.read(new Set(), { since })
  } finally {
    Date.now = realNow
  }
  assert.ok(waits.length >= 1 && waits.every(ms => ms >= 3000), 'the second request waited its turn')
})

function deltaService(reads: ((plan: any) => any)[]) {
  return import('../server/seeds/seeds-routes').then(({ createSeedsService }) => {
    const plans: any[] = []
    const box: { stored: any } = { stored: { ...existing(), seeds: { connected: true } } }
    const service = createSeedsService({
      db: {},
      requireAuth: () => {},
      requireTenant: () => {},
      load: async () => ({ data: box.stored }),
      commit: async (_id, state) => {
        box.stored = state
      },
      raced: () => false,
      openStatus: () => 'Open',
      today: () => '2026-11-13',
      token: () => 'app-token',
      apiUrl: () => 'https://seeds.iripple.com/api/v1',
      source: () => ({
        read: async (_emails, plan) => {
          plans.push(plan)
          return reads[plans.length - 1](plan)
        },
      }),
    })
    return { service, plans, box }
  })
}

test('the first sync is full, the next ones delta from Seeds’ last change, and Full sync forces one', async () => {
  const { service, plans, box } = await deltaService([
    () => ({
      snapshot: account(),
      fields: { users: ['id'] },
      mode: 'full',
      watermark: '2026-11-13T01:00:00.000Z',
      checked: 3,
    }),
    () => ({
      snapshot: snapshot({ people: [], clients: [], projects: [], tasks: [], assignments: [] }),
      fields: { projects: ['id'] },
      mode: 'delta',
      projectIds: [],
      checked: 0,
    }),
    () => ({ snapshot: account(), fields: {}, mode: 'full' }),
  ])
  await service.sync('org')
  assert.equal(plans[0], undefined, 'first: full')
  assert.equal(box.stored.seeds.sync.mode, 'full')
  assert.equal(box.stored.seeds.sync.updatedSince, '2026-11-13T01:00:00.000Z')
  const people = box.stored.seeds.people.length
  await service.sync('org')
  assert.equal(plans[1].since, '2026-11-13T00:50:00.000Z', 'ten minutes of overlap')
  assert.ok(plans[1].parents.has('s-acme'), 'linked parents are not read again')
  assert.equal(box.stored.seeds.sync.mode, 'delta')
  assert.equal(box.stored.seeds.sync.updatedSince, '2026-11-13T01:00:00.000Z', 'nothing changed: same start')
  assert.equal(box.stored.seeds.people.length, people, 'a delta keeps the people directory')
  assert.deepEqual(box.stored.seeds.sync.fields, { users: ['id'], projects: ['id'] }, 'field names add up')
  assert.deepEqual(
    activeAssignments(box.stored, 'u-bea').map(a => a.role),
    ['BA'],
    'untouched access stays',
  )
  await service.sync('org', true)
  assert.equal(plans[2], undefined, 'Full sync asked for')
})

test('a delta replaces access only on the projects it read, and closes linked projects nobody here is on', async () => {
  const { service, box } = await deltaService([
    () => ({ snapshot: account(), fields: {}, mode: 'full', watermark: '2026-11-13T01:00:00.000Z' }),
    // Seeds changed the portal (Bea taken off) and closed core banking.
    () => ({
      snapshot: {
        people: [],
        clients: [],
        projects: [
          { id: 's-portal', clientId: 's-acme', name: 'Customer Portal', contractNumber: 'CN-2026-014' },
          { id: 's-core', clientId: 's-new', name: 'Core Banking', contractNumber: 'CN-2026-020', archived: true },
        ],
        tasks: [],
        assignments: [],
      },
      fields: {},
      mode: 'delta',
      projectIds: ['s-portal', 's-core'],
      watermark: '2026-11-13T02:00:00.000Z',
    }),
  ])
  await service.sync('org')
  assert.deepEqual(
    activeAssignments(box.stored, 'u-bea').map(a => a.role),
    ['BA'],
  )
  await service.sync('org')
  assert.deepEqual(
    activeAssignments(box.stored, 'u-bea').filter(a => a.source === 'seeds'),
    [],
    'Bea is off the portal in Seeds',
  )
  const core = box.stored.projects.find((project: any) => project.seedsId === 's-core')
  assert.equal(core.seedsArchived, true, 'closed in Seeds, closed here, though nobody here is on it now')
  assert.equal(box.stored.seeds.sync.updatedSince, '2026-11-13T02:00:00.000Z')
})

test('time entries take the project’s default Seeds task and product; a required product is checked', async () => {
  const { seedsTimeBody } = await import('../server/seeds/seeds-time')
  const entry: any = { id: 'e1', date: '2026-11-13', hours: 1, note: 'Go Live – Makati T1' }
  const state = (rules: any, product?: string) => ({
    clients: [{ id: 'c1', seedsId: '5' }],
    projects: [
      {
        id: 'p1',
        clientId: 'c1',
        seedsId: '20',
        seedsTimeRules: rules,
        ...(product ? { seedsProductId: product } : {}),
      },
    ],
  })
  const task = { projectId: 'p1' }
  const filled: any = seedsTimeBody(state({ defaultTaskId: '30', defaultProductId: '9' }), task, entry)
  assert.equal(filled.ok, true)
  assert.deepEqual([filled.body.taskId, filled.body.productId], [30, 9])
  const defaults = { defaultTaskId: '30', defaultProductId: '9' }
  const own: any = seedsTimeBody(state(defaults, '4'), task, { ...entry, seedsTaskId: '31' })
  assert.deepEqual([own.body.taskId, own.body.productId], [31, 4], 'the entry’s own task and project product win')
  const missing: any = seedsTimeBody(state({ productRequired: true }), task, { ...entry, seedsTaskId: '31' })
  assert.equal(missing.ok, false)
  assert.match(missing.error, /Choose the Seeds product in Log time/)
})

test('Seeds products: read in a full sync, again in a delta only when a change names a new one', async () => {
  const products = {
    '/products?limit=100': {
      data: [
        { id: 9, name: 'Barter CX' },
        { id: 4, productName: 'RPOS 5.1' },
        { id: 8, name: 'Old one', isActive: false },
      ],
    },
  }
  const full = fakeSeeds(products)
  const read = await httpSeedsSource('t', undefined, full.fetcher, 1000, { gapMs: 0, sleep: async () => {} }).read(
    new Set(['bea@company.com']),
  )
  assert.deepEqual(read.snapshot.products, [
    { id: '9', name: 'Barter CX' },
    { id: '4', name: 'RPOS 5.1' },
    { id: '8', name: 'Old one', archived: true },
  ])
  const noGrant = fakeSeeds({ '/products?limit=100': { status: 403, error: { code: 'forbidden', message: 'x' } } })
  const quick = { gapMs: 0, sleep: async () => {} }
  const without = await httpSeedsSource('t', undefined, noGrant.fetcher, 1000, quick).read(new Set(['bea@company.com']))
  assert.deepEqual(without.snapshot.products, [], 'without core.products.read the sync still works')

  const changes = (productId: number) =>
    fakeSeeds({
      ...products,
      [deltaKey]: { data: [{ id: 20, parentId: 5, name: 'P', productId, updatedAt: '2026-11-09T01:00:00Z' }] },
      '/projects/20/members': { data: [] },
    })
  const known = changes(9)
  const quiet = await httpSeedsSource('t', undefined, known.fetcher, 1000, { gapMs: 0, sleep: async () => {} }).read(
    new Set(),
    { since, parents: new Set(['5']), products: new Set(['9', '4']) },
  )
  assert.equal(quiet.snapshot.products, undefined, 'known product: list not read, kept as it is')
  assert.ok(!known.calls.some(call => call.url.includes('/products')))
  const fresh = changes(12)
  const reread = await httpSeedsSource('t', undefined, fresh.fetcher, 1000, { gapMs: 0, sleep: async () => {} }).read(
    new Set(),
    { since, parents: new Set(['5']), products: new Set(['9', '4']) },
  )
  assert.equal(reread.snapshot.products?.length, 3, 'a new product id: list read again')
})

test('a Seeds task can require a product; the task’s pick wins; the time rule flags what is missing', async () => {
  const { seedsProductFor, seedsStatusFor } = await import('../src/shared/seeds')
  const { seedsTimeRule } = await import('../src/features/tasks/effort')
  assert.deepEqual(parseSeeds.task({ id: 31, name: 'Go Live', productRequired: true, defaultProductId: 9 }, '20'), {
    id: '31',
    projectId: '20',
    name: 'Go Live',
    productRequired: true,
    defaultProductId: '9',
  })
  const state: any = {
    seeds: { connected: true, products: [{ id: '4', name: 'RPOS' }] },
    projects: [
      {
        id: 'p1',
        seedsId: '20',
        seedsTasks: [
          { id: '30', name: 'Meetings' },
          { id: '31', name: 'Go Live', productRequired: true },
          { id: '32', name: 'Training', productRequired: true, defaultProductId: '9' },
        ],
      },
    ],
  }
  const task = { id: 't1', title: 'Makati T1', projectId: 'p1' }
  assert.deepEqual(seedsProductFor(state, task, '30'), { productId: '', required: false, missing: false })
  assert.deepEqual(seedsProductFor(state, task, '31'), { productId: '', required: true, missing: true })
  assert.deepEqual(seedsProductFor(state, task, '32'), { productId: '9', required: true, missing: false })
  assert.equal(seedsProductFor(state, { ...task, productId: '4' }, '32').productId, '4', 'picked on the task wins')
  assert.deepEqual(seedsTimeRule(state, task)?.needsProduct, ['31'])
  assert.equal(seedsTimeRule(state, { ...task, productId: '4' })?.needsProduct, undefined)

  const { seedsTimeBody } = await import('../server/seeds/seeds-time')
  const entry: any = { id: 'e1', date: '2026-11-13', hours: 0.5, note: 'Go Live', seedsTaskId: '31' }
  assert.equal((seedsTimeBody(state, task, entry) as any).ok, false, 'not sent without the product')
  const sent: any = seedsTimeBody(state, { ...task, productId: '4' }, entry)
  assert.equal(sent.body.productId, 4)
  assert.deepEqual(seedsStatusFor(state, { id: 'u1' }).products, [{ id: '4', name: 'RPOS' }])
})

test('a sync keeps the product list it read, and the last one when it read none', async () => {
  const { service, box } = await deltaService([
    () => ({
      snapshot: { ...account(), products: [{ id: '9', name: 'Barter CX' }] },
      fields: {},
      mode: 'full',
      watermark: '2026-11-13T01:00:00.000Z',
    }),
    (plan: any) => {
      assert.deepEqual([...plan.products], ['9'], 'known products go to the delta')
      return { snapshot: { ...account(), assignments: [] }, fields: {}, mode: 'delta', projectIds: [] }
    },
  ])
  await service.sync('org')
  assert.deepEqual(box.stored.seeds.products, [{ id: '9', name: 'Barter CX' }])
  await service.sync('org')
  assert.deepEqual(box.stored.seeds.products, [{ id: '9', name: 'Barter CX' }])
})

test('closed, resolved and completed Seeds projects count as closed, by name or by status id', async () => {
  const { closedStatus } = await import('../server/seeds/seeds-client')
  for (const status of ['Closed', 'RESOLVED', 'Completed', 'Cancelled', 'Done', 'Closed - Resolved', 'Archived'])
    assert.equal(closedStatus(status), true, status)
  for (const status of ['Open', 'In Progress', 'Pre Live', 'Live', 'On going', ''])
    assert.equal(closedStatus(status), false, status)
  assert.equal(parseSeeds.project({ id: 1, name: 'P', status: { name: 'Resolved' } }).archived, true)
  assert.equal(parseSeeds.project({ id: 2, name: 'P', projectStatus: 'Ongoing' }).archived, undefined)

  const { fetcher } = fakeSeeds({
    '/projects?limit=100': {
      data: [
        { id: 20, parentId: 5, name: 'Open one', statusId: 1 },
        { id: 21, parentId: 5, name: 'Resolved one', statusId: 2 },
      ],
    },
    '/statuses?limit=100': {
      data: [
        { id: 1, name: 'Ongoing' },
        { id: 2, name: 'Resolved' },
      ],
    },
  })
  const read = await httpSeedsSource('t', undefined, fetcher, 1000, { gapMs: 0, sleep: async () => {} }).read(
    new Set(['bea@company.com']),
  )
  assert.deepEqual(
    read.snapshot.projects.map(project => [project.id, Boolean(project.archived)]),
    [
      ['20', false],
      ['21', true],
    ],
  )
})

test('a linked project Seeds no longer lists is asked for by id, and closed when Seeds says completed', async () => {
  const { calls, fetcher } = fakeSeeds({
    // The shape Seeds sends for one project: the record under `data`, the status as an object.
    '/projects/1059': {
      data: { id: 1059, name: 'GOLDWING BALABALA', projectStatus: { id: 4, name: 'Completed' }, parent: { id: 5 } },
    },
    '/projects/1060': { data: { id: 1060, name: 'Hidden but open', projectStatus: { id: 1, name: 'Ongoing' } } },
  })
  const read = await httpSeedsSource('t', undefined, fetcher, 1000, { gapMs: 0, sleep: async () => {} }).read(
    new Set(['bea@company.com']),
    undefined,
    new Set(['20', '1059', '1060', '1061']),
  )
  const found = read.snapshot.projects.find(project => project.id === '1059')
  assert.deepEqual([found?.name, found?.archived, found?.clientId], ['GOLDWING BALABALA', true, '5'])
  assert.ok(!read.snapshot.projects.some(project => project.id === '1060'), 'an open one is left as it is')
  assert.ok(!read.snapshot.projects.some(project => project.id === '1061'), 'one Seeds does not have is skipped')
  assert.ok(!calls.some(call => call.url.endsWith('/projects/20')), 'a listed project is not asked for again')
  assert.ok(!calls.some(call => call.url.endsWith('/projects/1059/members')), 'no members for a closed project')

  // A list that gives only the status id, under the project status name, is still told apart through /statuses.
  const byId = fakeSeeds({
    '/projects?limit=100': { data: [{ id: 20, parentId: 5, name: 'Done one', projectStatusId: 4 }] },
    '/statuses?limit=100': { data: [{ id: 4, name: 'Completed' }] },
  })
  const second = await httpSeedsSource('t', undefined, byId.fetcher, 1000, { gapMs: 0, sleep: async () => {} }).read(
    new Set(['bea@company.com']),
  )
  assert.equal(second.snapshot.projects[0].archived, true)
})

test('closed projects are not offered for new work', async () => {
  const { isClosedProject } = await import('../src/features/tasks/lifecycle')
  assert.equal(isClosedProject({ seedsArchived: true }), true)
  assert.equal(isClosedProject({ archived: true }), true)
  assert.equal(isClosedProject({}), false)
})

test('a product is chosen in Log time: kept on the entry, required where Seeds says, and usable when sending', async () => {
  const { seedsTimeRule, validateTimeEntryInput } = await import('../src/features/tasks/effort')
  const { seedsTimeBody } = await import('../server/seeds/seeds-time')
  const state: any = {
    seeds: {
      connected: true,
      products: [
        { id: '4', name: 'RPOS' },
        { id: '9', name: 'Barter CX' },
      ],
    },
    projects: [
      { id: 'p1', seedsId: '20', seedsTasks: [{ id: '31', name: 'Remote Assistance', productRequired: true }] },
    ],
  }
  const task = { id: 't1', title: 'Issues Monitoring', projectId: 'p1' }
  const rule = seedsTimeRule(state, task)
  assert.deepEqual(
    rule?.products?.map(product => product.id),
    ['4', '9'],
  )
  const input = { date: '2026-11-13', hours: 1, note: 'Remote Assistance', seedsTaskId: '31' }
  const none: any = validateTimeEntryInput(input, rule)
  assert.match(none.error, /Choose the Seeds product/)
  assert.match((validateTimeEntryInput({ ...input, productId: '77' }, rule) as any).error, /from the list/)
  const picked: any = validateTimeEntryInput({ ...input, productId: '9' }, rule)
  assert.equal(picked.value.productId, '9')

  // Entries logged before a product could be chosen: the product chosen when sending is used.
  const old: any = { id: 'e1', date: '2026-11-11', hours: 1.5, note: 'Remote Assistance', seedsTaskId: '31' }
  assert.equal((seedsTimeBody(state, task, old) as any).ok, false)
  assert.equal((seedsTimeBody(state, task, old, '4') as any).body.productId, 4)
  assert.equal((seedsTimeBody(state, task, { ...old, productId: '9' }, '4') as any).body.productId, 9, 'its own wins')
})

test('a Seeds task, product and remarks are optional unless Seeds requires them on the project', async () => {
  const { seedsTimeRule, validateTimeEntryInput, unsentToSeeds } = await import('../src/features/tasks/effort')
  const { seedsTimeBody } = await import('../server/seeds/seeds-time')
  const project = { id: 'p1', seedsId: '20', clientId: 'c1', seedsTasks: [{ id: '31', name: 'Remote Assistance' }] }
  const state = (rules?: any): any => ({
    seeds: { connected: true, products: [{ id: '4', name: 'RPOS' }] },
    clients: [{ id: 'c1', seedsId: '5' }],
    projects: [{ ...project, ...(rules ? { seedsTimeRules: rules } : {}) }],
  })
  const task = { id: 't1', title: 'Issues Monitoring', projectId: 'p1' }
  const bare = { date: '2026-11-13', hours: 1 }

  const free: any = validateTimeEntryInput(bare, seedsTimeRule(state(), task))
  assert.equal(free.ok, true, 'no Seeds task, product or remarks')
  assert.deepEqual([free.value.seedsTaskId, free.value.note, free.value.forSeeds], [undefined, '', true])
  const entry = { id: 'e1', userId: 'u1', userName: 'P', createdAt: '', category: 'Other', ...free.value } as any
  assert.equal(unsentToSeeds(entry), true, 'it still goes to Seeds')
  const body: any = seedsTimeBody(state(), task, entry)
  assert.equal(body.ok, true)
  assert.deepEqual(body.body, {
    postDate: '2026-11-13',
    projectId: 20,
    minuteslogged: 60,
    taskId: null,
    parentId: 5,
    productId: null,
  })

  const strict = state({ taskRequired: true, remarksRequired: true, productRequired: true })
  const rule = seedsTimeRule(strict, task)
  assert.match((validateTimeEntryInput(bare, rule) as any).error, /requires a Seeds task/)
  assert.match((validateTimeEntryInput({ ...bare, seedsTaskId: '31' }, rule) as any).error, /requires remarks/)
  assert.match(
    (validateTimeEntryInput({ ...bare, seedsTaskId: '31', note: 'x' }, rule) as any).error,
    /requires a product/,
  )
  assert.equal(
    (validateTimeEntryInput({ ...bare, seedsTaskId: '31', note: 'x', productId: '4' }, rule) as any).ok,
    true,
  )
  assert.match((seedsTimeBody(strict, task, entry) as any).error, /requires a Seeds task/)

  // Work not under a Seeds project (Before Seeds) still takes no time once Seeds is on.
  const local: any = validateTimeEntryInput(bare, seedsTimeRule(state(), { ...task, projectId: 'other' }))
  assert.match(local.error, /Move this work to Seeds/)
})

test('the real Seeds project shape: contract number, id 0 as none, short requirement names', async () => {
  const { seedsTimeBody } = await import('../server/seeds/seeds-time')
  // GET /projects/1059, as Seeds sent it (2026-11-13).
  const record = {
    id: 1059,
    name: 'GOLDWING BALABALA',
    description: 'BALABALA',
    isDeleted: false,
    updatedAt: '2026-11-13T02:09:02.672Z',
    accessScope: 2,
    isPmoTracking: true,
    isBillable: true,
    isNoOvertime: false,
    allotedManHours: 24,
    estCompletionDate: '2026-04-30T10:45:56.000Z',
    completionDateActual: '2026-05-25T00:56:37.062Z',
    remainingManHours: '7.5',
    workClassification: 'CLIENT_BILLABLE',
    user: { id: '145', email: 'mangeles@iripple.com' },
    department: { id: 6, name: 'Client Engagement' },
    projectStatus: { id: 4, name: 'Completed' },
    parent: { id: 223, name: 'Goldwing Retail Group Inc.' },
    client: { id: 0, name: '-' },
    product: { id: 0, name: '' },
    contractId: 1660,
    contractLineItemId: 1850,
    contractNumber: 'CONTRACT-2026-04-1660',
    timeEntryRequirements: { task: true, parent: true, client: false, product: true, remarks: true },
    timeEntryDefaults: { parentId: 223, clientId: null, productId: null },
  }
  const project = parseSeeds.project(record)
  assert.equal(project.contractNumber, 'CONTRACT-2026-04-1660')
  assert.equal(project.clientId, '223', 'the parent is the client here')
  assert.equal(project.seedsClientId, '', 'Seeds client id 0 means none')
  assert.equal(project.productId, undefined, 'product id 0 means none')
  assert.equal(project.archived, true, 'Completed')
  assert.deepEqual(project.timeRules, {
    productRequired: true,
    taskRequired: true,
    remarksRequired: true,
    parentRequired: true,
    defaultParentId: '223',
  })

  const state: any = {
    projects: [{ id: 'p1', seedsId: '1059', clientId: 'c1', seedsTimeRules: project.timeRules }],
    clients: [{ id: 'c1', seedsId: '223' }],
  }
  const entry: any = { id: 'e1', date: '2026-11-13', hours: 1, note: 'Go Live', seedsTaskId: '31' }
  const noProduct: any = seedsTimeBody(state, { projectId: 'p1' }, entry)
  assert.match(noProduct.error, /requires a product/, 'product 0 no longer passes as a product')
  const sent: any = seedsTimeBody(state, { projectId: 'p1', productId: '9' }, entry)
  assert.deepEqual([sent.body.parentId, sent.body.productId], [223, 9])
  const noClient: any = seedsTimeBody(
    { ...state, clients: [], projects: [{ ...state.projects[0], clientId: '' }] },
    { projectId: 'p1', productId: '9' },
    entry,
  )
  assert.equal(noClient.body.parentId, 223, 'Seeds’ default parent when the project has no client here')
})
