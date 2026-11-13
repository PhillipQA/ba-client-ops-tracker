/**
 * Changing tasks: resolve, archive, reopen, status, waiting on, edit, move to Seeds and delete.
 */
import { businessDateKey } from '../../shared/businessDate'
import { trackerApi } from '../../features/trackers/trackerApi'
import { moveToSeeds } from '../../features/seeds/moveToSeeds'
import type { MoveRequest, MoveOutcome } from '../../features/seeds/MoveToSeedsDialog'
import { trackerProjectIds } from '../../features/trackers/trackerModel'
import { assertRtmMutation, reconcileRtm } from '../../features/requirements/rtm'
import { isArchived, taskArchiveBlockers, assertLifecycleMutation } from '../../features/tasks/lifecycle'
import { applySubtaskAssignmentInheritance } from '../../features/tasks/subtaskAssignment'
import { waitForCloudSaves, queueCloudStoreSave } from '../cloudStore'
import { doneWaitingOn, defaultWaitingOn, isWaitingOnDone, findWaitingOn } from '../../features/tasks/waitingOn'
import { openSubtasks as findOpenSubtasks, closeOpenSubtasks } from '../../features/tasks/closeSubtasks'
import type { WaitingOn, WorkItem } from '../../shared/types'
import {
  defaultClosedTaskStatus,
  defaultOpenTaskStatus,
  isTaskClosed,
  type Store,
  workEventsForItemChanges,
  STORE_SCHEMA_VERSION,
  organizationStorageKey,
} from '../store'
import type { UiState } from './useUiState'
import type { WorkspaceSave } from './useWorkspaceSave'
import type { SignIn } from './useSignIn'

