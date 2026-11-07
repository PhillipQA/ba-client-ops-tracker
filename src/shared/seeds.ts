/**
 * Seeds, the company's time and client tracker, as this app sees it.
 *
 *   Seeds client            → Client   (seedsId; name follows Seeds)
 *   Seeds project + contract → Project (seedsId, contractNumber, clientId; name follows Seeds)
 *   Seeds task              → parent Task (seedsId; title follows Seeds)
 *   Seeds assignment        → who sees which client or project (see access.ts)
 *
 * Subtasks, emails, trackers, documents and time stay in this app. Records keep their own ids; Seeds ids only link
 * them, so renames follow and nothing is matched twice.
 */
import { rolesFor, scopeFor, type SeedsRole } from './access'

export interface SeedsPerson {
  id: string
  name: string
  email: string
}
export interface SeedsClient {
  id: string
  name: string
  archived?: boolean
}
export interface SeedsProject {
  id: string
  /** Empty for Seeds' internal projects. */
  clientId: string
  name: string
  contractNumber: string
  archived?: boolean
}
export interface SeedsTask {
  id: string
  projectId: string
  name: string
  archived?: boolean
}
export interface SeedsAssignment {
  personId: string
  role: SeedsRole
  clientId?: string
  projectId?: string
}
export interface SeedsSnapshot {
  people: SeedsPerson[]
  clients: SeedsClient[]
  projects: SeedsProject[]
  tasks: SeedsTask[]
  assignments: SeedsAssignment[]
}

export type SeedsMatchKind = 'client' | 'project' | 'task'

/** A Seeds record whose name is close to, but not the same as, an existing record. Someone confirms it. */
export interface SeedsMatch {
  id: string
  kind: SeedsMatchKind
  seedsId: string
  seedsName: string
  appId: string
  appName: string
  contractNumber?: string
}

export interface SeedsCounts {
  people: number
  clients: number
  projects: number
  tasks: number
  assignments: number
  created: number
  linked: number
  renamed: number
}

export interface SeedsState {
  /** An Administrator saved a Seeds API key. Sync runs on its own from then on. */
  connected: boolean
  lastAttemptAt?: string
  lastSuccessAt?: string
  /** Why the last sync failed. The last good assignments stay in force meanwhile. */
  lastError?: string
  counts?: SeedsCounts
  pendingMatches: SeedsMatch[]
  /** Seeds ids whose suggested match was turned down; the next sync adds them as new records. */
  rejected: string[]
  /** Seeds people with no account here (matched by email). */
  unmatchedPeople: { id: string; name: string; email: string }[]
}

/** What the browser is told. Matches and unmatched people only go to those who can act on them. */
export interface SeedsStatus {
  connected: boolean
  lastAttemptAt?: string
  lastSuccessAt?: string
  lastError?: string
  counts?: SeedsCounts
  canReview: boolean
  pendingMatches: SeedsMatch[]
  unmatchedPeople: { id: string; name: string; email: string }[]
}

const list = (value: unknown): any[] => (Array.isArray(value) ? value : [])
const text = (value: unknown) => (value == null ? '' : String(value))

export function seedsState(state: any): SeedsState {
  const raw = state?.seeds && typeof state.seeds === 'object' ? state.seeds : {}
  return {
    connected: raw.connected === true,
    ...(raw.lastAttemptAt ? { lastAttemptAt: text(raw.lastAttemptAt) } : {}),
    ...(raw.lastSuccessAt ? { lastSuccessAt: text(raw.lastSuccessAt) } : {}),
    ...(raw.lastError ? { lastError: text(raw.lastError) } : {}),
    ...(raw.counts && typeof raw.counts === 'object' ? { counts: raw.counts as SeedsCounts } : {}),
    pendingMatches: list(raw.pendingMatches).filter(match => match?.id && match.seedsId && match.appId),
    rejected: list(raw.rejected).map(text).filter(Boolean),
    unmatchedPeople: list(raw.unmatchedPeople).filter(person => person?.id),
  }
}

