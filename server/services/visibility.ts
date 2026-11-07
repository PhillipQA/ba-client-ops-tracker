/**
 * Per-person visibility for the APIs that work on one task, tracker or document. GET /api/store filters the whole
 * workspace (services/client-state.ts); these helpers make every other route answer "not found" for work outside the
 * person's clients and projects, so a guessed id reveals nothing. When visibility is off they allow everything.
 */
import { canChangeItem, canSeeItem, scopeFor, type Scope } from '../../src/shared/access'

type Person = { id: string }
const text = (value: unknown) => (value == null ? '' : String(value))

/** The task with this id, if this person may read (or change) it. */
export function visibleTask(state: any, user: Person, taskId: string, mode: 'read' | 'write' = 'read') {
  const items = Array.isArray(state?.items) ? state.items : []
  const task = items.find((candidate: any) => text(candidate?.id) === taskId)
  if (!task) return undefined
  const scope = scopeFor(state, user.id)
  return (mode === 'write' ? canChangeItem(scope, taskId) : canSeeItem(scope, taskId)) ? task : undefined
}

/** Ids of the tasks this person may see, or null when visibility is off and every task is visible. */
export function visibleTaskIds(state: any, user: Person): Set<string> | null {
  const scope = scopeFor(state, user.id)
  return scope.all ? null : scope.visibleItems
}

/** May this person create work on this client, project or parent task? */
export function canCreateWork(
  state: any,
  user: Person,
  target: { clientId?: unknown; projectId?: unknown; parentTaskId?: unknown },
  scope: Scope = scopeFor(state, user.id),
) {
  if (scope.all) return true
  const parentTaskId = text(target.parentTaskId)
  if (parentTaskId) return canChangeItem(scope, parentTaskId)
  const clientId = text(target.clientId)
  const projectId = text(target.projectId)
  if (!clientId && !projectId) return true
  return (
    (Boolean(projectId) && scope.writeProjects.has(projectId)) ||
    (Boolean(clientId) && scope.writeClients.has(clientId))
  )
}

/** May this person see a record that belongs to one or more clients (a tracker, a document)? */
export function canSeeClients(state: any, user: Person, clientIds: unknown[], scope: Scope = scopeFor(state, user.id)) {
  if (scope.all) return true
  const ids = clientIds.map(text).filter(Boolean)
  return ids.length > 0 && ids.every(id => scope.fullClients.has(id))
}
