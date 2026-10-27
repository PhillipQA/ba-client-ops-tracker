import type { WorkItem } from '../../shared/types'

type TaskName = Pick<WorkItem, 'title' | 'clientId' | 'projectId'>
type ExistingTask = TaskName & Pick<WorkItem, 'id' | 'type' | 'parentTaskId'>

const normalizedTitle = (title: string) => title.trim().replace(/\s+/g, ' ').toLowerCase()

/** Task names are unique within the selected client/project, independently of the source email. */
export function findCommunicationTaskDuplicate<T extends ExistingTask>(
  items: readonly T[],
  draft: TaskName,
): T | undefined {
  const title = normalizedTitle(draft.title)
  if (!title || !draft.clientId || !draft.projectId) return undefined
  return items.find(
    item =>
      item.type === 'Task' &&
      !item.parentTaskId &&
      item.clientId === draft.clientId &&
      item.projectId === draft.projectId &&
      normalizedTitle(item.title) === title,
  )
}

type ParentCandidate = ExistingTask & Pick<WorkItem, 'status' | 'archived'> & { subtaskOrder?: number }

/** A subtask of the same name already under this task, if any. */
export function findSubtaskDuplicate<T extends ExistingTask>(items: readonly T[], parentId: string, title: string) {
  const wanted = normalizedTitle(title)
  return items.find(item => item.parentTaskId === parentId && normalizedTitle(item.title) === wanted)
}

/**
 * Why a task cannot take a new subtask from an email, or '' when it can: it must be an open, active top-level task
 * (a closed task would hold an open subtask; an archived one can only be reopened).
 */
export function subtaskParentProblem(parent: ParentCandidate | undefined, isClosed: (status: string) => boolean) {
  if (!parent) return 'That task no longer exists. Choose another task.'
  if (parent.parentTaskId) return 'Choose a task, not a subtask. Subtasks cannot have subtasks.'
  if (parent.archived) return `“${parent.title}” is archived. Reopen it in Tasks first.`
  if (isClosed(parent.status)) return `“${parent.title}” is closed. Reopen it before adding a subtask.`
  return ''
}

/** The order number for a new last subtask. */
export const nextSubtaskOrder = (items: readonly ParentCandidate[], parentId: string) =>
  items.filter(item => item.parentTaskId === parentId).reduce((max, item) => Math.max(max, item.subtaskOrder ?? 0), 0) +
  1
