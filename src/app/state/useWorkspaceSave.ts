/**
 * Saving the workspace (persist) and applying what the server sends back for RTMs, records, notifications,
 * evidence, comments and time entries.
 */
import { assertRtmMutation, reconcileRtm, type RtmMatrix } from '../../features/requirements/rtm'
import { assertLifecycleMutation, stableRecord } from '../../features/tasks/lifecycle'
import { queueCloudStoreSave, waitForCloudSaves, loadCloudStore } from '../cloudStore'
import type { TaskEvidenceMutationResult } from '../../features/tasks/taskEvidence'
import { loadNotifications } from '../../features/notifications/notifications'
import type { TaskCommentMutationResult } from '../../features/tasks/taskComments'
import type { TimeEntryMutationResult } from '../../features/tasks/timeEntries'
import type { Client, Project, AppNotification, WorkActivityEvent } from '../../shared/types'
import { withRecurrences } from '../../features/tasks/recurrence'
import { defaultWaitingOn } from '../../features/tasks/waitingOn'
import {
  defaultOpenTaskStatus,
  isTaskClosed,
  organizationStorageKey,
  type Store,
  workEventsForItemChanges,
  STORE_SCHEMA_VERSION,
  normalizeStore,
} from '../store'
import type { UiState } from './useUiState'

