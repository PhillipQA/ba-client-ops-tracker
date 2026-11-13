/**
 * Seeds, the company's time and client tracker, as this app sees it.
 *
 *   Seeds parent            → Client   (seedsId; name follows Seeds)
 *   Seeds project + contract → Project (seedsId, contractNumber, clientId; name follows Seeds)
 *   Seeds tasks             → the project's seedsTasks, a pick-list on subtasks (seedsTaskId)
 *   Seeds products          → the account's product list (/products); a task picks one (productId) when its time
 *                             must carry a product
 *   Seeds project member    → who sees which project (see access.ts)
 *
 * Subtasks, emails, trackers, documents and time stay in this app. Records keep their own ids; Seeds ids only link
 * them, so renames follow and nothing is matched twice.
 */
import { rolesFor, scopeFor, type SeedsRole } from './access'

export interface SeedsPerson {
  id: string
  name: string
  email: string
  /** Their job title in Seeds, when it says. */
  title?: string
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
  /** The Seeds product (Barter CX…), when the project names one: time entries carry it. */
  productId?: string
  /** What a time entry on this project must carry, and its defaults, when Seeds says. */
  timeRules?: SeedsTimeRules
  archived?: boolean
}
/** A Seeds project's time-entry requirements and defaults (from the Projects API). */
export interface SeedsTimeRules {
  productRequired?: boolean
  taskRequired?: boolean
  remarksRequired?: boolean
  defaultProductId?: string
  defaultTaskId?: string
}
export interface SeedsTask {
  id: string
  projectId: string
  name: string
  /** Seeds requires a product on time logged to this task. */
  productRequired?: boolean
  /** The product time on this task starts with, when Seeds names one. */
  defaultProductId?: string
  archived?: boolean
}
/** A Seeds product (Barter CX, RPOS…), from GET /products (`core.products.read`). */
export interface SeedsProduct {
  id: string
  name: string
  archived?: boolean
}
export interface SeedsAssignment {
  personId: string
  /** Lower-case email: how a Seeds person is matched to someone in this app. */
  email?: string
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
  /** Seeds' product list, when this read fetched it (absent: keep the one from the last sync). */
  products?: SeedsProduct[]
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

/** One person's part of the account's Seeds sync. */
export interface SeedsUserSync {
  /** Seeds lists this person (matched by email) on at least one project. */
  connected: boolean
  lastAttemptAt?: string
  lastSuccessAt?: string
  /** Why their last sync failed. Their last good assignments stay in force meanwhile. */
  lastError?: string
  counts?: SeedsCounts
  /** Role titles Seeds used that no job role claims yet (add them in Settings › Roles). */
  unknownRoles?: string[]
}

/** The account's last Seeds sync as a whole. */
export interface SeedsAccountSync {
  lastAttemptAt?: string
  lastSuccessAt?: string
  lastError?: string
  /** People in this app that Seeds lists on a project, and those it does not. */
  matched?: number
  unmatched?: number
  /** Record field names Seeds sent (names only), to check the mapping. */
  fields?: Record<string, string[]>
  /** Seeds projects Seeds would not give members or tasks for (skipped, not failed). */
  skipped?: number
  /** The last sync read every open project (full, once a week) or only those Seeds changed (delta). */
  mode?: 'full' | 'delta'
  /** Projects whose members the last sync read. */
  checked?: number
  lastFullAt?: string
  /** Where the next delta sync starts: the latest `updatedAt` Seeds sent (Seeds' clock). */
  updatedSince?: string
}

export interface SeedsState {
  /** An Administrator turned Seeds on. The server holds the Seeds application token; nobody pastes a key. */
  connected: boolean
  /** Tenant-wide people directory from the last successful /users sync; used for document signatory suggestions. */
  people: SeedsPerson[]
  /** Seeds' product list from the last sync that read it: what a task's product is picked from. */
  products: SeedsProduct[]
  sync: SeedsAccountSync
  users: Record<string, SeedsUserSync>
  pendingMatches: SeedsMatch[]
  /** Seeds ids whose suggested match was turned down; the next sync adds them as new records. */
  rejected: string[]
  /** When Seeds was first turned on: everything that existed then moved to Before Seeds. */
  cutoverAt?: string
}

/** What the browser is told: the person's own sync, and matches only for those who can act on them. */
export interface SeedsStatus {
  connected: boolean
  cutoverAt?: string
  /** When the account last synced, and why it failed if it did. */
  sync: Pick<SeedsAccountSync, 'lastAttemptAt' | 'lastSuccessAt' | 'lastError'>
  mine: SeedsUserSync
  canReview: boolean
  pendingMatches: SeedsMatch[]
  /** Seeds' products, for the product picker on tasks. */
  products: SeedsProduct[]
  /** Administrators: how each person's part of the sync went. */
  people?: (SeedsUserSync & { userId: string })[]
}

const list = (value: unknown): any[] => (Array.isArray(value) ? value : [])
const text = (value: unknown) => (value == null ? '' : String(value))

function userSync(raw: any): SeedsUserSync {
  return {
    connected: raw?.connected === true,
    ...(raw?.lastAttemptAt ? { lastAttemptAt: text(raw.lastAttemptAt) } : {}),
    ...(raw?.lastSuccessAt ? { lastSuccessAt: text(raw.lastSuccessAt) } : {}),
    ...(raw?.lastError ? { lastError: text(raw.lastError) } : {}),
    ...(raw?.counts && typeof raw.counts === 'object' ? { counts: raw.counts as SeedsCounts } : {}),
    ...(Array.isArray(raw?.unknownRoles) && raw.unknownRoles.length
      ? { unknownRoles: raw.unknownRoles.map(text).slice(0, 20) }
      : {}),
  }
}

/**
 * The Seeds product a task's time carries, and whether Seeds requires one. The product picked on the task wins, then
 * the Seeds project's product, then the Seeds task's default, then the project's default. A product is required when
 * the Seeds project or the Seeds task the time counts toward says so.
 */
export function seedsProductFor(
  state: { projects?: any[] } | null | undefined,
  item: { projectId?: string; productId?: string } | null | undefined,
  seedsTaskId?: string,
) {
  const project = list(state?.projects).find(candidate => candidate?.id && candidate.id === item?.projectId)
  const rules = project?.seedsTimeRules && typeof project.seedsTimeRules === 'object' ? project.seedsTimeRules : {}
  const task = seedsTaskId ? list(project?.seedsTasks).find(candidate => candidate?.id === seedsTaskId) : undefined
  const productId =
    text(item?.productId) ||
    text(project?.seedsProductId) ||
    text(task?.defaultProductId) ||
    text(rules.defaultProductId)
  const required = rules.productRequired === true || task?.productRequired === true
  return { productId, required, missing: required && !productId }
}

/** Products with an id and a name, once each, sorted by name. */
export function cleanProducts(value: unknown): SeedsProduct[] {
  const seen = new Set<string>()
  return list(value)
    .filter((product: any) => product && text(product.id).trim() && text(product.name).trim())
    .map((product: any) => ({
      id: text(product.id).trim(),
      name: text(product.name).trim().slice(0, 120),
      ...(product.archived === true ? { archived: true } : {}),
    }))
    .filter(product => !seen.has(product.id) && Boolean(seen.add(product.id)))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 2000)
}

