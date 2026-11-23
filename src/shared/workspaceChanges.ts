/**
 * Changed-record saves (Phase 4A).
 *
 * Instead of sending the whole workspace on every save, the browser sends only what changed since the server copy it
 * last had: for each list of records (items, clients, projects…) the records it added or changed and the ids it
 * removed, plus any other top-level value that changed. Each changed record carries a fingerprint of how it looked
 * before the edit, so the server can still take the save when someone else saved in the meantime, as long as they
 * did not touch the same records.
 *
 * Shared by the browser and the server: plain functions, no Node or DOM APIs.
 */

export type CollectionChanges = {
  /** Records added or changed, whole. */
  upsert: Record<string, unknown>[]
  /** Ids of records removed. */
  remove: string[]
  /** Fingerprint of each changed or removed record as it was before the edit; null for a new record. */
  base: Record<string, string | null>
  /** Where each new record goes: the id of the record before it in the list, or null for the top. */
  after?: Record<string, string | null>
}

export type WorkspaceChanges = {
  collections: Record<string, CollectionChanges>
  /** Other top-level values that changed, whole. */
  set: Record<string, unknown>
  /** Top-level values that were removed. */
  unset: string[]
  /** Fingerprint of each set or unset value as it was before the edit; null when it did not exist. */
  setBase: Record<string, string | null>
}

/** JSON with object keys sorted, so two equal values always give the same text. */
export function stableJson(value: unknown): string {
  return (
    JSON.stringify(value, (_key, entry) =>
      entry && typeof entry === 'object' && !Array.isArray(entry)
        ? Object.fromEntries(
            Object.keys(entry)
              .sort()
              .map(key => [key, entry[key]]),
          )
        : entry,
    ) ?? 'undefined'
  )
}

/** A short fingerprint of a value: two 32-bit FNV-1a hashes of its stable JSON. Equal values, equal fingerprints. */
export function fingerprint(value: unknown): string {
  const text = stableJson(value)
  let a = 0x811c9dc5
  let b = 0x01000193 ^ text.length
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    a = Math.imul(a ^ code, 0x01000193)
    b = Math.imul(b ^ code, 0x5bd1e995) ^ (b >>> 15)
  }
  return `${(a >>> 0).toString(36)}.${(b >>> 0).toString(36)}`
}

function idOf(record: unknown) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return undefined
  const id = (record as { id?: unknown }).id
  return typeof id === 'string' || typeof id === 'number' ? String(id) : undefined
}

/** A list of records, each an object with its own id: those are saved record by record. */
export function isRecordList(value: unknown): value is Record<string, unknown>[] {
  if (!Array.isArray(value)) return false
  const ids = new Set<string>()
  for (const entry of value) {
    const id = idOf(entry)
    if (id === undefined || ids.has(id)) return false
    ids.add(id)
  }
  return true
}

function byId(list: Record<string, unknown>[]) {
  return new Map(list.map(record => [idOf(record) as string, record]))
}

const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key)

/**
 * What changed from `before` (the server copy) to `after` (this browser's copy). Returns null when the two are not
 * both workspace objects. A list is compared record by record when both sides are lists of records with ids (an
 * empty list counts as one); anything else that changed is sent whole.
 */
export function diffWorkspace(before: unknown, after: unknown): WorkspaceChanges | null {
  if (!before || typeof before !== 'object' || Array.isArray(before)) return null
  if (!after || typeof after !== 'object' || Array.isArray(after)) return null
  const previous = before as Record<string, unknown>
  const next = after as Record<string, unknown>
  const changes: WorkspaceChanges = { collections: {}, set: {}, unset: [], setBase: {} }
  for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    const was = previous[key]
    const now = next[key]
    if (!own(next, key) || now === undefined) {
      if (own(previous, key) && was !== undefined) {
        changes.unset.push(key)
        changes.setBase[key] = fingerprint(was)
      }
      continue
    }
    if (was === now) continue
    if (isRecordList(was) && isRecordList(now)) {
      const wasById = byId(was)
      const nowById = byId(now)
      const upsert: Record<string, unknown>[] = []
      const remove: string[] = []
      const base: Record<string, string | null> = {}
      const after: Record<string, string | null> = {}
      let previousId: string | null = null
      for (const [id, record] of nowById) {
        const prior = previousId
        previousId = id
        const old = wasById.get(id)
        if (old === record) continue
        if (old === undefined) {
          upsert.push(record)
          base[id] = null
          after[id] = prior
          continue
        }
        const oldPrint = fingerprint(old)
        if (oldPrint === fingerprint(record)) continue
        upsert.push(record)
        base[id] = oldPrint
      }
      for (const [id, record] of wasById)
        if (!nowById.has(id)) {
          remove.push(id)
          base[id] = fingerprint(record)
        }
      // Order matters to the app (subtask order, board columns): a reordered list is sent whole.
      const order = (list: Record<string, unknown>[]) =>
        list.map(idOf).filter(id => wasById.has(id as string) && nowById.has(id as string))
      const reordered = stableJson(order(was)) !== stableJson(order(now))
      if (reordered) {
        changes.set[key] = now
        changes.setBase[key] = fingerprint(was)
        continue
      }
      if (upsert.length || remove.length) changes.collections[key] = { upsert, remove, base, after }
      continue
    }
    if (stableJson(was) === stableJson(now)) continue
    changes.set[key] = now
    changes.setBase[key] = own(previous, key) && was !== undefined ? fingerprint(was) : null
  }
  return changes
}

