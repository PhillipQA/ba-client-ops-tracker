import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createWorkHubSync, WORK_HUB_INTEGRATIONS } from '../src/features/work-hub/workHubSync'
import type { AuthUser } from '../src/features/accounts/auth'

const user: AuthUser = {
  id: 'alice',
  organizationId: 'tenant-a',
  username: 'alice',
  name: 'Alice',
  email: '',
  phone: '',
  role: 'Contributor',
  status: 'Active',
  modules: ['inbox', 'items'],
  accountType: 'tenant',
  lastLoginAt: '2026-10-08T02:00:00Z',
}
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
function fixture() {
  const saved = new Map<string, string>()
  const storage = {
    getItem: (key: string) => saved.get(key) || null,
    setItem: (key: string, value: string) => {
      saved.set(key, value)
    },
  }
  const calls: { url: string; method: string; signal?: AbortSignal | null }[] = []
  const connections = {
    github: { connected: true, repositories: [{ fullName: 'acme/app' }] },
    gitlab: { connected: true, repositories: [{ fullName: 'acme/app' }] },
  }
  const settings = {
    gmailConnected: true,
    gmailAvailable: true,
    gmailLabels: ['INBOX'],
    discordUserId: '123456789012345678',
  }
  const failures = new Map<string, number>(),
    gates = new Map<string, Promise<void>>()
  let hasMore = false
  const request = async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method || 'GET', signal: init.signal })
    await gates.get(url)
    if (failures.has(url)) return json({ error: 'Provider unavailable.' }, failures.get(url))
    if (url === '/api/communications/settings') return json(settings)
    if (url.endsWith('/connection')) return json(url.includes('/github/') ? connections.github : connections.gitlab)
    if (url.endsWith('/sync')) {
      assert.deepEqual(JSON.parse(String(init.body)), { auto: false })
      return json({ imported: 2, updated: 1, hasMore })
    }
    return json({ items: [{ id: String(calls.length) }], total: 1 })
  }
  const hub = createWorkHubSync({ request, storage })
  const syncs = () => calls.filter(call => call.method === 'POST').map(call => call.url)
  return {
    hub,
    request,
    storage,
    calls,
    syncs,
    connections,
    settings,
    failures,
    gates,
    setHasMore: (value: boolean) => {
      hasMore = value
    },
  }
}

test('login syncs every connected integration once; session checks do not repeat it', async () => {
  const f = fixture()
  await f.hub.setSession(user, true)
  assert.deepEqual(f.syncs().sort(), [
    '/api/communications/gmail/sync',
    '/api/work-hub/github/sync',
    '/api/work-hub/gitlab/sync',
  ])
  assert.equal(f.calls.filter(c => c.url === '/api/communications/settings').length, 1)
  assert.equal(f.calls.filter(c => c.url.includes('tab=Discord')).length, 1)
  for (const id of WORK_HUB_INTEGRATIONS) assert.equal(f.hub.getSnapshot().integrations[id].phase, 'success')
  const count = f.calls.length
  await f.hub.setSession({ ...user, name: 'Updated name' })
  await f.hub.setSession(user)
  await f.hub.setSession({ ...user, lastLoginAt: '2026-10-08T10:00:00.000000+08:00' })
  assert.equal(f.calls.length, count)
})

test('a restored browser session does not sync again; a new login does', async () => {
  const f = fixture()
  await f.hub.setSession(user, true)
  const restored = createWorkHubSync({ request: f.request, storage: f.storage })
  const count = f.calls.length
  await restored.setSession(user)
  assert.equal(f.calls.length, count)
  await restored.setSession({ ...user, lastLoginAt: '2026-10-08T03:00:00Z' })
  assert.equal(f.syncs().length, 6)
  await restored.setSession(null)
  await restored.setSession(user, true) // Legacy accounts can lack a login timestamp.
  assert.equal(f.syncs().length, 9)
})

test('Refresh now syncs all connected integrations again', async () => {
  const f = fixture()
  await f.hub.setSession(user, true)
  f.calls.length = 0
  await f.hub.syncAll()
  assert.equal(f.syncs().length, 3)
  assert.equal(f.calls.filter(c => c.url.includes('tab=Discord')).length, 1)
  for (const id of WORK_HUB_INTEGRATIONS) assert.equal(f.hub.getSnapshot().integrations[id].revision, 2)
})

for (const source of WORK_HUB_INTEGRATIONS)
  test(`Sync ${source} leaves other integrations and their cached data alone`, async () => {
    const f = fixture()
    await f.hub.setSession(user, true)
    const unrelated = source === 'gitlab' ? 'github' : 'gitlab'
    const url = `/api/work-hub/${unrelated}/tickets?page=2`
    const cached = await f.hub.read(unrelated, url)
    f.calls.length = 0
    await f.hub.syncOne(source)
    assert.deepEqual(await f.hub.read(unrelated, url), cached)
    assert.ok(
      f.calls.every(c =>
        source === 'gmail'
          ? c.url.startsWith('/api/communications') && !c.url.includes('tab=Discord')
          : source === 'discord'
            ? c.url === '/api/communications/settings' || c.url.includes('tab=Discord')
            : c.url.startsWith(`/api/work-hub/${source}/`),
      ),
    )
    assert.equal(f.syncs().length, source === 'discord' ? 0 : 1)
    assert.equal(f.hub.getSnapshot().integrations[unrelated].revision, 1)
  })

