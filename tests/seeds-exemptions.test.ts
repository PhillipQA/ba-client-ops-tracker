import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  missingSeedsExemptColumn,
  SEEDS_EXEMPT_NEEDS_SCHEMA,
  seedsExemptionOf,
  seedsExemptionsById,
} from '../server/auth/seeds-exemptions'

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

/** A stand-in for the database client: every query ends with the given result. */
function fakeDb(result: { data?: unknown; error?: unknown }) {
  const calls: string[] = []
  const query: any = new Proxy(
    {},
    {
      get(_target, key) {
        if (key === 'then') return (resolve: (value: unknown) => void) => resolve(result)
        return (...args: unknown[]) => {
          calls.push(`${String(key)}(${args.map(arg => JSON.stringify(arg)).join(',')})`)
          return key === 'maybeSingle' ? Promise.resolve(result) : query
        }
      },
    },
  )
  return { db: { from: (table: string) => (calls.push(`from(${table})`), query) }, calls }
}

test('a user’s Seeds exception is read from app_users, and is "legacy" before schema v43', async () => {
  const on = fakeDb({ data: { seeds_exempt: true } })
  assert.equal(await seedsExemptionOf(on.db, 'u1', 'org-a'), true)
  assert.ok(on.calls.includes('eq("id","u1")') && on.calls.includes('eq("organization_id","org-a")'))
  assert.equal(await seedsExemptionOf(fakeDb({ data: { seeds_exempt: false } }).db, 'u1', 'org-a'), false)
  assert.equal(await seedsExemptionOf(fakeDb({ data: null }).db, 'u1', 'org-a'), false)
  const missing = { code: '42703', message: 'column app_users.seeds_exempt does not exist' }
  assert.equal(await seedsExemptionOf(fakeDb({ error: missing }).db, 'u1', 'org-a'), 'legacy')
  await assert.rejects(seedsExemptionOf(fakeDb({ error: { code: '57014', message: 'timeout' } }).db, 'u1', 'org-a'))
  assert.equal(missingSeedsExemptColumn(null), false)
})

test('Internal Admin reads every exception, or learns the database needs schema v43', async () => {
  const rows = fakeDb({
    data: [
      { id: 'a', seeds_exempt: true },
      { id: 'b', seeds_exempt: false },
    ],
  })
  const map = await seedsExemptionsById(rows.db)
  assert.deepEqual(
    [...(map || [])],
    [
      ['a', true],
      ['b', false],
    ],
  )
  assert.equal(await seedsExemptionsById(fakeDb({ error: { code: '42703' } }).db), null)
  assert.match(SEEDS_EXEMPT_NEEDS_SCHEMA, /schema-v43-seeds-exemptions\.sql/)
})

test('schema v43 adds the column once and grants it to Administrators Seeds does not list', () => {
  const migration = read('database/migrations/schema-v43-seeds-exemptions.sql')
  assert.match(migration, /add column seeds_exempt boolean default false not null/)
  assert.match(migration, /column_name = 'seeds_exempt'/, 'safe to run again: the grant runs only with the column')
  assert.match(migration, /u\.role = 'Administrator'/)
  assert.match(migration, /data->'seeds'->>'connected' = 'true'/)
  assert.match(migration, /not exists \(\s*select 1 from jsonb_array_elements\(t\.data->'seeds'->'people'\)/)
  assert.match(migration, /43 as schema_version/)
  const schema = read('database/schema.sql')
  assert.match(schema, /seeds_exempt boolean DEFAULT false NOT NULL/)
  assert.ok(Number(/(\d+) as schema_version/.exec(schema)?.[1]) >= 43, 'schema.sql includes v43')
})

test('password sign-in may use the exception; Google never does; Internal Admin sets and revokes it', () => {
  const routes = read('server/auth/auth-routes.ts')
  assert.match(routes, /seedsSignInRoute\(tenantState\.data, normalizedAccount, exemption, 'password'\)/)
  assert.match(
    routes,
    /seedsSignInRoute\(state\.data, \{ role: row\.role, email: identity\.email \}, exemption, 'google'\)/,
  )
  assert.match(routes, /rememberSeedsExceptionSession\(token, user\.id\)/)
  assert.match(routes, /forgetSeedsException\(sessions\.keyFor\(token\)\)/, 'signing out forgets the session')
  const auth = read('server/core/auth.ts')
  assert.match(auth, /seedsStillAdmits\(user, sessions\.keyFor\(token\)\)/)
  // The mark is stored with the session (schema v47) and comes back with it after a restart.
  assert.match(auth, /sessions\.setFlag\(token, SEEDS_EXCEPTION, true\)/)
  assert.match(auth, /if \(session\.flags\[SEEDS_EXCEPTION\]\) rememberSeedsException\(key/)
  const admin = read('server/platform/internal-admin.ts')
  assert.match(admin, /typeof req\.body\?\.seedsExempt === 'boolean'/)
  assert.match(admin, /status\(409\)\.json\(\{ error: SEEDS_EXEMPT_NEEDS_SCHEMA \}\)/)
  assert.match(admin, /forgetSeedsExceptionSessionsOf\(userId\)/)
  assert.match(admin, /seedsExemptReady: Boolean\(seedsExemptions\)/)
  const ui = read('src/features/admin/InternalAdmin.tsx')
  assert.match(ui, /Can sign in with a password without Seeds/)
  assert.match(ui, /updateUser\(user, \{ seedsExempt: event\.target\.checked \}\)/)
  assert.doesNotMatch(read('src/features/onboarding/tourSteps.ts'), /Administrators can always sign in/)
})