export function hasChanges(changes: WorkspaceChanges) {
  return Object.keys(changes.collections).length > 0 || Object.keys(changes.set).length > 0 || changes.unset.length > 0
}

/** Checks that a change set from the network has the shape above. */
export function isWorkspaceChanges(value: unknown): value is WorkspaceChanges {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const changes = value as WorkspaceChanges
  const plain = (entry: unknown) => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry)
  if (!plain(changes.collections) || !plain(changes.set) || !plain(changes.setBase) || !Array.isArray(changes.unset))
    return false
  if (!changes.unset.every(key => typeof key === 'string')) return false
  for (const entry of Object.values(changes.collections)) {
    if (!plain(entry) || !Array.isArray(entry.upsert) || !Array.isArray(entry.remove) || !plain(entry.base))
      return false
    if (!entry.upsert.every(record => idOf(record) !== undefined)) return false
    if (!entry.remove.every(id => typeof id === 'string')) return false
    if (entry.after !== undefined && !plain(entry.after)) return false
  }
  return true
}

/**
 * The first record or value in `changes` that is no longer as the change set expects in `current` (someone else
 * changed or removed it, or added one with the same id), or null when every change still applies cleanly.
 */
export function changeConflict(current: unknown, changes: WorkspaceChanges): string | null {
  const state = (current && typeof current === 'object' ? current : {}) as Record<string, unknown>
  for (const [key, entry] of Object.entries(changes.collections)) {
    const list = state[key]
    if (list !== undefined && !isRecordList(list)) return key
    const records = byId((list as Record<string, unknown>[] | undefined) || [])
    const ids = [...entry.upsert.map(record => idOf(record) as string), ...entry.remove]
    for (const id of ids) {
      const expected = own(entry.base, id) ? entry.base[id] : undefined
      if (expected === undefined) return `${key} ${id}`
      const record = records.get(id)
      if ((record === undefined ? null : fingerprint(record)) !== expected) return `${key} ${id}`
    }
  }
  for (const key of [...Object.keys(changes.set), ...changes.unset]) {
    const expected = own(changes.setBase, key) ? changes.setBase[key] : undefined
    if (expected === undefined) return key
    const value = state[key]
    if ((value === undefined ? null : fingerprint(value)) !== expected) return key
  }
  return null
}

/**
 * `current` with the changes laid on top. A changed record keeps its place in its list; a new record goes after the
 * record it followed in the browser (at the end when that one is gone); a removed record is dropped. Returns a new
 * object; `current` is not modified.
 */
export function applyWorkspaceChanges<T>(current: T, changes: WorkspaceChanges): T {
  const state = { ...((current && typeof current === 'object' ? current : {}) as Record<string, unknown>) }
  for (const [key, entry] of Object.entries(changes.collections)) {
    const list = isRecordList(state[key]) ? (state[key] as Record<string, unknown>[]) : []
    const replacements = byId(entry.upsert)
    const removed = new Set(entry.remove)
    const kept = list
      .filter(record => !removed.has(idOf(record) as string))
      .map(record => replacements.get(idOf(record) as string) ?? record)
    const present = new Set(list.map(record => idOf(record) as string))
    for (const record of entry.upsert) {
      const id = idOf(record) as string
      if (present.has(id) || removed.has(id)) continue
      const previous = entry.after && own(entry.after, id) ? entry.after[id] : undefined
      const at =
        previous === null ? 0 : previous === undefined ? -1 : kept.findIndex(item => idOf(item) === previous) + 1
      if (at <= 0 && previous !== null) kept.push(record)
      else kept.splice(at, 0, record)
      present.add(id)
    }
    state[key] = kept
  }
  for (const [key, value] of Object.entries(changes.set)) state[key] = value
  for (const key of changes.unset) delete state[key]
  return state as T
}
