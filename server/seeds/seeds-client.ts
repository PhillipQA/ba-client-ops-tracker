/**
 * Reading Seeds over its Open API (docs/seeds-api.md). Read only. Seeds allows the app 20 requests a minute, so
 * requests go one at a time, about 3 seconds apart.
 *
 * Seeds gives one application token per app (from a SEEDS Admin), not one per person. The token lives only in the
 * server's environment (SEEDS_API_TOKEN) and goes out as `Authorization: Bearer <token>`. The address is
 * SEEDS_API_URL, by default https://seeds.iripple.com/api/v1. Two kinds of read cover the whole account:
 *
 * Full (weekly, and on request):
 *   GET /users, /parents, /projects        cursor-paged lists (`limit`, `cursor` → `nextCursor`)
 *   GET /clients                           only to find a project's parent when the project names a client instead
 *   GET /projects/{id}/members             who works on each open project, with email and organizational role
 *   GET /projects/{id}/tasks               only for projects someone in this app works on
 *   GET /products                          the product list a task picks from (core.products.read)
 *
 * Delta (every sync in between):
 *   GET /projects?updatedSince=…           only projects created, changed or deleted since the last sync; a change
 *                                          to a project's members or tasks marks the project updated too
 *   GET /projects/{id}/members, /tasks     only for those projects
 *   GET /parents/{id}, /clients/{id}       only for a parent not yet linked here
 *   GET /products                          only when a change names a product not known here
 *
 * Projects carry `updatedAt`, a deletion indicator, the contract number/reference, the product, and the project's
 * time-entry requirements and defaults.
 *
 * A Seeds **parent** (Think Library, Inc.) is this app's client. A Seeds project (named after a store or a title) is
 * this app's project. Seeds tasks (Go Live, Meetings…) are subtask-level activities: a pick-list on subtasks.
 *
 * Every answer is `{ data }`; Seeds does not publish the record fields, so names are read leniently (camelCase or
 * snake_case) and the field names seen are reported back so the mapping can be checked after the first sync.
 */
import type { SeedsSnapshot, SeedsTimeRules } from '../../src/shared/seeds'

export const DEFAULT_SEEDS_URL = 'https://seeds.iripple.com/api/v1'

export type SeedsFields = Partial<
  Record<'users' | 'parents' | 'clients' | 'projects' | 'members' | 'tasks' | 'products' | 'paging', string[]>
>

/**
 * A delta sync: only the projects Seeds changed since `since` (`GET /projects?updatedSince=`). Seeds marks a project
 * updated when its members or tasks change, and lists deleted ones with a deletion indicator, so these are the only
 * projects whose members and tasks can have changed. `parents` are the Seeds parents already linked here: a changed
 * project under another parent has its parent read by id. Without a plan, everything is read (a full sync).
 */
export type SeedsDeltaPlan = {
  since: string
  parents?: Set<string>
  /** Products already known here: the product list is read again only when a change names one that is not. */
  products?: Set<string>
}

export type SeedsRead = {
  snapshot: SeedsSnapshot
  fields: SeedsFields
  skipped?: string[]
  /** `delta`: the snapshot holds only `projectIds`, the projects Seeds changed; everything else is as it was. */
  mode?: 'full' | 'delta'
  /** The Seeds projects this read covers: every one seen (full) or every one changed (delta). */
  projectIds?: string[]
  /** Projects whose members were read this time. */
  checked?: number
  /** The latest `updatedAt` Seeds sent, by Seeds' clock: where the next delta sync starts. */
  watermark?: string
}

export interface SeedsSource {
  /**
   * Everything one account sync needs. Tasks are read only for projects where someone in `emails` is a member.
   * `linked` are the Seeds ids of this app's projects that are still open: in a full sync, one that Seeds no longer
   * lists is asked for by id, to learn whether it was completed or closed there. If Seeds turns down `updatedSince`,
   * a delta read falls back to a full one (and says so in `mode`).
   */
  read(emails: Set<string>, delta?: SeedsDeltaPlan, linked?: Set<string>): Promise<SeedsRead>
}

export class SeedsError extends Error {
  /** The field names Seeds sent before it failed, to check the mapping. */
  fields?: SeedsFields
  constructor(
    message: string,
    public status = 502,
  ) {
    super(message)
  }
}

const PAGE_SIZE = 100
const MAX_PAGES = 200
const MAX_RECORDS = 20000
/** Seeds allows this app 20 requests a minute: one every 3 seconds, with a little room. */
export const SEEDS_GAP_MS = 3100
const text = (value: unknown) => (value == null ? '' : String(value).trim())
const pick = (record: any, ...keys: string[]) => {
  for (const key of keys) {
    const value = key.split('.').reduce((at: any, part) => (at == null ? undefined : at[part]), record)
    if (value != null && value !== '' && typeof value !== 'object') return value
  }
  return undefined
}
/**
 * A record's Seeds id. Seeds ids in paths are whole numbers, so of the fields that may hold it, the first that is a
 * whole number wins (a record may also carry a code or a uuid under one of the names); else the first one present.
 */
