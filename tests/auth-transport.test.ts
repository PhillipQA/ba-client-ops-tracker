import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import express from 'express'
import { authRequestDiagnostics, configureHttpServer } from '../server/auth/auth-transport'
import { getAuthSession, login, logout } from '../src/features/accounts/auth'
import { APP_RELEASE } from '../src/shared/version'

const originalFetch = globalThis.fetch

test('auth logs correlate responses without recording credentials, cookies, or identity', async () => {
  const records: any[] = []
  const originalInfo = console.info
  console.info = (prefix, data) => {
    if (prefix === '[auth]') records.push(JSON.parse(data))
  }
  const app = express()
  app.use('/api/auth', authRequestDiagnostics)
  app.use(express.json())
  app.post('/api/auth/login', (_req, res) => res.status(401).json({ error: 'Invalid credentials.' }))
  app.post('/api/auth/logout', (_req, res) => res.json({ ok: true }))
  app.get('/api/auth/session', (_req, res) => res.status(401).json({ user: null }))
  const server = app.listen(0, '127.0.0.1')
  const originalRequestTimeout = server.requestTimeout
  configureHttpServer(server)
  assert(server.keepAliveTimeout >= 120_000)
  assert(server.headersTimeout > server.keepAliveTimeout)
  assert.equal(server.requestTimeout, originalRequestTimeout)
  await new Promise<void>(resolve => server.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as any).port}`
  try {
    const requestId = randomUUID()
    const result = await originalFetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Auth-Request-Id': requestId,
        Cookie: 'ba_session=private-cookie',
      },
      body: JSON.stringify({ account: 'private-account', username: 'private-user', password: 'private-password' }),
    })
    await result.text()
    assert.equal(result.headers.get('x-auth-request-id'), requestId)
    assert.equal(result.headers.get('cache-control'), 'no-store')
    assert.equal(result.headers.get('x-auth-app-version'), APP_RELEASE)
    assert.deepEqual(
      records.map(r => r.event),
      ['started', 'completed'],
    )
    assert.equal(records[1].status, 401)
    assert(records.every(r => r.requestId === requestId && r.action === 'login'))
    assert(!JSON.stringify(records).includes('private-'))

    const invalidId = 'private-user-supplied-id'
    const signedOut = await originalFetch(`${base}/api/auth/logout`, {
      method: 'POST',
      headers: { 'X-Auth-Request-Id': invalidId },
    })
    await signedOut.text()
    assert.notEqual(signedOut.headers.get('x-auth-request-id'), invalidId)
    assert(!JSON.stringify(records).includes(invalidId))
    const count = records.length
    const session = await originalFetch(`${base}/api/auth/session`)
    assert.equal(session.status, 401)
    await session.text()
    assert.equal(records.length, count)
  } finally {
    console.info = originalInfo
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('auth logging distinguishes an interrupted response from a completed one', async () => {
  const records: any[] = []
  const originalInfo = console.info
  console.info = (prefix, data) => {
    if (prefix === '[auth]') records.push(JSON.parse(data))
  }
  const app = express()
  app.use('/api/auth', authRequestDiagnostics)
  app.post('/api/auth/login', (_req, res) => res.destroy())
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  try {
    await assert.rejects(
      originalFetch(`http://127.0.0.1:${(server.address() as any).port}/api/auth/login`, { method: 'POST' }),
    )
    assert.deepEqual(
      records.map(r => r.event),
      ['started', 'closed_before_response'],
    )
    assert(records.every(r => r.status === undefined))
  } finally {
    console.info = originalInfo
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('failed login connection gets a trace reference without retrying credentials', async () => {
  const originalWarn = console.warn
  console.warn = () => {}
  let calls = 0
  let requestId = ''
  globalThis.fetch = async (_input, init) => {
    calls++
    requestId = new Headers(init?.headers).get('X-Auth-Request-Id') || ''
    assert.equal(init?.cache, 'no-store')
    assert.equal(init?.credentials, 'same-origin')
    throw new TypeError('Failed to fetch')
  }
  try {
    await assert.rejects(login('test', 'tester', 'fixture-password'), (error: any) => {
      assert(error.message.includes('connection was interrupted'))
      assert(error.message.includes(requestId))
      assert(!error.message.includes('fixture-password'))
      return true
    })
    assert.equal(calls, 1)
  } finally {
    globalThis.fetch = originalFetch
    console.warn = originalWarn
  }
})

test('connection interruption while reading a response is reported', async () => {
  const originalWarn = console.warn
  console.warn = () => {}
  globalThis.fetch = async () =>
    ({
      text: async () => {
        throw new TypeError('Body interrupted')
      },
    }) as any
  try {
    await assert.rejects(login('test', 'tester', 'fixture'), /connection was interrupted.*Reference:/)
  } finally {
    globalThis.fetch = originalFetch
    console.warn = originalWarn
  }
})

test('real lockout responses keep their message and are not automatically retried', async () => {
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return Response.json({ error: 'Too many failed login attempts. Please try again in 15 minutes.' }, { status: 429 })
  }
  try {
    await assert.rejects(
      login('test', 'tester', 'fixture'),
      /^Error: Too many failed login attempts\. Please try again in 15 minutes\.$/,
    )
    assert.equal(calls, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('normal anonymous session checks return null and successful login returns its user', async () => {
  const user = { id: 'fixture-user', username: 'tester' }
  globalThis.fetch = async input =>
    String(input).endsWith('/session') ? Response.json({ user: null }, { status: 401 }) : Response.json({ user })
  try {
    assert.equal(await getAuthSession(), null)
    assert.deepEqual(await login('test', 'tester', 'fixture'), user)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('logout failures reject while confirmed or already-expired sessions can sign out', async () => {
  let response = Response.json({ error: 'Server temporarily unavailable.' }, { status: 503 })
  globalThis.fetch = async () => response
  try {
    await assert.rejects(logout(), /Server temporarily unavailable/)
    response = Response.json({ error: 'Please sign in.' }, { status: 401 })
    await logout()
    response = Response.json({ ok: true })
    await logout()
    response = new Response('<html>Proxy page</html>')
    await assert.rejects(logout(), /Sign out could not be confirmed/)
    globalThis.fetch = async () => {
      throw new TypeError('Failed to fetch')
    }
    const originalWarn = console.warn
    console.warn = () => {}
    try {
      await assert.rejects(logout(), /connection was interrupted/)
    } finally {
      console.warn = originalWarn
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('HTML gateway failures and malformed success responses cannot look like a login', async () => {
  let response = new Response('<html>Bad Gateway</html>', { status: 502 })
  globalThis.fetch = async () => response
  try {
    await assert.rejects(login('test', 'tester', 'fixture'), /Login failed \(HTTP 502\).*Reference:/)
    response = Response.json({})
    await assert.rejects(login('test', 'tester', 'fixture'), /incomplete login response/)
  } finally {
    globalThis.fetch = originalFetch
  }
})
