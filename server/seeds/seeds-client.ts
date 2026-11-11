/**
 * Reading Seeds over its Open API (docs/seeds-api.md). Read only.
 *
 * Seeds gives one application token per app (from a SEEDS Admin), not one per person. The token lives only in the
 * server's environment (SEEDS_API_TOKEN) and goes out as `Authorization: Bearer <token>`. The address is
 * SEEDS_API_URL, by default https://seeds.iripple.com/api/v1. One read covers the whole account:
 *
 *   GET /users, /parents, /projects        cursor-paged lists (`limit`, `cursor` → `nextCursor`)
 *   GET /clients                           only to find a project's parent when the project names a client instead
 *   GET /projects/{id}/members             who works on each project, and as what
 *   GET /projects/{id}/tasks               only for projects someone in this app works on
 *
 * A Seeds **parent** (Think Library, Inc.) is this app's client. A Seeds project (named after a store or a title) is
 * this app's project. Seeds tasks (Go Live, Meetings…) are subtask-level activities: a pick-list on subtasks.
 *
 * Every answer is `{ data }`; Seeds does not publish the record fields, so names are read leniently (camelCase or
 * snake_case) and the field names seen are reported back so the mapping can be checked after the first sync.
 */
import type { SeedsSnapshot } from '../../src/shared/seeds'

export const DEFAULT_SEEDS_URL = 'https://seeds.iripple.com/api/v1'

export type SeedsFields = Partial<Record<'users' | 'parents' | 'clients' | 'projects' | 'members' | 'tasks', string[]>>

/**
 * A quick sync: members and tasks are read only for projects that are new (not in `known`), that already have
 * someone from this app (`keep`), or that Seeds shows as created or updated since `since`. Without it, every open
 * project is read (a full sync).
 */
export type SeedsQuickPlan = { since: string; known: Set<string>; keep: Set<string> }

export type SeedsRead = {
  snapshot: SeedsSnapshot
  fields: SeedsFields
  skipped?: string[]
  /** Every Seeds project id seen, for the next quick sync. */
  projectIds?: string[]
  /** Projects whose members were read this time. */
  checked?: number
}

export interface SeedsSource {
  /**
   * Everything one account sync needs. Tasks are read only for projects where someone in `emails` is a member.
   * `linked` are the Seeds ids of this app's projects that are still open: one that Seeds no longer lists is asked
   * for by id, to learn whether it was completed or closed there.
   */
  read(emails: Set<string>, quick?: SeedsQuickPlan, linked?: Set<string>): Promise<SeedsRead>
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
/** How many linked projects missing from Seeds' list a quick sync asks for by id. */
const MISSING_PER_QUICK_SYNC = 25
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
  return values.find(value => /^[1-9]\d*$/.test(value)) || values[0] || ''
}
/** A Seeds id that can go in a path: a whole number of at least 1. */
export const pathId = (id: string) => /^[1-9]\d*$/.test(id)

const archived = (record: any) =>
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

