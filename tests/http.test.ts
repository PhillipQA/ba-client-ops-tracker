import test from 'node:test'
import assert from 'node:assert/strict'
import { HttpError, requestJson } from '../src/shared/http'

const reply = (status: number, body: unknown, raw = false) =>
  new Response(raw ? String(body) : JSON.stringify(body), { status })
function stub(responder: (url: string, init: any) => Response | Promise<Response>) {
  const calls: { url: string; init: any }[] = []
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), init })
    return responder(String(url), init)
  }) as any
  return calls
}

test('JSON goes out with the session cookie and comes back parsed', async () => {
  const calls = stub(() => reply(200, { ok: 1 }))
  assert.deepEqual(await requestJson('/api/x', { body: { a: 1 } }), { ok: 1 })
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.credentials, 'same-origin')
  assert.equal(calls[0].init.body, '{"a":1}')
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json')
  await requestJson('/api/y', { method: 'DELETE' })
  assert.equal(
    calls[1].init.headers['Content-Type'],
    'application/json',
    'changes are marked as JSON even without a body',
  )
  await requestJson('/api/z', { method: 'DELETE', bare: true })
  assert.equal(calls[2].init.headers, undefined)
})

test('failures carry the server message, else the status or general fallback', async () => {
  stub(() => reply(409, { error: 'Someone else changed this row.', row: { id: 'r' } }))
  await assert.rejects(
    requestJson('/api/x'),
    (error: any) =>
      error instanceof HttpError &&
      error.status === 409 &&
      error.message === 'Someone else changed this row.' &&
      error.body.row.id === 'r',
  )
  stub(() => reply(403, '<html>', true))
  await assert.rejects(
    requestJson('/api/x', { statusFallback: { 403: 'No access.' }, fallback: 'Broken.' }),
    /No access\./,
  )
  stub(() => reply(500, {}))
  await assert.rejects(requestJson('/api/x', { fallback: 'Broken.' }), /Broken\./)
})

test('features keep their own errors, offline messages and accepted codes', async () => {
  class Mine extends Error {
    constructor(
      message: string,
      public code?: string,
    ) {
      super(message)
    }
  }
  stub(() => reply(400, { error: 'Bad', code: 'X' }))
  await assert.rejects(
    requestJson('/api/x', { error: (message, _s, body) => new Mine(message, body.code) }),
    (error: any) => error instanceof Mine && error.code === 'X',
  )
  stub(() => reply(409, { code: 'ALREADY_SAVED', url: 'u' }))
  assert.equal((await requestJson('/api/x', { acceptCodes: ['ALREADY_SAVED'] })).url, 'u')
  globalThis.fetch = (async () => {
    throw new TypeError('Failed to fetch')
  }) as any
  await assert.rejects(requestJson('/api/x', { offline: 'You are offline.' }), /You are offline\./)
  await assert.rejects(requestJson('/api/x'), /Failed to fetch/)
})
