import type { Client, Project, WorkItem, PlannerActivity, ActivityLog, TaskSettings } from '../../shared/types'
import { isWaitingOnDone, waitingOnOptions } from './waitingOn'
export type LifecycleStore = {
  clients: Client[]
  projects: Project[]
  items: WorkItem[]
  planner?: PlannerActivity[]
  activity?: ActivityLog[]
  taskSettings: TaskSettings
}
export type LifecycleActor = { role: string; modules: string[]; accountType?: string }
export class LifecycleError extends Error {
  constructor(
    message: string,
    public status = 409,
  ) {
    super(message)
  }
}
export const isArchived = (record?: { archived?: boolean }) => record?.archived === true
export const isWorkDone = (item: WorkItem, settings: TaskSettings) =>
  settings.statuses.find(s => s.label === item.status)?.closed ??
  ['Resolved', 'Closed', 'Completed', 'Done'].includes(item.status)
/** Completed the way the task list counts it: a closed status, or waiting on the completion option. */
export const isTaskFinished = (item: WorkItem, settings: TaskSettings) =>
  isWorkDone(item, settings) || isWaitingOnDone(item.waitingOn, settings)
/** Subtasks of a task that are not finished yet. */
export const openSubtasksOf = (items: WorkItem[], taskId: string, settings: TaskSettings) =>
  items.filter(item => item.parentTaskId === taskId && !isTaskFinished(item, settings))
/** Archived itself, or a subtask of an archived task. Archived work is hidden from Tasks until it is reopened. */
export function isTaskArchived(items: WorkItem[], item: WorkItem) {
  if (isArchived(item)) return true
  const parent = item.parentTaskId ? items.find(other => other.id === item.parentTaskId) : undefined
  return isArchived(parent)
}
/** Why a task cannot be archived yet; empty when it can. */
export function taskArchiveBlockers(items: WorkItem[], item: WorkItem, settings: TaskSettings): string[] {
  if (item.parentTaskId) return ['Archive the parent task; its subtasks are archived with it.']
  const blockers: string[] = []
  if (!isWorkDone(item, settings)) blockers.push('Close or resolve the task first.')
  const open = openSubtasksOf(items, item.id, settings)
  if (open.length)
    blockers.push(
      `Complete ${open.length} open subtask${open.length === 1 ? '' : 's'}: ${open
        .slice(0, 3)
        .map(t => t.title)
        .join(', ')}.`,
    )
  return blockers
}
export const stableRecord = (value: unknown): string =>
  JSON.stringify(value, (_key, entry) =>
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.keys(entry)
            .sort()
            .map(k => [k, entry[k]]),
        )
      : entry,
  )

// Include older subtasks that inherit their client/project through a parent.
export function workContext(
  state: LifecycleStore,
  item: { clientId?: string; projectId?: string; parentTaskId?: string },
) {
  let clientId = item.clientId,
    projectId = item.projectId,
    parentId = item.parentTaskId
  const seen = new Set<string>()
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId)
    const parent = state.items.find(t => t.id === parentId)
    if (!parent) break
    clientId = parent.clientId || clientId
    projectId = parent.projectId || projectId
    parentId = parent.parentTaskId
  }
  return { clientId, projectId }
}
export function archivedWorkReason(
  state: LifecycleStore,
  item: { clientId?: string; projectId?: string; parentTaskId?: string },
): string {
  let target: { clientId?: string; projectId?: string; parentTaskId?: string } | undefined = item
  const seen = new Set<string>()
  while (target) {
    const client = state.clients.find(c => c.id === target!.clientId),
      project = state.projects.find(p => p.id === target!.projectId)
    if (isArchived(client)) return `Activate client “${client!.name}” before changing its work.`
    if (isArchived(project)) return `Activate project “${project!.name}” before changing its work.`
    const parentId: string | undefined = target.parentTaskId
    if (!parentId || seen.has(parentId)) break
    seen.add(parentId)
    target = state.items.find(t => t.id === parentId)
    // A subtask of an archived task is archived with it.
    if (target && isArchived(target as WorkItem))
      return `Reopen task “${(target as WorkItem).title}” before changing its work.`
  }
  return ''
}

/**
 * True when a task changed only because the account's workflow changed: its status or waiting-on name now points
 * at the renamed (or, for a removed status, the replacement) entry, and it is exactly as done as before.
 */