const idOf = (record: any, ...keys: string[]) => {
  const values = keys
    .map(key => pick(record, key))
    .filter(value => value != null && value !== '')
    .map(text)
    // Seeds writes "none" as id 0 (a project with no client or product: { "id": 0, "name": "-" }).
    .filter(value => value !== '0')
  return values.find(value => /^[1-9]\d*$/.test(value)) || values[0] || ''
}
/** A Seeds id that can go in a path: a whole number of at least 1. */
export const pathId = (id: string) => /^[1-9]\d*$/.test(id)

/** Seeds' deletion indicator, under whichever name it uses: the project is gone in Seeds. */
export const deletedInSeeds = (record: any) =>
  record?.deleted === true ||
  record?.isDeleted === true ||
  record?.is_deleted === true ||
  record?.deletedAt != null ||
  record?.deleted_at != null ||
  record?.deletedOn != null ||
  /^(deleted|removed)$/i.test(text(record?.action ?? record?.changeType ?? record?.change_type ?? record?.operation))

const archived = (record: any) =>
  deletedInSeeds(record) ||
  record?.archived === true ||
  record?.isArchived === true ||
  record?.is_archived === true ||
  record?.active === false ||
  record?.isActive === false ||
  record?.is_active === false ||
  record?.deletedAt != null ||
  record?.deleted_at != null ||
  closedStatus(statusOf(record))

/** A Seeds status that means the work is over: closed, resolved, completed, cancelled, archived… */
export const closedStatus = (status: string) =>
  /\b(closed?|resolved|completed?|done|finished|cancell?ed|terminated|archived|inactive|dropped|lost)\b/i.test(status)

/** A record's status name, if it names one. */
const statusOf = (record: any) =>
  text(
    pick(
      record,
      'status',
      'status.name',
      'status.label',
      'statusName',
      'status_name',
      'projectStatus',
      'project_status',
      'projectStatus.name',
      'state',
    ),
  )
/** A record's status id, for when it does not name the status itself. */
const statusIdOf = (record: any) =>
  idOf(record, 'statusId', 'status_id', 'projectStatusId', 'project_status_id', 'projectStatus.id', 'status.id')
/** When Seeds last created or changed a record, if it says (the later of the two). */
const changedAt = (record: any) => {
  const times = [
    'updatedAt',
    'updated_at',
    'modifiedAt',
    'modified_at',
    'lastModified',
    'dateUpdated',
    'date_updated',
    'createdAt',
    'created_at',
    'dateCreated',
    'date_created',
  ]
    .map(key => Date.parse(text(pick(record, key))))
    .filter(Number.isFinite)
  return times.length ? new Date(Math.max(...times)).toISOString() : ''
}
const fullName = (record: any) =>
  text(pick(record, 'name', 'fullName', 'full_name', 'displayName', 'display_name')) ||
  [pick(record, 'firstName', 'first_name', 'firstname'), pick(record, 'lastName', 'last_name', 'lastname')]
    .map(text)
    .filter(Boolean)
    .join(' ')
const emailOf = (record: any) =>
  text(pick(record, 'email', 'emailAddress', 'email_address', 'workEmail', 'work_email', 'user.email')).toLowerCase()

/** The record fields Seeds sent, names only (one level into objects, as `parent.name`), to check the mapping. */
const fieldNames = (rows: any[]) => [
  ...new Set(
    rows
      .slice(0, 5)
      .flatMap(row =>
        row && typeof row === 'object'
          ? Object.entries(row).flatMap(([key, value]) =>
              value && typeof value === 'object' && !Array.isArray(value)
                ? [key, ...Object.keys(value).map(inner => `${key}.${inner}`)]
                : [key],
            )
          : [],
      ),
  ),
]

