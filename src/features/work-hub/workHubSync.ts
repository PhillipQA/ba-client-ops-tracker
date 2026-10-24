import type { AuthUser } from '../accounts/auth'

export const WORK_HUB_INTEGRATIONS = ['gmail', 'discord', 'github', 'gitlab'] as const
export type WorkHubIntegration = typeof WORK_HUB_INTEGRATIONS[number]
export type WorkHubSource = WorkHubIntegration | 'manual'
export const integrationLabel: Record<WorkHubIntegration, string> = { gmail: 'Gmail', discord: 'Discord', github: 'GitHub', gitlab: 'GitLab' }

type SyncStatus = { phase: 'idle' | 'syncing' | 'success' | 'error' | 'skipped'; message: string; revision: number }
export type WorkHubSyncState = { integrations: Record<WorkHubIntegration, SyncStatus>; allRunning: boolean; manualRevision: number }
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>
type Request = (url: string, init: RequestInit) => Promise<Response>

const initialState = (): WorkHubSyncState => ({
  integrations: Object.fromEntries(WORK_HUB_INTEGRATIONS.map(id => [id, { phase: 'idle', message: '', revision: 0 }])) as WorkHubSyncState['integrations'],
  allRunning: false, manualRevision: 0,
})
const defaultList: Record<WorkHubSource, string> = {
  gmail: '/api/communications?page=1&pageSize=5&tab=Gmail&archived=false',
  discord: '/api/communications?page=1&pageSize=5&tab=Discord&archived=false',
  manual: '/api/communications?page=1&pageSize=5&tab=Manual&archived=false',
  github: '/api/work-hub/github/tickets?page=1&pageSize=5&view=all&state=open&repository=&qa=&label=&q=',
  gitlab: '/api/work-hub/gitlab/tickets?page=1&pageSize=5&view=all&state=open&repository=&qa=&label=&q=',
}