function relabeledOnly(current: LifecycleStore, next: LifecycleStore, old: WorkItem, row: WorkItem) {
  if (stableRecord(current.taskSettings) === stableRecord(next.taskSettings)) return false
  const rest = (item: WorkItem) => stableRecord({ ...item, status: undefined, waitingOn: undefined })
  if (rest(old) !== rest(row)) return false
  const statusId = (store: LifecycleStore, label: string) =>
    store.taskSettings?.statuses?.find(status => status.label === label)?.id
  const statusFollows =
    old.status === row.status ||
    statusId(current, old.status) === statusId(next, row.status) ||
    statusId(next, old.status) === undefined
  const waitingId = (store: LifecycleStore, label: unknown) =>
    waitingOnOptions(store.taskSettings).find(option => option.label === label)?.id
  const waitingFollows =
    old.waitingOn === row.waitingOn || waitingId(current, old.waitingOn) === waitingId(next, row.waitingOn)
  return statusFollows && waitingFollows && isWorkDone(old, current.taskSettings) === isWorkDone(row, next.taskSettings)
}

/**
 * Task rules checked on every save, in the browser and on the server:
 * a task closes only when its subtasks are finished; only a closed task with finished subtasks is archived;
 * an archived task (and its subtasks) changes only by being reopened (unarchived).
 */
function assertTaskLifecycle(current: LifecycleStore, next: LifecycleStore, old?: WorkItem, row?: WorkItem) {
  if (row && row.archived !== undefined && typeof row.archived !== 'boolean')
    throw new LifecycleError('Archive state must be true or false.', 400)
  if (old && isArchived(old)) {
    // Reopening (archived → not archived) is the only change an archived task accepts.
    if (!row) throw new LifecycleError(`Reopen task “${old.title}” before deleting it.`)
    if (isArchived(row)) throw new LifecycleError(`Reopen task “${old.title}” before changing it.`)
  }
  if (!row) return
  const closing = isWorkDone(row, next.taskSettings) && !(old && isWorkDone(old, current.taskSettings))
  if (closing) {
    const open = openSubtasksOf(next.items, row.id, next.taskSettings)
    if (open.length)
      throw new LifecycleError(
        `Complete the ${open.length} open subtask${open.length === 1 ? '' : 's'} of “${row.title}” before closing it.`,
      )
  }
  if (isArchived(row) && !isArchived(old)) {
    const blockers = taskArchiveBlockers(next.items, row, next.taskSettings)
    if (blockers.length) throw new LifecycleError(`“${row.title}” cannot be archived yet. ${blockers.join(' ')}`)
  }
}

export function archiveBlockers(state: LifecycleStore, kind: 'clients' | 'projects', id: string): string[] {
  const record = state[kind].find(r => r.id === id)
  if (!record) return ['Record was not found.']
  const work = state.items.filter(t => workContext(state, t)[kind === 'clients' ? 'clientId' : 'projectId'] === id)
  const blockers: string[] = []
  if (record.status !== 'Closed') blockers.push(`Mark this ${kind === 'clients' ? 'client' : 'project'} Closed first.`)
  const open = work.filter(t => !isWorkDone(t, state.taskSettings))
  if (open.length)
    blockers.push(
      `Complete ${open.length} task(s)/subtask(s): ${open
        .slice(0, 3)
        .map(t => t.title)
        .join(', ')}.`,
    )
  const other = kind === 'projects' ? 'clients' : 'projects'
  const ids = new Set(
    work.map(t => workContext(state, t)[kind === 'projects' ? 'clientId' : 'projectId']).filter(Boolean),
  )
  const incomplete = [...ids].filter(id => state[other].find(r => r.id === id)?.status !== 'Closed')
  if (incomplete.length)
    blockers.push(
      `Mark linked ${other} Closed: ${incomplete.map(id => state[other].find(r => r.id === id)?.name || 'Unknown record').join(', ')}.`,
    )
  return blockers
}
const version = (r: { lifecycleVersion?: number }) => r.lifecycleVersion ?? 0
const metadata = (r: Client | Project) => ({ ...r, archived: isArchived(r), lifecycleVersion: undefined })

