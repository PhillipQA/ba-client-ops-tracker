import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { SessionStore, sessionKey, type SessionPersistence, type StoredSession } from '../server/auth/session-store'
import { sessionDatabase } from '../server/auth/session-database'

const MINUTE = 60_000
const read = (path: string) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
type User = { id: string; role: string }

function clock(start = 1_000_000) {
  let at = start
  return {
    now: () => at,
    advance: (ms: number) => {
      at += ms
    },
  }
}

/** A stand-in for public.app_sessions, shared by every store made from it (two servers, or before and after a restart). */
function table() {
  const rows = new Map<string, { session: StoredSession<User>; expiresAt: number }>()
  const log: string[] = []
  let down = false
  const check = () => {
    if (down) throw new Error('database unavailable')
  }
  const persistence: SessionPersistence<User> = {
    async save(key, session, expiresAt) {
      check()
      log.push(`save ${key}`)
      rows.set(key, { session: structuredClone(session), expiresAt })
    },
    async touch(key, lastSeenAt, expiresAt) {
      check()
      log.push(`touch ${key}`)
      const row = rows.get(key)
      if (row) rows.set(key, { session: { ...row.session, lastSeenAt }, expiresAt })
    },
    async remove(key) {
      check()
      log.push(`remove ${key}`)
      rows.delete(key)
    },
    async load(key) {
      check()
      return rows.has(key) ? structuredClone(rows.get(key)!.session) : null
    },
    async loadAll(now) {
      check()
      return [...rows].filter(([, row]) => row.expiresAt > now).map(([key, row]) => [key, structuredClone(row.session)])
    },
    async prune(now) {
      for (const [key, row] of rows) if (row.expiresAt <= now) rows.delete(key)
    },
  }
  return {
    rows,
    log,
    persistence,
    setDown: (value: boolean) => {
      down = value
    },
  }
}

const store = (persistence: SessionPersistence<User>, time: ReturnType<typeof clock>, extra = {}) =>
  new SessionStore<User>({ persistence, now: time.now, idleTimeoutMs: 30 * MINUTE, onError: () => {}, ...extra })

test('a sign-in is stored under a hash of its token, never the token, and survives a restart', async () => {
  const time = clock()
  const db = table()
  const before = store(db.persistence, time)
  const token = before.create({ id: 'ana', role: 'Administrator' })
  await before.flush()
  assert.deepEqual([...db.rows.keys()], [sessionKey(token)])
  assert.ok(!JSON.stringify([...db.rows]).includes(token), 'the token itself is not stored')

  // Restart: a new store, nothing in memory.
  const after = store(db.persistence, time)
  assert.equal(after.get(token), null, 'not held until loaded')
  assert.equal(await after.restore(), 1)
  assert.deepEqual(after.get(token), { id: 'ana', role: 'Administrator' })
})

test('a stored key presented as a cookie signs no one in', async () => {
  const time = clock()
  const db = table()
  const first = store(db.persistence, time)
  const token = first.create({ id: 'ana', role: 'Administrator' })
  await first.flush()
  const other = store(db.persistence, time)
  await other.restore()
  const key = sessionKey(token)
  await other.ready(key)
  assert.equal(other.get(key), null)
  other.delete(key)
  assert.deepEqual(other.get(token), { id: 'ana', role: 'Administrator' }, 'nor can it sign the person out')
})

test('a sign-in made on one server is known to another; a sign-out on one reaches the other within a minute', async () => {
  const time = clock()
  const db = table()
  const a = store(db.persistence, time)
  const b = store(db.persistence, time)
  const token = a.create({ id: 'ana', role: 'Contributor' })
  await a.flush()
  await b.ready(token)
  assert.deepEqual(b.get(token), { id: 'ana', role: 'Contributor' })

  a.delete(token)
  await a.flush()
  await b.ready(token)
  assert.ok(b.get(token), 'checked less than a minute ago: still held')
  time.advance(MINUTE)
  await b.ready(token)
  assert.equal(b.get(token), null, 'signed out on the other server')
})

test('a change to the signed-in user is stored and read by the other server', async () => {
  const time = clock()
  const db = table()
  const a = store(db.persistence, time)
  const b = store(db.persistence, time)
  const token = a.create({ id: 'ana', role: 'Contributor' })
  await a.flush()
  await b.ready(token)
  a.set(token, { id: 'ana', role: 'Viewer' })
  await a.flush()
  time.advance(MINUTE)
  await b.ready(token)
  assert.deepEqual(b.get(token), { id: 'ana', role: 'Viewer' })
})

