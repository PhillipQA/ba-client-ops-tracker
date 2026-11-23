import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  applyWorkspaceChanges,
  changeConflict,
  diffWorkspace,
  fingerprint,
  hasChanges,
  isWorkspaceChanges,
} from '../src/shared/workspaceChanges'
import { changedRows } from '../server/services/record-changes'
import { loadCloudStore, queueCloudStoreSave, resetCloudSession } from '../src/app/cloudStore'

const read = (path: string) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const task = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: id, status: 'Open', ...extra })
const workspace = (items: any[], extra: Record<string, unknown> = {}) => ({
  schemaVersion: 6,
  clients: [{ id: 'c1', name: 'Acme' }],
  items,
  taskSettings: { statuses: [{ id: 'open', label: 'Open' }] },
  ...extra,
})

test('a one-field edit sends only that record, with how it looked before', () => {
  const before = workspace([task('a'), task('b'), task('c')])
  const after = { ...before, items: [task('a'), task('b', { status: 'Done' }), task('c')] }
  const changes = diffWorkspace(before, after)!
  assert.deepEqual(Object.keys(changes.collections), ['items'])
  assert.deepEqual(changes.collections.items.upsert, [task('b', { status: 'Done' })])
  assert.deepEqual(changes.collections.items.remove, [])
  assert.equal(changes.collections.items.base.b, fingerprint(task('b')))
  assert.deepEqual(changes.set, {})
  assert.deepEqual(changes.unset, [])
  const many = workspace(Array.from({ length: 50 }, (_, index) => task(`t${index}`)))
  const one = { ...many, items: many.items.map((item, index) => (index === 7 ? { ...item, status: 'Done' } : item)) }
  assert.ok(JSON.stringify(diffWorkspace(many, one)).length * 10 < JSON.stringify(one).length, 'far smaller')
})

test('nothing changed means an empty change set, even when the copy is a new object', () => {
  const before = workspace([task('a')])
  const changes = diffWorkspace(before, structuredClone(before))!
  assert.equal(hasChanges(changes), false)
})

test('laying the changes on the old copy gives the new copy: adds, edits, removals and other values', () => {
  const before = workspace([task('a'), task('b'), task('c'), task('d')], { note: 'x', gone: 1 })
  const cases = [
    { ...before, items: [task('new'), ...before.items] },
    { ...before, items: [task('a'), task('b'), task('mid1'), task('mid2'), task('c'), task('d')] },
    { ...before, items: [task('a'), task('c', { title: 'C!' }), task('d'), task('end')] },
    { ...before, items: [], note: 'y' },
    { ...before, taskSettings: { statuses: [{ id: 'open', label: 'To do' }] }, gone: undefined },
    { ...before, clients: [...before.clients, { id: 'c2', name: 'Beta' }], fresh: [1, 2] },
  ]
  for (const after of cases) {
    const changes = diffWorkspace(before, after)!
    assert.ok(isWorkspaceChanges(changes))
    const expected = JSON.parse(JSON.stringify(after))
    assert.deepEqual(JSON.parse(JSON.stringify(applyWorkspaceChanges(before, changes))), expected)
    assert.equal(changeConflict(before, changes), null, 'applies cleanly to the copy it came from')
  }
})

test('a reordered list is sent whole, so the order is kept', () => {
  const before = workspace([task('a'), task('b'), task('c')])
  const after = { ...before, items: [task('c'), task('a'), task('b')] }
  const changes = diffWorkspace(before, after)!
  assert.deepEqual(changes.collections, {})
  assert.deepEqual(
    (changes.set.items as any[]).map(item => item.id),
    ['c', 'a', 'b'],
  )
  assert.deepEqual(applyWorkspaceChanges(before, changes).items, after.items)
})

