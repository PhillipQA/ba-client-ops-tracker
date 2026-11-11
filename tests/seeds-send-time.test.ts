import assert from 'node:assert/strict'
import test from 'node:test'
import { registerSeedsRoutes } from '../server/seeds/seeds-routes'
import { checkGoogleIdToken, seedsTimeBody, seedsTimeKey } from '../server/seeds/seeds-time'
import { SeedsError } from '../server/seeds/seeds-client'

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