export function useWorkspaceSave(ui: UiState) {
  const {
    authUser,
    notificationBusy,
    setNotificationBusy,
    storeRef,
    setStore,
    cloudStatus,
    setCloudStatus,
    setCloudMessage,
    setLastCloudSync,
    setRtmContext,
    setSelectedClientId,
    setSelectedProjectId,
    setView,
    setLifecycleSaving,
    today,
  } = ui
  // Opening the bell is an explicit read; the workspace refresh supplies notices otherwise.
  const refreshNotifications = async () => {
    if (!authUser || authUser.accountType === 'platform' || notificationBusy) return
    setNotificationBusy(true)
    try {
      const result = await loadNotifications()
      const next = { ...storeRef.current, notifications: result.notifications }
      storeRef.current = next
      setStore(next)
      localStorage.setItem(organizationStorageKey(authUser.organizationId), JSON.stringify(next))
    } catch (error) {
      console.error('Notification refresh failed:', error)
    } finally {
      setNotificationBusy(false)
    }
  }

  const persist = (requested: Store) => {
    let next = requested
    // A repeating task that has just been closed gets its next copy (recurrence.ts), however it was closed.
    const repeated = withRecurrences(
      storeRef.current.items,
      next.items,
      next.taskSettings,
      isTaskClosed,
      { openStatus: defaultOpenTaskStatus(next.taskSettings), openWaitingOn: defaultWaitingOn(next.taskSettings) },
      today,
    )
    if (repeated.made.length)
      next = {
        ...next,
        items: repeated.items,
        activity: [
          ...repeated.made.map(({ from, next: copy }) => ({
            id: crypto.randomUUID(),
            clientId: from.clientId,
            projectId: from.projectId,
            date: today,
            text: `Repeating task: made the next “${copy.title}”${copy.dueDate ? `, due ${copy.dueDate}` : ''}`,
          })),
          ...next.activity,
        ],
      }
    try {
      assertLifecycleMutation(storeRef.current, next, authUser)
      assertRtmMutation(storeRef.current, next, authUser)
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'This change is not allowed.')
      return false
    }

    const generatedEvents = workEventsForItemChanges(storeRef.current, next, authUser)
    const normalized = reconcileRtm(
      storeRef.current,
      {
        ...next,
        schemaVersion: STORE_SCHEMA_VERSION,
        workEvents: [...generatedEvents, ...(storeRef.current.workEvents || [])].slice(0, 10000),
      },
      authUser,
    )
    storeRef.current = normalized
    setStore(normalized)
    localStorage.setItem(organizationStorageKey(authUser?.organizationId), JSON.stringify(normalized))
    if (cloudStatus === 'local') return
    setCloudStatus('saving')
    setCloudMessage('Saving to database…')
    void queueCloudStoreSave(normalized)
      .then(result => {
        if (!result.configured) {
          setCloudStatus('local')
          setCloudMessage('Local browser storage')
          return
        }
        setLastCloudSync(result.updatedAt || new Date().toISOString())
        setCloudStatus('synced')
        setCloudMessage('Database synced')
      })
      .catch(error => {
        console.error(error)
        setCloudStatus('error')
        setCloudMessage(error instanceof Error ? error.message : 'Cloud save failed · local cache retained')
      })
  }

  const saveRtms = async (rtms: RtmMatrix[], items = storeRef.current.items) => {
    await waitForCloudSaves()
    const current = storeRef.current
    const next = { ...current, rtms, items }
    assertLifecycleMutation(current, next, authUser)
    assertRtmMutation(current, next, authUser)
    let savedState = reconcileRtm(current, next, authUser)
    if (cloudStatus !== 'local') {
      const saved = await queueCloudStoreSave(savedState)
      if (!saved.configured) throw new Error('Cloud storage is unavailable. Your RTM was not saved.')
      setLastCloudSync(saved.updatedAt || new Date().toISOString())
      setCloudStatus('synced')
      setCloudMessage('Database synced')
      const refreshed = await loadCloudStore<Store>().catch(() => null)
      if (refreshed?.data) savedState = normalizeStore(refreshed.data)
    }
    storeRef.current = savedState
    setStore(savedState)
    localStorage.setItem(organizationStorageKey(authUser?.organizationId), JSON.stringify(savedState))
  }
  const openRtms = (clientId?: string, projectId?: string) => {
    setRtmContext({ clientId, projectId })
    setSelectedClientId(null)
    setSelectedProjectId(null)
    setView('requirements')
  }

  const saveLifecycleRecord = async (kind: 'clients' | 'projects', record: Client | Project) => {
    if (!authUser || authUser.role === 'Viewer' || !authUser.modules.includes(kind))
      throw new Error('Edit access is required.')
    setLifecycleSaving(true)
    try {
      await waitForCloudSaves()
      const current = storeRef.current
      const old = current[kind].find(r => r.id === record.id)
      if (!old || (old.lifecycleVersion || 0) !== (record.lifecycleVersion || 0))
        throw new Error('This record changed. Close the editor and reopen it.')
      if (stableRecord(old) === stableRecord(record)) return
      const updated = { ...record, lifecycleVersion: (old.lifecycleVersion || 0) + 1 }
      const next = { ...current, [kind]: current[kind].map(r => (r.id === record.id ? updated : r)) } as Store
      assertLifecycleMutation(current, next, authUser)
      if (cloudStatus !== 'local') {
        const saved = await queueCloudStoreSave(next)
        if (!saved.configured)
          throw new Error('The server could not save this change. Retry when storage is available.')
        setLastCloudSync(saved.updatedAt || new Date().toISOString())
        setCloudStatus('synced')
        setCloudMessage('Database synced')
      }
      storeRef.current = next
      setStore(next)
      localStorage.setItem(organizationStorageKey(authUser.organizationId), JSON.stringify(next))
    } finally {
      setLifecycleSaving(false)
    }
  }

  const acceptNotificationPayload = (notifications: AppNotification[], updatedAt?: string) => {
    const current = storeRef.current
    const next = { ...current, notifications }
    storeRef.current = next
    setStore(next)
    localStorage.setItem(organizationStorageKey(authUser?.organizationId), JSON.stringify(next))
    if (updatedAt) setLastCloudSync(updatedAt)
  }

  const applyEvidenceMutation = (result: TaskEvidenceMutationResult) => {
    const current = storeRef.current
    const previous = current.items.find(item => item.id === result.item.id)
    const previousEvidence = previous?.evidence?.length || 0
    const nextEvidence = result.item.evidence?.length || 0
    const evidenceEvent =
      authUser && previousEvidence !== nextEvidence
        ? workEventsForItemChanges(
            current,
            { ...current, items: current.items.map(item => (item.id === result.item.id ? result.item : item)) },
            authUser,
          )[0]
        : undefined
    const explicitEvidenceEvent: WorkActivityEvent | undefined =
      authUser && previousEvidence !== nextEvidence
        ? {
            id: crypto.randomUUID(),
            occurredAt: new Date().toISOString(),
            date: today,
            actorUserId: authUser.id,
            actorName: authUser.name,
            actorRole: authUser.role,
            assignedToUserId: result.item.assignedToUserId,
            assignedToName: current.accounts.find(account => account.id === result.item.assignedToUserId)?.name,
            clientId: result.item.clientId,
            projectId: result.item.projectId,
            taskId: result.item.id,
            parentTaskId: result.item.parentTaskId,
            itemTitle: result.item.title,
            itemKind: result.item.parentTaskId ? 'Subtask' : 'Task',
            action: nextEvidence > previousEvidence ? 'evidence_uploaded' : 'evidence_deleted',
            summary: `${authUser.name} ${nextEvidence > previousEvidence ? 'uploaded evidence to' : 'removed evidence from'} “${result.item.title}”.`,
          }
        : evidenceEvent
    const next: Store = {
      ...current,
      items: current.items.map(item => (item.id === result.item.id ? result.item : item)),
      activity: result.activity
        ? [result.activity, ...current.activity.filter(entry => entry.id !== result.activity?.id)]
        : current.activity,
      workEvents: explicitEvidenceEvent
        ? [explicitEvidenceEvent, ...current.workEvents].slice(0, 10000)
        : current.workEvents,
      notifications: result.notifications || current.notifications,
    }
    storeRef.current = next
    setStore(next)
    localStorage.setItem(organizationStorageKey(authUser?.organizationId), JSON.stringify(next))
    if (result.updatedAt) setLastCloudSync(result.updatedAt)
    setCloudStatus('synced')
    setCloudMessage('Database synced')
  }

  const applyCommentMutation = (result: TaskCommentMutationResult) => {
    const current = storeRef.current
    const next: Store = {
      ...current,
      items: current.items.map(item => (item.id === result.item.id ? result.item : item)),
      notifications: result.notifications || current.notifications,
    }
    storeRef.current = next
    setStore(next)
    localStorage.setItem(organizationStorageKey(authUser?.organizationId), JSON.stringify(next))
    if (result.updatedAt) setLastCloudSync(result.updatedAt)
    setCloudStatus('synced')
    setCloudMessage('Comment saved · Database synced')
  }

  const applyTimeEntryMutation = (result: TimeEntryMutationResult) => {
    const current = storeRef.current
    const next: Store = {
      ...current,
      items: current.items.map(item =>
        item.id === result.item.id ? { ...item, timeEntries: result.item.timeEntries || [] } : item,
      ),
    }
    storeRef.current = next
    setStore(next)
    localStorage.setItem(organizationStorageKey(authUser?.organizationId), JSON.stringify(next))
    if (result.updatedAt) setLastCloudSync(result.updatedAt)
    setCloudStatus('synced')
    setCloudMessage('Time saved · Database synced')
  }

  return {
    acceptNotificationPayload,
    persist,
    applyCommentMutation,
    applyEvidenceMutation,
    applyTimeEntryMutation,
    openRtms,
    refreshNotifications,
    saveLifecycleRecord,
    saveRtms,
  }
}

export type WorkspaceSave = ReturnType<typeof useWorkspaceSave>