test('sign-in and sign-out are written in order, so a quick sign-out is never undone', async () => {
  const time = clock()
  const db = table()
  const s = store(db.persistence, time)
  const token = s.create({ id: 'ana', role: 'Viewer' })
  s.delete(token)
  await s.flush()
  assert.deepEqual(db.log, [`save ${sessionKey(token)}`, `remove ${sessionKey(token)}`])
  assert.equal(db.rows.size, 0)
})

test('expired sessions are not restored, and expiry still counts on the server', async () => {
  const time = clock()
  const db = table()
  const s = store(db.persistence, time)
  const token = s.create({ id: 'ana', role: 'Viewer' })
  await s.flush()
  time.advance(31 * MINUTE)
  const restarted = store(db.persistence, time)
  assert.equal(await restarted.restore(), 0)
  await restarted.ready(token)
  assert.equal(restarted.get(token), null)
  await restarted.flush()
  assert.equal(db.rows.size, 0, 'removed from the database too')
})

test('activity is written at most once a minute, and keeps the stored session from going idle', async () => {
  const time = clock()
  const db = table()
  const s = store(db.persistence, time)
  const token = s.create({ id: 'ana', role: 'Viewer' })
  await s.flush()
  for (let i = 0; i < 10; i++) {
    time.advance(10_000)
    s.get(token)
  }
  await s.flush()
  assert.equal(db.log.filter(line => line.startsWith('touch')).length, 1)
  time.advance(25 * MINUTE)
  s.get(token)
  await s.flush()
  time.advance(20 * MINUTE) // 45 minutes since sign-in, 20 since the last request
  const restarted = store(db.persistence, time)
  assert.equal(await restarted.restore(), 1)
})

test('when the database is down, sign-ins still work from memory and are stored once it is back', async () => {
  const time = clock()
  const db = table()
  const s = store(db.persistence, time)
  db.setDown(true)
  const token = s.create({ id: 'ana', role: 'Viewer' })
  await s.flush()
  time.advance(MINUTE)
  await s.ready(token)
  assert.ok(s.get(token), 'kept from memory while the database cannot be read')
  db.setDown(false)
  time.advance(MINUTE)
  await s.ready(token)
  await s.flush()
  assert.ok(s.get(token), 'not signed out because it was never stored')
  assert.ok(db.rows.has(sessionKey(token)), 'stored now')
})

test('flags such as a Seeds exception are stored and come back with the session', async () => {
  const time = clock()
  const db = table()
  const s = store(db.persistence, time)
  const token = s.create({ id: 'ana', role: 'Viewer' })
  s.setFlag(token, 'seedsException', true)
  await s.flush()
  const restored: string[] = []
  const after = store(db.persistence, time, {
    onRestore: (key: string, session: StoredSession<User>) => {
      if (session.flags.seedsException) restored.push(key)
    },
  })
  await after.restore()
  assert.deepEqual(restored, [sessionKey(token)])
  assert.deepEqual(after.flags(token), { seedsException: true })
})

test('signing a person out everywhere reaches sessions restored after a restart', async () => {
  const time = clock()
  const db = table()
  const s = store(db.persistence, time)
  const ana1 = s.create({ id: 'ana', role: 'Viewer' })
  const ana2 = s.create({ id: 'ana', role: 'Viewer' })
  const ben = s.create({ id: 'ben', role: 'Viewer' })
  await s.flush()
  const after = store(db.persistence, time)
  await after.restore()
  for (const [handle, user] of after.entries()) {
    assert.ok(!handle.match(/^[a-f0-9]{64}$/), 'a restored session is named by a stand-in, not its stored key')
    if (user.id === 'ana') after.delete(handle)
  }
  await after.flush()
  assert.deepEqual([...db.rows.keys()], [sessionKey(ben)])
  for (const token of [ana1, ana2]) {
    await after.ready(token)
    assert.equal(after.get(token), null)
  }
  assert.ok(after.get(ben))
})