export function seedsState(state: any): SeedsState {
  const raw = state?.seeds && typeof state.seeds === 'object' ? state.seeds : {}
  const users: Record<string, SeedsUserSync> = {}
  if (raw.users && typeof raw.users === 'object')
    for (const [userId, value] of Object.entries(raw.users)) users[userId] = userSync(value)
  const sync = raw.sync && typeof raw.sync === 'object' ? raw.sync : {}
  const fields: Record<string, string[]> = {}
  if (sync.fields && typeof sync.fields === 'object')
    for (const [key, names] of Object.entries(sync.fields)) fields[key] = list(names).map(text).slice(0, 60)
  return {
    connected: raw.connected === true,
    people: list(raw.people)
      .filter((person: any) => person && text(person.id) && text(person.email))
      .slice(0, 20000)
      .map((person: any) => ({
        id: text(person.id),
        name: text(person.name),
        email: text(person.email).toLowerCase(),
        ...(text(person.title) ? { title: text(person.title) } : {}),
      })),
    products: cleanProducts(raw.products),
    sync: {
      ...(sync.lastAttemptAt ? { lastAttemptAt: text(sync.lastAttemptAt) } : {}),
      ...(sync.lastSuccessAt ? { lastSuccessAt: text(sync.lastSuccessAt) } : {}),
      ...(sync.lastError ? { lastError: text(sync.lastError) } : {}),
      ...(Number.isFinite(sync.matched) ? { matched: Number(sync.matched) } : {}),
      ...(Number.isFinite(sync.unmatched) ? { unmatched: Number(sync.unmatched) } : {}),
      ...(Number(sync.skipped) > 0 ? { skipped: Number(sync.skipped) } : {}),
      // `quick` is what delta syncs were called before.
      ...(sync.mode === 'full'
        ? { mode: 'full' as const }
        : sync.mode === 'delta' || sync.mode === 'quick'
          ? { mode: 'delta' as const }
          : {}),
      ...(Number(sync.checked) >= 0 && sync.checked != null ? { checked: Number(sync.checked) } : {}),
      ...(sync.lastFullAt ? { lastFullAt: text(sync.lastFullAt) } : {}),
      ...(sync.updatedSince && Number.isFinite(Date.parse(text(sync.updatedSince)))
        ? { updatedSince: text(sync.updatedSince) }
        : {}),
      ...(Object.keys(fields).length ? { fields } : {}),
    },
    users,
    pendingMatches: list(raw.pendingMatches).filter(match => match?.id && match.seedsId && match.appId),
    rejected: list(raw.rejected).map(text).filter(Boolean),
    ...(raw.cutoverAt ? { cutoverAt: text(raw.cutoverAt) } : {}),
  }
}

