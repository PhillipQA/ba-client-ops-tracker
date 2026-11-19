/**
 * Tasks made or changed from trackers, opening the task editor and subtask creator, subtask order, and turning
 * inquiries into tasks.
 */
import { businessDateKey } from '../../shared/businessDate'
import { trackerApi, type TaskLink } from '../../features/trackers/trackerApi'
import type { TaskDraft } from '../../features/trackers/TrackerWork'
import { tasksFromDrafts } from '../../features/trackers/trackerTaskDrafts'
import { type TaskPatch, applyTaskPatches } from '../../features/trackers/trackerTasks'
import { planProjectMove } from '../../features/trackers/trackerProjects'
import { rememberTrackerRow } from '../../features/trackers/trackerNav'
import { archivedWorkReason } from '../../features/tasks/lifecycle'
import { useCallback, useEffect } from 'react'
import { waitForCloudSaves } from '../cloudStore'
import { defaultWaitingOn, doneWaitingOn } from '../../features/tasks/waitingOn'
import type { WorkItem } from '../../shared/types'
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
    const { projects, made, activity } = tasksFromDrafts(current, drafts, {
      today: businessDateKey(),
      newId: () => crypto.randomUUID(),
    })
    const created = new Map(made.map(item => [item.id, item]))
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
  /**
   * A tracker's Project chip or bulk "Set project": moves tasks, with their subtasks, to one of the tracker's projects.
   * Resolves with what moved; throws when the change could not be saved.
   */
  const moveTrackerTasks = async (
    taskIds: string[],
    projectId: string,
  ): Promise<{ tasks: number; subtasks: number; skipped: number }> => {
    if (!canWriteTasks || !hasModule('items')) throw new Error('Your role cannot change tasks.')
    const current = storeRef.current
    const project = current.projects.find(item => item.id === projectId)
    if (!project) throw new Error('That project is no longer in the workspace.')
    const plan = planProjectMove(
      current.items.filter(item => !archivedWorkReason(current, item)),
      taskIds,
      project,
    )
    if (!plan.tasks) return { tasks: 0, subtasks: 0, skipped: plan.skipped }
    const updated = new Map(plan.moved.map(item => [item.id, item]))
    const today = businessDateKey()
    const activity = plan.moved
      .filter(item => !item.parentTaskId)
      .map(item => ({
        id: crypto.randomUUID(),
        clientId: item.clientId,
        projectId: item.projectId,
        date: today,
        text: `Moved task to ${project.name} from a tracker: ${item.title}`,
      }))
    if (
      persist({
        ...current,
        items: current.items.map(item => updated.get(item.id) || item),
        activity: [...activity, ...current.activity],
      }) === false
    )
      throw new Error('You cannot move these tasks to that project.')
    if (cloudStatus !== 'local') await waitForCloudSaves()
    return { tasks: plan.tasks, subtasks: plan.subtasks, skipped: plan.skipped }
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
    moveTrackerTasks,
    updateTrackerTasks,
    openSubtaskCreator,
    openTaskEditor,
    openTrackerLink,
    reorderSubtasks,
  }
}

export type TrackerTasks = ReturnType<typeof useTrackerTasks>
