import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SessionStore,
  idleTimeoutFromEnv,
  DEFAULT_SESSION_IDLE_TIMEOUT_MS,
  SESSION_MAX_AGE_SECONDS,
} from '../server/auth/session-store'

const MINUTE = 60_000
function clock(start = 1_000_000) {
  let at = start
  return {
    now: () => at,
    advance: (ms: number) => {
      at += ms
    },
  }
}

test('sessions return their user until the idle timeout, and activity keeps them alive', () => {
  const time = clock()
  const store = new SessionStore<{ id: string }>({
    idleTimeoutMs: 30 * MINUTE,
    maxAgeMs: 8 * 60 * MINUTE,
    now: time.now,
  })
  const token = store.create({ id: 'u1' })
  assert.match(token, /^[a-f0-9]{64}$/)
  time.advance(20 * MINUTE)
  assert.deepEqual(store.get(token), { id: 'u1' })
  time.advance(20 * MINUTE) // 40 min total, but only 20 since the last request
  assert.deepEqual(store.get(token), { id: 'u1' })
  time.advance(31 * MINUTE)
  assert.equal(store.get(token), null)
  assert.equal(store.size, 0, 'an expired session is removed when it is presented')
})

test('a session ends at its absolute lifetime even if it is used constantly', () => {
  const time = clock()
  const store = new SessionStore<string>({ idleTimeoutMs: 30 * MINUTE, maxAgeMs: 2 * 60 * MINUTE, now: time.now })
  const token = store.create('user')
  for (let i = 0; i < 11; i++) {
    time.advance(10 * MINUTE)
    assert.equal(store.get(token), 'user')
  }
  time.advance(10 * MINUTE) // 120 minutes since login
  assert.equal(store.get(token), null)
})

test('unknown and deleted tokens are rejected, and tokens are unique', () => {
  const store = new SessionStore<string>()
  assert.equal(store.get('nope'), null)
  const a = store.create('a'),
    b = store.create('b')
  assert.notEqual(a, b)
  store.delete(a)
  assert.equal(store.get(a), null)
  assert.equal(store.get(b), 'b')
})

test('set replaces the user without extending the session; entries lists live sessions and tolerates edits while iterating', () => {
  const time = clock()
  const store = new SessionStore<{ role: string }>({ idleTimeoutMs: 30 * MINUTE, now: time.now })
  const keep = store.create({ role: 'Viewer' })
  const drop = store.create({ role: 'Viewer' })
  time.advance(25 * MINUTE)
  store.set(keep, { role: 'Administrator' })
  time.advance(10 * MINUTE) // neither was read in between: set() is not activity
  assert.equal(store.get(keep), null)
  const live = store.create({ role: 'Contributor' })
  const seen: string[] = []
  for (const [token, user] of store) {
    seen.push(token)
    if (user.role === 'Contributor') store.set(token, { role: 'Viewer' })
  }
  assert.deepEqual(seen, [live])
  assert.deepEqual(store.get(live), { role: 'Viewer' })
  assert.equal(store.get(drop), null)
})

test('prune removes abandoned sessions that are never presented again', () => {
  const time = clock()
  const store = new SessionStore<string>({ idleTimeoutMs: 30 * MINUTE, now: time.now })
  store.create('old')
  time.advance(31 * MINUTE)
  const fresh = store.create('fresh')
  assert.equal(store.size, 2)
  assert.equal(store.prune(), 1)
  assert.equal(store.size, 1)
  assert.equal(store.get(fresh), 'fresh')
})

test('idle timeout setting accepts minutes and ignores invalid values', () => {
  assert.equal(idleTimeoutFromEnv('45'), 45 * MINUTE)
  for (const value of [undefined, '', '0', '-5', 'abc'])
    assert.equal(idleTimeoutFromEnv(value), DEFAULT_SESSION_IDLE_TIMEOUT_MS)
  assert.equal(SESSION_MAX_AGE_SECONDS, 8 * 60 * 60)
})
