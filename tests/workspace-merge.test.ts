import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeWorkspace } from '../src/app/workspaceMerge'
import { loadCloudStore, queueCloudStoreSave, resetCloudSession, WORKSPACE_MERGED } from '../src/app/cloudStore'
import { applyWorkspaceChanges, changesSince } from '../src/shared/workspaceChanges'

/** What a fake server stores for a save: the whole copy (PUT) or its stored copy with the changes laid on (PATCH). */
const savedData = (body: any, stored: any) => (body.changes ? applyWorkspaceChanges(stored, body.changes) : body.data)

const task = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: id, status: 'Open', ...extra })
const base = {
  schemaVersion: 6,
  items: [task('a'), task('b'), task('c')],
  activity: [{ id: 'x1', text: 'old' }],
  taskSettings: { statuses: [{ label: 'Open' }] },
}

test('changes to different tasks, or different fields of one task, are both kept', () => {
  const mine = {
    ...base,
    items: [task('new-mine'), task('a', { status: 'Done' }), task('b'), task('c', { title: 'C mine' })],
    activity: [{ id: 'm1', text: 'mine' }, ...base.activity],
  }
  const theirs = {
    ...base,
    items: [task('new-theirs'), task('a'), task('b', { status: 'Blocked' }), task('c', { dueDate: '2026-11-02' })],
    activity: [{ id: 't1', text: 'theirs' }, ...base.activity],
  }
  const merged = mergeWorkspace(base, mine, theirs)
  assert.ok(merged.ok)
  if (!merged.ok) return
  assert.deepEqual(
    merged.data.items.map(item => [item.id, item.status, item.title, (item as any).dueDate]),
    [
      ['new-mine', 'Open', 'new-mine', undefined],
      ['new-theirs', 'Open', 'new-theirs', undefined],
      ['a', 'Done', 'a', undefined],
      ['b', 'Blocked', 'b', undefined],
      ['c', 'Open', 'C mine', '2026-11-02'],
    ],
  )
  assert.deepEqual(
    merged.data.activity.map(entry => entry.id),
    ['m1', 't1', 'x1'],
    'newest first, from both sides',
  )
})

test('the same field changed differently on both sides is a clash; the same change is not', () => {
  const mine = { ...base, items: [task('a', { status: 'Done' }), task('b'), task('c')] }
  const clash = mergeWorkspace(base, mine, { ...base, items: [task('a', { status: 'Blocked' }), task('b'), task('c')] })
  assert.equal(clash.ok, false)
  if (!clash.ok) assert.match(clash.clash, /items\[a\]\.status/)
  assert.ok(mergeWorkspace(base, mine, { ...base, items: [task('a', { status: 'Done' }), task('b'), task('c')] }).ok)
})

test('a delete on one side stands unless the other side changed that record', () => {
  const deleted = { ...base, items: [task('a'), task('c')] }
  const untouched = mergeWorkspace(base, deleted, {
    ...base,
    items: [task('a', { status: 'Done' }), task('b'), task('c')],
  })
  assert.ok(untouched.ok)
  if (untouched.ok)
    assert.deepEqual(
      untouched.data.items.map(item => item.id),
      ['a', 'c'],
    )
  const changed = mergeWorkspace(base, deleted, {
    ...base,
    items: [task('a'), task('b', { status: 'Done' }), task('c')],
  })
  assert.equal(changed.ok, false)
})