// One controller outlives the Hub's source tabs. No timer, focus, or visibility
// event starts a sync. Lists stay cached until their own source is refreshed.
export function createWorkHubSync(options: { request?: Request; storage?: Storage } = {}) {
  const request = options.request || ((url, init) => fetch(url, init))
  const storage = () => { try { return options.storage || window.localStorage } catch { return undefined } }
  let state = initialState(), session = '', active = false, generation = 0
  let controller = new AbortController()
  let allJob: Promise<void> | undefined
  const listeners = new Set<() => void>()
  const jobs = new Map<WorkHubIntegration, Promise<void>>()
  const cache = new Map<string, unknown>(), reads = new Map<string, Promise<any>>()
  const versions = new Map<WorkHubSource, number>()
  const emit = () => { for (const listener of listeners) listener() }
  const update = (id: WorkHubIntegration, patch: Partial<SyncStatus>) => {
    state = { ...state, integrations: { ...state.integrations, [id]: { ...state.integrations[id], ...patch } } }; emit()
  }
  const ask = async (url: string, method = 'GET', body?: unknown, signal = controller.signal) => {
    const response = await request(url, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error || 'Work Hub request failed.')
    return result
  }
  const invalidate = (source: WorkHubSource) => {
    versions.set(source, (versions.get(source) || 0) + 1)
    for (const key of cache.keys()) if (key.startsWith(`${source}:`)) cache.delete(key)
    for (const key of reads.keys()) if (key.startsWith(`${source}:`)) reads.delete(key)
  }
  const read = async <T = any>(source: WorkHubSource, url: string, signal?: AbortSignal): Promise<T> => {
    if (signal?.aborted) throw new DOMException('Request cancelled.', 'AbortError')
    const key = `${source}:${url}`, epoch = generation, version = versions.get(source) || 0
    let pending = reads.get(key)
    if (!pending) {
      pending = cache.has(key) ? Promise.resolve(cache.get(key)) : ask(url)
      reads.set(key, pending)
      const current = pending
      void pending.then(result => { if (epoch === generation && version === (versions.get(source) || 0)) cache.set(key, result) }).catch(() => {}).finally(() => { if (reads.get(key) === current) reads.delete(key) })
    }
    const result = await pending
    if (signal?.aborted || epoch !== generation || version !== (versions.get(source) || 0)) throw new DOMException('Request cancelled.', 'AbortError')
    return result
  }
  const syncOne = (id: WorkHubIntegration, settings?: Promise<any>): Promise<void> => {
    if (!active) return Promise.resolve()
    const existing = jobs.get(id)
    if (existing) return existing
    const epoch = generation, signal = controller.signal
    const current = () => epoch === generation && !signal.aborted
    update(id, { phase: 'syncing', message: `Syncing ${integrationLabel[id]}…` })
    const pending = (async () => {
      let attempted = false
      try {
        const connection = id === 'gmail' || id === 'discord'
          ? await (settings || ask('/api/communications/settings', 'GET', undefined, signal))
          : await ask(`/api/work-hub/${id}/connection`, 'GET', undefined, signal)
        if (!current()) return
        const connected = id === 'gmail' ? connection.gmailConnected && connection.gmailAvailable : id === 'discord' ? Boolean(connection.discordUserId) : connection.connected
        if (!connected) { update(id, { phase: 'skipped', message: `${integrationLabel[id]} is not connected.` }); return }
        if (id === 'gmail' && !connection.gmailLabels?.length || (id === 'github' || id === 'gitlab') && !connection.repositories?.length) {
          update(id, { phase: 'skipped', message: id === 'gmail' ? 'Select Gmail labels and save settings before syncing.' : `Select ${integrationLabel[id]} repositories and save settings before syncing.` }); return
        }
        attempted = true
        // Discord is received by the workspace bot. Refresh its saved inbox;
        // it does not have a personal API that can pull other people's DMs.
        const result = id === 'discord' ? null : await ask(id === 'gmail' ? '/api/communications/gmail/sync' : `/api/work-hub/${id}/sync`, 'POST', { auto: false }, signal)
        if (!current()) return
        invalidate(id)
        await read(id, defaultList[id])
        if (!current()) return
        const message = id === 'discord' ? 'Discord inbox refreshed.' : result.retryAfterSeconds
          ? `${integrationLabel[id]} is paused. Sync again in ${result.retryAfterSeconds} seconds.`
          : `${integrationLabel[id]}: ${result.imported || 0} imported; ${result.updated || 0} refreshed.${result.hasMore ? ' More data is available. Click Sync again to continue.' : ''}`
        update(id, { phase: 'success', message, revision: state.integrations[id].revision + 1 })
      } catch (error) {
        if (!current()) return
        if (attempted) invalidate(id)
        update(id, { phase: 'error', message: `${integrationLabel[id]}: ${error instanceof Error ? error.message : 'Sync failed.'}`, revision: state.integrations[id].revision + (attempted ? 1 : 0) })
      }
    })().finally(() => { if (jobs.get(id) === pending) jobs.delete(id) })
    jobs.set(id, pending)
    return pending
  }
  const syncAll = (): Promise<void> => {
    if (!active) return Promise.resolve()
    if (allJob) return allJob
    const epoch = generation
    state = { ...state, allRunning: true }; emit()
    // Share only the settings read. Each integration has its own sync job and
    // failure, and a per-integration button never invokes this all-source path.
    const settings = ask('/api/communications/settings')
    void settings.catch(() => {}) // Both communication jobs may already be running.
    const pending = Promise.all(WORK_HUB_INTEGRATIONS.map(id => syncOne(id, settings))).then(() => {
      if (epoch !== generation) return
      invalidate('manual')
      state = { ...state, manualRevision: state.manualRevision + 1 }
    }).finally(() => {
      if (epoch === generation) { allJob = undefined; state = { ...state, allRunning: false }; emit() }
    })
    allJob = pending
    return pending
  }
  const setSession = (user: AuthUser | null, freshLogin = false): Promise<void> => {
    const allowed = Boolean(user && user.status === 'Active' && user.accountType !== 'platform' && user.modules.includes('inbox'))
    const timestamp = Date.parse(user?.lastLoginAt || '')
    const loginStamp = Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : user?.lastLoginAt || 'session'
    const next = allowed ? JSON.stringify([user!.organizationId || '', user!.id, loginStamp]) : ''
    if (next === session && !freshLogin) return allJob || Promise.resolve()
    controller.abort(); controller = new AbortController(); generation++; session = next; active = allowed
    jobs.clear(); cache.clear(); reads.clear(); versions.clear(); allJob = undefined; state = initialState(); emit()
    if (!allowed) return Promise.resolve()
    const key = `work-hub-login-sync:${user!.organizationId || ''}:${user!.id}`
    try { if (!freshLogin && storage()?.getItem(key) === next) return Promise.resolve(); storage()?.setItem(key, next) } catch { /* The in-memory session still prevents repeated syncs. */ }
    // Claim before starting so StrictMode, session checks and source remounts
    // cannot schedule another attempt. Failures wait for an explicit Sync.
    return syncAll()
  }
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    setSession, syncAll, syncOne, read, invalidate,
    peek: <T = any>(source: WorkHubSource, url: string) => cache.get(`${source}:${url}`) as T | undefined,
  }
}

export const workHubSync = createWorkHubSync()
