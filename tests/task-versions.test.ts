import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  applyWorkspaceChanges,
  changesSince,
  diffWorkspace,
  fingerprint,
  hasChanges,
  isWorkspaceVersions,
  workspaceVersions,
} from '../src/shared/workspaceChanges'
import { chooseForClash, clashSides, clashTarget } from '../src/app/conflictChoice'
import { mergeWorkspace } from '../src/app/workspaceMerge'
import {
  loadCloudStore,
  queueCloudStoreSave,
  resetCloudSession,
  resolveSaveClash,
  saveClash,
  WORKSPACE_MERGED,
} from '../src/app/cloudStore'

const read = (path: string) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const task = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Task ${id}`,
  status: 'Open',
  ...extra,
})
const workspace = (items: any[], extra: Record<string, unknown> = {}) => ({
  schemaVersion: 6,
  clients: [{ id: 'c1', name: 'Acme' }],
  items,
  taskSettings: { statuses: [{ id: 'open', label: 'Open' }] },
  ...extra,
})
const json = (value: unknown) => JSON.parse(JSON.stringify(value))
const reply = (status: number, body: any) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

test('a refresh downloads only what differs from the copy it has, and rebuilds the latest exactly', () => {
  const old = workspace([task('a'), task('b'), task('c'), task('d')], { note: 'x', gone: 1 })
  const cases = [
    old,
    { ...old, items: [task('new'), ...old.items] },
    { ...old, items: [task('a'), task('b'), task('mid'), task('c'), task('d')] },
    { ...old, items: [task('a'), task('c', { status: 'Done' }), task('d'), task('end')] },
    { ...old, items: [task('d'), task('c'), task('b'), task('a')] },
    { ...old, items: [], note: 'y', gone: undefined },
    { ...old, clients: [...old.clients, { id: 'c2', name: 'Beta' }], extra: [1, 2] },
  ]
  for (const latest of cases) {
    const versions = json(workspaceVersions(old))
    assert.ok(isWorkspaceVersions(versions))
    const changes = json(changesSince(versions, latest))
    assert.deepEqual(json(applyWorkspaceChanges(old, changes)), json(latest))
  }
  const one = { ...old, items: old.items.map(item => (item.id === 'c' ? { ...item, status: 'Done' } : item)) }
  const changes = changesSince(workspaceVersions(old), one)
  assert.deepEqual(changes.collections.items.upsert, [task('c', { status: 'Done' })], 'only the changed task')
  assert.equal(hasChanges(changesSince(workspaceVersions(old), structuredClone(old))), false, 'nothing when unchanged')
})

test('record versions are small next to the records', () => {
  const big = workspace(
    Array.from({ length: 200 }, (_, index) =>
      task(`t${index}`, { description: 'Lorem ipsum dolor sit amet '.repeat(20) }),
    ),
  )
  assert.ok(JSON.stringify(workspaceVersions(big)).length * 20 < JSON.stringify(big).length)
})

test('choosing per record: "theirs" drops my edit to that record only; "mine" keeps it over theirs', () => {
  const base = workspace([task('a'), task('b')])
  const mine = workspace([task('a', { status: 'Done' }), task('b', { status: 'Blocked' })])
  const theirs = workspace([task('a'), task('b', { status: 'Waiting' }), task('x')])
  const clash = mergeWorkspace(base, mine, theirs)
  assert.equal(clash.ok, false)
  if (clash.ok) return
  assert.deepEqual(clashTarget(clash.clash), { key: 'items', id: 'b' })
  const sides = clashSides(mine, theirs, clash.clash)
  assert.equal(sides.label, 'Task b')
  assert.equal(sides.field, 'status')

  const keepTheirs = chooseForClash(base, mine, theirs, clash.clash, 'theirs')
  const a = mergeWorkspace(keepTheirs.base, keepTheirs.mine, theirs)
  assert.ok(a.ok)
  if (a.ok)
    assert.deepEqual(
      a.data.items.map(item => `${item.id}:${item.status}`),
      ['a:Done', 'b:Waiting', 'x:Open'],
    )
  const keepMine = chooseForClash(base, mine, theirs, clash.clash, 'mine')
  const b = mergeWorkspace(keepMine.base, keepMine.mine, theirs)
  assert.ok(b.ok)
  if (b.ok)
    assert.deepEqual(
      b.data.items.map(item => `${item.id}:${item.status}`),
      ['a:Done', 'b:Blocked', 'x:Open'],
    )
})

test('choosing per record also settles a delete against an edit, and a clashing setting', () => {
  const base = workspace([task('a'), task('b')])
  const mine = workspace([task('a')]) // I deleted b
  const theirs = workspace([task('a'), task('b', { status: 'Done' })]) // they changed it
  const clash = mergeWorkspace(base, mine, theirs)
  assert.equal(clash.ok, false)
  if (clash.ok) return
  const kept = chooseForClash(base, mine, theirs, clash.clash, 'mine')
  const deleted = mergeWorkspace(kept.base, kept.mine, theirs)
  assert.ok(deleted.ok && deleted.data.items.every(item => item.id !== 'b'), 'my delete wins')
  const back = chooseForClash(base, mine, theirs, clash.clash, 'theirs')
  const restored = mergeWorkspace(back.base, back.mine, theirs)
  assert.ok(restored.ok && restored.data.items.some(item => item.id === 'b' && item.status === 'Done'), 'theirs back')

  const settingsBase = workspace([], { taskSettings: { statuses: [{ id: 'open', label: 'Open' }] } })
  const settingsMine = workspace([], { taskSettings: { statuses: [{ id: 'open', label: 'To do' }] } })
  const settingsTheirs = workspace([], { taskSettings: { statuses: [{ id: 'open', label: 'Backlog' }] } })
  const settingClash = mergeWorkspace(settingsBase, settingsMine, settingsTheirs)
  assert.equal(settingClash.ok, false)
  if (settingClash.ok) return
  assert.equal(clashTarget(settingClash.clash).key, 'taskSettings')
  const chosen = chooseForClash(settingsBase, settingsMine, settingsTheirs, settingClash.clash, 'theirs')
  const merged = mergeWorkspace(chosen.base, chosen.mine, settingsTheirs)
  assert.ok(merged.ok && merged.data.taskSettings.statuses[0].label === 'Backlog')
})

/** A fake server: GET, delta sync, and change-set saves that adjust what was saved (as the real pipeline does). */
function fakeServer(initial: any, adjust: (data: any) => any = data => data) {
  const state = { version: 'v0', data: structuredClone(initial) as any, calls: [] as { url: string; body?: any }[] }
  const fetch = (async (url: string, init?: any) => {
    const body = init?.body ? JSON.parse(init.body) : undefined
    state.calls.push({ url: `${init?.method || 'GET'} ${url}`, body })
    if (url === '/api/store' && !init?.method)
      return reply(200, { configured: true, ...state, revision: state.version })
    if (url === '/api/store/sync')
      return reply(200, { configured: true, version: state.version, changes: changesSince(body.versions, state.data) })
    if (url === '/api/store/changes') {
      if (body.baseVersion !== state.version)
        return reply(409, { configured: true, refreshRequired: true, error: 'This workspace has newer changes.' })
      const sent = applyWorkspaceChanges(state.data, body.changes)
      state.data = adjust(structuredClone(sent))
      state.version = `v${state.calls.length}`
      return reply(200, { configured: true, version: state.version, adjusted: diffWorkspace(sent, state.data) })
    }
    return reply(404, {})
  }) as any
  return { state, fetch }
}

async function withBrowser(fetch: any, run: (events: any[]) => Promise<void>) {
  const realFetch = globalThis.fetch
  const realWindow = (globalThis as any).window
  const events: any[] = []
  ;(globalThis as any).window = { dispatchEvent: (event: any) => events.push(event) }
  globalThis.fetch = fetch
  try {
    resetCloudSession()
    await run(events)
  } finally {
    globalThis.fetch = realFetch
    ;(globalThis as any).window = realWindow
    resetCloudSession()
  }
}

test('a refresh with a copy in hand sends record versions and gets only the changed task', async () => {
  const server = fakeServer(workspace([task('a'), task('b')]))
  await withBrowser(server.fetch, async () => {
    await loadCloudStore()
    server.state.data = workspace([task('a'), task('b', { status: 'Done' })])
    server.state.version = 'v-other'
    const result = await loadCloudStore()
    const sync = server.state.calls.at(-1)!
    assert.equal(sync.url, 'POST /api/store/sync')
    assert.deepEqual(json(result.data), json(server.state.data))
    assert.equal(result.version, 'v-other')
  })
})

test('a server without delta loads gets plain loads', async () => {
  const server = fakeServer(workspace([task('a')]))
  let syncTries = 0
  const fetch = (async (url: string, init?: any) => {
    if (url !== '/api/store/sync') return server.fetch(url, init)
    syncTries++
    return reply(404, {})
  }) as any
  await withBrowser(fetch, async () => {
    await loadCloudStore()
    await loadCloudStore()
    await loadCloudStore()
    assert.equal(syncTries, 1, 'tried once')
    assert.deepEqual(
      server.state.calls.map(call => call.url),
      ['GET /api/store', 'GET /api/store', 'GET /api/store'],
      'then whole loads',
    )
  })
})

test('what the server adjusted in a save is taken in, so the next save from another copy is not refused', async () => {
  // The server stamps every saved task (as the real one normalizes dates and keeps server-owned fields).
  const stamp = (data: any) => ({ ...data, items: data.items.map((item: any) => ({ ...item, stamped: true })) })
  const server = fakeServer(workspace([task('a'), task('b')]), stamp)
  await withBrowser(server.fetch, async events => {
    await loadCloudStore()
    await queueCloudStoreSave(workspace([task('a', { status: 'Done' }), task('b')]))
    const shown = events.find(event => event.type === WORKSPACE_MERGED)
    assert.ok(shown, 'the app is shown what the server made of the save')
    assert.equal(shown.detail.data.items[0].stamped, true)
    // Someone else saves a different task; this browser's next edit to a, with a fingerprint of a as stored, goes in.
    const other = server.state.data
    server.state.data = {
      ...other,
      items: other.items.map((item: any) => (item.id === 'b' ? { ...item, owner: 'Ben' } : item)),
    }
    server.state.version = 'v-ben'
    await queueCloudStoreSave({
      ...shown.detail.data,
      items: shown.detail.data.items.map((item: any) => (item.id === 'a' ? { ...item, title: 'Renamed' } : item)),
    })
    const saves = server.state.calls.filter(call => call.url === 'PATCH /api/store/changes')
    const last = saves.at(-1)!.body
    assert.equal(last.changes.collections.items.base.a, fingerprint(other.items[0]), 'compares with what is stored')
    assert.equal(server.state.data.items.find((item: any) => item.id === 'b').owner, 'Ben', 'their change kept')
    assert.equal(server.state.data.items.find((item: any) => item.id === 'a').title, 'Renamed')
  })
})

test('a save conflict is settled per record: Use theirs, then saving resumes with my other edits', async () => {
  const server = fakeServer(workspace([task('a'), task('b')]))
  await withBrowser(server.fetch, async events => {
    await loadCloudStore()
    server.state.data = workspace([task('a'), task('b', { status: 'Waiting' })])
    server.state.version = 'v-ben'
    await assert.rejects(
      queueCloudStoreSave(workspace([task('a', { status: 'Done' }), task('b', { status: 'Blocked' })])),
      /same record/,
    )
    const clash = saveClash()!
    assert.equal(clash.label, 'Task b')
    assert.equal((clash.mine as any).status, 'Blocked')
    assert.equal((clash.theirs as any).status, 'Waiting')
    const result = await resolveSaveClash('theirs')
    assert.equal(result.done, true)
    assert.deepEqual(
      server.state.data.items.map((item: any) => `${item.id}:${item.status}`),
      ['a:Done', 'b:Waiting'],
    )
    assert.ok(
      events.some(event => event.type === WORKSPACE_MERGED),
      'the app shows the settled workspace',
    )
    assert.equal(saveClash(), undefined)
  })
})

test('Keep mine puts my version of the record over theirs', async () => {
  const server = fakeServer(workspace([task('a'), task('b')]))
  await withBrowser(server.fetch, async () => {
    await loadCloudStore()
    server.state.data = workspace([task('a'), task('b', { status: 'Waiting' })])
    server.state.version = 'v-ben'
    await assert.rejects(queueCloudStoreSave(workspace([task('a'), task('b', { status: 'Blocked' })])))
    await resolveSaveClash('mine')
    assert.equal(server.state.data.items[1].status, 'Blocked')
  })
})

test('wiring: delta sync route, adjustments in the save answer, and the choice in the Save conflict box', () => {
  const routes = read('server/workspace/store-routes.ts')
  assert.match(routes, /app\.post\('\/api\/store\/sync', requireAuth, requireTenantWorkspace/)
  assert.match(routes, /changesSince\(req\.body\.versions, sanitizeStateForClient\(state\.data, user\)\)/)
  assert.match(routes, /diffWorkspace\(sent, sanitizeStateForClient\(saved\.state, user\)\)/)
  assert.match(read('server/core/tenant-state.ts'), /return \{ \.\.\.saved, state: reconciled \}/)
  const app = read('src/app/App.tsx')
  assert.match(app, /<ConflictChoice conflict=\{saveConflict\} settle=\{settleConflict\} \/>/)
  assert.match(read('src/app/state/useCloudSync.ts'), /resolveSaveClash<Store>\(choice\)/)
})