test('another save to different records does not block this one; a save to the same record does', () => {
  const before = workspace([task('a'), task('b'), task('c')])
  const mine = diffWorkspace(before, { ...before, items: [task('a', { status: 'Done' }), task('b'), task('c')] })!
  const theirs = { ...before, items: [task('theirs'), task('a'), task('b', { owner: 'Ben' }), task('c')] }
  assert.equal(changeConflict(theirs, mine), null)
  const saved = applyWorkspaceChanges(theirs, mine)
  assert.deepEqual(
    saved.items.map(item => `${item.id}:${item.status}`),
    ['theirs:Open', 'a:Done', 'b:Open', 'c:Open'],
  )
  assert.equal(saved.items[2].owner, 'Ben', 'their change is kept')

  const clash = { ...before, items: [task('a', { title: 'Renamed' }), task('b'), task('c')] }
  assert.equal(changeConflict(clash, mine), 'items a')
  const removedThere = { ...before, items: [task('b'), task('c')] }
  assert.equal(changeConflict(removedThere, mine), 'items a')
  const added = diffWorkspace(before, { ...before, items: [...before.items, task('x')] })!
  assert.equal(changeConflict({ ...before, items: [...before.items, task('x', { title: 'Other' })] }, added), 'items x')
  const settings = diffWorkspace(before, { ...before, taskSettings: { statuses: [] } })!
  assert.equal(changeConflict({ ...before, taskSettings: { statuses: [{ id: 'z' }] } }, settings), 'taskSettings')
})

test('fingerprints ignore key order; malformed change sets are refused', () => {
  assert.equal(fingerprint({ a: 1, b: { c: 2, d: 3 } }), fingerprint({ b: { d: 3, c: 2 }, a: 1 }))
  assert.notEqual(fingerprint({ a: 1 }), fingerprint({ a: 2 }))
  for (const bad of [
    null,
    [],
    { collections: {}, set: {}, setBase: {} },
    { collections: { items: { upsert: [{ title: 'no id' }], remove: [], base: {} } }, set: {}, unset: [], setBase: {} },
    { collections: { items: { upsert: [], remove: [1], base: {} } }, set: {}, unset: [], setBase: {} },
  ])
    assert.equal(isWorkspaceChanges(bad), false, JSON.stringify(bad))
  // A record changed without saying how it looked before cannot slip past the check.
  const sneaky = { collections: { items: { upsert: [task('a')], remove: [], base: {} } }, set: {}, unset: [], setBase: {} }
  assert.equal(changeConflict(workspace([task('a')]), sneaky), 'items a')
})

test('the database is sent only the rows that changed; users are still written whole', () => {
  const before = {
    tasks: [
      { id: 't1', title: 'A', raw_data: { id: 't1' } },
      { id: 't2', title: 'B', raw_data: { id: 't2' } },
    ],
    inquiries: [] as any[],
    app_users: [{ id: 'u1', name: 'Ana' }],
  }
  const after = {
    tasks: [
      { id: 't1', title: 'A', raw_data: { id: 't1' } },
      { id: 't3', title: 'C', raw_data: { id: 't3' } },
    ],
    inquiries: [{ id: 't2', title: 'B', raw_data: { id: 't2', type: 'Inquiry' } }],
    app_users: [{ id: 'u1', name: 'Ana' }],
  }
  const { changes, counts } = changedRows(before, after, ['app_users'])
  assert.deepEqual(changes.tasks, { upsert: [after.tasks[1]], remove: ['t2'] })
  assert.deepEqual(changes.inquiries, { upsert: after.inquiries, remove: [] })
  assert.deepEqual(changes.app_users, { upsert: after.app_users, remove: [], replace: true })
  assert.deepEqual(counts, { tasks: 2, inquiries: 1, app_users: 1 })
  const same = changedRows(after, structuredClone(after), ['app_users'])
  assert.deepEqual(Object.keys(same.changes), ['app_users'], 'unchanged tables are not written')
})