/** Administrators and Project Managers review matches; each sees only matches on records they can see. */
export function seedsStatusFor(state: any, user: { id: string; role?: string }): SeedsStatus {
  const seeds = seedsState(state)
  const administrator = user.role === 'Administrator'
  const scope = scopeFor(state, user.id)
  const manager = rolesFor(state, user.id).includes('PM')
  const canReview = administrator || manager
  const sees = (match: SeedsMatch) =>
    administrator ||
    scope.all ||
    (match.kind === 'client'
      ? scope.labelClients.has(match.appId)
      : match.kind === 'project'
        ? scope.labelProjects.has(match.appId)
        : scope.visibleItems.has(match.appId))
  return {
    connected: seeds.connected,
    ...(seeds.lastAttemptAt ? { lastAttemptAt: seeds.lastAttemptAt } : {}),
    ...(seeds.lastSuccessAt ? { lastSuccessAt: seeds.lastSuccessAt } : {}),
    ...(seeds.lastError ? { lastError: seeds.lastError } : {}),
    ...(seeds.counts ? { counts: seeds.counts } : {}),
    canReview,
    pendingMatches: canReview ? seeds.pendingMatches.filter(sees) : [],
    unmatchedPeople: administrator ? seeds.unmatchedPeople : [],
  }
}

/** Fields Seeds owns on each kind of record. The browser cannot change them, add them or drop a linked record. */
const SEEDS_FIELDS: Record<'clients' | 'projects' | 'items', string[]> = {
  clients: ['seedsId', 'name', 'seedsArchived'],
  projects: ['seedsId', 'name', 'contractNumber', 'clientId', 'seedsArchived'],
  items: ['seedsId', 'title', 'seedsArchived'],
}
const LINK_FIELDS = ['seedsId', 'contractNumber', 'seedsArchived']

export function keepSeedsFields(current: any, next: any) {
  const result = { ...next }
  for (const key of ['clients', 'projects', 'items'] as const) {
    if (!Array.isArray(next?.[key])) continue
    const before = new Map(list(current?.[key]).map(record => [text(record?.id), record]))
    const seen = new Set<string>()
    const records = list(next[key]).map(record => {
      const id = text(record?.id)
      seen.add(id)
      const old = before.get(id)
      if (old?.seedsId) {
        const owned: Record<string, unknown> = {}
        for (const field of SEEDS_FIELDS[key]) if (old[field] !== undefined) owned[field] = old[field]
        return { ...record, ...owned }
      }
      if (!LINK_FIELDS.some(field => record?.[field] !== undefined)) return record
      const copy = { ...record }
      for (const field of LINK_FIELDS) if (old?.[field] === undefined) delete copy[field]
      return copy
    })
    // A record linked to Seeds is removed in Seeds, not here.
    const kept = list(current?.[key]).filter(record => record?.seedsId && !seen.has(text(record.id)))
    result[key] = [...records, ...kept]
  }
  return result
}

/** Normalized for matching: case, spacing, punctuation and company suffixes do not count. */
export function matchKey(value: unknown) {
  return text(value)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(the|inc|incorporated|corp|corporation|co|company|ltd|limited|llc|plc|opc)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** How alike two names are, 0 to 1 (Dice coefficient on letter pairs). */
export function nameSimilarity(a: unknown, b: unknown) {
  const left = matchKey(a).replace(/ /g, '')
  const right = matchKey(b).replace(/ /g, '')
  if (!left || !right) return 0
  if (left === right) return 1
  if (left.length >= 4 && right.length >= 4 && (left.includes(right) || right.includes(left))) return 0.9
  const pairs = (value: string) => {
    const counts = new Map<string, number>()
    for (let index = 0; index < value.length - 1; index++) {
      const pair = value.slice(index, index + 2)
      counts.set(pair, (counts.get(pair) || 0) + 1)
    }
    return counts
  }
  const one = pairs(left)
  const two = pairs(right)
  let shared = 0
  for (const [pair, count] of one) shared += Math.min(count, two.get(pair) || 0)
  return (2 * shared) / (left.length - 1 + right.length - 1 || 1)
}

export const CLOSE_MATCH = 0.75
