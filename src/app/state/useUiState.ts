/**
 * The app's screen state: which page and record are open, filters and layouts, dialogs, the signed-in person
 * and the save status. Only state and small toggles; the other state hooks act on it.
 */
import type { View, ClientLayout } from '../navigation'
import { routeFromLocation } from '../routes'
import { useBusinessDate } from '../../shared/businessDate'
import { usePageActive } from '../useVisiblePolling'
import { gitFollowSession } from '../../features/trackers/gitRefresh'
import { WORK_HUB_INTEGRATIONS, workHubSync } from '../../features/work-hub/workHubSync'
import { useWorkHubSync } from '../../features/work-hub/useWorkHubSync'
import type { TaskLink } from '../../features/trackers/trackerApi'
import type { ActionCenterScopeSelection } from '../../features/action-center/actionCenterScope'
import { useState, useEffect, useRef } from 'react'
import type { AuthUser } from '../../features/accounts/auth'
import type { CloudStorageStatus } from '../cloudStore'
import type { DrfPrefill } from '../../features/documents/drfPrefill'
import type { TaskLayout, BoardGroup } from '../../features/tasks/taskBoardModel'
import type { CalendarDate } from '../../features/tasks/taskViews'
import { confirmWord } from '../../features/tasks/closeSubtasks'
import type { CloseWithSubtasksRequest } from '../../features/tasks/CloseWithSubtasksDialog'
import type { WaitingOn, ItemType, WorkItem } from '../../shared/types'
import { readSidebarCollapsed, writeSidebarCollapsed } from '../sidebarState'
import { useRailTip } from '../../shared/ui/RailTip'
import { type Store, initialStore } from '../store'

export function useUiState() {
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
  // The Calendar view places tasks by their due or follow-up date.
  const [taskCalendarDate, setTaskCalendarDate] = useState<CalendarDate>('due')
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
  // GIT Tracker rows follow their tickets: brought up to date once at sign-in and each time the app loads.
  useEffect(() => {
    gitFollowSession(authUser)
  }, [
    authUser?.id,
    authUser?.organizationId,
    authUser?.accountType,
    authUser?.status,
    authUser?.lastLoginAt,
    authUser?.modules.includes('trackers'),
  ])
  const storeRef = useRef(store)
  const workspaceRefreshBusy = useRef(false)
  const [refreshingCloud, setRefreshingCloud] = useState(false)

  useEffect(() => {
    storeRef.current = store
  }, [store])

  return {
    authUser,
    storeRef,
    setSaveConflict,
    setCloudStatus,
    setCloudMessage,
    setStore,
    setRecoveringCloud,
    setLastCloudSync,
    resetToken,
    setAuthChecking,
    setAuthUser,
    setActionCenterScope,
    setClientLayout,
    setTaskLayout,
    setBoardGroup,
    setBoardShowSubtasks,
    setTaskCalendarDate,
    workspaceRefreshBusy,
    setRefreshingCloud,
    cloudStatus,
    view,
    selectedClientId,
    selectedProjectId,
    notificationBusy,
    setNotificationBusy,
    setRtmContext,
    setSelectedClientId,
    setSelectedProjectId,
    setView,
    setLifecycleSaving,
    today,
    setLoginBusy,
    setLoginError,
    logoutBusy,
    setLogoutBusy,
    setProfileOpen,
    setNewExternalInquiryIds,
    setEditingRecord,
    store,
    lifecycleSaving,
    setModal,
    setDocumentLaunch,
    setEditingTaskId,
    selectedProjectClientId,
    setSelectedProjectClientId,
    taskLayout,
    boardGroup,
    boardShowSubtasks,
    taskCalendarDate,
    clientSearch,
    clientArchiveFilter,
    clientSort,
    query,
    waitingFilter,
    actionCenterScope,
    aiClientId,
    aiProjectId,
    newExternalInquiryIds,
    taskArchiveView,
    taskClientFilter,
    taskProjectFilter,
    taskStatusFilter,
    taskDateFilter,
    editingTaskId,
    confirmCloseWithSubtasks,
    closedSubtasksNote,
    setTaskArchiveView,
    setTaskEditSaving,
    setTrackerLinks,
    setTaskPreset,
    editingActivityId,
    setEditingActivityId,
    dashboardAiPrompt,
    dashboardAiBusy,
    setDashboardAiBusy,
    setDashboardAiError,
    setDashboardAiResult,
    setAiPrompt,
    closeRequest,
    activityRange,
    aiPrompt,
    authChecking,
    clientLayout,
    cloudMessage,
    dashboardAiError,
    dashboardAiResult,
    documentLaunch,
    editingRecord,
    movingToSeeds,
    setMovingToSeeds,
    hubSyncing,
    lastCloudSync,
    loginBusy,
    loginError,
    modal,
    navCollapsed,
    pageActive,
    profileOpen,
    projectArchiveFilter,
    railTip,
    recoveringCloud,
    refreshingCloud,
    rtmContext,
    saveConflict,
    setActivityRange,
    setAiClientId,
    setAiProjectId,
    setClientArchiveFilter,
    setClientSearch,
    setClientSort,
    setDashboardAiPrompt,
    setProjectArchiveFilter,
    setQuery,
    setResetToken,
    setTaskClientFilter,
    setTaskDateFilter,
    setTaskProjectFilter,
    setTaskStatusFilter,
    setWaitingFilter,
    taskEditSaving,
    taskPreset,
    toggleNav,
    trackerLinks,
  }
}

export type UiState = ReturnType<typeof useUiState>