/** Yes, no, or not said: Seeds may send true/false, 1/0, "required"/"optional"… */
const yesNo = (value: unknown): boolean | undefined => {
  if (typeof value === 'boolean') return value
  if (value === 1 || value === 0) return value === 1
  const said = text(value).toLowerCase()
  if (/^(true|yes|y|1|required|mandatory)$/.test(said)) return true
  if (/^(false|no|n|0|optional|none)$/.test(said)) return false
  return undefined
}
/** Each name under each of the places Seeds may group time-entry settings. */
const under = (groups: string[], names: string[]) => groups.flatMap(group => names.map(name => `${group}${name}`))
const RULE_GROUPS = [
  '',
  'timeEntry.',
  'time_entry.',
  'timeEntryRequirements.',
  'time_entry_requirements.',
  'timeEntryRules.',
  'timeEntrySettings.',
  'requirements.',
]
const DEFAULT_GROUPS = ['timeEntryDefaults.', 'time_entry_defaults.', 'timeEntry.', 'time_entry.', 'defaults.']
/** Seeds' own shape: `timeEntryRequirements: { task, parent, client, product, remarks }`, each true or false. */
const REQUIREMENT_GROUPS = ['timeEntryRequirements.', 'time_entry_requirements.', 'requirements.']
const ruleOf = (record: any, names: string[], short?: string) => {
  const keys = [...(short ? under(REQUIREMENT_GROUPS, [short]) : []), ...under(RULE_GROUPS, names)]
  for (const key of keys) {
    const value = yesNo(key.split('.').reduce((at: any, part) => (at == null ? undefined : at[part]), record))
    if (value !== undefined) return value
  }
  return undefined
}
const defaultIdOf = (record: any, thing: 'product' | 'task') => {
  const Thing = thing === 'product' ? 'Product' : 'Task'
  return idOf(
    record,
    `default${Thing}Id`,
    `default_${thing}_id`,
    `default${Thing}.id`,
    ...under(DEFAULT_GROUPS, [`${thing}Id`, `${thing}_id`, `${thing}.id`, `default${Thing}Id`, `default_${thing}_id`]),
  )
}

/** Other names a requirement may go by, besides Seeds' own short ones. */
const PRODUCT_RULE = [
  'productRequired',
  'product_required',
  'requiresProduct',
  'requires_product',
  'requireProduct',
  'isProductRequired',
  'is_product_required',
]
const TASK_RULE = [
  'taskRequired',
  'task_required',
  'requiresTask',
  'requires_task',
  'requireTask',
  'isTaskRequired',
  'is_task_required',
]
const REMARKS_RULE = [
  'remarksRequired',
  'remarks_required',
  'requiresRemarks',
  'requires_remarks',
  'requireRemarks',
  'isRemarksRequired',
]

/** What a time entry on this project must carry, and what it starts with, when Seeds says. */
export function timeRulesOf(record: any): SeedsTimeRules | undefined {
  const rules: SeedsTimeRules = {}
  const product = ruleOf(record, PRODUCT_RULE, 'product')
  const task = ruleOf(record, TASK_RULE, 'task')
  const remarks = ruleOf(record, REMARKS_RULE, 'remarks')
  const parent = ruleOf(record, ['parentRequired', 'parent_required', 'requiresParent'], 'parent')
  if (product !== undefined) rules.productRequired = product
  if (task !== undefined) rules.taskRequired = task
  if (remarks !== undefined) rules.remarksRequired = remarks
  if (parent !== undefined) rules.parentRequired = parent
  const defaultProductId = defaultIdOf(record, 'product')
  const defaultTaskId = defaultIdOf(record, 'task')
  if (defaultProductId) rules.defaultProductId = defaultProductId
  if (defaultTaskId) rules.defaultTaskId = defaultTaskId
  const defaultParentId = idOf(record, 'timeEntryDefaults.parentId', 'time_entry_defaults.parent_id', 'defaultParentId')
  if (defaultParentId) rules.defaultParentId = defaultParentId
  return Object.keys(rules).length ? rules : undefined
}

