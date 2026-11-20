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

test('sign-in gives no hint whether an account exists: one answer for a wrong account, user or password', () => {
  assert.equal(routes.includes("'/api/auth/account'"), false, 'no route that checks an account on its own')
  assert.match(routes, /error: 'Incorrect account, user, or password\.'/)
  const workspace = routeBody('/api/auth/login')
  // An unknown or inactive account gets the same answer as a wrong password.
  const unknown = /if \(!organization \|\| organization\.status !== 'Active'\) \{\s*rejectInvalidLogin\(req, res\)/
  assert.match(workspace, unknown)
  assert.doesNotMatch(screens, /checkAccount|\/api\/auth\/account/, 'the account step asks the server nothing')
})

test('Internal Admin signs in only at /internal_admin, never on the workspace sign-in', () => {
  const internal = routeBody('/api/auth/internal-login')
  assert.match(internal, /enforceLoginFailureLimit/)
  assert.match(internal, /platform_users/)
  const workspace = routeBody('/api/auth/login')
  assert.doesNotMatch(workspace, /platform_users/, 'the workspace sign-in no longer reads Internal Admin users')
  assert.match(workspace, /accountKey === INTERNAL_ADMIN_ACCOUNT_KEY\) \{\s*rejectInvalidLogin\(req, res\)/)
  assert.match(app, /=== INTERNAL_ADMIN_PATH \? \(\s*<InternalAdminLogin/)
})

test('the sign-in screen has the account step, then user and password or Google for that account', () => {
  assert.match(screens, /setChosen\(typed\)/)
  assert.match(screens, /<GoogleSignIn busy=\{busy\} account=\{chosen\}/)
  assert.match(screens, /onLogin\(chosen, nextUsername/)
})
