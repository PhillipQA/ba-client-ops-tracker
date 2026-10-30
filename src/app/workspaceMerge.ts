/**
 * Merging two saves of the workspace made from the same starting point. The workspace is one record (tasks, clients,
 * projects, activity…), so a save is refused when anything else saved since this browser loaded it: another person,
 * another tab, or the server (Gmail and Discord captures, follow-up rollover). Most of the time the two sides changed
 * different things, and both can be kept:
 * - Lists of records with an id are merged record by record, and records field by field.
 * - A record or field changed on one side only takes that side's value; changed the same way on both sides is fine.
 * - Records added on either side are kept; a record deleted on one side and untouched on the other is deleted.
 * - Only the same field changed differently on both sides (or a record changed on one side and deleted on the other)
 *   is a real clash: then nothing is merged and the person chooses, as before.
 *
 * Pure functions, shared by the save queue and the tests.
 */

export type MergeOutcome<T> = { ok: true; data: T } | { ok: false; clash: string }

class Clash extends Error {}

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b)
const isPlain = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const hasIds = (value: unknown): value is { id: string }[] =>
  Array.isArray(value) && value.every(entry => isPlain(entry) && typeof entry.id === 'string' && entry.id !== '')

function mergeValue(base: unknown, mine: unknown, theirs: unknown, path: string): unknown {
  if (same(mine, theirs)) return mine
  if (same(mine, base)) return theirs
  if (same(theirs, base)) return mine
  // Changed on both sides, differently.
  if ((base === undefined || hasIds(base)) && hasIds(mine) && hasIds(theirs))
    return mergeList((base as { id: string }[] | undefined) || [], mine, theirs, path)
  if ((base === undefined || isPlain(base)) && isPlain(mine) && isPlain(theirs))
    return mergeObject(isPlain(base) ? base : {}, mine, theirs, path)
  throw new Clash(path)
}

function mergeObject(
  base: Record<string, unknown>,
  mine: Record<string, unknown>,
  theirs: Record<string, unknown>,
  path: string,
) {
  const out: Record<string, unknown> = {}
  for (const key of new Set([...Object.keys(theirs), ...Object.keys(mine)])) {
    const value = mergeValue(base[key], mine[key], theirs[key], path ? `${path}.${key}` : key)
    if (value !== undefined) out[key] = value
  }
  return out
}

function mergeList(base: { id: string }[], mine: { id: string }[], theirs: { id: string }[], path: string) {
  const before = new Map(base.map(entry => [entry.id, entry]))
  const ours = new Map(mine.map(entry => [entry.id, entry]))
  const other = new Map(theirs.map(entry => [entry.id, entry]))
  const keep = (id: string): unknown => {
    const b = before.get(id),
      m = ours.get(id),
      t = other.get(id),
      where = `${path}[${id}]`
    if (m && t) return mergeValue(b, m, t, where)
    if (m && !t) {
      if (!b) return m // added here
      if (same(m, b)) return undefined // deleted there, untouched here
      throw new Clash(where) // changed here, deleted there
    }
    if (t && !m) {
      if (!b) return t // added there
      if (same(t, b)) return undefined // deleted here, untouched there
      throw new Clash(where) // deleted here, changed there
    }
    return undefined
  }
  // New records from this side go first (lists such as activity are newest first), then the other side's order.
  const out: unknown[] = []
  for (const entry of mine) if (!before.has(entry.id) && !other.has(entry.id)) out.push(entry)
  for (const entry of theirs) {
    const value = keep(entry.id)
    if (value !== undefined) out.push(value)
  }
  // Records kept here that the other side reordered away are not lost.
  const placed = new Set(out.map(entry => (entry as { id: string }).id))
  for (const entry of mine)
    if (!placed.has(entry.id)) {
      const value = keep(entry.id)
      if (value !== undefined) out.push(value)
    }
  return out
}

/** Both sides' changes since `base`, or the first clash found. */
export function mergeWorkspace<T>(base: T | null | undefined, mine: T, theirs: T | null | undefined): MergeOutcome<T> {
  try {
    return { ok: true, data: mergeValue(base ?? {}, mine, theirs ?? {}, '') as T }
  } catch (error) {
    if (error instanceof Clash) return { ok: false, clash: error.message || 'workspace' }
    throw error
  }
}
