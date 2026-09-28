import { setBusinessTimeZone } from './businessDate'
export type CloudStorageStatus = 'checking' | 'local' | 'saving' | 'synced' | 'error'

export type CloudLoadResult<T> = {
  configured: boolean
  data: T | null
  updatedAt?: string
  version?: string
  timeZone?: string
}

export type ExternalInquiryLoadResult<T> = {
  configured: boolean
  items: T[]
  updatedAt?: string
}

export async function loadDiscordInquiries<T>(): Promise<ExternalInquiryLoadResult<T>> {
  const response = await fetch('/api/integrations/discord/inquiries', { credentials: 'same-origin' })
  const body = await response.json().catch(() => ({}))
  if (response.status === 503) return { configured: false, items: [] }
  if (!response.ok) throw new Error(body.error || 'Could not load Discord inquiries.')
  return {
    configured: Boolean(body.configured),
    items: Array.isArray(body.items) ? body.items as T[] : [],
    updatedAt: body.updatedAt,
  }
}

let saveQueue: Promise<unknown> = Promise.resolve()
let baseVersion: string | undefined
let generation = 0
let session = 0
let conflict = false
let saveError: Error | undefined
let pendingSnapshot: unknown
export function pendingCloudEdits<T>(): T | undefined { return pendingSnapshot === undefined ? undefined : structuredClone(pendingSnapshot) as T }

export function resetCloudSession() {
  session += 1; generation += 1; baseVersion = undefined; conflict = false; saveError = undefined; pendingSnapshot = undefined
  saveQueue = Promise.resolve()
}

export async function loadCloudStore<T>(options: { recover?: boolean } = {}): Promise<CloudLoadResult<T>> {
  if (options.recover) await saveQueue.catch(() => undefined)
  else { await saveQueue; if (saveError) throw saveError }
  const started = generation, activeSession = session
  const response = await fetch('/api/store', { credentials: 'same-origin' })
  const body = await response.json().catch(() => ({}))
  if (started !== generation || activeSession !== session) throw new Error('The workspace changed during refresh. Retry after saving.')
  if (response.status === 503) return { configured: false, data: null }
  if (!response.ok) throw new Error(body.error || 'Could not load the cloud database.')
  baseVersion = body.version
  conflict = false; saveError = undefined; pendingSnapshot = undefined; saveQueue = Promise.resolve()
  setBusinessTimeZone(body.timeZone)
  return { configured: Boolean(body.configured), data: (body.data ?? null) as T | null, updatedAt: body.updatedAt, version: body.version, timeZone: body.timeZone }
}

async function saveCloudStoreNow<T>(data: T, activeSession: number) {
  if (activeSession !== session) throw new Error('The workspace session changed. This save was cancelled.')
  if (conflict) throw saveError || new Error('Reload the latest workspace before saving.')
  if (!baseVersion) throw new Error('Load the cloud workspace before saving.')
  const response = await fetch('/api/store', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
    body: JSON.stringify({ data, baseVersion }),
  })
  const body = await response.json().catch(() => ({}))
  if (activeSession !== session) throw new Error('The workspace session changed during saving.')
  if (!response.ok) {
    const error = new Error(body.error || 'Could not save to the cloud database.')
    if (response.status === 409) {
      conflict = true
    }
    throw error
  }
  baseVersion = body.version
  saveError = undefined
  if (pendingSnapshot === data) pendingSnapshot = undefined
  return { configured: true as const, updatedAt: body.updatedAt as string | undefined }
}

export function queueCloudStoreSave<T>(data: T) {
  generation += 1
  const activeSession = session
  // Capture the snapshot now; subsequent editor mutations must not alter queued writes.
  const snapshot = structuredClone(data)
  pendingSnapshot = snapshot
  saveQueue = saveQueue.catch(() => undefined).then(() => saveCloudStoreNow(snapshot, activeSession)).catch(error => {
    if (activeSession === session) {
      saveError = error
      if (conflict) window.dispatchEvent(new CustomEvent('workspace-save-conflict', { detail: error.message }))
    }
    throw error
  })
  return saveQueue as Promise<{ configured: boolean; updatedAt?: string }>
}

export async function waitForCloudSaves() { await saveQueue; if (saveError) throw saveError }