test('the browser sends a change set, and the whole copy once a server without the route answers', async () => {
  const base = workspace([task('a'), task('b')])
  let server = { version: 'v0', data: structuredClone(base) as any }
  const sent: { method: string; body: any }[] = []
  let patchSupported = true
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (url: string, init?: any) => {
    const reply = (status: number, body: any) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    if (url === '/api/store' && !init?.method) return reply(200, { configured: true, ...server, revision: server.version })
    const body = JSON.parse(init.body)
    sent.push({ method: init.method, body })
    if (init.method === 'PATCH' && !patchSupported) return reply(404, { error: 'Not found' })
    const data = init.method === 'PATCH' ? applyWorkspaceChanges(server.data, body.changes) : body.data
    server = { version: `v${sent.length}`, data }
    return reply(200, { configured: true, version: server.version, updatedAt: 'now' })
  }) as any
  try {
    resetCloudSession()
    await loadCloudStore()
    await queueCloudStoreSave({ ...base, items: [task('a', { status: 'Done' }), task('b')] })
    assert.equal(sent.length, 1)
    assert.equal(sent[0].method, 'PATCH')
    assert.deepEqual(Object.keys(sent[0].body.changes.collections), ['items'])
    assert.deepEqual(sent[0].body.changes.collections.items.upsert, [task('a', { status: 'Done' })])
    assert.equal(sent[0].body.data, undefined, 'the whole workspace is not sent')
    assert.equal(server.data.items[0].status, 'Done')

    patchSupported = false
    await queueCloudStoreSave({ ...base, items: [task('a', { status: 'Done' }), task('b', { status: 'Done' })] })
    assert.deepEqual(
      sent.slice(1).map(entry => entry.method),
      ['PATCH', 'PUT'],
      'tried once, then the whole copy',
    )
    await queueCloudStoreSave({ ...base, items: [task('a'), task('b', { status: 'Done' })] })
    assert.equal(sent.at(-1)!.method, 'PUT', 'and stays with the whole copy')
    assert.equal(server.data.items[0].status, 'Open')
  } finally {
    globalThis.fetch = realFetch
    resetCloudSession()
  }
})

test('a save taken onto unseen changes keeps the old version, so a later whole copy cannot overwrite them', async () => {
  const base = workspace([task('a'), task('b')])
  const sent: any[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (url: string, init?: any) => {
    const reply = (status: number, body: any) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    if (url === '/api/store' && !init?.method) return reply(200, { configured: true, data: base, version: 'v0' })
    sent.push(JSON.parse(init.body))
    return reply(200, { configured: true, version: 'v9', updatedAt: 'now', behind: true })
  }) as any
  try {
    resetCloudSession()
    await loadCloudStore()
    await queueCloudStoreSave({ ...base, items: [task('a', { status: 'Done' }), task('b')] })
    await queueCloudStoreSave({ ...base, items: [task('a', { status: 'Done' }), task('b', { status: 'Done' })] })
    assert.deepEqual(
      sent.map(body => body.baseVersion),
      ['v0', 'v0'],
    )
  } finally {
    globalThis.fetch = realFetch
    resetCloudSession()
  }
})

test('wiring: PATCH /api/store/changes shares the save checks; schema v46 writes only changed rows', () => {
  const routes = read('server/workspace/store-routes.ts')
  assert.match(routes, /app\.put\('\/api\/store', requireAuth, requireTenantWorkspace, saveWorkspace\('full'\)\)/)
  assert.match(routes, /app\.patch\('\/api\/store\/changes', requireAuth, requireTenantWorkspace, saveWorkspace\('changes'\)\)/)
  assert.match(routes, /behind && changeConflict\(visible, changes\)/)
  assert.match(routes, /behind \? \{ behind: true \}/)
  assert.match(routes, /applyWorkspaceChanges\(visible, changes\)/)

  const tenant = read('server/core/tenant-state.ts')
  assert.match(tenant, /db\.rpc\('save_tenant_changes_v1'/)
  assert.match(tenant, /code === 'BA046'/, 'out-of-step tables fall back to the full save')
  assert.match(tenant, /code === 'PGRST202' \|\| code === '42883'/, 'a database without v46 falls back to the full save')
  assert.match(tenant, /db\.rpc\('save_tenant_state_v16'/, 'the full save is still there')

  const migration = read('database/migrations/schema-v46-changed-record-saves.sql')
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.save_tenant_changes_v1\(/)
  assert.match(migration, /46 as schema_version/)
  for (const sql of [migration, read('database/schema.sql')]) {
    assert.match(sql, /errcode = 'BA046'/)
    assert.match(sql, /errcode = '40001'/, 'the same revision check as v16')
    assert.match(sql, /for update/, 'the same lock as v16')
  }
  const schema = read('database/schema.sql')
  assert.match(schema, /CREATE FUNCTION public\.save_tenant_changes_v1\(/)
  assert.ok(Number(/(\d+) as schema_version/.exec(schema)?.[1]) >= 46)

  const cloud = read('src/app/cloudStore.ts')
  assert.match(cloud, /diffWorkspace\(serverData, payload\)/)
  assert.match(cloud, /'\/api\/store\/changes'/)
})
