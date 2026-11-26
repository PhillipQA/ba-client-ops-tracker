import { setBusinessTimeZone } from '../shared/businessDate'
import {
  applyWorkspaceChanges,
  diffWorkspace,
  hasChanges,
  isWorkspaceChanges,
  workspaceVersions,
} from '../shared/workspaceChanges'
import { type ClashChoice, chooseForClash, clashSides } from './conflictChoice'
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
/** Saves send only what changed (PATCH /api/store/changes) until a server without it answers; then the whole copy. */
let changeSaves = true
/** Loads send this copy's record versions and get back only what differs (POST /api/store/sync), likewise. */
let deltaLoads = true
/** A save stopped by a clash the person can settle record by record (see resolveSaveClash). */
let pendingClash: { parent: unknown; data: unknown; theirs: unknown; clash: string } | undefined
/**
 * Fired when a save merged changes saved elsewhere: the app takes them into what it shows. When it cannot (the person
 * changed the same field meanwhile), it cancels the event and names the field in `clash`.
 */
export const WORKSPACE_MERGED = 'workspace-merged'
export type WorkspaceMerged = { saved: unknown; data: unknown; clash?: string }
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
  changeSaves = true
  deltaLoads = true
  pendingClash = undefined
  saveQueue = Promise.resolve()
}

/**
 * The server's workspace now. With a server copy already here, only the records that differ from it come down
 * (Phase 4B delta load); otherwise, or with a server that has no such route, the whole workspace.
 */
async function fetchWorkspace(signal?: AbortSignal): Promise<{ response: Response; body: any }> {
  if (deltaLoads && serverData && typeof serverData === 'object') {
    const known = serverData
    const response = await fetch('/api/store/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      signal,
      body: JSON.stringify({ versions: workspaceVersions(known) }),
    })
    if (response.status === 404 || response.status === 405) deltaLoads = false
    else {
      const body = await response.json().catch(() => ({}))
      if (!response.ok || !isWorkspaceChanges(body.changes)) return { response, body }
      return { response, body: { ...body, data: applyWorkspaceChanges(known, body.changes) } }
    }
  }
  const response = await fetch('/api/store', { credentials: 'same-origin', signal })
  return { response, body: await response.json().catch(() => ({})) }
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
  const { response, body } = await fetchWorkspace(options.signal)
  assertCurrent()
  if (response.status === 503) return { configured: false, data: null }
  if (!response.ok) throw new Error(body.error || 'Could not load the cloud database.')
  baseVersion = body.version
  loadedRevision = body.revision
  conflict = false
  pendingClash = undefined
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
  const { response, body } = await fetchWorkspace()
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
        pendingClash = { parent, data, theirs: serverData, clash: merged.clash }
        throw new Error(
          `This workspace has newer changes to the same record (${merged.clash}). Your edits are retained locally. Download them and reload the latest workspace before reapplying your change.`,
        )
      }
      // Nothing came from elsewhere (an earlier save of this browser was simply ahead): the snapshot as it is.
      payload = JSON.stringify(merged.data) === JSON.stringify(data) ? data : merged.data
    }
    // Only what changed since the server copy goes over the wire; the server lays it on the workspace and saves the
    // changed records. Without a server copy to compare with, or with a server that has no such route, the whole copy.
    const changes = changeSaves && serverData ? diffWorkspace(serverData, payload) : null
    const response = await fetch(changes ? '/api/store/changes' : '/api/store', {
      method: changes ? 'PATCH' : 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(changes ? { changes, baseVersion } : { data: payload, baseVersion }),
    })
    const body = await response.json().catch(() => ({}))
    if (activeSession !== session) throw new Error('The workspace session changed during saving.')
    if (changes && (response.status === 404 || response.status === 405)) {
      changeSaves = false
      attempt--
      continue
    }
    if (response.ok) {
      // Taken onto newer changes from elsewhere that this copy lacks: keep the old version, so a later whole-copy save
      // cannot overwrite them (it is refused and merged), and the next refresh brings them in.
      if (!body.behind) baseVersion = body.version
      // What the server made of this save (dates, assignees, server-kept fields…), so the next save compares with what
      // the server really holds.
      const stored =
        !body.behind && isWorkspaceChanges(body.adjusted) && hasChanges(body.adjusted)
          ? applyWorkspaceChanges(payload, body.adjusted)
          : payload
      serverData = payload
      // Saves may merge server activity. Check once on the next active-tab refresh.
      loadedRevision = undefined
      saveError = undefined
      if (pendingSnapshot === data) pendingSnapshot = undefined
      localBase = payload
      if (stored !== data && typeof window !== 'undefined') {
        // Changes saved elsewhere came in with this save, or the server adjusted what was saved: the app shows them
        // too, and builds on them from now on.
        const merged = new CustomEvent<WorkspaceMerged>(WORKSPACE_MERGED, {
          detail: { saved: data, data: stored },
          cancelable: true,
        })
        window.dispatchEvent(merged)
        if (!merged.defaultPrevented) {
          serverData = stored
          localBase = stored
        } else if (payload !== data) {
          // The app could not take them in: the person changed the same field while this was saving. Saving what is on
          // screen next would undo the changes from elsewhere, so saving stops and the person chooses, as with a clash.
          conflict = true
          throw new Error(
            `Your earlier change was saved, but someone else changed the same record you are editing now (${merged.detail.clash || 'workspace'}). Your newer edits are retained locally. Download them and reload the latest workspace before reapplying them.`,
          )
        }
        // Otherwise only the server's own adjustments could not be shown yet; they come with the next refresh.
      }
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

/** The record a stopped save clashed on, both versions of it, for the person to choose between; undefined if none. */
export function saveClash() {
  if (!pendingClash || !conflict) return undefined
  return clashSides(pendingClash.data, pendingClash.theirs, pendingClash.clash)
}

/**
 * Settles the clash that stopped saving, for the one record it is about: `mine` keeps this browser's version of it,
 * `theirs` takes the other one. Everything else is merged as usual. When another record clashes too, it is returned
 * for the next choice; otherwise the app is given the merged workspace and it is saved.
 */
export async function resolveSaveClash<T>(choice: ClashChoice) {
  if (!pendingClash || !conflict) throw new Error('There is no save conflict to settle.')
  const { data, theirs } = pendingClash
  const chosen = chooseForClash(pendingClash.parent, pendingClash.data, theirs, pendingClash.clash, choice)
  const merged = mergeWorkspace<unknown>(chosen.base, chosen.mine, theirs)
  if (!merged.ok) {
    pendingClash = { parent: chosen.base, data: chosen.mine, theirs, clash: merged.clash }
    return { done: false as const, next: saveClash() }
  }
  if (typeof window !== 'undefined') {
    const shown = new CustomEvent<WorkspaceMerged>(WORKSPACE_MERGED, {
      detail: { saved: data, data: merged.data },
      cancelable: true,
    })
    window.dispatchEvent(shown)
    if (shown.defaultPrevented) {
      pendingClash = { parent: chosen.base, data: chosen.mine, theirs, clash: shown.detail.clash || pendingClash.clash }
      return { done: false as const, next: saveClash() }
    }
  }
  // The merged workspace is built on the server copy as it is now, and saved from it.
  pendingClash = undefined
  conflict = false
  saveError = undefined
  localBase = theirs
  const saved = await queueCloudStoreSave(merged.data as T)
  return { done: true as const, saved }
}
