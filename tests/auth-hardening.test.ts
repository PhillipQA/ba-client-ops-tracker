import test from 'node:test'
import assert from 'node:assert/strict'
import { requirePlatformAdmin } from '../server/platform/platform-auth'
import { securityHeaders } from '../server/auth/security-headers'

function run(middleware: (req: any, res: any, next: any) => void, req: any) {
  const result: any = { status: 200, body: undefined, headers: {} as Record<string, string>, nextCalled: false }
  const res: any = {
    status(code: number) {
      result.status = code
      return res
    },
    json(body: unknown) {
      result.body = body
      return res
    },
    setHeader(name: string, value: string) {
      result.headers[name] = value
    },
  }
  middleware(req, res, () => {
    result.nextCalled = true
  })
  return result
}
const admin = (extra: object = {}) => ({ isPlatformAdmin: true, accountType: 'platform', ...extra })

test('platform routes reject tenant users and signed-out requests', () => {
  for (const authUser of [
    undefined,
    { isPlatformAdmin: false, accountType: 'tenant' },
    { isPlatformAdmin: true, accountType: 'tenant' },
  ]) {
    const result = run(requirePlatformAdmin as any, {
      method: 'GET',
      originalUrl: '/api/internal-admin/dashboard',
      authUser,
    })
    assert.equal(result.status, 403)
    assert.equal(result.nextCalled, false)
  }
})

test('an administrator with a current password is not restricted', () => {
  for (const method of ['GET', 'POST', 'PATCH']) {
    assert.equal(
      run(requirePlatformAdmin as any, { method, originalUrl: '/api/internal-admin/organizations', authUser: admin() })
        .nextCalled,
      true,
    )
  }
})

test('while the bootstrap password is active, reads and the credential changes work but other changes are refused', () => {
  const authUser = admin({ mustChangePassword: true })
  assert.equal(
    run(requirePlatformAdmin as any, { method: 'GET', originalUrl: '/api/internal-admin/dashboard?x=1', authUser })
      .nextCalled,
    true,
  )
  assert.equal(
    run(requirePlatformAdmin as any, { method: 'POST', originalUrl: '/api/internal-admin/password', authUser })
      .nextCalled,
    true,
  )
  assert.equal(
    run(requirePlatformAdmin as any, { method: 'POST', originalUrl: '/api/internal-admin/recovery-email/', authUser })
      .nextCalled,
    true,
  )
  for (const [method, originalUrl] of [
    ['POST', '/api/internal-admin/organizations'],
    ['PATCH', '/api/internal-admin/users/u1'],
    ['POST', '/api/internal-admin/users/u1/password'],
    ['POST', '/api/data-architecture/migrate'],
    ['POST', '/api/internal-admin/password/../organizations'],
    ['POST', '/api/internal-admin/passwordx'],
  ]) {
    const result = run(requirePlatformAdmin as any, { method, originalUrl, authUser })
    assert.equal(result.status, 403, `${method} ${originalUrl}`)
    assert.equal(result.body.code, 'PASSWORD_CHANGE_REQUIRED')
    assert.equal(result.nextCalled, false)
  }
})

test('security headers are set on every response and HSTS only in production', () => {
  const development = run(securityHeaders({ production: false }) as any, {})
  assert.equal(development.nextCalled, true)
  assert.equal(development.headers['X-Content-Type-Options'], 'nosniff')
  assert.equal(development.headers['X-Frame-Options'], 'DENY')
  assert.equal(development.headers['Content-Security-Policy'], "frame-ancestors 'none'")
  assert.equal(development.headers['Referrer-Policy'], 'strict-origin-when-cross-origin')
  assert.equal(development.headers['Strict-Transport-Security'], undefined)
  assert.match(
    run(securityHeaders({ production: true }) as any, {}).headers['Strict-Transport-Security'],
    /^max-age=\d+$/,
  )
})
