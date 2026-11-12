import { type ClientLayout, type View, labels, navItems, PAGE_MODULES, priorityRank, SEEDS_PAGES } from './navigation'
import { atRoute, pathForRoute, routeFromLocation } from './routes'
import { businessDateKey, useBusinessDate } from '../shared/businessDate'
import { usePageActive, useVisiblePolling } from './useVisiblePolling'
import { workspaceAutoRefreshAllowed } from './activePolling'
import { workHubSync, WORK_HUB_INTEGRATIONS } from '../features/work-hub/workHubSync'
import { useWorkHubSync } from '../features/work-hub/useWorkHubSync'
import { trackerApi, type TaskLink } from '../features/trackers/trackerApi'
import type { TaskDraft } from '../features/trackers/TrackerWork'
import { seedsTaskNamed } from '../shared/seeds'
import { moveToSeeds } from '../features/seeds/moveToSeeds'
import type { MoveOutcome, MoveRequest } from '../features/seeds/MoveToSeedsDialog'
import { trackerProjectIds } from '../features/trackers/trackerModel'
import { applyTaskPatches, type TaskPatch } from '../features/trackers/trackerTasks'
import { rememberTrackerRow } from '../features/trackers/trackerNav'
import { assertRtmMutation, reconcileRtm, type RtmMatrix } from '../features/requirements/rtm'
import {
  assertLifecycleMutation,
  archivedWorkReason,
  isArchived,
  isTaskArchived,
  stableRecord,
  taskArchiveBlockers,
} from '../features/tasks/lifecycle'
import {
  itemMatchesActionCenterScope,
  resolveActionCenterScope,
  trackedActionCenterUsers,
  type ActionCenterScopeSelection,
} from '../features/action-center/actionCenterScope'
import { applySubtaskAssignmentInheritance } from '../features/tasks/subtaskAssignment'
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getAuthSession, login, loginWithGoogle, logout, type AuthUser } from '../features/accounts/auth'
import {
  loadCloudStore,
  resetCloudSession,
  pendingCloudEdits,
  queueCloudStoreSave,
  waitForCloudSaves,
  WORKSPACE_MERGED,
  type CloudStorageStatus,
  type WorkspaceMerged,
} from './cloudStore'
import { mergeWorkspace } from './workspaceMerge'
import { settingsRequest } from '../features/settings/Settings'
import { askBAAssistant, assistantMessages, type AIMessage, type AISuggestion } from '../features/ai/ai'
import type { DrfPrefill } from '../features/documents/drfPrefill'
import {
  defaultWaitingOn,
  doneWaitingOn,
  findWaitingOn,
  isWaitingOnDone,
  openWaitingOnOptions,
  waitingOnOptions,
} from '../features/tasks/waitingOn'
import { seedAccounts } from './data'
import type { TaskEvidenceMutationResult } from '../features/tasks/taskEvidence'
import {
  loadNotifications,
  markAllNotificationsRead,
  updateNotification,
} from '../features/notifications/notifications'
import type { TaskCommentMutationResult } from '../features/tasks/taskComments'
import type { BoardGroup, TaskLayout } from '../features/tasks/taskBoardModel'
import type { TimeEntryMutationResult } from '../features/tasks/timeEntries'
import { closeOpenSubtasks, confirmWord, openSubtasks as findOpenSubtasks } from '../features/tasks/closeSubtasks'
import type { CloseWithSubtasksRequest } from '../features/tasks/CloseWithSubtasksDialog'
import type {
  AppModule,
  AppNotification,
  Client,
  ItemType,
  PlannerActivity,
  Project,
  UserAccount,
  WaitingOn,
  WorkActivityEvent,
  WorkItem,
} from '../shared/types'
import type { AppTheme } from '../features/settings/theme'
import { normalizeInterfaceMode, type InterfaceMode } from '../features/settings/appearance'
import { readSidebarCollapsed, writeSidebarCollapsed } from './sidebarState'
import { useRailTip } from '../shared/ui/RailTip'
import {
  STORE_SCHEMA_VERSION,
  type Store,
  defaultClosedTaskStatus,
  defaultOpenTaskStatus,
  initialStore,
  isTaskClosed,
  normalizeAccount,
  normalizeStore,
  organizationStorageKey,
  seedStore,
  workEventsForItemChanges,
} from './store'
import { addDays, weekEndKey, weekStartKey } from '../shared/dates'

/**
 * Everything the app keeps track of while it runs: the signed-in person, the workspace (clients, projects, tasks,
 * planner) and how it is saved, which screen is open, and the handlers the screens call. The App component and the
 * pages read it; nothing here renders.
 */
/**
 * What this browser keeps for a signed-in person: the workspace copy that makes the next start fast, and AI BA
 * Assistant conversations. Removed at sign-out, so the next person at a shared computer cannot read them in the
 * browser's storage. Unsaved edits kept after a save conflict stay: they are the only copy.
 */
function forgetBrowserCopies(user: { id?: string; organizationId?: string } | null) {
  try {
    localStorage.removeItem(organizationStorageKey(user?.organizationId))
    const threadsKey = 'ba-client-ops-ai-threads-v1'
    const threads = JSON.parse(localStorage.getItem(threadsKey) || '{}') as Record<string, unknown>
    const mine = `${user?.id || ''}:`
    const others = Object.fromEntries(Object.entries(threads).filter(([key]) => !key.startsWith(mine)))
    if (Object.keys(others).length) localStorage.setItem(threadsKey, JSON.stringify(others))
    else localStorage.removeItem(threadsKey)
  } catch {
    /* Storage unavailable: nothing was kept. */
  }
}

