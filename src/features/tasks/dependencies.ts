/**
 * Task dependencies: a task (or subtask) can be blocked by other tasks. Stored on the blocked task as `blockedBy`
 * (task ids). They show where the work is (the task editor, the table, the board, the Timeline) and change nothing
 * else: statuses, closing and Waiting on work exactly as before.
 *
 * Rules: no task blocks itself, no loops (A blocked by B blocked by A), at most MAX_BLOCKERS, and ids of deleted
 * tasks are ignored wherever they are read.
 */
import { isTaskClosed } from '../../app/store'
import type { TaskSettings, WorkItem } from '../../shared/types'

export const MAX_BLOCKERS = 20

/** The task ids a task says block it, as stored (strings only, once each). */
export function blockerIds(item: Pick<WorkItem, 'blockedBy'> | undefined): string[] {
  const raw = item?.blockedBy
  if (!Array.isArray(raw)) return []
  return [...new Set(raw.filter((id): id is string => typeof id === 'string' && Boolean(id)))]
}

const index = (items: readonly WorkItem[]) => new Map(items.map(item => [item.id, item]))

/** The tasks that block this one and still exist. */
export function blockersOf(item: WorkItem, items: readonly WorkItem[], byId = index(items)): WorkItem[] {
  return blockerIds(item)
    .map(id => byId.get(id))
    .filter((blocker): blocker is WorkItem => Boolean(blocker))
}

/** Blockers that are not closed yet: the ones still holding this task up. */
export function openBlockersOf(
  item: WorkItem,
  items: readonly WorkItem[],
  settings: TaskSettings,
  byId = index(items),
): WorkItem[] {
  return blockersOf(item, items, byId).filter(blocker => !isTaskClosed(blocker.status, settings))
}

/** The tasks this one blocks. */
export function blockedBy(taskId: string, items: readonly WorkItem[]): WorkItem[] {
  return items.filter(item => blockerIds(item).includes(taskId))
}

/** Whether making `candidateId` block `taskId` would close a loop (the candidate already waits on the task). */
export function createsLoop(taskId: string, candidateId: string, items: readonly WorkItem[], byId = index(items)) {
  if (taskId === candidateId) return true
  const seen = new Set<string>()
  const stack = [candidateId]
  while (stack.length) {
    const id = stack.pop() as string
    if (id === taskId) return true
    if (seen.has(id)) continue
    seen.add(id)
    stack.push(...blockerIds(byId.get(id)))
  }
  return false
}

/** Blockers to save for a task: existing tasks, once each, not itself, no loops, at most MAX_BLOCKERS. */
export function cleanBlockers(taskId: string, ids: readonly string[], items: readonly WorkItem[]): string[] {
  const byId = index(items)
  const kept: string[] = []
  for (const id of new Set(ids)) {
    if (kept.length >= MAX_BLOCKERS) break
    if (!byId.has(id) || id === taskId) continue
    // Check against the other tasks as saved plus this task's blockers kept so far.
    const task = byId.get(taskId)
    const withTask = task ? new Map(byId).set(taskId, { ...task, blockedBy: kept }) : byId
    if (createsLoop(taskId, id, items, withTask)) continue
    kept.push(id)
  }
  return kept
}

/** Tasks that may be added as blockers: not itself, not already chosen, not ones that would make a loop. */
export function blockerChoices(task: WorkItem, chosen: readonly string[], items: readonly WorkItem[]): WorkItem[] {
  const byId = new Map(index(items)).set(task.id, { ...task, blockedBy: [...chosen] })
  const taken = new Set(chosen)
  return items.filter(
    candidate => candidate.id !== task.id && !taken.has(candidate.id) && !createsLoop(task.id, candidate.id, items, byId),
  )
}

/** Every dependency among these tasks, as blocker -> blocked pairs (for the Timeline's arrows). */
export function dependencyLinks(items: readonly WorkItem[]): { from: string; to: string }[] {
  const shown = new Set(items.map(item => item.id))
  return items.flatMap(item =>
    blockerIds(item)
      .filter(id => shown.has(id))
      .map(id => ({ from: id, to: item.id })),
  )
}

/** A short line for a blocked task: "Blocked by Login API" or "Blocked by 3 tasks" ('' when nothing is open). */
export function blockedText(open: readonly WorkItem[]) {
  if (!open.length) return ''
  return open.length === 1 ? `Blocked by ${open[0].title}` : `Blocked by ${open.length} tasks`
}
