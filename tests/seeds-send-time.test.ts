import assert from 'node:assert/strict'
import test from 'node:test'
import { registerSeedsRoutes } from '../server/seeds/seeds-routes'
import { checkGoogleIdToken, seedsTimeBody, seedsTimeKey } from '../server/seeds/seeds-time'
import { SeedsError } from '../server/seeds/seeds-client'
import { calendarTimeOf, logCalendarTime, removeCalendarTime } from '../server/seeds/calendar-time'

const CLIENT = '123-abc.apps.googleusercontent.com'
const idToken = (claims: Record<string, unknown>) =>
  `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`
const goodToken = (email = 'bea@iripple.com') =>
  idToken({ aud: CLIENT, email, email_verified: true, exp: Math.floor(Date.now() / 1000) + 3600 })

const entry = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  date: '2026-11-09',
  hours: 1.75,
  category: 'Other',
  note: 'Go Live – Makati T1',
  userId: 'u-bea',
  userName: 'Bea',
  createdAt: '2026-11-09T01:00:00Z',
  seedsTaskId: '77',
  ...extra,
})
const workspace = () => ({
  seeds: { connected: true },
  accounts: [
    { id: 'u-bea', name: 'Bea', email: 'Bea@iRipple.com', status: 'Active' },
    { id: 'u-pao', name: 'Paolo', email: 'paolo@iripple.com', status: 'Active' },
  ],
  clients: [{ id: 'c1', name: 'Think Library, Inc.', seedsId: '5' }],
  projects: [{ id: 'p1', name: 'CURATED MEEPLE OPC', clientId: 'c1', seedsId: '20', seedsProductId: '9' }],
  items: [
    {
      id: 't1',
      title: 'Go-live prep',
      projectId: 'p1',
      clientId: 'c1',
      timeEntries: [
        entry('e1'),
        entry('e2', { hours: 0.5, note: 'Store call' }),
        entry('e3', { userId: 'u-pao' }),
        entry('e4', { seedsEntryId: '900' }),
        entry('e5', { seedsTaskId: undefined }),
      ],
    },
  ],
})

test('an entry goes to Seeds as its time-entry body, with a key that never changes', () => {
  const state = workspace()
  const body = seedsTimeBody(state, state.items[0], entry('e1') as any)
  assert.deepEqual(body, {
    ok: true,
    body: {
      postDate: '2026-11-09',
      projectId: 20,
      minuteslogged: 105,
      taskId: 77,
      parentId: 5,
      productId: 9,
      remarks: 'Go Live – Makati T1',
    },
  })
  assert.equal(seedsTimeKey({ id: 'e1' }), seedsTimeKey({ id: 'e1' }))
  assert.ok(seedsTimeKey({ id: 'e1' }).length >= 8)
  assert.equal(seedsTimeBody({ ...state, projects: [] }, state.items[0], entry('e1') as any).ok, false)
})

test('on a project with no client of its own, the time goes to the task’s client as the Seeds parent', () => {
  const base = workspace()
  const state = {
    ...base,
    clients: [...base.clients, { id: 'c2', name: 'Emperador Distillers', seedsId: '8' }],
    projects: [{ ...base.projects[0], clientId: undefined, seedsTimeRules: { defaultParentId: '3' } }],
  }
  const parent = (clientId?: string) => {
    const result: any = seedsTimeBody(state, { ...state.items[0], clientId }, entry('e1') as any)
    return result.body.parentId
  }
  assert.equal(parent('c2'), 8)
  assert.equal(parent(undefined), 3, 'no client on the task: the Seeds default')
  const fixed: any = seedsTimeBody(base, { ...base.items[0], clientId: 'c2' } as any, entry('e1') as any)
  assert.equal(fixed.body.parentId, 5, 'the project’s own client always wins')
})

test('the Google sign-in must be for this app, current, and the same person', () => {
  const at = { clientId: CLIENT, email: 'Bea@iRipple.com', now: Date.now() }
  assert.deepEqual(checkGoogleIdToken(goodToken(), at), { ok: true })
  assert.match((checkGoogleIdToken(goodToken('paolo@iripple.com'), at) as any).error, /Sign in with Google as/)
  assert.match(
    (checkGoogleIdToken(idToken({ aud: 'other', email: 'bea@iripple.com', exp: 9e9 }), at) as any).error,
    /not for this app/,
  )
  assert.match(
    (checkGoogleIdToken(idToken({ aud: CLIENT, email: 'bea@iripple.com', exp: 1 }), at) as any).error,
    /expired/,
  )
  assert.equal(checkGoogleIdToken('nope', at).ok, false)
})

