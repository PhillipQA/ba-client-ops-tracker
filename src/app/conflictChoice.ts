/**
 * Choosing per record in a save conflict (Phase 4B). When this browser and another save changed the same field of
 * the same record differently, the person picks, for that record, their version or the other one; everything else is
 * merged as usual. A clash outside a record list (a setting) is chosen for that whole setting.
 *
 * Pure functions, shared by the save queue and the tests.
 */

export type ClashChoice = 'mine' | 'theirs'

export type ClashTarget = { key: string; id?: string }

/** The record (or top-level value) a clash path such as `items[b].status` points at. */
export function clashTarget(clash: string): ClashTarget {
  const record = /^([^.[\]]+)\[([^\]]+)\]/.exec(clash)
  if (record) return { key: record[1], id: record[2] }
  return { key: clash.split(/[.[]/)[0] || clash }
}

type State = Record<string, unknown>
const plain = (value: unknown): value is State => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const list = (value: unknown) => (Array.isArray(value) ? (value as { id?: unknown }[]) : [])

function recordIn(state: unknown, target: ClashTarget) {
  if (!plain(state)) return undefined
  if (target.id === undefined) return state[target.key]
  return list(state[target.key]).find(entry => plain(entry) && String(entry.id) === target.id)
}

/** `state` with the target set to `value` (a record put in place, added at the end, or removed when undefined). */
function withTarget(state: unknown, target: ClashTarget, value: unknown) {
  const copy: State = { ...(plain(state) ? state : {}) }
  if (target.id === undefined) {
    if (value === undefined) delete copy[target.key]
    else copy[target.key] = value
    return copy
  }
  const entries = list(copy[target.key])
  const index = entries.findIndex(entry => plain(entry) && String(entry.id) === target.id)
  const next = [...entries]
  if (value === undefined) {
    if (index >= 0) next.splice(index, 1)
  } else if (index >= 0) next[index] = value as { id?: unknown }
  else next.push(value as { id?: unknown })
  copy[target.key] = next
  return copy
}

/**
 * The starting point and this browser's copy, adjusted so merging again honours the choice for the clashing record:
 * - `theirs`: this browser's copy takes their version of the record, so its own edit to it is dropped;
 * - `mine`: the starting point takes their version, so this browser's version counts as the only change and wins.
 */
export function chooseForClash<T>(base: T, mine: T, theirs: T, clash: string, choice: ClashChoice) {
  const target = clashTarget(clash)
  const theirVersion = recordIn(theirs, target)
  if (choice === 'theirs') return { base, mine: withTarget(mine, target, theirVersion) as T }
  return { base: withTarget(base, target, theirVersion) as T, mine }
}

/** Both versions of the clashing record, and a name for it, for the person to choose between. */
export function clashSides(mine: unknown, theirs: unknown, clash: string) {
  const target = clashTarget(clash)
  const ours = recordIn(mine, target)
  const other = recordIn(theirs, target)
  const named = (plain(ours) ? ours : plain(other) ? other : {}) as State
  const label = String(named.title || named.name || named.label || target.id || target.key)
  const field = clash.slice(clash.indexOf(']') + 1).replace(/^\./, '') || undefined
  return { ...target, label, field: target.id === undefined ? undefined : field, mine: ours, theirs: other }
}
