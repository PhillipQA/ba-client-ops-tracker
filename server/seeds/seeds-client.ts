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

export interface SeedsSource {
  /** Everything one account sync needs. Tasks are read only for projects where someone in `emails` is a member. */
  read(emails: Set<string>): Promise<{ snapshot: SeedsSnapshot; fields: SeedsFields }>
}

export class SeedsError extends Error {
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
const text = (value: unknown) => (value == null ? '' : String(value).trim())
const pick = (record: any, ...keys: string[]) => {
  for (const key of keys) {
    const value = key.split('.').reduce((at: any, part) => (at == null ? undefined : at[part]), record)
    if (value != null && value !== '' && typeof value !== 'object') return value
  }
  return undefined
}
const archived = (record: any) =>
  record?.archived === true ||
  record?.isArchived === true ||
  record?.is_archived === true ||
  record?.active === false ||
  record?.isActive === false ||
  record?.is_active === false ||
  record?.deletedAt != null ||
  record?.deleted_at != null ||
  ['archived', 'inactive', 'closed', 'cancelled', 'canceled', 'completed', 'done'].includes(
    text(pick(record, 'status', 'status.name', 'statusName', 'status_name')).toLowerCase(),
  )
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
  person: (record: any) => ({
    id: text(pick(record, 'id', 'userId', 'user_id', 'employeeId', 'employee_id')),
    name: fullName(record),
    email: emailOf(record),
    title: text(
      pick(record, 'position', 'jobTitle', 'job_title', 'title', 'designation', 'role', 'role.name', 'roleName'),
    ),
  }),
  /** A Seeds parent: the customer company, which is this app's client. */
  parent: (record: any) => ({
    id: text(pick(record, 'id', 'parentId', 'parent_id')),
    name: text(
      pick(record, 'name', 'parentName', 'parent_name', 'companyName', 'company_name', 'clientName', 'client_name'),
    ),
    ...(archived(record) ? { archived: true } : {}),
  }),
  /** A Seeds client, read only for the parent it belongs to. */
  client: (record: any) => ({
    id: text(pick(record, 'id', 'clientId', 'client_id')),
    parentId: text(pick(record, 'parentId', 'parent_id', 'parent.id')),
  }),
  /** `clientId` here is the Seeds parent (this app's client); `seedsClientId` is Seeds' own client, if any. */
  project: (record: any) => ({
    id: text(pick(record, 'id', 'projectId', 'project_id')),
    clientId: text(pick(record, 'parentId', 'parent_id', 'parent.id')),
    seedsClientId: text(pick(record, 'clientId', 'client_id', 'client.id')),
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
  }),
  task: (record: any, projectId: string) => ({
    id: text(pick(record, 'id', 'taskId', 'task_id')),
    projectId,
    name: text(pick(record, 'name', 'taskName', 'task_name', 'title', 'description')),
    ...(archived(record) ? { archived: true } : {}),
  }),
  /** A member names the person by user id (or carries their email) and their role on the project. */
  member: (record: any) => ({
    personId: text(
      pick(record, 'userId', 'user_id', 'user.id', 'employeeId', 'employee_id', 'memberId', 'member_id', 'id'),
    ),
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

  return {
    async read(emails) {
      progress({ step: 'lists', done: 0, total: 3 })
      const rawUsers = await readAll('/users', 'users')
      progress({ step: 'lists', done: 1, total: 3 })
      const rawParents = await readAll('/parents', 'parents')
      progress({ step: 'lists', done: 2, total: 3 })
      const rawProjects = await readAll('/projects', 'projects')
      progress({ step: 'lists', done: 3, total: 3 })
      const people = rawUsers.map(parseSeeds.person).filter(person => person.id)
      const emailById = new Map(people.map(person => [person.id, person.email]))
      const titleById = new Map(people.map(person => [person.id, person.title]))
      const parsed = rawProjects.map(parseSeeds.project).filter(project => project.id && project.name)
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
      const open = projects.filter(project => !project.archived)
      const membersByProject: {
        project: (typeof projects)[number]
        members: ReturnType<typeof parseSeeds.member>[]
      }[] = []
      for (const project of open) {
        progress({ step: 'members', done: membersByProject.length, total: open.length })
        const rows = await readOne(`/projects/${encodeURIComponent(project.id)}/members`, 'project members')
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
      for (const project of wantedProjects) {
        progress({ step: 'tasks', done: taskLists.length, total: wantedProjects.length })
        const rows = await readOne(`/projects/${encodeURIComponent(project.id)}/tasks`, 'project tasks')
        rawTasks.push(...rows.slice(0, 5))
        taskLists.push(rows.map(row => parseSeeds.task(row, project.id)))
      }
      const tasks = taskLists.flat().filter(task => task.id && task.name)

      return {
        snapshot: { people, clients, projects, tasks, assignments },
        fields: {
          users: fieldNames(rawUsers),
          parents: fieldNames(rawParents),
          ...(rawClients.length ? { clients: fieldNames(rawClients) } : {}),
          projects: fieldNames(rawProjects),
          members: fieldNames(rawMembers),
          tasks: fieldNames(rawTasks),
        },
      }
    },
  }
}