export function useAppState() {
  const today = useBusinessDate()
  const [documentLaunch, setDocumentLaunch] = useState<{
    taskId: string
    flow: 'drf' | 'signoff'
    nonce: number
    /** DRF fields the BA assistant drafted from an email, to fill the form for review. */
    drf?: DrfPrefill
  }>()

  const [resetToken, setResetToken] = useState<string | null>(() =>
    new URLSearchParams(window.location.hash.slice(1)).get('reset-password'),
  )
  const [store, setStore] = useState<Store>(initialStore)
  // The page in the address (/tasks, /clients/<id>…), read once at start; see routes.ts.
  const [startRoute] = useState(() => routeFromLocation(window.location.pathname, window.location.search))
  // Returning from the Google Drive consent screen opens Settings so the result is shown; others follow the address.
  const [view, setView] = useState<View>(() => {
    const hash = new URLSearchParams(window.location.hash.slice(1))
    return hash.has('drive')
      ? 'settings'
      : hash.has('gmail')
        ? 'inbox'
        : hash.has('sheets')
          ? 'trackers'
          : startRoute?.view || 'action'
  })
  const [query, setQuery] = useState('')
  const [clientArchiveFilter, setClientArchiveFilter] = useState('active')
  const [clientLayout, setClientLayout] = useState<ClientLayout>('tiles')
  const [taskLayout, setTaskLayout] = useState<TaskLayout>('table')
  const [boardGroup, setBoardGroup] = useState<BoardGroup>('status')
  const [boardShowSubtasks, setBoardShowSubtasks] = useState(false)
  const [clientSearch, setClientSearch] = useState('')
  const [clientSort, setClientSort] = useState('name')
  const [projectArchiveFilter, setProjectArchiveFilter] = useState('active')
  const [lifecycleSaving, setLifecycleSaving] = useState(false)
  const [editingRecord, setEditingRecord] = useState<{ kind: 'clients' | 'projects'; id: string } | null>(null)
  /** Before Seeds work being moved into Seeds: one task, or a project's tasks. Administrators only. */
  const [movingToSeeds, setMovingToSeeds] = useState<{ taskId?: string; fromProjectId?: string } | null>(null)
  const [waitingFilter, setWaitingFilter] = useState<'All' | WaitingOn>('All')
  const [taskClientFilter, setTaskClientFilter] = useState('')
  const [taskProjectFilter, setTaskProjectFilter] = useState('')
  const [taskStatusFilter, setTaskStatusFilter] = useState('')
  /** Tasks shows active work; Archived lists archived tasks so they can be reopened. */
  const [taskArchiveView, setTaskArchiveView] = useState<'active' | 'archived'>('active')
  const [taskDateFilter, setTaskDateFilter] = useState<
    'All' | 'due-3' | 'due-7' | 'followup-3' | 'followup-7' | 'overdue'
  >('All')
  const [selectedClientId, setSelectedClientId] = useState<string | null>(() => startRoute?.clientId ?? null)
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(() => startRoute?.projectId ?? null)
  const [selectedProjectClientId, setSelectedProjectClientId] = useState<string | null>(
    () => startRoute?.projectClientId ?? null,
  )
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null)
  const [taskEditSaving, setTaskEditSaving] = useState(false)
  const [taskPreset, setTaskPreset] = useState<{
    clientId?: string
    projectId?: string
    type?: ItemType
    parentTaskId?: string
  } | null>(null)
  const [modal, setModal] = useState<'item' | 'taskEdit' | 'client' | 'project' | 'activity' | null>(null)
  /** Asking before a task with open subtasks closes (they close with it). */
  const [closeRequest, setCloseRequest] = useState<CloseWithSubtasksRequest | null>(null)
  const confirmCloseWithSubtasks = (task: WorkItem, status: string, subtasks: WorkItem[]) =>
    new Promise<boolean>(resolve =>
      setCloseRequest({
        taskTitle: task.title,
        status,
        subtasks: subtasks.map(subtask => subtask.title),
        word: confirmWord(),
        answer: confirmed => {
          setCloseRequest(null)
          resolve(confirmed)
        },
      }),
    )
  /** The activity line for subtasks closed with their task. */
  const closedSubtasksNote = (task: WorkItem, count: number, date: string) => ({
    id: crypto.randomUUID(),
    clientId: task.clientId,
    projectId: task.projectId,
    date,
    text: `Closed ${count} open subtask${count === 1 ? '' : 's'} with task: ${task.title}`,
  })
  const [editingActivityId, setEditingActivityId] = useState<string | null>(null)
  const [aiClientId, setAiClientId] = useState('')
  const [aiProjectId, setAiProjectId] = useState('')
  const [aiPrompt, setAiPrompt] = useState('')
  const [activityRange, setActivityRange] = useState<'today' | 'week'>('today')
  const [actionCenterScope, setActionCenterScope] = useState<ActionCenterScopeSelection>('mine')
  const [trackerLinks, setTrackerLinks] = useState<TaskLink[]>([])
  const [dashboardAiPrompt, setDashboardAiPrompt] = useState('')
  const [dashboardAiBusy, setDashboardAiBusy] = useState(false)
  const [dashboardAiError, setDashboardAiError] = useState('')
  const [dashboardAiResult, setDashboardAiResult] = useState<{ message: string; wordCount: number } | null>(null)
  const [saveConflict, setSaveConflict] = useState('')
  const [recoveringCloud, setRecoveringCloud] = useState(false)
  const [cloudStatus, setCloudStatus] = useState<CloudStorageStatus>('checking')
  const [cloudMessage, setCloudMessage] = useState('Checking cloud storage…')
  const [lastCloudSync, setLastCloudSync] = useState<string>('')
  const [authUser, setAuthUser] = useState<AuthUser | null>(null)
  const [authChecking, setAuthChecking] = useState(true)
  const [loginError, setLoginError] = useState('')
  const [loginBusy, setLoginBusy] = useState(false)
  const [logoutBusy, setLogoutBusy] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const [navCollapsed, setNavCollapsed] = useState(readSidebarCollapsed)
  const railTip = useRailTip(navCollapsed)
  const toggleNav = () => {
    const next = !navCollapsed
    railTip.hide()
    setNavCollapsed(next)
    writeSidebarCollapsed(next)
  }
  const [newExternalInquiryIds, setNewExternalInquiryIds] = useState<string[]>([])
  const [notificationBusy, setNotificationBusy] = useState(false)
  const [rtmContext, setRtmContext] = useState<{ clientId?: string; projectId?: string }>({})
  const pageActive = usePageActive()
  const hubSync = useWorkHubSync()
  const hubSyncing =
    hubSync.allRunning || WORK_HUB_INTEGRATIONS.some(id => hubSync.integrations[id].phase === 'syncing')
  useEffect(() => {
    void workHubSync.setSession(authUser)
  }, [
    authUser?.id,
    authUser?.organizationId,
    authUser?.accountType,
    authUser?.status,
    authUser?.lastLoginAt,
    authUser?.modules.includes('inbox'),
  ])
  const storeRef = useRef(store)
  const workspaceRefreshBusy = useRef(false)
  const [refreshingCloud, setRefreshingCloud] = useState(false)

  useEffect(() => {
    storeRef.current = store
  }, [store])

  useEffect(() => {
    const onConflict = (event: Event) => {
      const message = (event as CustomEvent<string>).detail
      try {
        localStorage.setItem(
          `${organizationStorageKey(authUser?.organizationId)}:pending-edits`,
          JSON.stringify(pendingCloudEdits<Store>() || storeRef.current),
        )
      } catch {
        /* The on-screen draft remains available. */
      }
      setSaveConflict(message)
      setCloudStatus('error')
      setCloudMessage(message)
    }
    window.addEventListener('workspace-save-conflict', onConflict)
    return () => window.removeEventListener('workspace-save-conflict', onConflict)
  }, [authUser?.organizationId])
  // A save merged changes made elsewhere (another person, tab or capture): show them, keeping edits made since.
  useEffect(() => {
    const onMerged = (event: Event) => {
      const detail = (event as CustomEvent<WorkspaceMerged>).detail
      const merged = mergeWorkspace(detail.saved as Store, storeRef.current, detail.data as Store)
      if (!merged.ok) {
        // The person changed the same field meanwhile. Their screen cannot show the other changes, and saving it as it
        // is would undo them: refuse, so saving stops and the Save conflict box appears (see cloudStore).
        detail.clash = merged.clash
        event.preventDefault()
        return
      }
      const next = normalizeStore(merged.data, seedStore())
      storeRef.current = next
      setStore(next)
      try {
        localStorage.setItem(organizationStorageKey(authUser?.organizationId), JSON.stringify(next))
      } catch {
        /* The workspace on screen is current; only the browser copy is behind. */
      }
    }
    window.addEventListener(WORKSPACE_MERGED, onMerged)
    return () => window.removeEventListener(WORKSPACE_MERGED, onMerged)
  }, [authUser?.organizationId])

  const recoverCloud = async () => {
    setRecoveringCloud(true)
    try {
      const activePending = pendingCloudEdits<Store>()
      const pending = activePending
        ? JSON.stringify(activePending, null, 2)
        : localStorage.getItem(`${organizationStorageKey(authUser?.organizationId)}:pending-edits`) ||
          JSON.stringify(storeRef.current, null, 2)
      localStorage.setItem(`${organizationStorageKey(authUser?.organizationId)}:pending-edits`, pending)
      const url = URL.createObjectURL(new Blob([pending], { type: 'application/json' }))
      const link = document.createElement('a')
      link.href = url
      link.download = `pending-workspace-edits-${Date.now()}.json`
      link.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      const result = await loadCloudStore<Store>({ recover: true })
      if (!result.configured || !result.data)
        throw new Error('The latest workspace could not be loaded. Your pending edits are retained.')
      const next = normalizeStore(result.data, seedStore())
      storeRef.current = next
      setStore(next)
      localStorage.setItem(organizationStorageKey(authUser?.organizationId), JSON.stringify(next))
      localStorage.removeItem(`${organizationStorageKey(authUser?.organizationId)}:pending-edits`)
      setLastCloudSync(result.updatedAt || '')
      setSaveConflict('')
      setCloudStatus('synced')
      setCloudMessage('Latest workspace loaded. Reapply your edits from the downloaded copy.')
    } catch (error) {
      setCloudMessage(error instanceof Error ? error.message : 'Reload failed.')
    } finally {
      setRecoveringCloud(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    if (resetToken !== null) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search)
      setAuthChecking(false)
      return
    }
    void getAuthSession()
      .then(user => {
        if (!cancelled) setAuthUser(user)
      })
      .catch(error => {
        console.error(error)
      })
      .finally(() => {
        if (!cancelled) setAuthChecking(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    setActionCenterScope('mine')
  }, [authUser?.id, authUser?.organizationId])

  useEffect(() => {
    if (!authUser) {
      setClientLayout('tiles')
      return
    }
    try {
      const saved = localStorage.getItem(`ba-client-layout:${authUser.organizationId}:${authUser.id}`)
      setClientLayout(saved === 'list' || saved === 'table' ? saved : 'tiles')
    } catch {
      setClientLayout('tiles')
    }
  }, [authUser?.id, authUser?.organizationId])

  useEffect(() => {
    setTaskLayout('table')
    setBoardGroup('status')
    setBoardShowSubtasks(false)
    if (!authUser) return
    try {
      const saved = JSON.parse(
        localStorage.getItem(`ba-task-view:${authUser.organizationId}:${authUser.id}`) || '{}',
      ) as { layout?: string; group?: string; subtasks?: boolean }
      setTaskLayout(saved.layout === 'board' ? 'board' : 'table')
      setBoardGroup(saved.group === 'waiting' ? 'waiting' : 'status')
      setBoardShowSubtasks(saved.subtasks === true)
    } catch {
      /* Defaults already applied. */
    }
  }, [authUser?.id, authUser?.organizationId])

  useEffect(() => {
    resetCloudSession()
    setSaveConflict('')
    if (!authUser) return
    if (authUser.accountType === 'platform') {
      setStore(seedStore())
      setCloudStatus('synced')
      setCloudMessage('Internal Admin · control plane')
      setLastCloudSync('')
      return
    }
    let cancelled = false
    const connectCloud = async () => {
      setCloudStatus('checking')
      setCloudMessage('Checking cloud storage…')
      const tenantStorageKey = organizationStorageKey(authUser.organizationId)
      const cached = localStorage.getItem(tenantStorageKey)
      if (localStorage.getItem(`${tenantStorageKey}:pending-edits`))
        setSaveConflict(
          'A pending copy from a previous save conflict is available. Download it and reapply the needed edits to the latest workspace.',
        )
      if (cached) {
        try {
          setStore(normalizeStore(JSON.parse(cached), seedStore()))
        } catch {
          /* cloud load will replace invalid cache */
        }
      } else {
        setStore(seedStore())
      }
      try {
        const result = await loadCloudStore<Store>()
        if (cancelled) return
        if (!result.configured) {
          setCloudStatus('local')
          setCloudMessage('Local browser storage')
          return
        }
        if (result.data) {
          const sourceVersion = Number((result.data as Partial<Store>).schemaVersion || 0)
          const cloud = normalizeStore(result.data, initialStore())
          setStore(cloud)
          localStorage.setItem(tenantStorageKey, JSON.stringify(cloud))
          setLastCloudSync(result.updatedAt || new Date().toISOString())
          setCloudMessage('Database synced')
          setCloudStatus('synced')
          if (sourceVersion < STORE_SCHEMA_VERSION) {
            void queueCloudStoreSave(cloud).catch(error =>
              console.error('Could not save migrated tracker data:', error),
            )
          }
          return
        }
        const local = cached ? normalizeStore(JSON.parse(cached), seedStore()) : seedStore()
        const saved = await queueCloudStoreSave(local)
        if (cancelled) return
        setLastCloudSync(saved.updatedAt || new Date().toISOString())
        setCloudMessage('Database initialized from this browser')
        setCloudStatus('synced')
      } catch (error) {
        if (cancelled) return
        console.error(error)
        setCloudStatus('error')
        setCloudMessage('Cloud unavailable · using local cache')
      }
    }
    void connectCloud()
    return () => {
      cancelled = true
    }
  }, [authUser?.id])

  const refreshWorkspace = async (manual = false, signal?: AbortSignal) => {
    if (!authUser || authUser.accountType === 'platform' || workspaceRefreshBusy.current) return
    workspaceRefreshBusy.current = true
    if (manual) setRefreshingCloud(true)
    try {
      const result = await loadCloudStore<Store>({ onlyIfChanged: !manual, signal })
      if (signal?.aborted || !result.configured) return
      if (result.data) {
        const refreshed = normalizeStore(result.data, seedStore())
        storeRef.current = refreshed
        setStore(refreshed)
        localStorage.setItem(organizationStorageKey(authUser.organizationId), JSON.stringify(refreshed))
        setLastCloudSync(result.updatedAt || new Date().toISOString())
        setCloudStatus('synced')
        setCloudMessage('Database synced')
      }
    } catch (error) {
      if (!signal?.aborted) {
        console.error('Workspace refresh failed:', error)
        if (manual) setCloudMessage(error instanceof Error ? error.message : 'Could not refresh the workspace.')
      }
    } finally {
      workspaceRefreshBusy.current = false
      if (manual) setRefreshingCloud(false)
    }
  }
  useVisiblePolling(signal => refreshWorkspace(false, signal), {
    enabled: Boolean(
      authUser &&
        authUser.accountType !== 'platform' &&
        (cloudStatus === 'synced' || cloudStatus === 'saving') &&
        workspaceAutoRefreshAllowed(view, selectedClientId, selectedProjectId),
    ),
    interval: 5 * 60_000,
    scope: `${authUser?.id}:${view}:${selectedClientId || ''}:${selectedProjectId || ''}`,
    events: ['dochub-updated'],
  })

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

  const persist = (next: Store) => {
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

  /** After a sign-in, by password or with Google: open the person's first page. */
  const enterAs = (user: AuthUser) => {
    void workHubSync.setSession(user, true)
    setAuthUser(user)
    if (user.accountType === 'platform' && user.isPlatformAdmin) {
      setCloudStatus('synced')
      setCloudMessage('Internal Admin · control plane')
      setView('internal-admin')
    } else {
      setCloudStatus('checking')
      setCloudMessage('Checking cloud storage…')
      setView(
        user.role === 'Administrator' || user.modules.includes('action')
          ? 'action'
          : (user.modules[0] as View) || 'reports',
      )
    }
  }

  const handleLogin = async (account: string, username: string, password: string) => {
    setLoginBusy(true)
    setLoginError('')
    try {
      enterAs(await login(account, username, password))
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : 'Login failed.')
    } finally {
      setLoginBusy(false)
      setAuthChecking(false)
    }
  }

  /** Sign in with Google. Answers the accounts to choose from when the email is registered in several. */
  const handleGoogleLogin = async (credential: string, account?: string) => {
    setLoginBusy(true)
    setLoginError('')
    try {
      const result = await loginWithGoogle(credential, account)
      if ('accounts' in result) return result.accounts
      enterAs(result.user)
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : 'Sign in with Google failed.')
    } finally {
      setLoginBusy(false)
      setAuthChecking(false)
    }
    return null
  }

  const handleLogout = async () => {
    if (logoutBusy) return
    setLogoutBusy(true)
    try {
      // Changes still being saved would be cut off by signing out (the save needs the session): wait for them, and
      // ask before losing any that cannot be saved.
      const saved = await Promise.race([
        waitForCloudSaves().then(
          () => true,
          () => false,
        ),
        new Promise<boolean>(resolve => window.setTimeout(() => resolve(false), 10_000)),
      ])
      if (
        !saved &&
        !window.confirm(
          'Your latest changes have not been saved yet. Sign out anyway? Changes that are not saved will be lost.',
        )
      )
        return
      const signedOut = authUser
      await logout()
      forgetBrowserCopies(signedOut)
      void workHubSync.setSession(null)
      setAuthUser(null)
      setProfileOpen(false)
      setSelectedClientId(null)
      setSelectedProjectId(null)
      setNewExternalInquiryIds([])
      setEditingRecord(null)
      setStore(seedStore())
      setLoginError('')
    } catch (error) {
      console.error('Sign out could not be confirmed:', error)
      window.alert(error instanceof Error ? error.message : 'Sign out could not be confirmed. Please try again.')
    } finally {
      setLogoutBusy(false)
    }
  }

  const accountCurrentUser = authUser
    ? store.accounts.find(account => account.id === authUser.id && account.status === 'Active')
    : null
  // Job roles (Settings › Roles) decide a non-Administrator's pages and what they can change; the server applies the
  // same rule to every request. Without a job role, the modules picked for them by hand stay.
  const roleModules = authUser?.role === 'Administrator' ? undefined : store.access?.modules
  const roleEdit = authUser?.role === 'Administrator' ? undefined : store.access?.editModules
  const roleViewer = Boolean(roleModules && roleEdit && !roleEdit.length)
  const currentUser: UserAccount | null = authUser
    ? {
        ...(accountCurrentUser ?? { ...authUser, passwordHash: '', createdAt: today }),
        role: roleViewer ? 'Viewer' : authUser.role,
        modules: roleModules
          ? authUser.organizationModules?.length
            ? roleModules.filter(module => authUser.organizationModules?.includes(module))
            : roleModules
          : authUser.modules,
        organizationId: authUser.organizationId,
        organizationName: authUser.organizationName,
        organizationSlug: authUser.organizationSlug,
        organizationModules: authUser.organizationModules || authUser.modules,
        isPlatformAdmin: authUser.isPlatformAdmin,
        accountType: authUser.accountType,
        accountKey: authUser.accountKey,
        interfaceMode: normalizeInterfaceMode(authUser.interfaceMode),
        lastLoginAt: authUser.lastLoginAt,
      }
    : null
  // Whether this person may change things on the page they are on: a job role can see a page without changing it.
  const canEditModule = (module: AppModule) => !roleEdit || roleEdit.includes(module)
  const pageModule: AppModule | null = selectedClientId
    ? 'clients'
    : selectedProjectId
      ? 'projects'
      : (PAGE_MODULES as Record<string, AppModule | undefined>)[view] || null
  const canWrite = Boolean(
    currentUser && currentUser.role !== 'Viewer' && !lifecycleSaving && (!pageModule || canEditModule(pageModule)),
  )
  const canManageAccounts = currentUser?.role === 'Administrator' && currentUser.accountType !== 'platform'
  const hasModule = (module: AppModule) => Boolean(currentUser && currentUser.modules.includes(module))
  // Tasks open from many pages, so this follows the task rights, not the page.
  const canWriteTasks = Boolean(
    currentUser &&
      currentUser.role !== 'Viewer' &&
      !lifecycleSaving &&
      ((hasModule('items') && canEditModule('items')) || (hasModule('inbox') && canEditModule('inbox'))),
  )
  // Account Managers are Viewers who may still ask the AI BA Assistant about their clients.
  // A Viewer by job role (an Account Manager, say) may still ask the AI BA Assistant.
  const canUseAI = Boolean(currentUser && (currentUser.role !== 'Viewer' || roleViewer) && hasModule('ai'))
  const visibleNavItems = currentUser
    ? navItems.filter(item => hasModule(item.id) && (item.id !== 'ai' || canUseAI))
    : []

  const handleNotificationAction = async (notification: AppNotification, action: 'read' | 'unread' | 'dismiss') => {
    if (notificationBusy) return
    setNotificationBusy(true)
    try {
      const result = await updateNotification(notification.id, action)
      acceptNotificationPayload(result.notifications, result.updatedAt)
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Notification could not be updated.')
    } finally {
      setNotificationBusy(false)
    }
  }

  const handleReadAllNotifications = async () => {
    if (notificationBusy) return
    setNotificationBusy(true)
    try {
      const result = await markAllNotificationsRead()
      acceptNotificationPayload(result.notifications, result.updatedAt)
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Notifications could not be updated.')
    } finally {
      setNotificationBusy(false)
    }
  }

  useEffect(() => {
    const open = (event: Event) => {
      const detail = (event as CustomEvent).detail
      if (!authUser?.modules?.includes('documents') || !detail?.taskId) return
      setModal(null)
      setSelectedClientId(null)
      setSelectedProjectId(null)
      setDocumentLaunch({ ...detail, nonce: Date.now() })
      setView('documents')
    }
    window.addEventListener('dochub-create', open)
    return () => window.removeEventListener('dochub-create', open)
  }, [authUser?.id])
  const openNotification = (notification: AppNotification) => {
    if (!notification.readAt) void handleNotificationAction(notification, 'read')
    const item = notification.taskId
      ? storeRef.current.items.find(candidate => candidate.id === notification.taskId)
      : undefined
    if (!item) {
      if (notification.documentId && hasModule('documents')) {
        setSelectedClientId(null)
        setSelectedProjectId(null)
        setView('documents')
      }
      return
    }
    setSelectedClientId(null)
    setSelectedProjectId(null)
    setView(hasModule('items') ? 'items' : 'inbox')
    if (canWriteTasks) {
      setEditingTaskId(item.id)
      setModal('taskEdit')
    }
  }

  // Real addresses: the page on screen is written to the address bar, and Back/Forward bring pages back.
  // The first write after signing in, and redirects away from a page the person cannot open, replace the address
  // instead of adding to the history, so Back never lands on a page that would only redirect again.
  const firstRouteWrite = useRef(true)
  const redirectingRoute = useRef(false)
  useEffect(() => {
    if (!currentUser) return
    const target = pathForRoute({
      view,
      clientId: selectedClientId,
      projectId: selectedProjectId,
      projectClientId: selectedProjectClientId,
    })
    const { pathname, search } = window.location
    if (!atRoute(pathname, search, target)) {
      try {
        if (firstRouteWrite.current || redirectingRoute.current) window.history.replaceState(null, '', target)
        else window.history.pushState(null, '', target)
      } catch {
        /* The page still shows; only the address is not updated. */
      }
      redirectingRoute.current = false
    }
    firstRouteWrite.current = false
  }, [currentUser?.id, view, selectedClientId, selectedProjectId, selectedProjectClientId])
  useEffect(() => {
    const onPop = () => {
      const route = routeFromLocation(window.location.pathname, window.location.search)
      setView(route?.view || 'action')
      setSelectedClientId(route?.clientId ?? null)
      setSelectedProjectId(route?.projectId ?? null)
      setSelectedProjectClientId(route?.projectClientId ?? null)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  useEffect(() => {
    if (!currentUser) return
    if (currentUser.accountType === 'platform' && currentUser.isPlatformAdmin) {
      if (view !== 'internal-admin') {
        redirectingRoute.current = true
        setSelectedClientId(null)
        setSelectedProjectId(null)
        setView('internal-admin')
      }
      return
    }
    if (view === 'themes' || (view === 'users' && canManageAccounts)) return
    if (view === 'seeds' && visibleNavItems.some(item => SEEDS_PAGES.includes(item.id))) return
    if (!visibleNavItems.length) {
      redirectingRoute.current = true
      setView('themes')
      return
    }
    if (!visibleNavItems.some(item => item.id === view)) {
      redirectingRoute.current = true
      setSelectedClientId(null)
      setSelectedProjectId(null)
      setView(visibleNavItems[0].id)
    }
  }, [currentUser?.id, currentUser?.role, currentUser?.accountType, currentUser?.modules.join('|'), view])

  const acceptAccountUsers = (users: UserAccount[]) => {
    const current = storeRef.current
    const accounts = users
      .map((account, index) => normalizeAccount(account, index))
      .filter((account): account is UserAccount => Boolean(account))
    const next = { ...current, accounts }
    storeRef.current = next
    setStore(next)
    localStorage.setItem(organizationStorageKey(authUser?.organizationId), JSON.stringify(next))
  }

  const saveOwnPreferences = async (patch: {
    name?: string
    email?: string
    phone?: string
    theme?: AppTheme
    interfaceMode?: InterfaceMode | null
    clientId?: string
    clientTheme?: AppTheme | null
    newPassword?: string
    currentPassword?: string
  }) => {
    await waitForCloudSaves()
    const result = await settingsRequest('/api/account/profile', 'PATCH', patch)
    const accounts = storeRef.current.accounts
    acceptAccountUsers(
      accounts.map(account => (account.id === result.user.id ? { ...account, ...result.user } : account)),
    )
    if (patch.newPassword) setAuthUser(await getAuthSession())
    // Take only the profile fields. The response's role and modules are the stored account's, not the session's
    // (an Administrator gets every module the account has), so copying them hid pages such as Data explorer
    // until the page was reloaded.
    else
      setAuthUser(current => {
        if (!current || current.id !== result.user.id) return current
        const { name, email, phone, theme, interfaceMode, clientThemes } = result.user
        return {
          ...current,
          ...(name !== undefined && { name }),
          ...(email !== undefined && { email }),
          ...(phone !== undefined && { phone }),
          ...(theme !== undefined && { theme }),
          ...(interfaceMode !== undefined && { interfaceMode }),
          ...(clientThemes !== undefined && { clientThemes }),
        }
      })
  }

  const updateOwnProfile = async (profile: {
    name: string
    email: string
    phone: string
    theme: AppTheme
    newPassword?: string
    currentPassword?: string
  }) => {
    try {
      await saveOwnPreferences(profile)
      return profile.newPassword ? 'Password changed. Sign in with your new password.' : 'Profile updated.'
    } catch (error) {
      return error instanceof Error ? error.message : 'Profile save failed.'
    }
  }

  // Active pages recheck the session; every server action still verifies permissions.
  useVisiblePolling(
    async signal => {
      const session = await getAuthSession()
      if (signal.aborted) return
      setAuthUser(session)
      if (!session) {
        setStore(seedStore())
        setProfileOpen(false)
        setSelectedClientId(null)
        setSelectedProjectId(null)
      }
    },
    {
      enabled: Boolean(authUser && workspaceAutoRefreshAllowed(view, selectedClientId, selectedProjectId)),
      interval: 60_000,
      immediate: false,
      scope: `${authUser?.id}:${view}`,
    },
  )

  const clientName = (id?: string) =>
    id ? (store.clients.find(c => c.id === id)?.name ?? 'Unknown client') : 'General / no client'
  const projectName = (id?: string) =>
    id ? (store.projects.find(p => p.id === id)?.name ?? 'Unknown project') : 'No project'

  const openItems = useMemo(
    () =>
      store.items.filter(
        item =>
          (currentUser?.role !== 'Contributor' || item.assignedToUserId === currentUser.id) &&
          !isTaskClosed(item.status, store.taskSettings) &&
          !isWaitingOnDone(item.waitingOn, store.taskSettings),
      ),
    [store.items, store.taskSettings, currentUser],
  )

  const chooseTaskView = (next: { layout?: TaskLayout; group?: BoardGroup; subtasks?: boolean }) => {
    const view = {
      layout: next.layout ?? taskLayout,
      group: next.group ?? boardGroup,
      subtasks: next.subtasks ?? boardShowSubtasks,
    }
    setTaskLayout(view.layout)
    setBoardGroup(view.group)
    setBoardShowSubtasks(view.subtasks)
    if (!authUser) return
    try {
      localStorage.setItem(`ba-task-view:${authUser.organizationId}:${authUser.id}`, JSON.stringify(view))
    } catch {
      /* Keep the view usable when storage is unavailable. */
    }
  }

  const chooseClientLayout = (layout: ClientLayout) => {
    setClientLayout(layout)
    if (!authUser) return
    try {
      localStorage.setItem(`ba-client-layout:${authUser.organizationId}:${authUser.id}`, layout)
    } catch {
      /* Keep the view usable when storage is unavailable. */
    }
  }

  const visibleClients = useMemo(() => {
    const search = clientSearch.trim().toLocaleLowerCase()
    return store.clients
      .filter(client => clientArchiveFilter === 'all' || isArchived(client) === (clientArchiveFilter === 'archived'))
      .filter(
        client =>
          !search ||
          [client.name, client.contact, client.email, client.notes || ''].some(part =>
            part.toLocaleLowerCase().includes(search),
          ),
      )
      .map(client => {
        const projects = new Set(
          store.items.filter(item => item.clientId === client.id && item.projectId).map(item => item.projectId),
        )
        const tasks = openItems.filter(item => item.clientId === client.id)
        const next = tasks
          .filter(item => item.followUpDate)
          .sort((a, b) => a.followUpDate.localeCompare(b.followUpDate))[0]
        return { client, projectCount: projects.size, openTaskCount: tasks.length, next }
      })
      .sort((a, b) => {
        if (clientSort === 'name-desc') return b.client.name.localeCompare(a.client.name)
        if (clientSort === 'open-tasks')
          return b.openTaskCount - a.openTaskCount || a.client.name.localeCompare(b.client.name)
        if (clientSort === 'follow-up')
          return (
            (a.next?.followUpDate || '9999-12-31').localeCompare(b.next?.followUpDate || '9999-12-31') ||
            a.client.name.localeCompare(b.client.name)
          )
        return a.client.name.localeCompare(b.client.name)
      })
  }, [store.clients, store.items, openItems, clientArchiveFilter, clientSearch, clientSort])

  const openInquiryCount = openItems.filter(item => item.type === 'Inquiry').length

  const searchedItems = useMemo(() => {
    const q = query.trim().toLowerCase()
    return store.items
      .filter(item => {
        const text = [
          item.title,
          item.description,
          clientName(item.clientId),
          projectName(item.projectId),
          item.type,
          item.status,
        ]
          .join(' ')
          .toLowerCase()
        return !q || text.includes(q)
      })
      .filter(item => waitingFilter === 'All' || item.waitingOn === waitingFilter)
      .sort((a, b) => {
        const aOverdue = a.followUpDate && a.followUpDate < today ? 1 : 0
        const bOverdue = b.followUpDate && b.followUpDate < today ? 1 : 0
        return (
          bOverdue - aOverdue ||
          priorityRank[b.priority] - priorityRank[a.priority] ||
          (a.followUpDate || '9999').localeCompare(b.followUpDate || '9999')
        )
      })
  }, [store.items, query, waitingFilter, store.clients, store.projects, today])

  const actionCenterUsers = trackedActionCenterUsers(store.accounts)
  const resolvedActionCenterScope = resolveActionCenterScope(
    actionCenterScope,
    currentUser?.id || '',
    currentUser?.role || 'Viewer',
    store.accounts,
  )
  const actionCenterScopeLabel =
    resolvedActionCenterScope.kind === 'all'
      ? 'All Users’ Action Center'
      : resolvedActionCenterScope.kind === 'user'
        ? `${actionCenterUsers.find(account => account.id === resolvedActionCenterScope.userId)?.name || 'User'}’s Action Center`
        : 'My Action Center'
  const matchesActionCenterScope = (item: WorkItem) => itemMatchesActionCenterScope(item, resolvedActionCenterScope)
  const actionCenterWorkItems = store.items.filter(
    item =>
      matchesActionCenterScope(item) &&
      !isTaskClosed(item.status, store.taskSettings) &&
      !isWaitingOnDone(item.waitingOn, store.taskSettings),
  )
  const actionItems = searchedItems.filter(
    item =>
      matchesActionCenterScope(item) &&
      !isTaskClosed(item.status, store.taskSettings) &&
      !isWaitingOnDone(item.waitingOn, store.taskSettings),
  )
  const canEditActionItem = (item: WorkItem) =>
    canWriteTasks && (currentUser?.role === 'Administrator' || item.assignedToUserId === currentUser?.id)
  // The metric follows the built-in Developer option (by id, so a rename keeps it).
  // If an account removed it, count everything waiting on someone other than the default assignee.
  const developerWaitingOn = waitingOnOptions(store.taskSettings).find(
    option => option.id === 'developer' && !option.done,
  )
  const actionCenterWaitingTitle = developerWaitingOn ? `Waiting on ${developerWaitingOn.label}` : 'Waiting on others'
  const actionCenterWaitingDev = actionCenterWorkItems.filter(item =>
    developerWaitingOn
      ? item.waitingOn === developerWaitingOn.label
      : item.waitingOn !== defaultWaitingOn(store.taskSettings),
  )
  const actionCenterClientCount = new Set(actionCenterWorkItems.map(item => item.clientId).filter(Boolean)).size
  const actionCenterWaitingDevOverdue = actionCenterWaitingDev.filter(
    item => item.followUpDate && item.followUpDate < today,
  ).length
  const actionCenterInquiryCount = actionCenterWorkItems.filter(item => item.type === 'Inquiry').length
  useEffect(() => {
    if (
      actionCenterScope.startsWith('user:') &&
      !actionCenterUsers.some(account => account.id === actionCenterScope.slice('user:'.length))
    )
      setActionCenterScope('mine')
  }, [actionCenterScope, store.accounts])
  const dashboardAiContext = useMemo(() => {
    const client = store.clients.find(value => value.id === aiClientId)
    const project = store.projects.find(value => value.id === aiProjectId)
    const scopedItems = store.items.filter(
      item => (!aiClientId || item.clientId === aiClientId) && (!aiProjectId || item.projectId === aiProjectId),
    )
    const closedStatuses = new Set(
      store.taskSettings.statuses.filter(status => status.closed).map(status => status.label),
    )
    const openItems = scopedItems
      .filter(item => !closedStatuses.has(item.status) && !isWaitingOnDone(item.waitingOn, store.taskSettings))
      .slice(0, 20)
    const upcomingActivities = store.planner
      .filter(
        activity =>
          (!aiClientId || activity.clientId === aiClientId) &&
          (!aiProjectId || activity.projectId === aiProjectId) &&
          activity.status === 'Planned',
      )
      .slice(0, 15)
    const contextUser = currentUser || seedAccounts[0]
    return {
      currentUser: { id: contextUser.id, name: contextUser.name, role: contextUser.role, modules: contextUser.modules },
      client,
      project,
      openItems,
      recentItems: scopedItems.slice(0, 20),
      upcomingActivities,
      myAssignments: scopedItems.filter(item => item.assignedToUserId === contextUser.id).slice(0, 40),
      myRecentActivity: store.workEvents
        .filter(
          event =>
            event.actorUserId === contextUser.id ||
            event.assignedToUserId === contextUser.id ||
            (event.field === 'assignedToUserId' && event.oldValue === contextUser.id),
        )
        .slice(0, 40),
    }
  }, [
    aiClientId,
    aiProjectId,
    store.clients,
    store.projects,
    store.items,
    store.planner,
    store.taskSettings,
    store.workEvents,
    currentUser,
  ])
  const inquiryItems = searchedItems.filter(
    item => item.type === 'Inquiry' && !isTaskClosed(item.status, store.taskSettings),
  )
  const archivedInquiryItems = useMemo(() => {
    const q = query.trim().toLowerCase()
    return store.items
      .filter(
        item =>
          item.source === 'Discord' &&
          (item.type !== 'Inquiry' ||
            isTaskClosed(item.status, store.taskSettings) ||
            isWaitingOnDone(item.waitingOn, store.taskSettings)),
      )
      .filter(item => {
        const text = [
          item.title,
          item.description,
          clientName(item.clientId),
          projectName(item.projectId),
          item.type,
          item.status,
          item.sourceSender || '',
        ]
          .join(' ')
          .toLowerCase()
        return !q || text.includes(q)
      })
      .sort((a, b) => (b.resolvedDate || b.dateRaised).localeCompare(a.resolvedDate || a.dateRaised))
  }, [store.items, store.taskSettings, store.clients, store.projects, query])
  const newExternalInquiryCount = newExternalInquiryIds.filter(id =>
    store.items.some(
      item =>
        item.id === id &&
        item.type === 'Inquiry' &&
        !isTaskClosed(item.status, store.taskSettings) &&
        !isWaitingOnDone(item.waitingOn, store.taskSettings),
    ),
  ).length

  const filteredTasks = useMemo(() => {
    const due3 = addDays(today, 3)
    const due7 = addDays(today, 7)
    return searchedItems.filter(item => {
      if (isTaskArchived(store.items, item) !== (taskArchiveView === 'archived')) return false
      if (taskClientFilter === '__none__' && item.clientId) return false
      if (taskClientFilter && taskClientFilter !== '__none__' && item.clientId !== taskClientFilter) return false
      if (taskProjectFilter === '__none__' && item.projectId) return false
      if (taskProjectFilter && taskProjectFilter !== '__none__' && item.projectId !== taskProjectFilter) return false
      if (taskStatusFilter && item.status !== taskStatusFilter) return false
      if (taskDateFilter === 'due-3') return Boolean(item.dueDate && item.dueDate >= today && item.dueDate <= due3)
      if (taskDateFilter === 'due-7') return Boolean(item.dueDate && item.dueDate >= today && item.dueDate <= due7)
      if (taskDateFilter === 'followup-3')
        return Boolean(item.followUpDate && item.followUpDate >= today && item.followUpDate <= due3)
      if (taskDateFilter === 'followup-7')
        return Boolean(item.followUpDate && item.followUpDate >= today && item.followUpDate <= due7)
      if (taskDateFilter === 'overdue')
        return (
          Boolean((item.dueDate && item.dueDate < today) || (item.followUpDate && item.followUpDate < today)) &&
          !isTaskClosed(item.status, store.taskSettings)
        )
      return true
    })
  }, [
    searchedItems,
    store.items,
    taskArchiveView,
    taskClientFilter,
    taskProjectFilter,
    taskStatusFilter,
    taskDateFilter,
    store.taskSettings,
    today,
  ])
  const archivedTaskCount = useMemo(
    () => store.items.filter(item => !item.parentTaskId && isArchived(item)).length,
    [store.items],
  )
  const selectedClient = store.clients.find(client => client.id === selectedClientId) ?? null
  const selectedProject = store.projects.find(project => project.id === selectedProjectId) ?? null
  // The tab title names the page, so the browser's history list (long-press Back) tells pages apart.
  useEffect(() => {
    const page = selectedProject?.name || selectedClient?.name || (currentUser ? labels[view] : '')
    document.title = page ? `${page} · BA Client Ops Tracker` : 'BA Client Ops Tracker'
  }, [view, selectedProject?.name, selectedClient?.name, Boolean(currentUser)])
  const editingTask = editingTaskId ? (store.items.find(item => item.id === editingTaskId) ?? null) : null

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
  }, [view, hasTrackers, currentUser?.id])
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

  const weekStart = weekStartKey(today)
  const weekEnd = weekEndKey(today)
  const sortedPlanner = [...store.planner].sort(
    (a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime),
  )
  const todayActivities = sortedPlanner.filter(item => item.date === today && item.status !== 'Cancelled')
  const weekActivities = sortedPlanner.filter(
    item => item.date >= weekStart && item.date <= weekEnd && item.status !== 'Cancelled',
  )
  const todayFollowUps = actionCenterWorkItems
    .filter(item => item.followUpDate === today)
    .sort((a, b) => priorityRank[b.priority] - priorityRank[a.priority] || a.title.localeCompare(b.title))
  const weekFollowUps = actionCenterWorkItems
    .filter(item => item.followUpDate && item.followUpDate >= weekStart && item.followUpDate <= weekEnd)
    .sort(
      (a, b) =>
        a.followUpDate.localeCompare(b.followUpDate) ||
        priorityRank[b.priority] - priorityRank[a.priority] ||
        a.title.localeCompare(b.title),
    )
  const editingActivity = editingActivityId ? (store.planner.find(item => item.id === editingActivityId) ?? null) : null

  const openActivityModal = (activity?: PlannerActivity) => {
    if (!canWrite) return
    setEditingActivityId(activity?.id ?? null)
    setModal('activity')
  }

  const saveActivity = (activity: PlannerActivity) => {
    if (!canWrite) return
    const exists = store.planner.some(item => item.id === activity.id)
    persist({
      ...store,
      planner: exists
        ? store.planner.map(item => (item.id === activity.id ? activity : item))
        : [activity, ...store.planner],
    })
    setModal(null)
    setEditingActivityId(null)
  }

  const toggleActivityDone = (id: string) => {
    if (!canWrite) return
    persist({
      ...store,
      planner: store.planner.map(item =>
        item.id === id ? { ...item, status: item.status === 'Done' ? 'Planned' : 'Done' } : item,
      ),
    })
  }

  const assessDashboardAI = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const text = dashboardAiPrompt.trim()
    if (!text || dashboardAiBusy) return

    setDashboardAiBusy(true)
    setDashboardAiError('')
    setDashboardAiResult(null)

    const threadKey = `${currentUser?.id || 'unknown'}:${aiClientId || 'global'}:${aiProjectId || 'all'}`
    let threads: Record<string, AIMessage[]> = {}
    try {
      threads = JSON.parse(localStorage.getItem('ba-client-ops-ai-threads-v1') || '{}') as Record<string, AIMessage[]>
    } catch {
      threads = {}
    }
    const history = Array.isArray(threads[threadKey]) ? threads[threadKey] : []

    try {
      const result = await askBAAssistant({ message: text, context: dashboardAiContext, history: history.slice(-8) })
      const now = new Date().toISOString()
      const userMessage: AIMessage = { id: crypto.randomUUID(), role: 'user', content: text, createdAt: now }
      const nextThreads = { ...threads, [threadKey]: [...history, userMessage, ...assistantMessages(result)] }
      localStorage.setItem('ba-client-ops-ai-threads-v1', JSON.stringify(nextThreads))
      const wordCount = result.message.trim().split(/\s+/).filter(Boolean).length
      setDashboardAiResult({ message: result.message, wordCount })
    } catch (error) {
      setDashboardAiError(error instanceof Error ? error.message : 'The AI assistant could not respond.')
    } finally {
      setDashboardAiBusy(false)
    }
  }

  const openDashboardAiResult = () => {
    setAiPrompt('')
    setView('ai')
  }

  const applyAISuggestion = (suggestion: AISuggestion, contextClientId: string, contextProjectId: string) => {
    if (!canWriteTasks) return 'Task or Inbox write access is required to apply a suggestion.'
    const clientId = contextClientId || undefined
    const projectId = contextProjectId || undefined
    const locked = archivedWorkReason(store, { clientId, projectId })
    if (locked) return locked

    if (suggestion.kind === 'activity') {
      const activity: PlannerActivity = {
        id: crypto.randomUUID(),
        title: suggestion.title,
        date: suggestion.activityDate || suggestion.followUpDate || today,
        startTime: suggestion.activityTime || '',
        endTime: '',
        allDay: !suggestion.activityTime,
        source: 'Local',
        status: 'Planned',
        clientId,
        projectId,
        notes: suggestion.description || suggestion.rationale,
      }
      persist({ ...store, planner: [activity, ...store.planner] })
      return `Added tracker activity: ${suggestion.title}`
    }

    const type: ItemType =
      suggestion.kind === 'issue' ? 'Issue' : suggestion.kind === 'requirement' ? 'Requirement' : 'Follow-up'
    const item: WorkItem = {
      id: crypto.randomUUID(),
      clientId,
      projectId,
      title: suggestion.title,
      type,
      priority: suggestion.priority || 'Medium',
      status: defaultOpenTaskStatus(store.taskSettings),
      waitingOn:
        suggestion.waitingOn &&
        openWaitingOnOptions(store.taskSettings).some(option => option.label === suggestion.waitingOn)
          ? suggestion.waitingOn
          : defaultWaitingOn(store.taskSettings),
      assignedToUserId: currentUser?.id,
      owner: currentUser?.name || '',
      dateRaised: today,
      startDate: '',
      dueDate: '',
      followUpDate: suggestion.followUpDate || '',
      description: suggestion.description || suggestion.rationale,
      resolution: '',
      source: 'Internal',
    }
    persist({
      ...store,
      items: [item, ...store.items],
      activity: [
        {
          id: crypto.randomUUID(),
          clientId,
          projectId,
          date: today,
          text: `AI suggestion approved: created ${type.toLowerCase()} task — ${suggestion.title}`,
        },
        ...store.activity,
      ],
    })
    return `Created ${type.toLowerCase()} task: ${suggestion.title}`
  }
  return {
    acceptAccountUsers,
    closeRequest,
    actionCenterClientCount,
    actionCenterInquiryCount,
    actionCenterScope,
    actionCenterScopeLabel,
    actionCenterUsers,
    actionCenterWaitingDev,
    actionCenterWaitingDevOverdue,
    actionCenterWaitingTitle,
    actionCenterWorkItems,
    actionItems,
    activityRange,
    aiClientId,
    aiProjectId,
    aiPrompt,
    applyAISuggestion,
    applyCommentMutation,
    applyEvidenceMutation,
    applyTimeEntryMutation,
    archivedInquiryItems,
    assessDashboardAI,
    authChecking,
    authUser,
    boardGroup,
    boardShowSubtasks,
    canEditActionItem,
    canManageAccounts,
    canUseAI,
    canWrite,
    canWriteTasks,
    chooseClientLayout,
    chooseTaskView,
    clientArchiveFilter,
    clientLayout,
    clientName,
    clientSearch,
    clientSort,
    closedStatus,
    cloudMessage,
    cloudStatus,
    convertInquiry,
    createTrackerTasks,
    updateTrackerTasks,
    currentUser,
    dashboardAiBusy,
    dashboardAiError,
    dashboardAiPrompt,
    dashboardAiResult,
    deleteTask,
    documentLaunch,
    editingActivity,
    editingRecord,
    editingTask,
    movingToSeeds,
    setMovingToSeeds,
    moveWorkToSeeds,
    filteredTasks,
    handleLogin,
    handleGoogleLogin,
    handleLogout,
    handleNotificationAction,
    handleReadAllNotifications,
    hasModule,
    hubSyncing,
    inquiryItems,
    lastCloudSync,
    loginBusy,
    loginError,
    logoutBusy,
    modal,
    navCollapsed,
    newExternalInquiryCount,
    newExternalInquiryIds,
    notificationBusy,
    openActivityModal,
    openDashboardAiResult,
    openInquiryCount,
    openItems,
    openNotification,
    openRtms,
    openSubtaskCreator,
    openTaskEditor,
    openTrackerLink,
    pageActive,
    persist,
    profileOpen,
    projectArchiveFilter,
    projectName,
    query,
    railTip,
    recoverCloud,
    recoveringCloud,
    refreshNotifications,
    refreshWorkspace,
    refreshingCloud,
    reorderSubtasks,
    resetToken,
    resolveItem,
    archiveTask,
    reopenTask,
    archivedTaskCount,
    taskArchiveView,
    setTaskArchiveView,
    resolvedActionCenterScope,
    rtmContext,
    saveActivity,
    saveConflict,
    saveLifecycleRecord,
    saveOwnPreferences,
    saveRtms,
    saveTaskEdit,
    selectedClient,
    selectedClientId,
    selectedProject,
    selectedProjectClientId,
    selectedProjectId,
    setActionCenterScope,
    setActivityRange,
    setAiClientId,
    setAiProjectId,
    setAiPrompt,
    setAuthUser,
    setClientArchiveFilter,
    setClientSearch,
    setClientSort,
    setDashboardAiError,
    setDashboardAiPrompt,
    setDashboardAiResult,
    setEditingActivityId,
    setEditingRecord,
    setEditingTaskId,
    setLoginError,
    setModal,
    setNewExternalInquiryIds,
    setProfileOpen,
    setProjectArchiveFilter,
    setQuery,
    setResetToken,
    setRtmContext,
    setSelectedClientId,
    setSelectedProjectClientId,
    setSelectedProjectId,
    setStore,
    setTaskClientFilter,
    setTaskDateFilter,
    setTaskPreset,
    setTaskProjectFilter,
    setTaskStatusFilter,
    setView,
    setWaitingFilter,
    store,
    taskClientFilter,
    taskDateFilter,
    taskEditSaving,
    taskLayout,
    taskPreset,
    taskProjectFilter,
    taskStatusFilter,
    today,
    todayActivities,
    todayFollowUps,
    toggleActivityDone,
    toggleNav,
    trackerLinks,
    updateOwnProfile,
    updateTaskStatus,
    updateTaskWaitingOn,
    view,
    visibleClients,
    visibleNavItems,
    waitingFilter,
    weekActivities,
    weekFollowUps,
  }
}

export type AppState = ReturnType<typeof useAppState>
/** The person using the app, once they are signed in. Screens are only shown then. */
export type SignedInUser = NonNullable<AppState['currentUser']>