export const parseSeeds = {
  person: (record: any) => {
    // Seeds /users returns identity at the top level and employee details inside
    // an Employee array (capital E).
    const employeeValue = record?.Employee ?? record?.employee
    const employee = Array.isArray(employeeValue) ? employeeValue[0] : employeeValue
    const details = employee && typeof employee === 'object' ? employee : record
    return {
      id:
        idOf(record, 'userId', 'user_id', 'id', 'employeeId', 'employee_id') ||
        idOf(details, 'userId', 'user_id', 'id', 'employeeId', 'employee_id'),
      name: fullName(details) || fullName(record),
      email: emailOf(record) || emailOf(details),
      title: text(
        pick(
          details,
          'currentRole',
          'position',
          'jobTitle',
          'job_title',
          'title',
          'designation',
          'role',
          'role.name',
          'roleName',
        ),
      ),
    }
  },
  /** A Seeds parent: the customer company, which is this app's client. */
  parent: (record: any) => ({
    id: idOf(record, 'parentId', 'parent_id', 'id'),
    name: text(
      pick(record, 'name', 'parentName', 'parent_name', 'companyName', 'company_name', 'clientName', 'client_name'),
    ),
    ...(archived(record) ? { archived: true } : {}),
  }),
  /** A Seeds client, read only for the parent it belongs to. */
  client: (record: any) => ({
    id: idOf(record, 'clientId', 'client_id', 'id'),
    parentId: text(pick(record, 'parentId', 'parent_id', 'parent.id')),
  }),
  /** `clientId` here is the Seeds parent (this app's client); `seedsClientId` is Seeds' own client, if any. */
  project: (record: any) => {
    const timeRules = timeRulesOf(record)
    const parentName = text(pick(record, 'parent.name', 'parentName', 'parent_name', 'parent.parentName'))
    return {
      id: idOf(record, 'projectId', 'project_id', 'id'),
      clientId: idOf(record, 'parentId', 'parent_id', 'parent.id'),
      seedsClientId: idOf(record, 'clientId', 'client_id', 'client.id'),
      name: text(pick(record, 'name', 'projectName', 'project_name', 'title')),
      // The contract number, or Seeds' contract reference when a project has no number.
      contractNumber: text(
        pick(
          record,
          'contractNumber',
          'contract_number',
          'contractNo',
          'contract_no',
          'contract.contractNumber',
          'contract.number',
          'contract.contractNo',
          'contractReference',
          'contract_reference',
          'contractRef',
          'contract_ref',
          'contract.reference',
          'contract.referenceNumber',
        ),
      ),
      ...(idOf(record, 'productId', 'product_id', 'product.id')
        ? { productId: idOf(record, 'productId', 'product_id', 'product.id') }
        : {}),
      ...(timeRules ? { timeRules } : {}),
      ...(parentName ? { parentName } : {}),
      ...(archived(record) ? { archived: true } : {}),
      ...(changedAt(record) ? { changedAt: changedAt(record) } : {}),
    }
  },
  task: (record: any, projectId: string) => {
    const rules = timeRulesOf(record)
    return {
      id: idOf(record, 'taskId', 'task_id', 'id'),
      projectId,
      name: text(pick(record, 'name', 'taskName', 'task_name', 'title', 'description')),
      ...(rules?.productRequired ? { productRequired: true } : {}),
      ...(rules?.defaultProductId ? { defaultProductId: rules.defaultProductId } : {}),
      ...(archived(record) ? { archived: true } : {}),
    }
  },
  /** A Seeds product (GET /products). */
  product: (record: any) => ({
    id: idOf(record, 'productId', 'product_id', 'id'),
    name: text(pick(record, 'name', 'productName', 'product_name', 'title', 'description', 'code')),
    ...(archived(record) ? { archived: true } : {}),
  }),
  /** A member names the person by user id (or carries their email) and their role on the project. */
  member: (record: any) => ({
    personId: idOf(record, 'userId', 'user_id', 'user.id', 'employeeId', 'employee_id', 'memberId', 'member_id', 'id'),
    email: emailOf(record),
    role: text(
      pick(
        record,
        'role',
        'roleName',
        'role_name',
        'role.name',
        'projectRole',
        'project_role',
        // Seeds members carry the person's organizational role (no separate project role).
        'organizationalRole',
        'organizational_role',
        'organizationalRole.name',
        'organizationRole',
        'organization_role',
        'orgRole',
        'org_role',
        'position',
        'designation',
        'title',
      ),
    ).slice(0, 60),
  }),
}

/** Only public https addresses: the server sends its token there, so it must not reach the server's own network. */
export function cleanSeedsBaseUrl(value: unknown) {
  let url: URL
  try {
    url = new URL(text(value))
  } catch {
    throw new SeedsError('SEEDS_API_URL must be an https:// address.', 500)
  }
  const host = url.hostname.toLowerCase()
  const privateHost =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    /^\d+\.\d+\.\d+\.\d+$/.test(host) ||
    host.includes(':')
  if (url.protocol !== 'https:' || privateHost || url.username || url.password)
    throw new SeedsError('SEEDS_API_URL must be an https:// address with a public host name.', 500)
  url.hash = ''
  url.search = ''
  return url.toString().replace(/\/+$/, '')
}

/** The rows and the next cursor of one answer, wherever Seeds puts them. */
function page(body: any) {
  const data = body?.data
  const rows = Array.isArray(data)
    ? data
    : Array.isArray(data?.items)
      ? data.items
      : Array.isArray(data?.results)
        ? data.results
        : Array.isArray(data?.records)
          ? data.records
          : Array.isArray(data?.rows)
            ? data.rows
            : null
  return { rows, next: nextCursorOf(body) }
}

