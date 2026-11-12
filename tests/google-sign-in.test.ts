import assert from 'node:assert/strict'
import { createSign, generateKeyPairSync } from 'node:crypto'
import test from 'node:test'
import {
  chooseGoogleUser,
  createGoogleVerifier,
  exactLike,
  seedsAllowsSignIn,
  type GoogleCandidate,
} from '../server/auth/google-sign-in'

const CLIENT = 'tracker-client.apps.googleusercontent.com'
const google = generateKeyPairSync('rsa', { modulusLength: 2048 })
const stranger = generateKeyPairSync('rsa', { modulusLength: 2048 })
const NOW = Date.parse('2026-11-12T02:00:00Z')

const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
function token(claims: Record<string, unknown> = {}, options: { key?: any; alg?: string; kid?: string } = {}) {
  const head = part({ alg: options.alg || 'RS256', kid: options.kid || 'k1' })
  const body = part({
    iss: 'https://accounts.google.com',
    aud: CLIENT,
    exp: NOW / 1000 + 3600,
    sub: '1234567890',
    email: 'Phillip@iripple.com',
    email_verified: true,
    hd: 'iripple.com',
    name: 'Phillip',
    ...claims,
  })
  const signature = createSign('RSA-SHA256')
    .update(`${head}.${body}`)
    .sign(options.key || google.privateKey)
    .toString('base64url')
  return `${head}.${body}.${signature}`
}
function verifier() {
  let fetched = 0
  const request: any = async () => {
    fetched++
    return new Response(JSON.stringify({ keys: [{ ...google.publicKey.export({ format: 'jwk' }), kid: 'k1' }] }), {
      headers: { 'cache-control': 'public, max-age=3600' },
    })
  }
  return { verify: createGoogleVerifier({ request, now: () => NOW }), fetched: () => fetched }
}

test('a Google ID token is accepted only when Google signed it, for this app, with a verified hosted email', async () => {
  const v = verifier()
  assert.deepEqual(await v.verify(token(), CLIENT), {
    email: 'phillip@iripple.com',
    name: 'Phillip',
    subject: '1234567890',
  })
  await v.verify(token({ email: 'someone@gmail.com', hd: undefined }), CLIENT)
  assert.equal(v.fetched(), 1, 'Google’s keys are fetched once and kept')
  const refused = async (bad: string, why: RegExp, label: string) =>
    assert.rejects(
      () => v.verify(bad, CLIENT),
      (error: any) => why.test(error.message),
      label,
    )
  await refused(token({}, { key: stranger.privateKey }), /could not be verified/, 'signed by someone else')
  await refused(token({}, { alg: 'none' }), /could not be verified/, 'unsigned')
  await refused(token({}, { kid: 'other' }), /could not be verified/, 'unknown key')
  await refused(token({ aud: 'another-app' }), /not for this app/, 'made for another app')
  await refused(token({ iss: 'https://evil.example' }), /could not be verified/, 'another issuer')
  await refused(token({ exp: NOW / 1000 - 1 }), /expired/, 'expired')
  await refused(token({ email_verified: false }), /verified email/, 'unverified email')
  await refused(token({ email: 'me@outlook.com', hd: undefined }), /Gmail or Google Workspace/, 'not Google-hosted')
  const [head, body, signature] = token().split('.')
  const forged = part({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), email: 'ceo@iripple.com' })
  await refused(`${head}.${forged}.${signature}`, /could not be verified/, 'changed after signing')
  await refused('not-a-token', /could not be verified/, 'not a token')
})

const candidate = (userId: string, accountId: string): GoogleCandidate => ({
  user: { id: userId },
  organization: { id: accountId, name: `Account ${accountId}`, slug: accountId },
})

test('the email picks one user: none is refused, several accounts ask which, a duplicate is refused', () => {
  const email = 'phillip@iripple.com'
  const none = chooseGoogleUser([], email)
  assert.ok(!none.ok && none.status === 403 && /No active user/.test(none.error))
  const one = chooseGoogleUser([candidate('u1', 'a')], email)
  assert.ok(one.ok && one.candidate.user.id === 'u1')
  const two = chooseGoogleUser([candidate('u1', 'a'), candidate('u2', 'b')], email)
  assert.ok(!two.ok && two.status === 409)
  assert.deepEqual(!two.ok && two.accounts?.map(account => account.slug), ['a', 'b'])
  const picked = chooseGoogleUser([candidate('u1', 'a'), candidate('u2', 'b')], email, 'b')
  assert.ok(picked.ok && picked.candidate.user.id === 'u2')
  const elsewhere = chooseGoogleUser([candidate('u1', 'a')], email, 'unknown')
  assert.ok(!elsewhere.ok && elsewhere.status === 403)
  const duplicate = chooseGoogleUser([candidate('u1', 'a'), candidate('u3', 'a')], email)
  assert.ok(!duplicate.ok && duplicate.status === 409 && !duplicate.accounts)
})

test('once Seeds is on, the email must be in its employee directory; an exact email match only', () => {
  const people = [{ id: '7', name: 'Phillip', email: 'phillip@iripple.com' }]
  assert.equal(seedsAllowsSignIn({ seeds: { connected: true, people } }, 'Phillip@iripple.com'), true)
  assert.equal(seedsAllowsSignIn({ seeds: { connected: true, people } }, 'left@iripple.com'), false)
  assert.equal(seedsAllowsSignIn({ seeds: { connected: false, people } }, 'left@iripple.com'), true, 'Seeds is off')
  assert.equal(seedsAllowsSignIn({ seeds: { connected: true, people: [] } }, 'a@iripple.com'), true, 'no directory')
  assert.equal(seedsAllowsSignIn({}, 'a@iripple.com'), true)
  assert.equal(exactLike('john_doe%@x.com'), 'john\\_doe\\%@x.com')
})
