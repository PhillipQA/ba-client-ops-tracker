import type { WorkItem } from './types'

type TaskName = Pick<WorkItem, 'title' | 'clientId' | 'projectId'>
type ExistingTask = TaskName & Pick<WorkItem, 'id' | 'type' | 'parentTaskId'>

const normalizedTitle = (title: string) => title.trim().replace(/\s+/g, ' ').toLowerCase()

/** Task names are unique within the selected client/project, independently of the source email. */
export function findCommunicationTaskDuplicate<T extends ExistingTask>(items: readonly T[], draft: TaskName): T | undefined {
  const title = normalizedTitle(draft.title)
  if (!title || !draft.clientId || !draft.projectId) return undefined
  return items.find(item => item.type === 'Task' && !item.parentTaskId && item.clientId === draft.clientId && item.projectId === draft.projectId && normalizedTitle(item.title) === title)
}
