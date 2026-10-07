import test from 'node:test'
import assert from 'node:assert/strict'
import { startActivePolling, workspaceAutoRefreshAllowed, type PollEnvironment } from '../src/activePolling'
import { loadCloudStore, queueCloudStoreSave, resetCloudSession } from '../src/cloudStore'
import { readNotificationState, readWorkspaceRevision, workspaceRevision } from '../server/services/workspace-reads'

const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
function clock() {
  let now = 0, visible = true, sequence = 0
  const timers = new Map<number, { callback: () => void; at: number }>(), listeners = new Set<() => void>()
  const environment: PollEnvironment = {
    active: () => visible, now: () => now,
    setTimer: (callback, delay) => { const id = ++sequence; timers.set(id, { callback, at: now + delay }); return id },
    clearTimer: timer => { timers.delete(timer as number) },
    subscribe: callback => { listeners.add(callback); return () => { listeners.delete(callback) } },
  }
  return {
    environment, timers,
    async advance(milliseconds: number) {
      const end = now + milliseconds
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a,b) => a[1].at-b[1].at)[0]
        if (!next) break
        now = next[1].at; timers.delete(next[0]); next[1].callback(); await settle()
      }
      now = end; await settle()
    },
    activity(value = visible) { visible = value; listeners.forEach(callback => callback()) },
  }
}

test('All Items has no automatic reads; selected client/project tabs can refresh', async () => {
  const c = clock(); let reads = 0
  const stop = workspaceAutoRefreshAllowed('items') ? startActivePolling(async () => { reads++ }, { interval: 300_000, environment: c.environment }) : () => undefined
  await c.advance(3_600_000); c.activity(); await settle()
  assert.equal(reads, 0); assert.equal(c.timers.size, 0); stop()
  assert.equal(workspaceAutoRefreshAllowed('items', 'client'), true)
  assert.equal(workspaceAutoRefreshAllowed('items', undefined, 'project'), true)
  assert.equal(workspaceAutoRefreshAllowed('inbox'), true)
  assert.equal(workspaceAutoRefreshAllowed('settings'), false)
})

test('hidden or offline tabs cancel polling; visible tabs resume without overlap', async () => {
  const c = clock(); const signals: AbortSignal[] = []; let finish: (() => void) | undefined
  const stop = startActivePolling(signal => { signals.push(signal); return new Promise<void>(resolve => { finish = resolve; signal.addEventListener('abort', resolve, { once: true }) }) }, { interval: 300_000, environment: c.environment })
  assert.equal(signals.length, 1)
  c.activity(); c.activity(); await settle(); assert.equal(signals.length, 1)
  c.activity(false); await settle(); assert.equal(signals[0].aborted, true); assert.equal(c.timers.size, 0)
  await c.advance(900_000); assert.equal(signals.length, 1)
  c.activity(true); await settle(); assert.equal(signals.length, 2)
  finish?.(); await settle(); await c.advance(300_000); assert.equal(signals.length, 3)
  stop(); await settle(); await c.advance(900_000); assert.equal(signals.length, 3); assert.equal(signals[2].aborted, true)
})

test('switching the source tab disposes its timer and in-flight request', async () => {
  const c = clock(); let reads = 0, activeSignal: AbortSignal | undefined
  const stop = startActivePolling(signal => { reads++; activeSignal = signal; return new Promise<void>(resolve => signal.addEventListener('abort', resolve, { once: true })) }, { interval: 120_000, environment: c.environment })
  stop(); await settle(); assert.equal(activeSignal?.aborted, true)
  c.activity(); await c.advance(600_000); assert.equal(reads, 1); assert.equal(c.timers.size, 0)
})

test('a quick return to a visible page resumes after the cancelled request settles', async () => {
  const c = clock(); let reads = 0, finish: (() => void) | undefined
  const stop = startActivePolling(() => { reads++; return new Promise<void>(resolve => { finish = resolve }) }, { interval: 300_000, minGap: 10_000, environment: c.environment })
  c.activity(false); c.activity(true); finish?.(); await settle()
  await c.advance(9_999); assert.equal(reads, 1)
  await c.advance(1); assert.equal(reads, 2); stop(); finish?.(); await settle()
})

test('focus and visibility events are throttled to one check', async () => {
  const c = clock(); let reads = 0
  const stop = startActivePolling(async () => { reads++ }, { interval: 300_000, minGap: 60_000, environment: c.environment })
  await settle(); c.activity(); c.activity(); await c.advance(59_999); assert.equal(reads, 1)
  await c.advance(1); assert.equal(reads, 2); stop()
})

