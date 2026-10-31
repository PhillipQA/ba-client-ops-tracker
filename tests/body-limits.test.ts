import test from 'node:test'
import assert from 'node:assert/strict'
import { BODY_LIMITS, jsonBodies } from '../server/auth/body-limits'

test('large JSON bodies are read only for signed-in requests; anonymous ones get the small limit', () => {
  const used: string[] = []
  const parsers: string[] = []
  const handler = jsonBodies({
    json: ({ limit }) => {
      parsers.push(limit)
      return (_req, _res, next) => {
        used.push(limit)
        next()
      }
    },
    signedIn: req => req.headers.cookie === 'ba_session=valid',
  })
  assert.deepEqual(parsers.sort(), ['100kb', '24mb'], 'one parser per limit, made once')
  let passed = 0
  const next = () => passed++
  handler({ headers: { cookie: 'ba_session=valid' } } as any, {} as any, next)
  handler({ headers: {} } as any, {} as any, next)
  handler({ headers: { cookie: 'ba_session=forged' } } as any, {} as any, next)
  assert.deepEqual(used, [BODY_LIMITS.signedIn, BODY_LIMITS.anonymous, BODY_LIMITS.anonymous])
  assert.equal(passed, 3)
  assert.equal(BODY_LIMITS.anonymous, '100kb')
})