function fakeApp() {
  const routes: { method: string; path: string; handlers: any[] }[] = []
  const add =
    (method: string) =>
    (path: string, ...handlers: any[]) =>
      routes.push({ method, path, handlers })
  const app: any = { get: add('GET'), post: add('POST'), put: add('PUT'), delete: add('DELETE') }
  app.ask = (method: string, path: string, user: any, body?: any) => {
    const route = routes.find(r => r.method === method && r.path === path)
    if (!route) throw new Error(`No route ${method} ${path}`)
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
      const run = (at: number) =>
        route.handlers[at]?.({ method, body, params: {}, authUser: user }, res, () => run(at + 1))
      run(0)
    })
  }
  return app
}

function setup(post: (input: any) => Promise<string>, clientId = CLIENT) {
  let stored: any = workspace()
  const app = fakeApp()
  const pass = (_req: any, _res: any, next: () => void) => next()
  const sent: any[] = []
  registerSeedsRoutes(app, {
    db: {},
    requireAuth: pass,
    requireTenant: pass,
    load: async () => ({ data: stored }),
    commit: async (_id, state) => {
      stored = state
    },
    raced: () => false,
    openStatus: () => 'Open',
    today: () => '2026-11-09',
    token: () => 'app-token',
    apiUrl: () => 'https://seeds.iripple.com/api/v1',
    googleClientId: () => clientId,
    postTime: async input => {
      sent.push(input)
      return post(input)
    },
  })
  return { app, sent, state: () => stored }
}
const bea = { id: 'u-bea', role: 'Contributor', modules: ['items'], organizationId: 'org' }
const entries = (state: any) => state.items[0].timeEntries

test('sending: only my unsent Seeds entries go, each once, with my Google sign-in', async () => {
  const { app, sent, state } = setup(async input => `s-${input.key}`)
  const status = await app.ask('GET', '/api/seeds/time', bea)
  assert.deepEqual(status.body, { ready: true, clientId: CLIENT, unsent: 2, hours: 2.25 })

  const result = await app.ask('POST', '/api/seeds/time/send', bea, { idToken: goodToken() })
  assert.equal(result.status, 200, JSON.stringify(result.body))
  assert.deepEqual([result.body.sent, result.body.failed, result.body.left], [2, [], 0])
  assert.deepEqual(
    sent.map(input => [
      input.token,
      input.idToken === goodToken() || input.idToken.length > 10,
      input.key,
      input.body.minuteslogged,
    ]),
    [
      ['app-token', true, 'ba-time-e1', 105],
      ['app-token', true, 'ba-time-e2', 30],
    ],
    'not Paolo’s, not one already in Seeds, not one without a Seeds task',
  )
  assert.equal(entries(state()).find((e: any) => e.id === 'e1').seedsEntryId, 's-ba-time-e1')
  assert.ok(entries(state()).find((e: any) => e.id === 'e1').seedsSentAt)
  const again = await app.ask('POST', '/api/seeds/time/send', bea, { idToken: goodToken() })
  assert.equal(again.body.sent, 0, 'nothing is sent twice')
})

test('someone else’s Google account cannot send my time, and a failure is kept to retry', async () => {
  const wrong = setup(async () => 'x')
  const other = await wrong.app.ask('POST', '/api/seeds/time/send', bea, { idToken: goodToken('paolo@iripple.com') })
  assert.equal(other.status, 400)
  assert.equal(wrong.sent.length, 0)

  const failing = setup(async () => {
    throw new SeedsError('Seeds said: postDate is in a closed period', 422)
  })
  const result = await failing.app.ask('POST', '/api/seeds/time/send', bea, { idToken: goodToken(), entryIds: ['e1'] })
  assert.equal(result.body.sent, 0)
  assert.deepEqual(result.body.failed[0], {
    entryId: 'e1',
    error: 'Seeds said: postDate is in a closed period',
    projectName: 'CURATED MEEPLE OPC',
    taskName: 'Go-live prep',
    date: '2026-11-09',
    hours: 1.75,
    remarks: 'Go Live – Makati T1',
  })
  assert.match(result.body.failed[0].error, /closed period/)
  const e1 = entries(failing.state()).find((e: any) => e.id === 'e1')
  assert.deepEqual([e1.seedsEntryId, e1.seedsError], [undefined, 'Seeds said: postDate is in a closed period'])

  const unset = setup(async () => 'x', '')
  assert.equal((await unset.app.ask('POST', '/api/seeds/time/send', bea, { idToken: goodToken() })).status, 503)
})