function browser(t: any, handler: typeof fetch) {
  const before = { fetch: globalThis.fetch, window: (globalThis as any).window }
  globalThis.fetch = handler; (globalThis as any).window = new EventTarget()
  resetCloudSession()
  t.after(() => { globalThis.fetch = before.fetch; (globalThis as any).window = before.window; resetCloudSession() })
}
const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
const snapshot = { configured: true, data: { items: [{ id: 'task', title: 'Saved' }] }, version: 'v1', revision: 'r1', updatedAt: '2026-10-07T01:00:00Z', timeZone: 'Asia/Manila' }

test('unchanged workspace checks download only revision metadata; manual refresh still loads data', async t => {
  const calls: string[] = []
  browser(t, async url => { calls.push(String(url)); return response(String(url).endsWith('/revision') ? { configured: true, revision: 'r1' } : snapshot) })
  await loadCloudStore()
  for (let i = 0; i < 3; i++) assert.equal((await loadCloudStore({ onlyIfChanged: true })).unchanged, true)
  assert.equal(calls.filter(url => url === '/api/store').length, 1)
  assert.equal(calls.filter(url => url.endsWith('/revision')).length, 3)
  assert.deepEqual((await loadCloudStore()).data, snapshot.data)
  assert.equal(calls.filter(url => url === '/api/store').length, 2)
})

test('changed revisions load the workspace once and then return to small checks', async t => {
  let revision = 'r1', loads = 0
  browser(t, async url => {
    if (String(url).endsWith('/revision')) return response({ configured: true, revision })
    loads++; return response({ ...snapshot, revision })
  })
  await loadCloudStore(); revision = 'r2'
  assert.deepEqual((await loadCloudStore({ onlyIfChanged: true })).data, snapshot.data)
  assert.equal((await loadCloudStore({ onlyIfChanged: true })).unchanged, true)
  assert.equal(loads, 2)
})

test('leaving a tab during its revision check prevents the full workspace read', async t => {
  const controller = new AbortController(); let loads = 0
  browser(t, async url => {
    if (String(url).endsWith('/revision')) { controller.abort(); return response({ configured: true, revision: 'changed' }) }
    loads++; return response(snapshot)
  })
  await loadCloudStore()
  await assert.rejects(loadCloudStore({ onlyIfChanged: true, signal: controller.signal }), { name: 'AbortError' })
  assert.equal(loads, 1)
})

test('an edit during a revision check cannot be replaced by a stale refresh', async t => {
  let release: (() => void) | undefined, started: (() => void) | undefined
  const checking = new Promise<void>(resolve => { started = resolve })
  let loads = 0
  browser(t, async (url, init) => {
    if (init?.method === 'PUT') return response({ configured: true, version: 'v2' })
    if (String(url).endsWith('/revision')) { started?.(); await new Promise<void>(resolve => { release = resolve }); return response({ configured: true, revision: 'changed' }) }
    loads++; return response(snapshot)
  })
  await loadCloudStore()
  const refresh = loadCloudStore({ onlyIfChanged: true })
  await checking; await queueCloudStoreSave({ items: [{ id: 'task', title: 'My edit' }] }); release?.()
  await assert.rejects(refresh, /workspace changed during refresh/); assert.equal(loads, 1)
})

test('revision changes at tenant midnight so follow-ups catch up after idle time', () => {
  const updated = '2026-10-07T01:00:00Z'
  assert.notEqual(workspaceRevision(updated, 'Asia/Manila', new Date('2026-10-07T15:59:59Z')), workspaceRevision(updated, 'Asia/Manila', new Date('2026-10-07T16:00:00Z')))
})

test('Supabase checks select metadata or notifications without downloading tenant_state data', async () => {
  const calls: any[] = []
  const db = { from(table: string) {
    let columns = '', tenant = ''
    const query: any = { select(value: string) { columns = value; return query }, eq(key: string, value: string) { assert.equal(key, 'organization_id'); tenant = value; return query }, async maybeSingle() {
      calls.push({ table, columns, tenant })
      return { data: columns === 'updated_at' ? { updated_at: 'stamp' } : { notifications: [{ id: 'notice' }], updated_at: 'stamp' }, error: null }
    } }
    return query
  } }
  const revision = await readWorkspaceRevision(db, 'tenant-a', 'Asia/Manila')
  assert(revision.revision.startsWith('stamp:'))
  assert.deepEqual(await readNotificationState(db, 'tenant-a'), { notifications: [{ id: 'notice' }], updatedAt: 'stamp' })
  assert.deepEqual(calls, [
    { table: 'tenant_state', columns: 'updated_at', tenant: 'tenant-a' },
    { table: 'tenant_state', columns: 'notifications:data->notifications,updated_at', tenant: 'tenant-a' },
  ])
})
