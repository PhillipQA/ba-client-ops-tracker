/**
 * Tasks and subtasks a tracker asks for, made into workspace records. Shared by the app (a person's tracker edit, see
 * createTrackerTasks in app/state/useTrackerTasks) and the server (rows added for new Seeds projects, see
 * server/trackers/tracker-seeds-rows), so both make the same records. Pure: ids and today's date are passed in.
 */
import { seedsTaskNamed } from '../../shared/seeds'
import type { Client, Project, TaskSettings, UserAccount, WorkItem } from '../../shared/types'
import { archivedWorkReason, isArchived } from '../tasks/lifecycle'
import { defaultWaitingOn } from '../tasks/waitingOn'
import type { TaskDraft } from './TrackerWork'

type Workspace = {
  clients: Client[]
  projects: Project[]
  items: WorkItem[]
  accounts: Pick<UserAccount, 'id' | 'name'>[]
  taskSettings: TaskSettings
}
export type TrackerTaskActivity = { id: string; clientId?: string; projectId?: string; date: string; text: string }

/**
 * The records for `drafts`, in order. Throws (with a message for the person) when a draft has no client, names a
 * missing client or parent, or puts a subtask before its task. Projects named by `newProjectName` are made once each,
 * reusing an open project of the same name.
 */
export function tasksFromDrafts(
  current: Workspace,
  drafts: TaskDraft[],
  options: { today: string; newId: () => string },
): { projects: Project[]; made: WorkItem[]; activity: TrackerTaskActivity[] } {
  const { today, newId } = options
  const projects = [...current.projects]
  const projectFor = (draft: TaskDraft) => {
    const name = (draft.newProjectName || '').trim().slice(0, 120)
    if (!name) return draft.projectId || undefined
    const found = projects.find(
      project => project.name.trim().toLowerCase() === name.toLowerCase() && !isArchived(project),
    )
    if (found) return found.id
    const project: Project = {
      id: newId(),
      name,
      status: 'Active',
      targetDate: '',
      summary: 'Created from a tracker.',
    }
    projects.push(project)
    return project.id
  }
  // Under a Seeds project, a task or subtask gets its Seeds task: the one chosen, else the one named like it (a
  // tracker's "GO LIVE" step becomes a GO LIVE subtask). Without either, a subtask follows its task's.
  const seedsTaskFor = (draft: TaskDraft, projectId?: string) => {
    const seedsTasks = projects.find(project => project.id === projectId)?.seedsTasks
    if (!seedsTasks?.length) return {}
    const chosen =
      draft.seedsTaskId && seedsTasks.some(task => task.id === draft.seedsTaskId) ? draft.seedsTaskId : undefined
    const seedsTaskId = chosen || seedsTaskNamed(seedsTasks, draft.title)
    return seedsTaskId ? { seedsTaskId } : {}
  }
  const openStatus = current.taskSettings.statuses.find(status => !status.closed)?.label || 'Open'
  const nextOrder = new Map<string, number>()
  const made: WorkItem[] = []
  drafts.forEach((draft, index) => {
    const batchParent = draft.parentIndex !== undefined ? made[draft.parentIndex] : undefined
    if (draft.parentIndex !== undefined && (!batchParent || draft.parentIndex >= index || batchParent.parentTaskId))
      throw new Error('A subtask must come after its task in the list.')
    const parent =
      batchParent || (draft.parentTaskId ? current.items.find(item => item.id === draft.parentTaskId) : undefined)
    if (draft.parentTaskId && !batchParent && (!parent || parent.parentTaskId))
      throw new Error('The parent task was not found.')
    if (parent && !batchParent && archivedWorkReason(current, parent))
      throw new Error(archivedWorkReason(current, parent) || 'The parent task is archived.')
    const clientId = parent ? parent.clientId : draft.clientId || undefined
    if (!clientId) throw new Error('Choose the client for the task.')
    if (!current.clients.some(client => client.id === clientId)) throw new Error('That client was not found.')
    let order: number | undefined
    if (parent) {
      const base =
        nextOrder.get(parent.id) ??
        Math.max(
          -1,
          ...current.items.filter(item => item.parentTaskId === parent.id).map(item => item.subtaskOrder ?? -1),
        ) + 1
      order = base
      nextOrder.set(parent.id, base + 1)
    }
    const assignee =
      parent?.assignedToUserId ||
      (draft.assignedToUserId && current.accounts.some(account => account.id === draft.assignedToUserId)
        ? draft.assignedToUserId
        : undefined)
    const isoDate = (value?: string) => (value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : '')
    const projectId = parent ? parent.projectId : projectFor(draft)
    made.push({
      id: newId(),
      clientId,
      projectId,
      parentTaskId: parent?.id,
      subtaskOrder: order,
      title: draft.title.trim().slice(0, 200) || 'Untitled',
      type: 'Task',
      priority: 'Medium',
      status: openStatus,
      waitingOn: defaultWaitingOn(current.taskSettings),
      assignedToUserId: assignee,
      assignmentInherited: parent?.assignedToUserId ? true : undefined,
      owner: parent?.owner || current.accounts.find(account => account.id === assignee)?.name || '',
      dateRaised: today,
      startDate: isoDate(draft.startDate),
      dueDate: isoDate(draft.dueDate),
      followUpDate: '',
      description: (draft.description || '').slice(0, 2000),
      resolution: '',
      source: 'Internal',
      qaResult: 'Not Run',
      ...seedsTaskFor(draft, projectId),
    })
  })
  const titleOf = (id?: string) =>
    made.find(item => item.id === id)?.title || current.items.find(item => item.id === id)?.title || 'a task'
  const activity = made.map(item => ({
    id: newId(),
    clientId: item.clientId,
    projectId: item.projectId,
    date: today,
    text: item.parentTaskId
      ? `Created subtask under ${titleOf(item.parentTaskId)} from a tracker: ${item.title}`
      : `Created task from a tracker: ${item.title}`,
  }))
  return { projects, made, activity }
}