/** The record fields Seeds sent, names only, so the mapping can be checked. */
const fieldNames = (rows: any[]) => [
  ...new Set(rows.slice(0, 5).flatMap(row => (row && typeof row === 'object' ? Object.keys(row) : []))),
]

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
  project: (record: any) => ({
    id: idOf(record, 'projectId', 'project_id', 'id'),
    clientId: idOf(record, 'parentId', 'parent_id', 'parent.id'),
    seedsClientId: idOf(record, 'clientId', 'client_id', 'client.id'),
    name: text(pick(record, 'name', 'projectName', 'project_name', 'title')),
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
      ),
    ),
    ...(text(pick(record, 'productId', 'product_id', 'product.id'))
      ? { productId: text(pick(record, 'productId', 'product_id', 'product.id')) }
      : {}),
    ...(archived(record) ? { archived: true } : {}),
    ...(changedAt(record) ? { changedAt: changedAt(record) } : {}),
  }),
  task: (record: any, projectId: string) => ({
    id: idOf(record, 'taskId', 'task_id', 'id'),
    projectId,
    name: text(pick(record, 'name', 'taskName', 'task_name', 'title', 'description')),
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
  const next = text(
    body?.nextCursor ?? body?.meta?.nextCursor ?? body?.pagination?.nextCursor ?? data?.nextCursor ?? body?.next_cursor,
  )
  return { rows, next }
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
  let gap = options.gapMs ?? 400
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
        gap = Math.min(gap * 2 || 500, 3000)
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
          'Seeds kept saying the app reads too fast, even after slowing down. The next sync (in 30 minutes) tries again; ask the SEEDS Admin about the app’s rate limit if it keeps happening.',
        )
      throw new SeedsError(`Seeds answered ${response.status} for ${what}.${detail}`)
    }
  }

  /** A list the token may not be allowed to read: none instead of an error. */
  async function readAllIfAllowed(path: string, what: string) {
    try {
      return await readAll(path, what)
    } catch (error) {
      if (error instanceof SeedsError && /not allowed|answered 404/.test(error.message)) return []
      throw error
    }
  }

  async function readAll(path: string, what: string) {
    const records: any[] = []
    let cursor = ''
    for (let count = 0; count < MAX_PAGES; count++) {
      const body = await get(path, what, { limit: String(PAGE_SIZE), ...(cursor ? { cursor } : {}) })
      const { rows, next } = page(body)
      if (!rows) throw new SeedsError(`Seeds sent an unexpected answer for ${what}.`)
      records.push(...rows)
      if (records.length > MAX_RECORDS) throw new SeedsError(`Seeds sent more ${what} than this app can sync.`)
      if (!next || next === cursor) break
      cursor = next
    }
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

  /** One project by id, or nothing when Seeds does not have it or will not show it. */
  async function readProject(id: string) {
    try {
      const body = await get(`/projects/${encodeURIComponent(id)}`, 'project')
      const record = body?.data ?? body
      return record && typeof record === 'object' && !Array.isArray(record) ? record : null
    } catch (error) {
      if (error instanceof SeedsError && /not allowed|answered (400|404|422)/.test(error.message)) return null
      throw error
    }
  }

  return {
    async read(emails, quick, linked) {
      // The field names Seeds sent so far, kept on a failure too, so the mapping can be checked either way.
      const fields: SeedsFields = {}
      const note = (key: keyof SeedsFields, rows: any[]) => {
        if (rows.length) fields[key] = fieldNames(rows)
      }
      try {
        return await readEverything(emails, fields, note, quick, linked)
      } catch (error) {
        if (error instanceof SeedsError) error.fields = fields
        throw error
      }
    },
  }

  async function readEverything(
    emails: Set<string>,
    fields: SeedsFields,
    note: (key: keyof SeedsFields, rows: any[]) => void,
    quick?: SeedsQuickPlan,
    linked?: Set<string>,
  ) {
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
    // by id, so one completed or closed in Seeds is marked closed here instead of staying open. A quick sync checks
    // a few; the daily full sync checks them all.
    const listed = new Set(parsed.map(project => project.id))
    const missing = [...(linked || [])].filter(id => pathId(id) && !listed.has(id))
    for (const id of quick ? missing.slice(0, MISSING_PER_QUICK_SYNC) : missing) {
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
    const projects = parsed.map(({ seedsClientId, ...project }) => ({
      ...project,
      clientId: project.clientId || parentOfClient.get(seedsClientId) || '',
    }))
    const clients = rawParents.map(parseSeeds.parent).filter(client => client.id && client.name)

    const rawMembers: any[] = []
    // A quick sync reads members only where something may have changed; a full one reads every open project.
    const since = quick ? Date.parse(quick.since) : Number.NaN
    const open = projects.filter(
      project =>
        !project.archived &&
        (!quick ||
          !quick.known.has(project.id) ||
          quick.keep.has(project.id) ||
          !Number.isFinite(since) ||
          Boolean(project.changedAt && Date.parse(project.changedAt) >= since)),
    )
    const membersByProject: {
      project: (typeof projects)[number]
      members: ReturnType<typeof parseSeeds.member>[]
    }[] = []
    const skipped: string[] = []
    for (const [index, project] of open.entries()) {
      progress({ step: 'members', done: index, total: open.length })
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
        const email = member.email || emailById.get(member.personId) || ''
        if (!email || !emails.has(email)) continue
        wanted = true
        // No role on the project: fall back to the person's title, then "Member" (map it in Settings › Roles).
        const role = member.role || titleById.get(member.personId) || 'Member'
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
    const tasks = taskLists.flat().filter(task => task.id && task.name)

    return {
      snapshot: {
        people,
        clients,
        projects: projects.map(({ changedAt: _changed, ...project }) => project),
        tasks,
        assignments,
      },
      projectIds: projects.map(project => project.id),
      checked: membersByProject.length,
      fields: {
        ...fields,
        ...(rawClients.length ? { clients: fieldNames(rawClients) } : {}),
        members: fieldNames(rawMembers),
        tasks: fieldNames(rawTasks),
      },
      skipped: [...new Set(skipped)],
    }
  }
}
