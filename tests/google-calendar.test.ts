import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import express from 'express'
import { CALENDAR_CALLBACK, CALENDAR_SCOPES, calendarRange, createCalendarStore, mapCalendarEvent, openCalendar, registerGoogleCalendarRoutes, sealCalendar, validateCredentials } from '../google-calendar'
import { scheduleRange } from '../src/googleCalendar'
import { requirePlatformAdmin } from '../platform-auth'

process.env.TENANT_INTEGRATION_MASTER_KEY = 'ab'.repeat(32)
delete process.env.APP_BASE_URL
const clientId = '123456-calendar.apps.googleusercontent.com', clientSecret = 'GOCSPX-test-credential-not-real'
function memoryDatabase() {
  const tables = new Map<string, any[]>([['google_calendar_accounts', []], ['google_calendar_connections', []], ['app_users', []]])
  let failure = false
  return { tables, fail(value: boolean) { failure = value }, from(name: string) {
    let filters: [string, unknown][] = [], method = 'select', payload: any, single = false
    const q: any = {
      select() { return q }, eq(key: string, value: unknown) { filters.push([key, value]); return q }, is(key: string, value: unknown) { filters.push([key, value]); return q },
      maybeSingle() { single = true; return q }, update(value: any) { method = 'update'; payload = value; return q }, insert(value: any) { method = 'insert'; payload = value; return q },
      upsert(value: any) { method = 'upsert'; payload = value; return q }, delete() { method = 'delete'; return q },
      then(resolve: any) {
        if (failure) return resolve({ data: null, error: { code: '42P01' } })
        const rows = tables.get(name) || [], matches = (row: any) => filters.every(([key, value]) => row[key] === value)
        if (method === 'insert' || method === 'upsert') {
          const index = rows.findIndex(row => row.tenant_id === payload.tenant_id && (name !== 'google_calendar_connections' || row.user_id === payload.user_id))
          if (method === 'insert' && index >= 0) return resolve({ data: null, error: { code: '23505' } })
          const row = { platform_enabled: false, account_enabled: false, revision: randomUUID(), ...payload }
          if (index >= 0) rows[index] = row; else rows.push(row)
        }
        if (method === 'update') rows.filter(matches).forEach(row => Object.assign(row, payload))
        tables.set(name, method === 'delete' ? rows.filter(row => !matches(row)) : rows)
        const found = tables.get(name)!.filter(matches).map(row => structuredClone(row))
        resolve({ data: single ? found[0] || null : found, error: null })
      },
    }; return q
  } }
}
async function fixture() {
  const db = memoryDatabase(), app = express(), sessions = new Map<string, any>(), calls: { url: string; init: RequestInit }[] = []
  const orgs: any = { a: { id: 'a', status: 'Active', enabledModules: ['action', 'settings'] }, b: { id: 'b', status: 'Active', enabledModules: ['action', 'settings'] } }
  for (const [token, tenant, id, role, modules] of [
    ['admin', 'a', 'admin-a', 'Administrator', ['settings', 'action']], ['alice', 'a', 'alice', 'Contributor', ['action']], ['bob', 'a', 'bob', 'Contributor', ['action']], ['viewer', 'a', 'viewer', 'Viewer', ['action']], ['other', 'b', 'other', 'Administrator', ['settings', 'action']],
  ] as const) {
    sessions.set(token, { id, organizationId: tenant, role, modules, status: 'Active', accountType: 'tenant' })
    db.tables.get('app_users')!.push({ id, organization_id: tenant, role, modules: [...modules], status: 'Active', deleted_at: null })
  }
  sessions.set('platform', { id: 'platform', role: 'Administrator', status: 'Active', modules: [], accountType: 'platform', isPlatformAdmin: true, mustChangePassword: false })
  const sessionFromRequest = (req: express.Request) => { const token = req.get('x-test-session') || ''; return { token, user: sessions.get(token) || null } }
  const auth: any = (req: any, res: any, next: any) => { const { user } = sessionFromRequest(req); if (!user) return res.sendStatus(401); req.authUser = user; next() }
  const tenant: any = (req: any, res: any, next: any) => req.authUser.accountType === 'tenant' ? next() : res.sendStatus(403)
  let time = Date.parse('2026-09-23T01:00:00Z'), failRefresh = false, failRevoke = false, partialConsent = false
  const googleFetch: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input)); calls.push({ url: url.href, init })
    const json = (value: any, status = 200) => new Response(JSON.stringify(value), { status })
    if (url.pathname === '/token') {
      const body = new URLSearchParams(String(init.body)), refreshing = body.get('grant_type') === 'refresh_token'
      if (refreshing && failRefresh) return json({ error: 'invalid_grant', error_description: 'PRIVATE provider message' }, 400)
      const user = refreshing ? body.get('refresh_token')?.replace('refresh-', '') : body.get('code')
      return json({ access_token: `access-${user}`, ...(refreshing ? {} : { refresh_token: `refresh-${user}` }), expires_in: 3600, scope: partialConsent ? 'openid email' : CALENDAR_SCOPES.join(' ') })
    }
    const bearer = new Headers(init.headers).get('Authorization')?.replace('Bearer access-', '') || ''
    if (url.pathname === '/v1/userinfo') return json({ sub: bearer, email: `${bearer}@example.test`, email_verified: true })
    if (url.pathname === '/revoke') return json({}, failRevoke ? 503 : 200)
    if (url.pathname.endsWith('/calendarList')) return url.searchParams.has('pageToken') ? json({ items: [{ id: 'shared@example.test', summary: 'Team meetings', accessRole: 'reader' }] }) : json({ items: [{ id: `${bearer}@example.test`, summary: 'Personal', primary: true }], nextPageToken: 'next-calendar' })
    if (url.pathname.endsWith('/events')) {
      assert.equal(init.method || 'GET', 'GET')
      assert.equal(url.searchParams.get('singleEvents'), 'true')
      return url.searchParams.has('pageToken') ? json({ items: [{ id: 'event2', summary: `${bearer} meeting`, start: { dateTime: '2026-09-23T01:00:00Z' }, end: { dateTime: '2026-09-23T02:00:00Z' }, htmlLink: 'https://calendar.google.com/event?eid=example' }, { id: 'removed', status: 'cancelled', start: { date: '2026-09-23' } }] }) : json({ items: [{ id: 'event1', summary: `${bearer} private`, start: { date: '2026-09-22' }, end: { date: '2026-09-25' } }], nextPageToken: 'next-event' })
    }
    throw new Error(`Unexpected Google URL: ${url.origin}${url.pathname}`)
  }
  app.use(express.json())
  registerGoogleCalendarRoutes(app, { db, requireAuth: auth, requireTenant: tenant, requirePlatformAdmin, organizationById: async id => orgs[id], sessionFromRequest, sessionByToken: token => sessions.get(token) || null, fetchGoogle: googleFetch, now: () => time })
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as any).port}`
  const call = (url: string, session = 'admin', method = 'GET', body?: any, headers?: Record<string, string>) => fetch(base + url, { method, redirect: 'manual', headers: { 'x-test-session': session, Origin: base, 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
  const enable = async (id = 'a', user = 'admin') => {
    assert.equal((await call(`/api/internal-admin/organizations/${id}/google-calendar`, 'platform', 'PUT', { enabled: true })).status, 200)
    const result = await call('/api/account/google-calendar', user, 'PUT', { enabled: true, oauthJson: { web: { client_id: clientId, client_secret: clientSecret } } })
    assert.equal(result.status, 200, await result.text())
  }
  const start = async (user = 'alice') => {
    const response = await call('/api/me/google-calendar/connect', user, 'POST', {})
    assert.equal(response.status, 200)
    const url = new URL((await response.json()).url)
    return { url, state: url.searchParams.get('state')!, cookie: response.headers.get('set-cookie')!.split(';')[0] }
  }
  const callback = (pending: Awaited<ReturnType<typeof start>>, code = 'alice', extra = '') => call(`${CALENDAR_CALLBACK}?state=${pending.state}&code=${code}${extra}`, '', 'GET', undefined, { Cookie: pending.cookie })
  const connect = async (user = 'alice') => { const pending = await start(user); const response = await callback(pending, user); assert.equal(response.headers.get('location'), '/#calendar=connected'); return pending }
  const eventsUrl = '/api/me/google-calendar/events?start=2026-09-20T00:00:00Z&end=2026-09-27T00:00:00Z&timeZone=Asia%2FManila'
  return { db, calls, sessions, orgs, call, enable, start, connect, callback, eventsUrl, base, advance(ms: number) { time += ms }, failRefresh() { failRefresh = true }, failRevoke() { failRevoke = true }, partialConsent() { partialConsent = true }, close: () => new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())) }
}

test('Calendar encryption is bound to tenant, user and purpose; tampering fails', () => {
  const value = { refreshToken: 'private-refresh', email: 'private@example.test' }, cipher = sealCalendar(value, 'a', 'alice')
  assert.deepEqual(openCalendar(cipher, 'a', 'alice'), value)
  assert(!cipher.includes(value.refreshToken)); assert.notEqual(cipher, sealCalendar(value, 'a', 'alice'))
  for (const [tenant, user] of [['b', 'alice'], ['a', 'bob'], ['a', undefined]]) assert.throws(() => openCalendar(cipher, tenant!, user))
  const chunks = cipher.split('.'); chunks[2] = Buffer.alloc(16).toString('base64'); assert.throws(() => openCalendar(chunks.join('.'), 'a', 'alice'))
})
test('Web JSON validation fixes provider endpoints and callback to the current application', () => {
  const origin = 'https://tracker.example.test'
  assert.deepEqual(validateCredentials({ oauthJson: JSON.stringify({ web: { client_id: clientId, client_secret: clientSecret, token_uri: 'https://attacker.test' } }) }, origin), { clientId, clientSecret, redirectUri: origin + CALENDAR_CALLBACK })
  assert.throws(() => validateCredentials({ oauthJson: { installed: {} } }, origin))
  assert.throws(() => validateCredentials({ clientId, clientSecret, redirectUri: 'https://attacker.test/callback' }, origin))
})
test('dates handle Manila offsets, midnight, all-day exclusive ends, cancelled/declined events and unsafe links', () => {
  const allDay = mapCalendarEvent({ id: '1', start: { date: '2026-09-22' }, end: { date: '2026-09-25' } }, 'primary', 'Asia/Manila')!
  assert.equal(allDay.endDate, '2026-09-24'); assert.equal(allDay.allDay, true)
  const timed = mapCalendarEvent({ id: '1', start: { dateTime: '2026-09-22T23:00:00Z' }, end: { dateTime: '2026-09-23T16:00:00Z' }, htmlLink: 'javascript:alert(1)' }, 'primary', 'Asia/Manila')!
  assert.equal(timed.date, '2026-09-23'); assert.equal(timed.startTime, '07:00'); assert.equal(timed.endDate, '2026-09-23'); assert.equal(timed.endTime, '00:00'); assert.equal(timed.calendarLink, undefined)
  assert.equal(mapCalendarEvent({ id: '1', status: 'cancelled' }, 'primary', 'UTC'), null)
  assert.equal(mapCalendarEvent({ id: '1', attendees: [{ self: true, responseStatus: 'declined' }] }, 'primary', 'UTC'), null)
  assert.notEqual(allDay.id, mapCalendarEvent({ id: '1', start: { date: '2026-09-22' } }, 'second', 'UTC')?.id)
  assert.throws(() => calendarRange('bad', 'bad', 'UTC')); assert.throws(() => calendarRange('2026-01-01', '2026-04-01', 'UTC'))
  assert.throws(() => calendarRange('2026-01-01', '2026-01-02', 'Invalid/Zone'))
  const week = scheduleRange('week', new Date(2026, 8, 23)), from = new Date(week.start), to = new Date(week.end)
  assert.equal(from.getDay(), 0); assert.equal(from.getDate(), 20); assert.equal(to.getDate(), 27)
})
test('account settings and platform gates require proper authority, same origin and active tenant/user', async () => {
  const f = await fixture()
  try {
    assert.equal((await f.call('/api/account/google-calendar', '')).status, 401)
    for (const role of ['alice', 'viewer', 'platform']) assert.equal((await f.call('/api/account/google-calendar', role)).status, 403)
    assert.equal((await f.call('/api/account/google-calendar', 'admin', 'PUT', { enabled: true, clientId, clientSecret })).status, 403)
    assert.equal((await f.call('/api/internal-admin/organizations/a/google-calendar', 'admin', 'PUT', { enabled: true })).status, 403)
    assert.equal((await f.call('/api/internal-admin/organizations/a/google-calendar', 'platform', 'PUT', { enabled: true }, { Origin: 'https://attacker.test' })).status, 403)
    await f.enable()
    const summary = await (await f.call('/api/account/google-calendar')).json()
    assert.equal(summary.clientId, clientId); assert(!JSON.stringify(summary).includes(clientSecret)); assert(!JSON.stringify(summary).includes('encrypted_config'))
    assert.equal((await createCalendarStore(f.db).config('b')), null)
    assert(!JSON.stringify(f.db.tables.get('google_calendar_accounts')).includes(clientSecret))
    f.orgs.a.status = 'Suspended'; assert.equal((await f.call('/api/me/google-calendar', 'alice')).status, 403); f.orgs.a.status = 'Active'
    f.db.tables.get('app_users')!.find(row => row.id === 'alice').status = 'Disabled'; assert.equal((await f.call('/api/me/google-calendar', 'alice')).status, 403)
    f.db.fail(true); assert.equal((await f.call('/api/account/google-calendar')).status, 503)
  } finally { await f.close() }
})
test('OAuth is session-bound, PKCE-protected and single-use without weakening the main session cookie', async () => {
  const f = await fixture()
  try {
    await f.enable(); const p = await f.start()
    assert.equal(p.url.searchParams.get('code_challenge_method'), 'S256'); assert.equal(p.url.searchParams.get('access_type'), 'offline')
    assert.deepEqual(p.url.searchParams.get('scope')!.split(' '), CALENDAR_SCOPES)
    assert.equal((await f.call(`${CALENDAR_CALLBACK}?state=${p.state}&code=alice`, '')).headers.get('location'), '/#calendar=failed')
    assert.equal((await f.callback(p)).headers.get('location'), '/#calendar=connected')
    const exchange = f.calls.find(call => call.url.endsWith('/token'))!; assert(new URLSearchParams(String(exchange.init.body)).get('code_verifier'))
    assert.equal((await f.callback(p)).headers.get('location'), '/#calendar=failed')
    const status = await (await f.call('/api/me/google-calendar', 'alice')).json(); assert.equal(status.email, 'alice@example.test')
    assert.equal((await (await f.call('/api/me/google-calendar', 'bob')).json()).connected, false)
    const p2 = await f.start('bob'); f.sessions.delete('bob'); assert.equal((await f.callback(p2, 'bob')).headers.get('location'), '/#calendar=failed')
    const p3 = await f.start(); f.advance(11 * 60000); assert.equal((await f.callback(p3)).headers.get('location'), '/#calendar=failed')
  } finally { await f.close() }
})
test('cancelled and partial consent never create a connection', async () => {
  const f = await fixture()
  try {
    await f.enable(); let p = await f.start()
    assert.equal((await f.callback(p, 'alice', '&error=access_denied')).headers.get('location'), '/#calendar=denied')
    assert.equal(f.calls.length, 0)
    f.partialConsent(); p = await f.start(); assert.equal((await f.callback(p)).headers.get('location'), '/#calendar=failed')
    assert.equal(f.db.tables.get('google_calendar_connections')!.length, 0)
  } finally { await f.close() }
})
test('events are private per tenant/user, paginated and never written to the shared planner or Google', async () => {
  const f = await fixture()
  try {
    await f.enable(); await f.enable('b', 'other'); await f.connect('alice'); await f.connect('bob'); await f.connect('other')
    const response = await f.call(`${f.eventsUrl}&userId=bob&tenantId=b`, 'alice')
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store')
    const events = (await response.json()).events
    assert.equal(events.length, 2); assert(events.every((event: any) => event.title.startsWith('alice')))
    assert.equal((await (await f.call(f.eventsUrl, 'bob')).json()).events[0].title, 'bob private')
    assert.equal((await (await f.call(f.eventsUrl, 'other')).json()).events[0].title, 'other private')
    assert.equal((await f.call(f.eventsUrl, 'viewer')).status, 409)
    const calendars = (await (await f.call('/api/me/google-calendar/calendars', 'alice')).json()).calendars; assert.equal(calendars.length, 2)
    assert.equal((await f.call('/api/me/google-calendar/calendars', 'alice', 'PUT', { calendarIds: ['private-bob'] })).status, 400)
    assert.equal((await f.call('/api/me/google-calendar/calendars', 'alice', 'PUT', { calendarIds: ['primary', 'alice@example.test', 'shared@example.test'], tenantId: 'b', userId: 'bob' })).status, 200)
    assert.deepEqual((await createCalendarStore(f.db).connection('a', 'alice')).selected_calendars, ['primary', 'shared@example.test'])
    assert.deepEqual((await createCalendarStore(f.db).connection('a', 'bob')).selected_calendars, ['primary'])
    assert.equal((await (await f.call(f.eventsUrl, 'alice')).json()).events.length, 4)
    assert.equal((await f.call('/api/me/google-calendar/calendars', 'alice', 'PUT', { calendarIds: [] })).status, 200)
    assert.deepEqual((await (await f.call(f.eventsUrl, 'alice')).json()).events, [])
    assert(!JSON.stringify(f.db.tables.get('google_calendar_connections')).includes('refresh-alice'))
    assert(!f.db.tables.has('tenant_state')); assert(f.calls.filter(c => c.url.includes('/calendar/v3/')).every(c => !c.init.method || c.init.method === 'GET'))
  } finally { await f.close() }
})
test('refresh survives store reconstruction, retains refresh token and safely reports revoked authorization', async () => {
  const f = await fixture()
  try {
    await f.enable(); await f.connect(); f.advance(2 * 3600000)
    assert.equal((await f.call(f.eventsUrl, 'alice')).status, 200)
    assert.equal(f.calls.filter(c => c.url.endsWith('/token')).length, 2)
    const row = await createCalendarStore(f.db).connection('a', 'alice')
    assert.equal(openCalendar<any>(row.encrypted_tokens, 'a', 'alice').refreshToken, 'refresh-alice')
    f.advance(2 * 3600000); f.failRefresh(); const failed = await f.call(f.eventsUrl, 'alice'); assert.equal(failed.status, 401)
    const text = await failed.text(); assert(!text.includes('PRIVATE')); assert(!text.includes('refresh-alice'))
  } finally { await f.close() }
})
test('platform disable, user module changes, account rotation and pending OAuth cannot bypass restrictions', async () => {
  const f = await fixture()
  try {
    await f.enable(); await f.connect(); const pending = await f.start('bob')
    assert.equal((await f.call('/api/internal-admin/organizations/a/google-calendar', 'platform', 'PUT', { enabled: false })).status, 200)
    assert.equal((await f.call(f.eventsUrl, 'alice')).status, 403)
    assert.equal((await f.callback(pending, 'bob')).headers.get('location'), '/#calendar=failed')
    await f.call('/api/internal-admin/organizations/a/google-calendar', 'platform', 'PUT', { enabled: true })
    const user = f.db.tables.get('app_users')!.find(row => row.id === 'alice'); user.modules = []
    assert.equal((await f.call(f.eventsUrl, 'alice')).status, 403); user.modules = ['action']
    await f.call('/api/account/google-calendar', 'admin', 'PUT', { enabled: false }); assert.equal((await f.call(f.eventsUrl, 'alice')).status, 409)
    await f.call('/api/account/google-calendar', 'admin', 'PUT', { enabled: true, clientId, clientSecret })
    assert.equal((await f.call(f.eventsUrl, 'alice')).status, 409)
    assert.equal((await (await f.call('/api/me/google-calendar', 'alice')).json()).reconnectRequired, true)
  } finally { await f.close() }
})
test('disconnect works while disabled, deletes only own tokens and reports failed provider revocation', async () => {
  const f = await fixture()
  try {
    await f.enable(); await f.connect('alice'); await f.connect('bob')
    await f.call('/api/internal-admin/organizations/a/google-calendar', 'platform', 'PUT', { enabled: false })
    f.failRevoke()
    const response = await f.call('/api/me/google-calendar', 'alice', 'DELETE', { userId: 'bob' })
    assert.equal(response.status, 200); assert.match((await response.json()).message, /could not be confirmed/)
    assert.equal(await createCalendarStore(f.db).connection('a', 'alice'), null); assert(await createCalendarStore(f.db).connection('a', 'bob'))
  } finally { await f.close() }
})