/** Where an answer can say there is another page: a cursor field, or a link to the next page that carries one. */
export function nextCursorOf(body: any) {
  const data = body?.data
  const holders = [body, body?.meta, body?.pagination, body?.meta?.pagination, body?.paging, data, data?.meta]
  for (const holder of holders) {
    const found = text(holder?.nextCursor ?? holder?.next_cursor ?? holder?.cursor?.next ?? holder?.cursors?.after)
    if (found) return found
  }
  for (const link of [body?.links?.next, body?.meta?.links?.next, body?.next, body?.pagination?.next]) {
    if (typeof link !== 'string' || !link.includes('cursor=')) continue
    try {
      const cursor = new URL(link, 'https://seeds.invalid').searchParams.get('cursor')
      if (cursor) return cursor
    } catch {
      /* Not a link. */
    }
  }
  return ''
}

/** The names in an answer, never its values: `success, data, meta{nextCursor, total}`. To see how Seeds pages. */
export function answerShape(body: any) {
  if (!body || typeof body !== 'object') return typeof body
  return Object.keys(body)
    .slice(0, 12)
    .map(key => {
      const value = body[key]
      return value && typeof value === 'object' && !Array.isArray(value) && key !== 'data'
        ? `${key}{${Object.keys(value).slice(0, 12).join(', ')}}`
        : key
    })
    .join(', ')
}