test('a sent entry is removed in Seeds, not here', async () => {
  const { removeTimeEntry } = await import('../server/services/time-entries')
  const result = removeTimeEntry({ timeEntries: [entry('e4', { seedsEntryId: '900' })] }, 'e4', { id: 'u-bea' })
  assert.equal(result.ok, false)
  assert.match((result as any).error, /already in Seeds/)
})

test('time from a calendar event: on a Seeds project the person works on, once per event, by the task rules', () => {
  const state = workspace()
  const meeting = { eventId: 'g-1', eventTitle: 'Weekly sync', projectId: 'p1', date: '2026-11-09', hours: 1 }
  const logged = logCalendarTime(state, bea, meeting, new Date('2026-11-09T09:00:00Z'), 'k1')
  assert.ok(logged.ok)
  const entry = logged.value.entry
  assert.deepEqual(
    [entry.eventId, entry.projectId, entry.hours, entry.userId, entry.forSeeds],
    ['g-1', 'p1', 1, 'u-bea', true],
  )
  assert.deepEqual(calendarTimeOf(logged.value.state, 'u-bea'), [entry])
  assert.deepEqual(calendarTimeOf(logged.value.state, 'u-pao'), [], 'only my own')

  const twice = logCalendarTime(logged.value.state, bea, meeting, new Date(), 'k2')
  assert.ok(!twice.ok && twice.status === 409, 'the same meeting is not logged twice')
  const fails = (input: any, user: any = bea, at: any = state) => {
    const result = logCalendarTime(at, user, input, new Date(), 'x')
    return result.ok ? '' : result.error
  }
  assert.match(fails({ ...meeting, hours: 0.4 }), /15-minute/)
  assert.match(fails({ ...meeting, projectId: 'nope' }), /project/)
  assert.match(fails(meeting, { ...bea, role: 'Viewer' }), /Viewers/)
  assert.match(fails(meeting, bea, { ...state, seeds: { connected: false } }), /Seeds is not turned on/)
  const closed = { ...state, projects: state.projects.map(p => ({ ...p, status: 'Completed', seedsArchived: true })) }
  assert.match(fails(meeting, bea, closed), /completed/)

  const removed = removeCalendarTime(logged.value.state, bea, 'k1')
  assert.ok(removed.ok)
  assert.deepEqual(calendarTimeOf(removed.value.state, 'u-bea'), [])
  const inSeeds = { ...logged.value.state, calendarTime: [{ ...entry, seedsEntryId: '901' }] }
  assert.ok(!removeCalendarTime(inSeeds, bea, 'k1').ok, 'once in Seeds it is removed there')
  assert.ok(!removeCalendarTime(logged.value.state, { ...bea, id: 'u-pao' }, 'k1').ok, 'not someone else’s')
})

test('calendar time is sent to Seeds with my other time, under its project', async () => {
  const { app, sent, state } = setup(async input => `s-${input.key}`)
  const logged = await app.ask('POST', '/api/seeds/calendar-time', bea, {
    eventId: 'g-1',
    eventTitle: 'Weekly sync',
    projectId: 'p1',
    date: '2026-11-09',
    hours: 0.75,
    note: 'Weekly sync',
  })
  assert.equal(logged.status, 200, JSON.stringify(logged.body))
  assert.equal((await app.ask('GET', '/api/seeds/time', bea)).body.unsent, 3)

  const result = await app.ask('POST', '/api/seeds/time/send', bea, { idToken: goodToken() })
  assert.equal(result.body.sent, 3)
  const calendar = sent.find(input => input.key === `ba-time-${logged.body.entry.id}`)
  assert.deepEqual(
    [calendar.body.projectId, calendar.body.minuteslogged, calendar.body.remarks],
    [20, 45, 'Weekly sync'],
  )
  assert.equal(state().calendarTime[0].seedsEntryId, calendar ? `s-${calendar.key}` : '')
  assert.equal(result.body.calendarTime[0].seedsEntryId, state().calendarTime[0].seedsEntryId)
})
