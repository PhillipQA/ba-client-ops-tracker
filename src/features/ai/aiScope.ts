/**
 * What the AI assistant looks at: one or more clients, and for each client all its projects or only some of them.
 * Used by the assistant screen and by the server, which reads the same choice from the request.
 */

export type AiScope = { clientIds: string[]; projectIds: string[] }

export const NO_SCOPE: AiScope = { clientIds: [], projectIds: [] }
/** The most clients one question can be about. */
export const AI_SCOPE_CLIENTS = 20

type ProjectLike = { id: string; clientId?: string }
type Placed = { clientId?: string; projectId?: string }

const ids = (value: unknown): string[] =>
  Array.isArray(value)
    ? [
        ...new Set(
          value
            .map(entry => (entry && typeof entry === 'object' ? (entry as { id?: unknown }).id : entry))
            .filter((id): id is string => typeof id === 'string' && id.trim() !== '')
            .map(id => id.trim()),
        ),
      ]
    : []

/**
 * The client each project belongs to. Older projects have no client of their own: they take the client of their
 * tasks, when all their tasks share one.
 */
export function projectClients(projects: readonly ProjectLike[], items: readonly Placed[] = []) {
  const owner = new Map<string, string>()
  const fromTasks = new Map<string, Set<string>>()
  for (const item of items)
    if (item.projectId && item.clientId)
      fromTasks.set(item.projectId, (fromTasks.get(item.projectId) || new Set()).add(item.clientId))
  for (const project of projects) {
    const seen = fromTasks.get(project.id)
    const client = project.clientId || (seen?.size === 1 ? [...seen][0] : '')
    if (client) owner.set(project.id, client)
  }
  return owner
}

/** The projects of one client, in the order given. */
export const projectsOfClient = <P extends ProjectLike>(
  clientId: string,
  projects: readonly P[],
  owner: Map<string, string>,
) => projects.filter(project => owner.get(project.id) === clientId)

/**
 * The scope a request asks for: `clients` and `projects` (ids or records), or the older single `client` and `project`.
 * Projects are kept only under a chosen client; a project chosen on its own brings its client in.
 */
export function requestedScope(requested: any, owner?: Map<string, string>): AiScope {
  let clientIds = ids(requested?.clients ?? requested?.clientIds)
  let projectIds = ids(requested?.projects ?? requested?.projectIds)
  if (!clientIds.length && !projectIds.length) {
    clientIds = ids([requested?.client?.id ?? requested?.clientId])
    projectIds = ids([requested?.project?.id ?? requested?.projectId])
  }
  return cleanScope({ clientIds, projectIds }, owner)
}

/** Drops projects whose client is not chosen, adding the client of a project chosen without one. */
export function cleanScope(scope: AiScope, owner?: Map<string, string>): AiScope {
  const clientIds = [...new Set(scope.clientIds)].slice(0, AI_SCOPE_CLIENTS)
  if (!owner) return { clientIds, projectIds: [...new Set(scope.projectIds)] }
  for (const id of scope.projectIds) {
    const client = owner.get(id)
    if (client && !clientIds.includes(client) && clientIds.length < AI_SCOPE_CLIENTS) clientIds.push(client)
  }
  const projectIds = [...new Set(scope.projectIds)].filter(id => {
    const client = owner.get(id)
    return !client || clientIds.includes(client)
  })
  return { clientIds, projectIds }
}

/**
 * Whether a task, activity or event is in scope. Nothing chosen: everything. Otherwise its client must be chosen, and
 * when some of that client's projects are chosen, its project must be one of them.
 */
export function inScope(scope: AiScope, owner: Map<string, string>) {
  if (!scope.clientIds.length && !scope.projectIds.length) return (_entry: Placed) => true
  const clients = new Set(scope.clientIds)
  const projects = new Set(scope.projectIds)
  // Clients with some projects chosen: only those projects count for them.
  const narrowed = new Set(scope.projectIds.map(id => owner.get(id)).filter((id): id is string => Boolean(id)))
  return (entry: Placed) => {
    if (entry.projectId && projects.has(entry.projectId)) return true
    const client = entry.clientId || (entry.projectId ? owner.get(entry.projectId) : '') || ''
    return clients.has(client) && !narrowed.has(client)
  }
}

/**
 * The one client (and its one project) chosen, for actions that place a single new task. Empty when several clients
 * are chosen, since a new task cannot be placed under all of them.
 */
export const singleOf = (scope: AiScope) => {
  const clientId = scope.clientIds.length === 1 ? scope.clientIds[0] : ''
  return { clientId, projectId: clientId && scope.projectIds.length === 1 ? scope.projectIds[0] : '' }
}

/** The key a conversation is kept under. One client and one project give the same key as before. */
export function scopeKey(userId: string, scope: AiScope) {
  const part = (list: string[], none: string) => (list.length ? [...list].sort().join('+') : none)
  return `${userId}:${part(scope.clientIds, 'global')}:${part(scope.projectIds, 'all')}`
}
