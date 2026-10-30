import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeWorkspace } from '../src/app/workspaceMerge'
import { loadCloudStore, queueCloudStoreSave, resetCloudSession, WORKSPACE_MERGED } from '../src/app/cloudStore'

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
    if (url === '/api/store' && init.method === 'PUT') {
      const body = JSON.parse(init.body)
      puts.push(body)
      if (body.baseVersion !== server.version)
        return reply(409, { configured: true, refreshRequired: true, error: 'This workspace has newer changes.' })
      server = { version: `v${puts.length}`, data: body.data }
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
