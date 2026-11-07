/**
 * Reading Seeds over HTTP. Read only: this app never writes to Seeds in this phase.
 *
 * The base URL comes from Settings › Integrations › Seeds; each person's own API key from the Seeds page. Each list is
 * read from `<base>/<resource>` (clients, projects, tasks, assignments, and if Seeds has them, people and `me`, who
 * the key belongs to) with `Authorization: Bearer <key>`. Responses may be a bare list or
 * `{ data: [...] }` with an optional `next` link; field names are read leniently (camelCase or snake_case) so the
 * mapping can be confirmed against Seeds' API documentation without touching the sync.
 */
import type { SeedsRole } from '../../src/shared/access'
import type { SeedsSnapshot } from '../../src/shared/seeds'

export interface SeedsSource {
  snapshot(): Promise<SeedsSnapshot>
}

export class SeedsError extends Error {
  constructor(
    message: string,
    public status = 502,
  ) {
    super(message)
  }
}

const MAX_PAGES = 50
const MAX_RECORDS = 20000
const text = (value: unknown) => (value == null ? '' : String(value).trim())
const pick = (record: any, ...keys: string[]) => {
  for (const key of keys) {
    const value = key.split('.').reduce((at: any, part) => (at == null ? undefined : at[part]), record)
    if (value != null && value !== '') return value
  }
  return undefined
}
const archived = (record: any) =>
  record?.archived === true ||
  record?.is_archived === true ||
  record?.isArchived === true ||
  ['archived', 'inactive', 'closed'].includes(text(record?.status).toLowerCase())

/** The role title as Seeds gives it; the sync maps it to a job role (Settings › Roles › Seeds titles). */
export function seedsRole(value: unknown): SeedsRole | null {
  const title = text(value).slice(0, 60)
  return title || null
}

const person = (record: any) => ({
  id: text(pick(record, 'id', 'person_id', 'personId', 'user_id', 'userId')),
  name: text(pick(record, 'name', 'full_name', 'fullName', 'display_name')),
  email: text(pick(record, 'email', 'email_address', 'emailAddress', 'work_email')),
})

type Lists = 'people' | 'clients' | 'projects' | 'tasks' | 'assignments'

/** Turns Seeds' raw lists into the snapshot the sync reads. Records without an id or name are skipped. */
export function parseSeedsSnapshot(raw: Record<Lists, any[]> & { me?: any }): SeedsSnapshot {
  const me = raw.me ? person(raw.me?.data ?? raw.me?.user ?? raw.me) : undefined
  const people = raw.people.map(person).filter(entry => entry.id && entry.email)
  const clients = raw.clients
    .map(record => ({
      id: text(pick(record, 'id', 'client_id', 'clientId')),
      name: text(pick(record, 'name', 'client_name', 'clientName')),
      ...(archived(record) ? { archived: true } : {}),
    }))
    .filter(client => client.id && client.name)
  const projects = raw.projects
    .map(record => ({
      id: text(pick(record, 'id', 'project_id', 'projectId')),
      clientId: text(pick(record, 'client_id', 'clientId', 'client.id')),
      name: text(pick(record, 'name', 'project_name', 'projectName')),
      contractNumber: text(
        pick(record, 'contract_number', 'contractNumber', 'contract_no', 'contractNo', 'contract.number'),
      ),
      ...(archived(record) ? { archived: true } : {}),
    }))
    .filter(project => project.id && project.name)
  const tasks = raw.tasks
    .map(record => ({
      id: text(pick(record, 'id', 'task_id', 'taskId')),
      projectId: text(pick(record, 'project_id', 'projectId', 'project.id')),
      name: text(pick(record, 'name', 'title', 'task_name', 'taskName')),
      ...(archived(record) ? { archived: true } : {}),
    }))
    .filter(task => task.id && task.projectId && task.name)
  const assignments = raw.assignments
    .map(record => {
      const role = seedsRole(pick(record, 'role', 'role_code', 'roleCode', 'position'))
      const projectId = text(pick(record, 'project_id', 'projectId', 'project.id'))
      const clientId = text(pick(record, 'client_id', 'clientId', 'client.id'))
      return {
        personId: text(pick(record, 'person_id', 'personId', 'user_id', 'userId', 'person.id')),
        role,
        ...(projectId ? { projectId } : {}),
        ...(clientId ? { clientId } : {}),
      }
    })
    .filter((assignment): assignment is SeedsSnapshot['assignments'][number] =>
      Boolean(assignment.personId && assignment.role && (assignment.projectId || assignment.clientId)),
    )
  return { ...(me?.id ? { me } : {}), people, clients, projects, tasks, assignments }
}

/** Only public https addresses: the server calls this URL, so it must not reach the server's own network. */
export function cleanSeedsBaseUrl(value: unknown) {
  let url: URL
  try {
    url = new URL(text(value))
  } catch {
    throw new SeedsError('Enter the Seeds API address, starting with https://.', 400)
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
    throw new SeedsError('Enter the Seeds API address, starting with https:// and a public host name.', 400)
  url.hash = ''
  url.search = ''
  return url.toString().replace(/\/+$/, '')
}

export function httpSeedsSource(
  baseUrl: string,
  apiKey: string,
  request: typeof fetch = fetch,
  timeoutMs = 20000,
): SeedsSource {
  const base = cleanSeedsBaseUrl(baseUrl)
  async function get(url: string, resource: string, optional: boolean) {
    let response: Response
    try {
      response = await request(url, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch {
      throw new SeedsError('Seeds could not be reached. Your last synced access stays in place.')
    }
    if (response.status === 401 || response.status === 403)
      throw new SeedsError('Seeds did not accept your API key. Check it on the Seeds page › Sync.', 400)
    if (optional && response.status === 404) return null
    if (!response.ok) throw new SeedsError(`Seeds answered ${response.status} for ${resource}. Try again later.`)
    return response.json().catch(() => {
      throw new SeedsError(`Seeds sent something other than JSON for ${resource}.`)
    })
  }
  async function readAll(resource: Lists, optional = false) {
    const records: any[] = []
    let url: string | null = `${base}/${resource}`
    for (let page = 0; url && page < MAX_PAGES; page++) {
      const body: any = await get(url, resource, optional)
      if (body === null) return records
      const rows = Array.isArray(body)
        ? body
        : Array.isArray(body?.data)
          ? body.data
          : Array.isArray(body?.[resource])
            ? body[resource]
            : null
      if (!rows) throw new SeedsError(`Seeds sent an unexpected answer for ${resource}.`)
      records.push(...rows)
      if (records.length > MAX_RECORDS) throw new SeedsError(`Seeds sent more ${resource} than this app can sync.`)
      const next = Array.isArray(body) ? null : text(body?.next || body?.links?.next || body?.meta?.next)
      url = next ? new URL(next, `${base}/`).toString() : null
      if (url && !url.startsWith(`${base}/`)) throw new SeedsError('Seeds pointed to another address. Sync stopped.')
    }
    return records
  }
  return {
    async snapshot() {
      const [me, people, clients, projects, tasks, assignments] = await Promise.all([
        get(`${base}/me`, 'me', true),
        readAll('people', true),
        readAll('clients'),
        readAll('projects'),
        readAll('tasks'),
        readAll('assignments'),
      ])
      return parseSeedsSnapshot({ me, people, clients, projects, tasks, assignments })
    },
  }
}
