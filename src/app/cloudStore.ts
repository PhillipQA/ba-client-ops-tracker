import { setBusinessTimeZone } from '../shared/businessDate'
import { mergeWorkspace } from './workspaceMerge'
export type CloudStorageStatus = 'checking' | 'local' | 'saving' | 'synced' | 'error'

export type CloudLoadResult<T> = {
  configured: boolean
  data: T | null
  updatedAt?: string
  version?: string
  timeZone?: string
  unchanged?: boolean
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
    items: Array.isArray(body.items) ? (body.items as T[]) : [],
    updatedAt: body.updatedAt,
  }
}

let saveQueue: Promise<unknown> = Promise.resolve()
let baseVersion: string | undefined
let loadedRevision: string | undefined
let generation = 0
let session = 0
let conflict = false
let saveError: Error | undefined
let pendingSnapshot: unknown
/** The workspace as the server holds it at baseVersion (as far as this browser knows). */
let serverData: unknown
/** The server copy this browser's own data was last brought up to date with: queued saves are changes from it. */
let localBase: unknown
/** Fired when a save merged changes saved elsewhere: the app takes them into what it shows. */
export const WORKSPACE_MERGED = 'workspace-merged'
export type WorkspaceMerged = { saved: unknown; data: unknown }
export function pendingCloudEdits<T>(): T | undefined {
  return pendingSnapshot === undefined ? undefined : (structuredClone(pendingSnapshot) as T)
}

export function resetCloudSession() {
  session += 1
  generation += 1
  baseVersion = undefined
  loadedRevision = undefined
  conflict = false
  saveError = undefined
  pendingSnapshot = undefined
  serverData = undefined
  localBase = undefined
  saveQueue = Promise.resolve()
}

export async function loadCloudStore<T>(
  options: { recover?: boolean; onlyIfChanged?: boolean; signal?: AbortSignal } = {},
): Promise<CloudLoadResult<T>> {
  if (options.recover) await saveQueue.catch(() => undefined)
  else {
    await saveQueue
    if (saveError) throw saveError
  }
  const started = generation,
    activeSession = session
  const assertCurrent = () => {
    options.signal?.throwIfAborted()
    if (started !== generation || activeSession !== session)
      throw new Error('The workspace changed during refresh. Retry after saving.')
  }
  assertCurrent()
  if (options.onlyIfChanged) {
    const response = await fetch('/api/store/revision', { credentials: 'same-origin', signal: options.signal })
    const revision = await response.json().catch(() => ({}))
    assertCurrent()
    if (response.status === 503) return { configured: false, data: null }
    if (!response.ok) throw new Error(revision.error || 'Could not check the cloud workspace.')
    if (loadedRevision && revision.revision === loadedRevision)
      return { configured: true, data: null, unchanged: true, updatedAt: revision.updatedAt }
  }
  assertCurrent()
  const response = await fetch('/api/store', { credentials: 'same-origin', signal: options.signal })
  const body = await response.json().catch(() => ({}))
  assertCurrent()
  if (response.status === 503) return { configured: false, data: null }
  if (!response.ok) throw new Error(body.error || 'Could not load the cloud database.')
  baseVersion = body.version
  loadedRevision = body.revision
  conflict = false
  saveError = undefined
  pendingSnapshot = undefined
  serverData = body.data ?? null
  localBase = serverData
  saveQueue = Promise.resolve()
  setBusinessTimeZone(body.timeZone)
  return {
    configured: Boolean(body.configured),
    data: (body.data ?? null) as T | null,
    updatedAt: body.updatedAt,
    version: body.version,
    timeZone: body.timeZone,
  }
}

/** The latest workspace on the server, without touching the save queue. */
async function fetchLatest() {
  const response = await fetch('/api/store', { credentials: 'same-origin' })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error || 'Could not load the latest workspace.')
  return { data: (body.data ?? null) as unknown, version: String(body.version || '') }
}

const MERGE_TRIES = 3

/**
 * Saves one queued snapshot. `parent` is the server copy the snapshot was made from: when the server has moved on
 * since (another person, another tab, a capture), the snapshot's own changes are merged onto the server's latest
 * (see workspaceMerge). Only a real clash is refused, as before.
 */
async function saveCloudStoreNow<T>(data: T, activeSession: number, parent: unknown) {
  if (activeSession !== session) throw new Error('The workspace session changed. This save was cancelled.')
  if (conflict) throw saveError || new Error('Reload the latest workspace before saving.')
  if (!baseVersion) throw new Error('Load the cloud workspace before saving.')
  let payload: unknown = data
  for (let attempt = 0; ; attempt++) {
    if (parent !== undefined && serverData !== undefined && parent !== serverData) {
      const merged = mergeWorkspace<unknown>(parent, data, serverData)
      if (!merged.ok) {
        conflict = true
        throw new Error(
          `This workspace has newer changes to the same record (${merged.clash}). Your edits are retained locally. Download them and reload the latest workspace before reapplying your change.`,
        )
      }
      // Nothing came from elsewhere (an earlier save of this browser was simply ahead): the snapshot as it is.
      payload = JSON.stringify(merged.data) === JSON.stringify(data) ? data : merged.data
    }
    const response = await fetch('/api/store', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ data: payload, baseVersion }),
    })
    const body = await response.json().catch(() => ({}))
    if (activeSession !== session) throw new Error('The workspace session changed during saving.')
    if (response.ok) {
      baseVersion = body.version
      serverData = payload
      // Saves may merge server activity. Check once on the next active-tab refresh.
      loadedRevision = undefined
      saveError = undefined
      if (pendingSnapshot === data) pendingSnapshot = undefined
      if (payload !== data && typeof window !== 'undefined') {
        // Changes saved elsewhere came in with this save: the app shows them too, and builds on them from now on.
        window.dispatchEvent(
          new CustomEvent<WorkspaceMerged>(WORKSPACE_MERGED, { detail: { saved: data, data: payload } }),
        )
      }
      localBase = payload
      return { configured: true as const, updatedAt: body.updatedAt as string | undefined }
    }
    // Saved elsewhere since: fetch the latest and merge onto it, a few times at most.
    if (response.status === 409 && body.refreshRequired && attempt < MERGE_TRIES && parent !== undefined) {
      const latest = await fetchLatest()
      if (activeSession !== session) throw new Error('The workspace session changed during saving.')
      serverData = latest.data
      baseVersion = latest.version
      continue
    }
    const error = new Error(body.error || 'Could not save to the cloud database.')
    if (response.status === 409) {
      conflict = true
    }
    throw error
  }
}

export function queueCloudStoreSave<T>(data: T) {
  generation += 1
  const activeSession = session
  // Capture the snapshot now; subsequent editor mutations must not alter queued writes.
  const snapshot = structuredClone(data)
  // What the app's data was built on when this was queued; saves queued before a merge reached the app still merge.
  const parent = localBase
  pendingSnapshot = snapshot
  saveQueue = saveQueue
    .catch(() => undefined)
    .then(() => saveCloudStoreNow(snapshot, activeSession, parent))
    .catch(error => {
      if (activeSession === session) {
        saveError = error
        if (conflict) window.dispatchEvent(new CustomEvent('workspace-save-conflict', { detail: error.message }))
      }
      throw error
    })
  return saveQueue as Promise<{ configured: boolean; updatedAt?: string }>
}

export async function waitForCloudSaves() {
  await saveQueue
  if (saveError) throw saveError
}
