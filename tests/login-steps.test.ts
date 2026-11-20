import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Source checks of the sign-in rules; the routes themselves need the database to run.
const routes = readFileSync(new URL('../server/auth/auth-routes.ts', import.meta.url), 'utf8')
const screens = readFileSync(new URL('../src/app/AuthScreens.tsx', import.meta.url), 'utf8')
const app = readFileSync(new URL('../src/app/App.tsx', import.meta.url), 'utf8')

const routeBody = (path: string) => {
  const start = routes.indexOf(`app.post('${path}'`)
  assert.ok(start >= 0, `missing route ${path}`)
  const next = routes.indexOf('app.post(', start + 10)
  return routes.slice(start, next < 0 ? undefined : next)
}

test('sign-in checks the account first, rate limited, without telling which usernames exist', () => {
  const account = routeBody('/api/auth/account')
  assert.match(account, /accountLookupLimiter/)
  assert.match(account, /organization\.status !== 'Active'\) return void notFound\(\)/)
  assert.doesNotMatch(account, /app_users|username/, 'step 1 never looks at users')
})

test('Internal Admin signs in only at /internal_admin, never on the workspace sign-in', () => {
  const internal = routeBody('/api/auth/internal-login')
  assert.match(internal, /enforceLoginFailureLimit/)
  assert.match(internal, /platform_users/)
  const workspace = routeBody('/api/auth/login')
  assert.doesNotMatch(workspace, /platform_users/, 'the workspace sign-in no longer reads Internal Admin users')
  assert.match(workspace, /accountKey === INTERNAL_ADMIN_ACCOUNT_KEY\) \{\s*rejectInvalidLogin\(req, res\)/)
  assert.match(routeBody('/api/auth/account'), /INTERNAL_ADMIN_ACCOUNT_KEY\) return void notFound\(\)/)
  assert.match(app, /=== INTERNAL_ADMIN_PATH \? \(\s*<InternalAdminLogin/)
})

test('the sign-in screen has the account step, then user and password or Google for that account', () => {
  assert.match(screens, /checkAccount\(typed\)/)
  assert.match(screens, /<GoogleSignIn busy=\{busy\} account=\{chosen\.key\}/)
  assert.match(screens, /onLogin\(chosen\.key, nextUsername/)
})