test('with two servers, signing a person out everywhere on one reaches sessions made on the other', async () => {
  const time = clock()
  const db = table()
  const a = store(db.persistence, time)
  await a.restore() // A started first
  const b = store(db.persistence, time)
  const token = b.create({ id: 'ana', role: 'Viewer' })
  await b.flush()
  time.advance(MINUTE)
  await a.restore() // A's minute sync takes in B's sign-in
  for (const [handle, user] of a.entries()) if (user.id === 'ana') a.delete(handle)
  await a.flush()
  time.advance(MINUTE)
  await b.restore() // B's minute sync (or its next request) drops it
  assert.equal(b.get(token), null)
})

test('the minute sync never drops a session whose save landed after the list was read', async () => {
  const time = clock()
  const db = table()
  let s: SessionStore<User> | undefined
  let late = ''
  const persistence: SessionPersistence<User> = {
    ...db.persistence,
    async loadAll(now) {
      const rows = await db.persistence.loadAll(now)
      // A sign-in is made and stored while the list is on its way back.
      late = s!.create({ id: 'late', role: 'Viewer' })
      await s!.flush()
      return rows
    },
  }
  s = store(persistence, time)
  await s.restore()
  assert.ok(s.get(late), 'kept')
})

test('without a database the store works in memory exactly as before', async () => {
  const s = new SessionStore<User>()
  const token = s.create({ id: 'ana', role: 'Viewer' })
  await s.ready(token)
  assert.ok(s.get(token))
  assert.equal(await s.restore(), 0)
})

test('the session table: hashed key in, rows out; a missing table is reported once and keeps memory sessions', async () => {
  const queries: { sql: string; values: unknown[] }[] = []
  let missing = true
  const warnings: string[] = []
  const pool = {
    async query(sql: string, values: unknown[] = []) {
      queries.push({ sql, values })
      if (missing) throw Object.assign(new Error('relation "public.app_sessions" does not exist'), { code: '42P01' })
      if (sql.startsWith('select'))
        return {
          rows: [
            {
              token_hash: 'k',
              user_data: { id: 'ana' },
              flags: { seedsException: true },
              created_at: '2026-11-23T00:00:00.000Z',
              last_seen_at: '2026-11-23T01:00:00.000Z',
            },
          ],
        }
      return { rows: [] }
    },
  }
  let at = Date.parse('2026-11-23T02:00:00Z')
  const database = sessionDatabase<any>(pool, { now: () => at, warn: message => warnings.push(message) })
  const session = { user: { id: 'ana', organizationId: 'org' }, createdAt: at, lastSeenAt: at, flags: {} }
  await database.save('a'.repeat(64), session, at + MINUTE)
  await database.save('a'.repeat(64), session, at + MINUTE)
  assert.equal(warnings.length, 1, 'reported once')
  assert.equal(queries.length, 1, 'not asked again for ten minutes')
  await assert.rejects(database.load('k'), 'an unreadable store is not "signed out"')
  at += 10 * MINUTE
  missing = false
  await database.save('a'.repeat(64), session, at + MINUTE)
  const saved = queries.at(-1)!
  assert.match(saved.sql, /insert into public\.app_sessions/)
  assert.deepEqual(saved.values.slice(0, 4), ['a'.repeat(64), 'ana', 'org', 'tenant'])
  assert.deepEqual(await database.load('k'), {
    user: { id: 'ana' },
    flags: { seedsException: true },
    createdAt: Date.parse('2026-11-23T00:00:00Z'),
    lastSeenAt: Date.parse('2026-11-23T01:00:00Z'),
  })
})

test('wiring: sessions are loaded before every route, restored at start, and kept in schema v47', () => {
  const index = read('server/index.ts')
  assert.ok(index.indexOf('app.use(loadSession)') < index.indexOf('app.use(jsonBodies('), 'before the body limits')
  assert.match(index, /sessions\.restore\(\)/)
  assert.match(index, /sessions\.flush\(\)/)
  const auth = read('server/core/auth.ts')
  assert.match(auth, /persistence: db\?\.pool \? sessionDatabase<SessionUser>\(db\.pool\) : undefined/)
  const migration = read('database/migrations/schema-v47-sessions.sql')
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.app_sessions/)
  assert.match(migration, /47 as schema_version/)
  const schema = read('database/schema.sql')
  assert.match(schema, /CREATE TABLE public\.app_sessions/)
  assert.match(schema, /token_hash ~ '\^\[a-f0-9\]\{64\}\$'/)
  assert.ok(Number(/(\d+) as schema_version/.exec(schema)?.[1]) >= 47)
})