/**
 * Seeds becomes the source of truth: every client and project not from Seeds moves to Before Seeds. Their tasks,
 * subtasks, trackers and documents go with them (they belong to the client or project). Nothing is deleted; Before
 * Seeds stays open to everyone and editable. Done once, when Seeds is first turned on.
 */
export function moveToBeforeSeeds(state: any, now: string) {
  const seeds = seedsState(state)
  if (seeds.cutoverAt) return state
  const move = (record: any) =>
    record?.seedsId || record?.beforeSeeds
      ? record
      : { ...record, beforeSeeds: true, lifecycleVersion: (Number(record?.lifecycleVersion) || 0) + 1 }
  return {
    ...state,
    clients: list(state?.clients).map(move),
    projects: list(state?.projects).map(move),
    seeds: { ...seeds, cutoverAt: now },
  }
}

/** A client or project from before Seeds (see moveToBeforeSeeds). */
export const isBeforeSeeds = (record: any) => record?.beforeSeeds === true

/** Administrators and Project Managers review matches; each sees only matches on records they can see. */
export function seedsStatusFor(state: any, user: { id: string; role?: string }): SeedsStatus {
  const seeds = seedsState(state)
  const administrator = user.role === 'Administrator'
  const scope = scopeFor(state, user.id)
  const canReview = administrator || rolesFor(state, user.id).includes('PM')
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
    ...(seeds.cutoverAt ? { cutoverAt: seeds.cutoverAt } : {}),
    sync: {
      ...(seeds.sync.lastAttemptAt ? { lastAttemptAt: seeds.sync.lastAttemptAt } : {}),
      ...(seeds.sync.lastSuccessAt ? { lastSuccessAt: seeds.sync.lastSuccessAt } : {}),
      ...(seeds.sync.lastError ? { lastError: seeds.sync.lastError } : {}),
    },
    mine: seeds.users[user.id] || { connected: false },
    canReview,
    pendingMatches: canReview ? seeds.pendingMatches.filter(sees) : [],
    products: seeds.products,
    ...(administrator ? { people: Object.entries(seeds.users).map(([userId, sync]) => ({ userId, ...sync })) } : {}),
  }
}

/** Fields Seeds owns on each kind of record. The browser cannot change them, add them or drop a linked record. */
const SEEDS_FIELDS: Record<'clients' | 'projects' | 'items', string[]> = {
  clients: ['seedsId', 'name', 'seedsArchived'],
  projects: [
    'seedsId',
    'name',
    'contractNumber',
    'clientId',
    'seedsArchived',
    'seedsTasks',
    'seedsProductId',
    'seedsTimeRules',
  ],
  items: ['seedsId', 'title', 'seedsArchived'],
}
const LINK_FIELDS = [
  'seedsId',
  'contractNumber',
  'seedsArchived',
  'seedsTasks',
  'beforeSeeds',
  'seedsProductId',
  'seedsTimeRules',
]

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
        const linked = { ...record, ...owned }
        for (const field of LINK_FIELDS) if (old[field] === undefined) delete linked[field]
        return linked
      }
      // Before Seeds is set by the server only, and stays.
      const kept = old?.beforeSeeds ? { ...record, beforeSeeds: true } : record
      if (!LINK_FIELDS.some(field => kept?.[field] !== undefined)) return kept
      const copy = { ...kept }
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

const seedsKey = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
/**
 * The Seeds task whose name matches a task or subtask title ("GO LIVE" ↔ "Go Live"), from a project's list: how a
 * tracker's step and cell subtasks get their Seeds task without picking one.
 */
export function seedsTaskNamed(tasks: { id: string; name: string; archived?: boolean }[] | undefined, title: string) {
  const key = seedsKey(title)
  return key ? (tasks || []).find(task => !task.archived && seedsKey(task.name) === key)?.id : undefined
}

/**
 * Whether a task or subtask is Before Seeds work: it is in its project's folder, or its client's when it has no
 * project. Work with neither counts as From Seeds.
 */
export function isBeforeSeedsWork(
  item: { projectId?: string; clientId?: string },
  projects: { id: string; beforeSeeds?: boolean }[],
  clients: { id: string; beforeSeeds?: boolean }[],
) {
  const project = item.projectId ? projects.find(candidate => candidate.id === item.projectId) : undefined
  if (project) return project.beforeSeeds === true
  return Boolean(item.clientId && clients.find(candidate => candidate.id === item.clientId)?.beforeSeeds)
}