export function useTaskActions(ui: UiState, saving: WorkspaceSave, signIn: SignIn) {
  const {
    storeRef,
    confirmCloseWithSubtasks,
    closedSubtasksNote,
    store,
    today,
    setTaskArchiveView,
    setTaskEditSaving,
    authUser,
    cloudStatus,
    setCloudStatus,
    setCloudMessage,
    setLastCloudSync,
    setStore,
    setEditingTaskId,
    setModal,
    editingTaskId,
  } = ui
  const { persist } = saving
  const { canWriteTasks } = signIn
  const resolveItem = async (id: string) => {
    if (!canWriteTasks) return
    const before = storeRef.current
    const target = before.items.find(item => item.id === id)
    if (!target) return
    const closedStatus = defaultClosedTaskStatus(before.taskSettings)
    // Open subtasks close with the task, once the person confirms.
    const open = findOpenSubtasks(before.items, id, before.taskSettings)
    if (open.length && !(await confirmCloseWithSubtasks(target, closedStatus, open))) return
    const current = storeRef.current
    const now = new Date().toISOString().slice(0, 10)
    const closing = findOpenSubtasks(current.items, id, current.taskSettings).length
    persist({
      ...current,
      items: closeOpenSubtasks(current.items, id, closedStatus, current.taskSettings, now).map(item =>
        item.id === id
          ? {
              ...item,
              status: closedStatus,
              waitingOn: doneWaitingOn(current.taskSettings),
              followUpDate: '',
              resolvedDate: now,
            }
          : item,
      ),
      activity: [
        {
          id: crypto.randomUUID(),
          clientId: target.clientId,
          projectId: target.projectId,
          date: now,
          text: `Completed task: ${target.title}`,
        },
        ...(closing ? [closedSubtasksNote(target, closing, now)] : []),
        ...current.activity,
      ],
    })
  }

  /** Puts a closed task (and its finished subtasks) away: it leaves Tasks until it is reopened. */
  const archiveTask = (id: string) => {
    if (!canWriteTasks) return
    const target = store.items.find(item => item.id === id)
    if (!target || isArchived(target)) return
    const blockers = taskArchiveBlockers(store.items, target, store.taskSettings)
    if (blockers.length) {
      window.alert(`“${target.title}” cannot be archived yet. ${blockers.join(' ')}`)
      return
    }
    persist({
      ...store,
      items: store.items.map(item =>
        item.id === id ? { ...item, archived: true, archivedAt: new Date().toISOString() } : item,
      ),
      activity: [
        {
          id: crypto.randomUUID(),
          clientId: target.clientId,
          projectId: target.projectId,
          date: today,
          text: `Archived task: ${target.title}`,
        },
        ...store.activity,
      ],
    })
  }

  /** Brings an archived task back to Tasks with an open status, ready to be worked on again. */
  const reopenTask = (id: string) => {
    if (!canWriteTasks) return
    const target = store.items.find(item => item.id === id)
    if (!target || !isArchived(target)) return
    const { archived: _archived, archivedAt: _archivedAt, ...rest } = target
    const saved = persist({
      ...store,
      items: store.items.map(item =>
        item.id === id
          ? {
              ...rest,
              status: defaultOpenTaskStatus(store.taskSettings),
              waitingOn: defaultWaitingOn(store.taskSettings),
              resolvedDate: undefined,
            }
          : item,
      ),
      activity: [
        {
          id: crypto.randomUUID(),
          clientId: target.clientId,
          projectId: target.projectId,
          date: today,
          text: `Reopened task: ${target.title}`,
        },
        ...store.activity,
      ],
    })
    if (saved !== false) setTaskArchiveView('active')
  }

  const updateTaskStatus = async (id: string, status: string) => {
    if (!canWriteTasks) return
    const before = storeRef.current
    const original = before.items.find(item => item.id === id)
    if (!original || original.status === status) return
    // Closing with open subtasks: they close with it, once the person confirms.
    const open = isTaskClosed(status, before.taskSettings)
      ? findOpenSubtasks(before.items, id, before.taskSettings)
      : []
    if (open.length && !(await confirmCloseWithSubtasks(original, status, open))) return
    const store = storeRef.current
    const target = store.items.find(item => item.id === id)
    if (!target || target.status === status) return
    const closed = isTaskClosed(status, store.taskSettings)
    const closing = closed ? findOpenSubtasks(store.items, id, store.taskSettings).length : 0
    const reopened = isTaskClosed(target.status, store.taskSettings) && !closed
    const items = closed ? closeOpenSubtasks(store.items, id, status, store.taskSettings, today) : store.items
    persist({
      ...store,
      items: items.map(item =>
        item.id === id
          ? {
              ...item,
              status,
              startDate: status === 'In Progress' && !item.startDate ? today : item.startDate,
              resolvedDate: closed ? item.resolvedDate || today : undefined,
              waitingOn: closed
                ? doneWaitingOn(store.taskSettings)
                : reopened && isWaitingOnDone(item.waitingOn, store.taskSettings)
                  ? defaultWaitingOn(store.taskSettings)
                  : item.waitingOn,
            }
          : item,
      ),
      activity: [
        {
          id: crypto.randomUUID(),
          clientId: target.clientId,
          projectId: target.projectId,
          date: today,
          text: `Task status changed: ${target.title} → ${status}`,
        },
        ...(closing ? [closedSubtasksNote(target, closing, today)] : []),
        ...store.activity,
      ],
    })
  }

  const updateTaskWaitingOn = (id: string, waitingOn: WaitingOn) => {
    if (!canWriteTasks) return
    const target = store.items.find(item => item.id === id)
    if (
      !target ||
      target.waitingOn === waitingOn ||
      isWaitingOnDone(waitingOn, store.taskSettings) ||
      !findWaitingOn(waitingOn, store.taskSettings) ||
      isTaskClosed(target.status, store.taskSettings)
    )
      return
    persist({
      ...store,
      items: store.items.map(item => (item.id === id ? { ...item, waitingOn } : item)),
      activity: [
        {
          id: crypto.randomUUID(),
          clientId: target.clientId,
          projectId: target.projectId,
          date: today,
          text: `Task now waiting on ${waitingOn}: ${target.title}`,
        },
        ...store.activity,
      ],
    })
  }

  const saveTaskEdit = async (updated: WorkItem) => {
    if (!canWriteTasks) throw new Error('You do not have permission to edit this task.')
    setTaskEditSaving(true)
    try {
      // A prior optimistic save may have failed. Allow this confirmed edit to retry.
      await waitForCloudSaves().catch(() => undefined)
      // Closing with open subtasks: they close with it, once the person confirms.
      const before = storeRef.current
      const beforeTask = before.items.find(item => item.id === updated.id)
      if (
        beforeTask &&
        isTaskClosed(updated.status, before.taskSettings) &&
        !isTaskClosed(beforeTask.status, before.taskSettings)
      ) {
        const open = findOpenSubtasks(before.items, updated.id, before.taskSettings)
        if (open.length && !(await confirmCloseWithSubtasks(beforeTask, updated.status, open)))
          throw new Error('Not saved. The task and its open subtasks were left open.')
      }
      const current = storeRef.current
      const previous = current.items.find(item => item.id === updated.id)
      if (!previous) throw new Error('This task is no longer available. Reload the workspace and try again.')
      const closed = isTaskClosed(updated.status, current.taskSettings)
      const closing = closed ? findOpenSubtasks(current.items, updated.id, current.taskSettings).length : 0
      const normalized: WorkItem = {
        ...updated,
        title: previous.title,
        clientId: previous.clientId,
        projectId: previous.parentTaskId ? previous.projectId : updated.projectId,
        waitingOn: closed
          ? doneWaitingOn(current.taskSettings)
          : isWaitingOnDone(updated.waitingOn, current.taskSettings)
            ? defaultWaitingOn(current.taskSettings)
            : updated.waitingOn,
        startDate: updated.status === 'In Progress' && !updated.startDate ? today : updated.startDate,
        resolvedDate: closed ? previous.resolvedDate || today : undefined,
      }
      const editedItems = current.items.map(item =>
        item.id === updated.id
          ? normalized
          : item.parentTaskId === updated.id
            ? { ...item, projectId: normalized.projectId }
            : item,
      )
      const closedItems = closed
        ? closeOpenSubtasks(editedItems, updated.id, updated.status, current.taskSettings, today)
        : editedItems
      const inheritedItems = applySubtaskAssignmentInheritance(current.items, closedItems)
      const next: Store = {
        ...current,
        items: inheritedItems.map(item => ({
          ...item,
          owner: item.assignedToUserId
            ? current.accounts.find(account => account.id === item.assignedToUserId)?.name || item.owner
            : '',
        })),
        activity: [
          {
            id: crypto.randomUUID(),
            clientId: previous.clientId,
            projectId: normalized.projectId,
            date: today,
            text: `Updated task: ${previous.title}`,
          },
          ...(closing ? [closedSubtasksNote(previous, closing, today)] : []),
          ...current.activity,
        ],
      }
      assertLifecycleMutation(current, next, authUser)
      const generatedEvents = workEventsForItemChanges(current, next, authUser)
      assertRtmMutation(current, next, authUser)
      const candidate = reconcileRtm(
        current,
        {
          ...next,
          schemaVersion: STORE_SCHEMA_VERSION,
          workEvents: [...generatedEvents, ...current.workEvents].slice(0, 10000),
        },
        authUser,
      )
      if (cloudStatus !== 'local') {
        setCloudStatus('saving')
        setCloudMessage('Saving to database…')
        try {
          const result = await queueCloudStoreSave(candidate)
          if (!result.configured)
            throw new Error(
              'Cloud storage is unavailable. Your edit was not saved; please retry when the database is connected.',
            )
          setLastCloudSync(result.updatedAt || new Date().toISOString())
          setCloudStatus('synced')
          setCloudMessage('Database synced')
        } catch (error) {
          setCloudStatus('error')
          setCloudMessage(error instanceof Error ? error.message : 'Cloud save failed')
          throw error
        }
      }
      storeRef.current = candidate
      setStore(candidate)
      localStorage.setItem(organizationStorageKey(authUser?.organizationId), JSON.stringify(candidate))
      setEditingTaskId(null)
      setModal(null)
    } finally {
      setTaskEditSaving(false)
    }
  }

  /**
   * Moves Before Seeds tasks (with their subtasks) into a Seeds project and its client. Administrators only: it is for
   * the move to Seeds, and the Before Seeds data is removed once everything is moved. Trackers on the old project can
   * get the Seeds project as their default too.
   */
  const moveWorkToSeeds = async (request: MoveRequest): Promise<MoveOutcome> => {
    if (authUser?.role !== 'Administrator') throw new Error('Only an Administrator can move work to Seeds.')
    await waitForCloudSaves().catch(() => undefined)
    const current = storeRef.current
    const project = current.projects.find(candidate => candidate.id === request.projectId)
    if (!project) throw new Error('That Seeds project is no longer here. Sync Seeds and try again.')
    const fromIds = [
      ...new Set(
        request.taskIds.map(id => current.items.find(item => item.id === id)?.projectId).filter(Boolean) as string[],
      ),
    ]
    const result = moveToSeeds(current.items, { taskIds: request.taskIds, project, seedsTaskId: request.seedsTaskId })
    const skipped = result.skipped.map(skip => ({ title: skip.title, reason: skip.reason }))
    if (!result.moved.length) return { moved: 0, subtasks: 0, skipped }
    const today = businessDateKey()
    const titles = result.moved.map(id => current.items.find(item => item.id === id)?.title || '').filter(Boolean)
    const next: Store = {
      ...current,
      items: result.items,
      activity: [
        {
          id: crypto.randomUUID(),
          clientId: project.clientId,
          projectId: project.id,
          date: today,
          text: `Moved to Seeds (${project.name}): ${titles.slice(0, 5).join(', ')}${titles.length > 5 ? ` and ${titles.length - 5} more` : ''}`,
        },
        ...current.activity,
      ],
    }
    assertLifecycleMutation(current, next, authUser)
    if (persist(next) === false) throw new Error('The move was not allowed.')
    if (cloudStatus !== 'local') await waitForCloudSaves()
    // Trackers on the old project take the Seeds project as their default, so new rows and sites go to Seeds.
    if (request.trackers && fromIds.length) {
      const listed = await trackerApi.list().catch(() => null)
      for (const tracker of listed?.trackers || []) {
        const ids = trackerProjectIds(tracker)
        if (!ids.some(id => fromIds.includes(id)) || ids[0] === project.id) continue
        const clientIds = tracker.clientIds?.length ? tracker.clientIds : tracker.clientId ? [tracker.clientId] : []
        await trackerApi
          .update(tracker.id, {
            projectIds: [project.id, ...ids.filter(id => id !== project.id)],
            clientIds: clientIds.includes(project.clientId || '') ? clientIds : [...clientIds, project.clientId || ''],
          })
          .catch(() => undefined)
      }
    }
    return { moved: result.moved.length, subtasks: result.subtasks, skipped }
  }

  const deleteTask = (id: string) => {
    if (!canWriteTasks) return
    const target = store.items.find(item => item.id === id)
    if (!target) return
    const childCount = store.items.filter(item => item.parentTaskId === id).length
    const deleteMessage = childCount
      ? `Delete task "${target.title}" and its ${childCount} subtask${childCount === 1 ? '' : 's'}? This cannot be undone.`
      : `Delete task "${target.title}"? This cannot be undone.`
    if (!window.confirm(deleteMessage)) return
    persist({
      ...store,
      items: store.items.filter(item => item.id !== id && item.parentTaskId !== id),
      activity: [
        {
          id: crypto.randomUUID(),
          clientId: target.clientId,
          projectId: target.projectId,
          date: today,
          text: `Deleted task: ${target.title}`,
        },
        ...store.activity,
      ],
    })
    if (editingTaskId === id) {
      setEditingTaskId(null)
      setModal(null)
    }
  }

  return {
    deleteTask,
    moveWorkToSeeds,
    resolveItem,
    archiveTask,
    reopenTask,
    saveTaskEdit,
    updateTaskStatus,
    updateTaskWaitingOn,
  }
}

export type TaskActions = ReturnType<typeof useTaskActions>