/** The latest change time among Seeds' records, by Seeds' clock. */
const latest = (projects: { changedAt?: string }[]) => {
  const times = projects.map(project => Date.parse(project.changedAt || '')).filter(Number.isFinite)
  return times.length ? new Date(Math.max(...times)).toISOString() : undefined
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** Where a sync is, for the Seeds card: which step, and how far through it. */
export type SeedsProgress = { step: 'lists' | 'members' | 'tasks'; done: number; total: number }

export type SeedsReadOptions = {
  /** The least time between two requests to Seeds; it grows when Seeds says to slow down. */
  gapMs?: number
  /** How many times to wait and try again when Seeds says to slow down (429). */
  retries?: number
  onProgress?: (progress: SeedsProgress) => void
  /** Replaced in tests so they do not wait. */
  sleep?: (ms: number) => Promise<unknown>
}

/**
 * Seeds limits how fast an app may read (429 Too Many Requests). One request at a time, a short gap between them,
 * and when Seeds says to slow down: wait as long as it asks (or longer each time), widen the gap, and carry on.
 */
export function httpSeedsSource(
  token: string,
  baseUrl = DEFAULT_SEEDS_URL,
  request: typeof fetch = fetch,
  timeoutMs = 20000,
  options: SeedsReadOptions = {},
): SeedsSource {
  const base = cleanSeedsBaseUrl(baseUrl)
  const sleep = options.sleep || wait
  const retries = options.retries ?? 6
  let gap = options.gapMs ?? SEEDS_GAP_MS
  let lastStart = 0
  const progress = options.onProgress || (() => {})

  async function get(path: string, what: string, query: Record<string, string> = {}): Promise<any> {
    const url = new URL(`${base}${path}`)
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
    for (let attempt = 0; ; attempt++) {
      const due = lastStart + gap - Date.now()
      if (due > 0) await sleep(due)
      lastStart = Date.now()
      let response: Response
      try {
        response = await request(url.toString(), {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch {
        throw new SeedsError('Seeds could not be reached. The last synced access stays in place.')
      }
      if (response.status === 429 && attempt < retries) {
        const seconds = Number(response.headers.get('retry-after'))
        const backoff = Math.min(5000 * 2 ** attempt, 60000)
        gap = Math.min(Math.max(gap * 2, 500), 6000)
        await sleep(Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 120000) : backoff)
        continue
      }
      const body: any = await response.json().catch(() => null)
      if (response.ok) {
        if (body == null) throw new SeedsError(`Seeds sent something other than JSON for ${what}.`)
        return body
      }
      const said = text(body?.error?.message).slice(0, 200)
      const ref = text(body?.error?.requestId)
      const detail = `${said ? ` Seeds said: ${said}` : ''}${ref ? ` (request ${ref})` : ''}`
      if (response.status === 401)
        throw new SeedsError(`Seeds did not accept the application token.${detail} Check SEEDS_API_TOKEN.`, 502)
      if (response.status === 403)
        throw new SeedsError(`The Seeds token is not allowed to read ${what}.${detail} Ask a SEEDS Admin.`, 502)
      if (response.status === 429)
        throw new SeedsError(
          'Seeds kept saying the app reads too fast, even after slowing down. The next sync (in 10 minutes) tries again; ask the SEEDS Admin about the app’s rate limit if it keeps happening.',
        )
      throw new SeedsError(`Seeds answered ${response.status} for ${what}.${detail}`)
    }
  }

  // How each list of the current sync was paged (see readAll).
  let paging: string[] = []

  /** A list the token may not be allowed to read: none instead of an error. */
  async function readAllIfAllowed(path: string, what: string) {
    try {
      return await readAll(path, what)
    } catch (error) {
      if (error instanceof SeedsError && /not allowed|answered 404/.test(error.message)) return []
      throw error
    }
  }

  async function readAll(path: string, what: string, query: Record<string, string> = {}) {
    const records: any[] = []
    let cursor = ''
    let pages = 0
    let last: any = null
    for (let count = 0; count < MAX_PAGES; count++) {
      const body = await get(path, what, { limit: String(PAGE_SIZE), ...query, ...(cursor ? { cursor } : {}) })
      const { rows, next } = page(body)
      if (!rows) throw new SeedsError(`Seeds sent an unexpected answer for ${what}.`)
      records.push(...rows)
      pages++
      last = { body, rows: rows.length }
      if (records.length > MAX_RECORDS) throw new SeedsError(`Seeds sent more ${what} than this app can sync.`)
      if (!next || next === cursor) break
      cursor = next
    }
    // How each list was read, shown in Settings › Integrations › Seeds (Fields Seeds sent › paging). A full last
    // page with no next-page marker this app knows may mean Seeds has more: the answer's names show how it pages.
    const full = last && last.rows >= PAGE_SIZE
    const more = full ? ` (last page full and no next-page marker found; answer: ${answerShape(last.body)})` : ''
    paging.push(`${what}: ${records.length} in ${pages} page${pages === 1 ? '' : 's'}${more}`)
    return records
  }

  async function readOne(path: string, what: string) {
    const { rows } = page(await get(path, what))
    if (!rows) throw new SeedsError(`Seeds sent an unexpected answer for ${what}.`)
    return rows
  }

  /**
   * One project's members or tasks. If Seeds turns down that one project (400/404, say an id it does not accept),
   * it is skipped and counted rather than stopping the whole sync.
   */
  async function readForProject(id: string, list: 'members' | 'tasks', skipped: string[]) {
    if (!pathId(id)) {
      skipped.push(id)
      return null
    }
    try {
      return await readOne(`/projects/${encodeURIComponent(id)}/${list}`, `project ${list}`)
    } catch (error) {
      if (error instanceof SeedsError && /answered (400|404|422)/.test(error.message)) {
        skipped.push(id)
        return null
      }
      throw error
    }
  }

  /** One record by id (a project, parent or client), or nothing when Seeds does not have it or will not show it. */
  async function readRecord(path: string, what: string) {
    try {
      const body = await get(path, what)
      const record = body?.data ?? body
      return record && typeof record === 'object' && !Array.isArray(record) ? record : null
    } catch (error) {
      if (error instanceof SeedsError && /not allowed|answered (400|404|422)/.test(error.message)) return null
      throw error
    }
  }
  const readProject = (id: string) => readRecord(`/projects/${encodeURIComponent(id)}`, 'project')

  return {
    async read(emails, delta, linked) {
      // The field names Seeds sent so far, kept on a failure too, so the mapping can be checked either way.
      const fields: SeedsFields = {}
      const note = (key: keyof SeedsFields, rows: any[]) => {
        if (rows.length) fields[key] = fieldNames(rows)
      }
      paging = []
      const withPaging = <T extends { fields: SeedsFields }>(result: T): T =>
        paging.length ? { ...result, fields: { ...result.fields, paging: [...paging] } } : result
      try {
        if (delta && Number.isFinite(Date.parse(delta.since))) {
          const changes = await readChanges(emails, fields, note, delta)
          if (changes) return withPaging(changes)
        }
        return withPaging(await readEverything(emails, fields, note, linked))
      } catch (error) {
        if (error instanceof SeedsError) error.fields = paging.length ? { ...fields, paging: [...paging] } : fields
        throw error
      }
    },
  }

  /** Members, then tasks for projects someone in `emails` is on: what both kinds of sync read per project. */
  async function readMembersAndTasks<Project extends { id: string }>(
    projects: Project[],
    emails: Set<string>,
    people: { emailById: Map<string, string>; titleById: Map<string, string> },
    note: (key: keyof SeedsFields, rows: any[]) => void,
    skipped: string[],
  ) {
    const rawMembers: any[] = []
    const membersByProject: { project: Project; members: ReturnType<typeof parseSeeds.member>[] }[] = []
    for (const [index, project] of projects.entries()) {
      progress({ step: 'members', done: index, total: projects.length })
      const rows = await readForProject(project.id, 'members', skipped)
      if (!rows) continue
      if (rawMembers.length < 5) note('members', [...rawMembers, ...rows.slice(0, 5)])
      rawMembers.push(...rows.slice(0, 5))
      membersByProject.push({ project, members: rows.map(parseSeeds.member) })
    }
    const assignments: SeedsSnapshot['assignments'] = []
    const wantedProjects: typeof projects = []
    for (const { project, members } of membersByProject) {
      let wanted = false
      for (const member of members) {
        // Seeds members carry their email; older answers gave only a user id, found in /users.
        const email = member.email || people.emailById.get(member.personId) || ''
        if (!email || !emails.has(email)) continue
        wanted = true
        // No role on the member: fall back to the person's title, then "Member" (map it in Settings › Roles).
        const role = member.role || people.titleById.get(member.personId) || 'Member'
        assignments.push({ personId: member.personId, email, role, projectId: project.id })
      }
      if (wanted) wantedProjects.push(project)
    }

    const rawTasks: any[] = []
    const taskLists: ReturnType<typeof parseSeeds.task>[][] = []
    for (const [index, project] of wantedProjects.entries()) {
      progress({ step: 'tasks', done: index, total: wantedProjects.length })
      const rows = await readForProject(project.id, 'tasks', skipped)
      if (!rows) continue
      rawTasks.push(...rows.slice(0, 5))
      taskLists.push(rows.map(row => parseSeeds.task(row, project.id)))
    }
    return {
      assignments,
      tasks: taskLists.flat().filter(task => task.id && task.name),
      checked: membersByProject.length,
      rawMembers,
      rawTasks,
    }
  }

  /**
   * A delta read: `GET /projects?updatedSince=` gives the projects Seeds created, changed (including their members
   * or tasks) or deleted since then. Only those are read further; /users, /parents and /statuses are not read at all
   * (members carry email and role; projects carry status, contract and product). Answers null when Seeds turns down
   * `updatedSince`, so the caller reads everything instead.
   */
  async function readChanges(
    emails: Set<string>,
    fields: SeedsFields,
    note: (key: keyof SeedsFields, rows: any[]) => void,
    delta: SeedsDeltaPlan,
  ): Promise<SeedsRead | null> {
    progress({ step: 'lists', done: 0, total: 1 })
    let rawProjects: any[]
    try {
      rawProjects = await readAll('/projects', 'projects', { updatedSince: new Date(delta.since).toISOString() })
    } catch (error) {
      if (error instanceof SeedsError && /answered (400|422)/.test(error.message)) return null
      throw error
    }
    note('projects', rawProjects)
    progress({ step: 'lists', done: 1, total: 1 })
    // A deleted project may come back with little more than its id: keep it, so it is closed here.
    const parsed = rawProjects.map(parseProject).filter(project => project.id && (project.name || project.archived))

    // Parents of changed projects: named on the project, already linked here, or read by id (once each).
    const clients = new Map<string, { id: string; name: string; archived?: boolean }>()
    for (const project of parsed)
      if (project.clientId && project.parentName)
        clients.set(project.clientId, { id: project.clientId, name: project.parentName })
    const parentOfClient = new Map<string, string>()
    for (const project of parsed) {
      if (project.clientId || !project.seedsClientId || !pathId(project.seedsClientId)) continue
      if (parentOfClient.has(project.seedsClientId)) continue
      const record = await readRecord(`/clients/${encodeURIComponent(project.seedsClientId)}`, 'client')
      parentOfClient.set(project.seedsClientId, record ? parseSeeds.client(record).parentId : '')
    }
    const projects = parsed.map(({ seedsClientId, parentName: _name, ...project }) => ({
      ...project,
      clientId: project.clientId || parentOfClient.get(seedsClientId) || '',
    }))
    const wanted = new Set(
      projects
        .filter(project => !project.archived && project.clientId)
        .map(project => project.clientId)
        .filter(id => !clients.has(id) && !delta.parents?.has(id) && pathId(id)),
    )
    for (const id of wanted) {
      const record = await readRecord(`/parents/${encodeURIComponent(id)}`, 'parent')
      const parent = record ? parseSeeds.parent(record) : null
      if (parent?.id && parent.name) clients.set(parent.id, parent)
    }

    const skipped: string[] = []
    const open = projects.filter(project => !project.archived)
    const read = await readMembersAndTasks(open, emails, { emailById: new Map(), titleById: new Map() }, note, skipped)
    // A change that names a product not known here (on the project, its defaults or a task): read the list again.
    const named = [
      ...projects.flatMap(project => [project.productId, project.timeRules?.defaultProductId]),
      ...read.tasks.map(task => task.defaultProductId),
    ].filter((id): id is string => Boolean(id))
    const products =
      !delta.products?.size || named.some(id => !delta.products?.has(id))
        ? (await readAllIfAllowed('/products', 'products')).map(parseSeeds.product)
        : undefined
    return {
      mode: 'delta',
      snapshot: {
        people: [],
        clients: [...clients.values()],
        projects: projects.map(({ changedAt: _changed, ...project }) => project),
        tasks: read.tasks,
        assignments: read.assignments,
        ...(products ? { products: products.filter(product => product.id && product.name) } : {}),
      },
      projectIds: projects.map(project => project.id),
      checked: read.checked,
      watermark: latest(projects),
      fields: {
        ...fields,
        ...(read.rawMembers.length ? { members: fieldNames(read.rawMembers) } : {}),
        ...(read.rawTasks.length ? { tasks: fieldNames(read.rawTasks) } : {}),
      },
      skipped: [...new Set(skipped)],
    }
  }

  async function readEverything(
    emails: Set<string>,
    fields: SeedsFields,
    note: (key: keyof SeedsFields, rows: any[]) => void,
    linked?: Set<string>,
  ): Promise<SeedsRead> {
    progress({ step: 'lists', done: 0, total: 3 })
    const rawUsers = await readAll('/users', 'users')
    note('users', rawUsers)
    progress({ step: 'lists', done: 1, total: 3 })
    const rawParents = await readAll('/parents', 'parents')
    note('parents', rawParents)
    progress({ step: 'lists', done: 2, total: 3 })
    const rawProjects = await readAll('/projects', 'projects')
    note('projects', rawProjects)
    progress({ step: 'lists', done: 3, total: 3 })
    const people = rawUsers.map(parseSeeds.person).filter(person => person.id)
    const emailById = new Map(people.map(person => [person.id, person.email]))
    const titleById = new Map(people.map(person => [person.id, person.title]))
    // Projects that give only a status id: name it from /statuses (when the token may read it) to tell closed ones.
    const statusIds = rawProjects.some(record => !statusOf(record) && statusIdOf(record))
    const statusNames = statusIds
      ? new Map(
          (await readAllIfAllowed('/statuses', 'statuses')).map(row => [
            idOf(row, 'statusId', 'status_id', 'id'),
            text(pick(row, 'name', 'statusName', 'status_name', 'label', 'description')),
          ]),
        )
      : new Map<string, string>()
    const withStatus = (record: any) => {
      const project = parseSeeds.project(record)
      const named = statusNames.get(statusIdOf(record))
      return named && closedStatus(named) ? { ...project, archived: true as const } : project
    }
    const parsed = rawProjects.map(withStatus).filter(project => project.id && project.name)
    // Seeds may leave finished projects out of its list. A project linked here that is missing from it is asked for
    // by id, so one completed or closed in Seeds is marked closed here instead of staying open.
    const listed = new Set(parsed.map(project => project.id))
    for (const id of [...(linked || [])].filter(id => pathId(id) && !listed.has(id))) {
      const record = await readProject(id)
      const project = record ? withStatus(record) : null
      if (project?.archived && project.id === id && project.name) parsed.push(project)
    }
    // Projects that name a Seeds client but not its parent: look the parent up through /clients.
    const rawClients = parsed.some(project => !project.clientId && project.seedsClientId)
      ? await readAllIfAllowed('/clients', 'clients')
      : []
    const parentOfClient = new Map(
      rawClients.map(parseSeeds.client).map(client => [client.id, client.parentId] as const),
    )
    const projects = parsed.map(({ seedsClientId, parentName: _name, ...project }) => ({
      ...project,
      clientId: project.clientId || parentOfClient.get(seedsClientId) || '',
    }))
    const clients = rawParents.map(parseSeeds.parent).filter(client => client.id && client.name)
    // Seeds' product list (core.products.read): what tasks pick a product from. Without the grant, none.
    const rawProducts = await readAllIfAllowed('/products', 'products')
    note('products', rawProducts)

    const skipped: string[] = []
    const read = await readMembersAndTasks(
      projects.filter(project => !project.archived),
      emails,
      { emailById, titleById },
      note,
      skipped,
    )
    return {
      mode: 'full',
      snapshot: {
        people,
        clients,
        projects: projects.map(({ changedAt: _changed, ...project }) => project),
        tasks: read.tasks,
        assignments: read.assignments,
        products: rawProducts.map(parseSeeds.product).filter(product => product.id && product.name),
      },
      projectIds: projects.map(project => project.id),
      checked: read.checked,
      watermark: latest(projects),
      fields: {
        ...fields,
        ...(rawClients.length ? { clients: fieldNames(rawClients) } : {}),
        members: fieldNames(read.rawMembers),
        tasks: fieldNames(read.rawTasks),
      },
      skipped: [...new Set(skipped)],
    }
  }
}

const parseProject = (record: any) => parseSeeds.project(record)