test('a save refused because someone else saved first is merged onto theirs and saved again', async () => {
  let server = { version: 'v0', data: structuredClone(base) as any }
  const puts: any[] = []
  const realFetch = globalThis.fetch
  const realWindow = (globalThis as any).window
  const events: any[] = []
  ;(globalThis as any).window = { dispatchEvent: (event: any) => events.push(event) }
  globalThis.fetch = (async (url: string, init?: any) => {
    const reply = (status: number, body: any) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    if (url === '/api/store' && (!init || !init.method))
      return reply(200, { configured: true, ...server, revision: server.version })
    if (url === '/api/store/sync')
      return reply(200, {
        configured: true,
        version: server.version,
        changes: changesSince(JSON.parse(init.body).versions, server.data),
      })
    if ((url === '/api/store' && init.method === 'PUT') || (url === '/api/store/changes' && init.method === 'PATCH')) {
      const body = JSON.parse(init.body)
      puts.push(body)
      if (body.baseVersion !== server.version)
        return reply(409, { configured: true, refreshRequired: true, error: 'This workspace has newer changes.' })
      server = { version: `v${puts.length}`, data: savedData(body, server.data) }
      return reply(200, { configured: true, version: server.version, updatedAt: 'now' })
    }
    return reply(404, {})
  }) as any
  try {
    resetCloudSession()
    await loadCloudStore()
    // Someone else adds a task in the meantime.
    server = { version: 'v-other', data: { ...base, items: [task('theirs'), ...base.items] } }
    // This browser completes task a, from the copy it loaded.
    const result = await queueCloudStoreSave({ ...base, items: [task('a', { status: 'Done' }), task('b'), task('c')] })
    assert.equal(result.configured, true)
    assert.equal(puts.length, 2, 'refused once, then saved merged')
    assert.deepEqual(
      server.data.items.map((item: any) => [item.id, item.status]),
      [
        ['theirs', 'Open'],
        ['a', 'Done'],
        ['b', 'Open'],
        ['c', 'Open'],
      ],
    )
    assert.equal(events.length, 1)
    assert.equal(events[0].type, WORKSPACE_MERGED)

    // A real clash still stops, as before.
    server = {
      version: 'v-clash',
      data: {
        ...server.data,
        items: server.data.items.map((item: any) => (item.id === 'b' ? { ...item, status: 'Blocked' } : item)),
      },
    }
    await assert.rejects(
      queueCloudStoreSave({
        ...server.data,
        items: server.data.items.map((item: any) => (item.id === 'b' ? { ...item, status: 'Done' } : item)),
      }),
      /same record/,
    )
  } finally {
    globalThis.fetch = realFetch
    ;(globalThis as any).window = realWindow
    resetCloudSession()
  }
})

test('an edit to the same field made while a merged save is going out stops saving instead of undoing the other changes', async () => {
  let server = { version: 'v0', data: structuredClone(base) as any }
  const puts: any[] = []
  const conflicts: string[] = []
  // What the app shows. Its handler takes merged changes in, or refuses them when they clash with an edit made since.
  let screen: any = structuredClone(base)
  const realFetch = globalThis.fetch
  const realWindow = (globalThis as any).window
  ;(globalThis as any).window = {
    dispatchEvent: (event: any) => {
      if (event.type === 'workspace-save-conflict') conflicts.push(event.detail)
      if (event.type !== WORKSPACE_MERGED) return true
      const merged = mergeWorkspace(event.detail.saved, screen, event.detail.data)
      if (merged.ok) screen = merged.data
      else {
        event.detail.clash = merged.clash
        event.preventDefault()
      }
      return !event.defaultPrevented
    },
  }
  globalThis.fetch = (async (url: string, init?: any) => {
    const reply = (status: number, body: any) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    if (url === '/api/store' && !init?.method)
      return reply(200, { configured: true, ...server, revision: server.version })
    if (url === '/api/store/sync')
      return reply(200, {
        configured: true,
        version: server.version,
        changes: changesSince(JSON.parse(init.body).versions, server.data),
      })
    const body = JSON.parse(init.body)
    puts.push(body)
    if (body.baseVersion !== server.version)
      return reply(409, { configured: true, refreshRequired: true, error: 'This workspace has newer changes.' })
    server = { version: `v${puts.length}`, data: savedData(body, server.data) }
    return reply(200, { configured: true, version: server.version, updatedAt: 'now' })
  }) as any
  const status = (data: any) => data.items.map((item: any) => `${item.id}:${item.status}`).join(' ')
  try {
    resetCloudSession()
    await loadCloudStore()
    // Ben, elsewhere: adds a task and marks b Blocked.
    server = {
      version: 'v-ben',
      data: { ...base, items: [task('ben'), task('a'), task('b', { status: 'Blocked' }), task('c')] },
    }
    // Ana completes a; her save goes out, and while it is merged with Ben's she sets b to Done.
    screen = {
      ...screen,
      items: screen.items.map((item: any) => (item.id === 'a' ? { ...item, status: 'Done' } : item)),
    }
    const first = queueCloudStoreSave(screen)
    screen = {
      ...screen,
      items: screen.items.map((item: any) => (item.id === 'b' ? { ...item, status: 'Done' } : item)),
    }
    await assert.rejects(first, /changed the same record you are editing now \(items\[b\]\.status\)/)
    assert.equal(status(server.data), 'ben:Open a:Done b:Blocked c:Open', 'her first change is saved with Ben’s')
    assert.equal(conflicts.length, 1, 'the Save conflict box appears')

    // Her screen still lacks Ben's changes, so it is not saved over them.
    const putsBefore = puts.length
    await assert.rejects(queueCloudStoreSave(screen))
    assert.equal(puts.length, putsBefore, 'nothing more is sent')
    assert.equal(status(server.data), 'ben:Open a:Done b:Blocked c:Open', 'Ben’s task and status are still there')
  } finally {
    globalThis.fetch = realFetch
    ;(globalThis as any).window = realWindow
    resetCloudSession()
  }
})
