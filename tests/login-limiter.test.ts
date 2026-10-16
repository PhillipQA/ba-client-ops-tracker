import test from 'node:test'
import assert from 'node:assert/strict'
import { createLoginLimiter } from '../server/auth/login-limiter'

function setup() {
  let at = 0
  const limiter = createLoginLimiter({ now: () => at, windowMs: 15 * 60_000, maxPerAttempt: 5, maxPerUser: 20, maxPerIp: 40 })
  return { limiter, advance: (ms: number) => { at += ms } }
}
const who = (ip: string, username: string, account = 'acme') => ({ ip, account, username })

test('five failures from one address for one user block that combination', () => {
  const { limiter } = setup()
  for (let i = 0; i < 4; i++) { limiter.recordFailure(who('1.1.1.1', 'maria')); assert.equal(limiter.check(who('1.1.1.1', 'maria')).blocked, false) }
  const last = limiter.recordFailure(who('1.1.1.1', 'maria'))
  assert.equal(last.limit, 5); assert.equal(last.remaining, 0)
  const blocked = limiter.check(who('1.1.1.1', 'maria'))
  assert.equal(blocked.blocked, true)
  assert.equal(blocked.retryAfterSeconds, 900)
  assert.equal(limiter.check(who('1.1.1.1', 'someone-else')).blocked, false, 'other users from the same address are not blocked by this counter')
})

test('one password tried against many usernames from one address is stopped by the per-address limit', () => {
  const { limiter } = setup()
  for (let i = 0; i < 40; i++) {
    assert.equal(limiter.check(who('9.9.9.9', `user${i}`)).blocked, false, `attempt ${i + 1} is still allowed`)
    limiter.recordFailure(who('9.9.9.9', `user${i}`))
  }
  assert.equal(limiter.check(who('9.9.9.9', 'user-new')).blocked, true)
  assert.equal(limiter.check(who('8.8.8.8', 'user-new')).blocked, false, 'a different address is unaffected')
})

test('guessing one account from many addresses is stopped by the per-user limit', () => {
  const { limiter } = setup()
  for (let i = 0; i < 20; i++) {
    assert.equal(limiter.check(who(`10.0.0.${i}`, 'admin')).blocked, false)
    limiter.recordFailure(who(`10.0.0.${i}`, 'admin'))
  }
  const next = limiter.check(who('10.0.1.1', 'admin'))
  assert.equal(next.blocked, true)
  assert.equal(limiter.check(who('10.0.1.1', 'admin', 'other-account')).blocked, false, 'accounts are counted separately')
})

test('identity is case- and whitespace-insensitive so spelling variants share a counter', () => {
  const { limiter } = setup()
  for (const username of ['Maria', 'maria ', ' MARIA', 'maria', 'Maria']) limiter.recordFailure(who('1.1.1.1', username, 'x'))
  assert.equal(limiter.check(who('1.1.1.1', 'maria', 'X ')).blocked, true, 'five differently spelled failures count as five')
})

test('counters expire after the window', () => {
  const { limiter, advance } = setup()
  for (let i = 0; i < 5; i++) limiter.recordFailure(who('1.1.1.1', 'maria'))
  assert.equal(limiter.check(who('1.1.1.1', 'maria')).blocked, true)
  advance(15 * 60_000)
  assert.equal(limiter.check(who('1.1.1.1', 'maria')).blocked, false)
  limiter.prune()
  assert.equal(limiter.size, 0)
})

test('a successful login resets only the address-and-user counter', () => {
  const { limiter } = setup()
  for (let i = 0; i < 4; i++) limiter.recordFailure(who('1.1.1.1', 'maria'))
  limiter.recordSuccess(who('1.1.1.1', 'maria'))
  for (let i = 0; i < 4; i++) assert.equal(limiter.recordFailure(who('1.1.1.1', 'maria')).limit, 5)
  assert.equal(limiter.check(who('1.1.1.1', 'maria')).blocked, false, 'the attempt counter started again from zero')
  // 8 failures are still on the per-user and per-address counters
  for (let i = 0; i < 12; i++) limiter.recordFailure(who(`2.2.2.${i}`, 'maria'))
  assert.equal(limiter.check(who('3.3.3.3', 'maria')).blocked, true, 'the per-user counter kept the earlier failures')
})
