/**
 * Tasks made or changed from trackers, opening the task editor and subtask creator, subtask order, and turning
 * inquiries into tasks.
 */
import { businessDateKey } from '../../shared/businessDate'
import { trackerApi, type TaskLink } from '../../features/trackers/trackerApi'
import type { TaskDraft } from '../../features/trackers/TrackerWork'
import { seedsTaskNamed } from '../../shared/seeds'
import { type TaskPatch, applyTaskPatches } from '../../features/trackers/trackerTasks'
import { rememberTrackerRow } from '../../features/trackers/trackerNav'
import { isArchived, archivedWorkReason } from '../../features/tasks/lifecycle'
import { useCallback, useEffect } from 'react'
import { waitForCloudSaves } from '../cloudStore'
import { defaultWaitingOn, doneWaitingOn } from '../../features/tasks/waitingOn'
import type { WorkItem, Project } from '../../shared/types'
import { isTaskClosed, defaultOpenTaskStatus, defaultClosedTaskStatus } from '../store'
import type { UiState } from './useUiState'
import type { WorkspaceSave } from './useWorkspaceSave'
import type { SignIn } from './useSignIn'

export function useTrackerTasks(ui: UiState, saving: WorkspaceSave, signIn: SignIn) {
  const {
    store,
    view,
    setTrackerLinks,
    setSelectedClientId,
    setSelectedProjectId,
    setView,
    storeRef,
    cloudStatus,
    setEditingTaskId,
    setModal,
    setTaskPreset,
    today,
  } = ui
  const { persist } = saving
  const { currentUser, canWriteTasks, hasModule } = signIn
  // Task pickers across the app (email, documents, DocHub, Git tickets) offer only open work, by this account's statuses.
  const closedStatus = useCallback((status: string) => isTaskClosed(status, store.taskSettings), [store.taskSettings])
  const hasTrackers = Boolean(currentUser?.modules.includes('trackers'))
  // Tasks linked from a tracker say so in the Action Center. Without the Trackers module, or before its links table exists, there is simply nothing to show.
  useEffect(() => {
    if (view !== 'action' || !hasTrackers) return
    const controller = new AbortController()
    trackerApi
      .allLinks(controller.signal)
      .then(result => setTrackerLinks(result.links))
      .catch(() => {
        if (!controller.signal.aborted) setTrackerLinks([])
      })
    return () => controller.abort()
  }, [view, hasTrackers, currentUser?.id, setTrackerLinks])
  const openTrackerLink = (link: TaskLink) => {
    rememberTrackerRow(link.trackerId, link.rowId)
    setSelectedClientId(null)
    setSelectedProjectId(null)
    setView('trackers')
  }
  // Trackers create tasks and subtasks from their cells. They are added to the workspace like any other task, and the
  // tracker links them only after the save reaches the server, which checks that a linked task exists.
  const createTrackerTasks = async (drafts: TaskDraft[]): Promise<WorkItem[]> => {
    if (!canWriteTasks || !hasModule('items')) throw new Error('Your role cannot create tasks.')
    const current = storeRef.current
    const today = businessDateKey()
    // New projects first: one per name, reusing an existing project with the same name.
    const projects = [...current.projects],
      addedProjects: Project[] = []
    const projectFor = (draft: TaskDraft) => {
      const name = (draft.newProjectName || '').trim().slice(0, 120)
      if (!name) return draft.projectId || undefined
      const found = projects.find(
        project => project.name.trim().toLowerCase() === name.toLowerCase() && !isArchived(project),
      )
      if (found) return found.id
      const project: Project = {
        id: crypto.randomUUID(),
        name,
        status: 'Active',
        targetDate: '',
        summary: 'Created from a tracker.',
      }
      projects.push(project)
      addedProjects.push(project)
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
        id: crypto.randomUUID(),
        clientId,
        projectId,
        parentTaskId: parent?.id,
        subtaskOrder: order,
        title: draft.title.trim().slice(0, 200) || 'Untitled',
        type: 'Task',
        priority: 'Medium',
        status: defaultOpenTaskStatus(current.taskSettings),
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
    const created = new Map(made.map(item => [item.id, item]))
    const titleOf = (id?: string) =>
      made.find(item => item.id === id)?.title || current.items.find(item => item.id === id)?.title || 'a task'
    const activity = made.map(item => ({
      id: crypto.randomUUID(),
      clientId: item.clientId,
      projectId: item.projectId,
      date: today,
      text: item.parentTaskId
        ? `Created subtask under ${titleOf(item.parentTaskId)} from a tracker: ${item.title}`
        : `Created task from a tracker: ${item.title}`,
    }))
    if (
      persist({
        ...current,
        projects,
        items: [...made, ...current.items],
        activity: [...activity, ...current.activity],
      }) === false
    )
      throw new Error('The tasks could not be created.')
    if (cloudStatus !== 'local') await waitForCloudSaves()
    void addedProjects
    return made.map(item => storeRef.current.items.find(saved => saved.id === item.id) || created.get(item.id)!)
  }
  /**
   * Changes from a project timeline tracker: titles, start and due dates, the phase a subtask sits under, and done or
   * reopened. Phase tasks are rolled up from their subtasks (see trackerTasks). Returns false when nothing could be saved.
   */
  const updateTrackerTasks = async (patches: TaskPatch[]): Promise<boolean> => {
    if (!canWriteTasks || !hasModule('items') || !patches.length) return false
    const current = storeRef.current
    const today = businessDateKey()
    const closedStatus = defaultClosedTaskStatus(current.taskSettings)
    const { items, changed } = applyTaskPatches(
      current.items.filter(item => !archivedWorkReason(current, item)),
      patches,
      {
        isClosed: status => isTaskClosed(status, current.taskSettings),
        close: () => ({
          status: closedStatus,
          waitingOn: doneWaitingOn(current.taskSettings),
          followUpDate: '',
          resolvedDate: today,
        }),
        open: () => ({
          status: defaultOpenTaskStatus(current.taskSettings),
          waitingOn: defaultWaitingOn(current.taskSettings),
          resolvedDate: undefined,
        }),
      },
    )
    if (!changed.length) return true
    const updated = new Map(items.map(item => [item.id, item]))
    const activity = changed
      .filter(entry => entry.done !== undefined)
      .map(entry => ({
        id: crypto.randomUUID(),
        clientId: entry.item.clientId,
        projectId: entry.item.projectId,
        date: today,
        text: `${entry.done ? 'Completed' : 'Reopened'} ${entry.item.parentTaskId ? 'subtask' : 'task'} from a tracker: ${entry.item.title}`,
      }))
    if (
      persist({
        ...current,
        items: current.items.map(item => updated.get(item.id) || item),
        activity: [...activity, ...current.activity],
      }) === false
    )
      return false
    if (cloudStatus !== 'local') await waitForCloudSaves()
    return true
  }
  const openTaskEditor = (id: string) => {
    if (!canWriteTasks) return
    const target = store.items.find(item => item.id === id)
    if (target && archivedWorkReason(store, target)) {
      window.alert(archivedWorkReason(store, target))
      return
    }
    setEditingTaskId(id)
    setModal('taskEdit')
  }

  const openSubtaskCreator = (parentTaskId: string) => {
    if (!canWriteTasks) return
    const parent = store.items.find(item => item.id === parentTaskId)
    if (!parent || parent.parentTaskId) return
    if (archivedWorkReason(store, parent)) {
      window.alert(archivedWorkReason(store, parent))
      return
    }
    setTaskPreset({ clientId: parent.clientId, projectId: parent.projectId, type: 'Task', parentTaskId: parent.id })
    setModal('item')
  }

  const reorderSubtasks = (parentTaskId: string, orderedIds: string[]) => {
    if (!canWriteTasks || !orderedIds.length) return
    const valid = new Set(store.items.filter(item => item.parentTaskId === parentTaskId).map(item => item.id))
    const normalizedIds = orderedIds.filter(id => valid.has(id))
    if (normalizedIds.length !== valid.size) return
    const orderMap = new Map(normalizedIds.map((id, index) => [id, index]))
    persist({
      ...store,
      items: store.items.map(item =>
        item.parentTaskId === parentTaskId
          ? { ...item, subtaskOrder: orderMap.get(item.id) ?? item.subtaskOrder }
          : item,
      ),
    })
  }

  const convertInquiry = (id: string, type: 'Requirement' | 'Issue') => {
    if (!canWriteTasks) return
    const target = store.items.find(item => item.id === id)
    if (!target) return
    persist({
      ...store,
      items: store.items.map(item => (item.id === id ? { ...item, type } : item)),
      activity: [
        {
          id: crypto.randomUUID(),
          clientId: target.clientId,
          projectId: target.projectId,
          date: today,
          text: `Inquiry converted to ${type.toLowerCase()}: ${target.title}`,
        },
        ...store.activity,
      ],
    })
  }

  return {
    closedStatus,
    convertInquiry,
    createTrackerTasks,
    updateTrackerTasks,
    openSubtaskCreator,
    openTaskEditor,
    openTrackerLink,
    reorderSubtasks,
  }
}

export type TrackerTasks = ReturnType<typeof useTrackerTasks>