/** Shared browser validation and final server save gate. */
export function assertLifecycleMutation(current: LifecycleStore, next: LifecycleStore, actor?: LifecycleActor | null) {
  for (const kind of ['clients', 'projects'] as const) {
    if (!Array.isArray(next[kind]) || !Array.isArray(next.items))
      throw new LifecycleError('Clients, projects, and tasks must be arrays.', 400)
    const ids = new Set<string>()
    for (const row of next[kind]) {
      if (!row || typeof row.id !== 'string' || !row.id || ids.has(row.id))
        throw new LifecycleError(`Invalid or duplicate ${kind} ID.`, 400)
      ids.add(row.id)
      if (row.archived !== undefined && typeof row.archived !== 'boolean')
        throw new LifecycleError('Archive state must be true or false.', 400)
      if (!Number.isSafeInteger(version(row)) || version(row) < 0)
        throw new LifecycleError('Invalid record version.', 400)
    }
    for (const old of current[kind])
      if (!ids.has(old.id))
        throw new LifecycleError(
          `${kind === 'clients' ? 'Clients' : 'Projects'} cannot be deleted. Archive the record instead.`,
        )
    for (const row of next[kind]) {
      const old = current[kind].find(r => r.id === row.id)
      const changed = !old || stableRecord(metadata(old)) !== stableRecord(metadata(row))
      if (old && version(row) !== version(old) + (changed ? 1 : 0))
        throw new LifecycleError('This client or project changed in another session. Reload before saving.')
      if (!changed) continue
      if (actor && (actor.accountType === 'platform' || actor.role === 'Viewer' || !actor.modules.includes(kind)))
        throw new LifecycleError(`${kind === 'clients' ? 'Client' : 'Project'} edit access is required.`, 403)
      if (old && kind === 'clients' && row.name !== old.name && actor?.role !== 'Administrator')
        throw new LifecycleError('Only an Administrator can rename a client.', 403)
      if (typeof row.name !== 'string' || !row.name.trim() || row.name.length > 200)
        throw new LifecycleError('Use a name between 1 and 200 characters.', 400)
      const statuses =
        kind === 'clients' ? ['Active', 'Closing', 'Closed'] : ['Discovery', 'Active', 'UAT', 'Closing', 'Closed']
      if (!statuses.includes(row.status)) throw new LifecycleError('Choose a valid completion status.', 400)
      if (isArchived(row) && !isArchived(old)) {
        // Deleting or reassigning unfinished work in the same save cannot bypass completion.
        const blockers = [...archiveBlockers(current, kind, row.id), ...archiveBlockers(next, kind, row.id)]
        if (blockers.length) throw new LifecycleError([...new Set(blockers)].join(' '))
      }
      if (isArchived(row) && row.status !== 'Closed')
        throw new LifecycleError('Archived records must remain Closed. Activate the record first.')
      if (row.status === 'Closed' && old?.status !== 'Closed') {
        const open = next.items.filter(
          t =>
            workContext(next, t)[kind === 'clients' ? 'clientId' : 'projectId'] === row.id &&
            !isWorkDone(t, next.taskSettings),
        )
        if (open.length)
          throw new LifecycleError(`Complete all ${open.length} task(s)/subtask(s) before marking this record Closed.`)
      }
    }
  }
  for (const key of ['items', 'planner', 'activity'] as const) {
    const oldMap = new Map<string, WorkItem | PlannerActivity | ActivityLog>(
        (current[key] || []).map(row => [row.id, row]),
      ),
      newMap = new Map<string, WorkItem | PlannerActivity | ActivityLog>((next[key] || []).map(row => [row.id, row]))
    for (const id of new Set([...oldMap.keys(), ...newMap.keys()])) {
      const old = oldMap.get(id),
        row = newMap.get(id)
      if (stableRecord(old) === stableRecord(row)) continue
      // Remote signing history may arrive after a client/project was archived.
      // Only the trusted server actor may append signing metadata to otherwise unchanged work.
      if (!actor && key === 'items' && old && row) {
        const strip = (item: any) => ({ ...item, comments: undefined, docHubDocuments: undefined })
        if (stableRecord(strip(old)) === stableRecord(strip(row))) continue
      }
      // An account renaming or merging statuses relabels tasks, archived ones included; that is not a task change.
      if (key === 'items' && old && row && relabeledOnly(current, next, old as WorkItem, row as WorkItem)) continue
      const reason = (old && archivedWorkReason(current, old)) || (row && archivedWorkReason(next, row))
      if (reason) throw new LifecycleError(reason)
      if (key === 'items') assertTaskLifecycle(current, next, old as WorkItem | undefined, row as WorkItem | undefined)
      if (row && key !== 'activity') {
        const ctx = workContext(next, row)
        if (key === 'items' && 'parentTaskId' in row && row.parentTaskId) {
          const parent = next.items.find(t => t.id === row.parentTaskId)
          if (!parent || parent.id === row.id || parent.parentTaskId)
            throw new LifecycleError('Select an existing parent task.', 400)
          if ((row.clientId && row.clientId !== ctx.clientId) || (row.projectId && row.projectId !== ctx.projectId))
            throw new LifecycleError('A subtask must use its parent client and project.', 400)
        }
        if (ctx.clientId && !next.clients.some(c => c.id === ctx.clientId))
          throw new LifecycleError('Select an existing client.', 400)
        if (ctx.projectId && !next.projects.some(p => p.id === ctx.projectId))
          throw new LifecycleError('Select an existing project.', 400)
      }
    }
  }
  for (const project of next.projects.filter(isArchived)) {
    const blockers = archiveBlockers(next, 'projects', project.id)
    if (blockers.length) throw new LifecycleError(`Activate project “${project.name}” first. ${blockers.join(' ')}`)
  }
}