test('disconnected integrations and integrations with no selected scope are skipped', async () => {
  const f = fixture()
  f.settings.gmailLabels = []
  f.settings.discordUserId = ''
  f.connections.github.connected = false
  f.connections.gitlab.repositories = []
  await f.hub.setSession(user, true)
  assert.equal(f.syncs().length, 0)
  assert.equal(f.calls.filter(c => c.url.includes('/tickets?') || c.url.includes('/communications?')).length, 0)
  for (const id of WORK_HUB_INTEGRATIONS) assert.equal(f.hub.getSnapshot().integrations[id].phase, 'skipped')
})

test('a failed source does not stop the others or retry on a timer; backfills wait for Sync', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture()
  f.failures.set('/api/work-hub/github/sync', 429)
  f.setHasMore(true)
  await f.hub.setSession(user, true)
  assert.equal(f.hub.getSnapshot().integrations.github.phase, 'error')
  assert.equal(f.hub.getSnapshot().integrations.gitlab.phase, 'success')
  assert.match(f.hub.getSnapshot().integrations.gmail.message, /Click Sync again/)
  const count = f.calls.length
  t.mock.timers.tick(3_600_000)
  await settle()
  assert.equal(f.calls.length, count)
  f.failures.clear()
  await f.hub.syncOne('github')
  assert.equal(f.hub.getSnapshot().integrations.github.phase, 'success')
})

test('overlapping all-source and individual requests share one job per integration', async () => {
  const f = fixture()
  await f.hub.setSession(user, true)
  f.calls.length = 0
  let release!: () => void
  f.gates.set(
    '/api/work-hub/gitlab/sync',
    new Promise(resolve => {
      release = resolve
    }),
  )
  const one = f.hub.syncOne('gitlab')
  assert.equal(f.hub.syncOne('gitlab'), one)
  const all = f.hub.syncAll()
  assert.equal(f.hub.syncAll(), all)
  await settle()
  release()
  await Promise.all([one, all])
  assert.equal(f.syncs().filter(url => url.includes('/gitlab/')).length, 1)
  assert.equal(f.hub.getSnapshot().allRunning, false)
})

test('sign-out aborts work and prevents late responses or cached content crossing accounts', async () => {
  const f = fixture()
  await f.hub.setSession(user, true)
  const url = '/api/work-hub/gitlab/tickets?page=2'
  await f.hub.read('gitlab', url)
  let release!: () => void
  f.gates.set(
    '/api/work-hub/gitlab/sync',
    new Promise(resolve => {
      release = resolve
    }),
  )
  const pending = f.hub.syncOne('gitlab')
  await settle()
  const signal = f.calls.findLast(c => c.url === '/api/work-hub/gitlab/sync')!.signal!
  await f.hub.setSession(null)
  assert.equal(signal.aborted, true)
  assert.equal(f.hub.peek('gitlab', url), undefined)
  release()
  await pending
  assert.equal(f.hub.getSnapshot().integrations.gitlab.phase, 'idle')
  f.gates.clear()
  await f.hub.setSession({ ...user, id: 'bob', organizationId: 'tenant-b' }, true)
  const count = f.calls.length
  await f.hub.read('gitlab', url)
  assert.equal(f.calls.length, count + 1)
})

test('tabs and filters reuse saved pages; cancelling one view does not cancel another', async () => {
  const f = fixture()
  await f.hub.setSession(user, true)
  const url = '/api/communications?page=1&pageSize=5&tab=Gmail&archived=false'
  const count = f.calls.length
  await f.hub.read('gmail', url)
  await f.hub.read('gmail', url)
  assert.equal(f.calls.length, count)
  const signal = new AbortController()
  const cancelled = f.hub.read('gmail', '/api/communications?page=2', signal.signal)
  const otherView = f.hub.read('gmail', '/api/communications?page=2')
  signal.abort()
  await assert.rejects(cancelled, { name: 'AbortError' })
  assert.ok((await otherView).items.length)
  assert.equal(f.calls.filter(c => c.url === '/api/communications?page=2').length, 1)
})

test('a stale read cannot overwrite a refreshed source cache', async () => {
  let release!: () => void,
    requests = 0
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const hub = createWorkHubSync({
    request: async () => {
      const value = ++requests
      if (value === 1) await gate
      return json({ value })
    },
  })
  const old = hub.read('gmail', '/page')
  hub.invalidate('gmail')
  assert.deepEqual(await hub.read('gmail', '/page'), { value: 2 })
  release()
  // The waiting view gets the refreshed page instead of a cancel it would ignore (and spin on).
  assert.deepEqual(await old, { value: 2 })
  assert.deepEqual(await hub.read('gmail', '/page'), { value: 2 })
  assert.equal(requests, 2)
})

test('opening an unread email: marking it read mid-load still delivers the thread', async () => {
  let release!: () => void,
    requests = 0
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const hub = createWorkHubSync({
    request: async () => {
      const value = ++requests
      if (value === 1) await gate
      return json({ items: [{ id: 'm1', read: value > 1 }], total: 1 })
    },
  })
  const thread = hub.read('gmail', '/api/communications/m1/thread?page=1', new AbortController().signal)
  hub.invalidate('gmail') // markRead finishes before the thread request
  release()
  assert.deepEqual(await thread, { items: [{ id: 'm1', read: true }], total: 1 })
  assert.equal(requests, 2)
})

test('users without Work Hub and Internal Admin never fetch integration data', async () => {
  const f = fixture()
  for (const account of [
    { ...user, modules: [] },
    { ...user, accountType: 'platform' as const },
    { ...user, status: 'Disabled' as const },
  ]) {
    await f.hub.setSession(account, true)
    await f.hub.syncAll()
    await f.hub.syncOne('gmail')
  }
  assert.equal(f.calls.length, 0)
})
