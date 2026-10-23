import { businessDateKey, useBusinessDate } from './businessDate'
import { usePageActive, useVisiblePolling } from './useVisiblePolling'
import { workspaceAutoRefreshAllowed } from './activePolling'
import { workHubSync, WORK_HUB_INTEGRATIONS } from './workHubSync'
import { useWorkHubSync } from './useWorkHubSync'
import RequirementsTraceability from './RequirementsTraceability'
import RtmTaskLinks from './RtmTaskLinks'
import { assertRtmMutation, reconcileRtm, type RtmMatrix, type RtmLink } from './rtm'
import { DocHubHistory } from './DocHubPanel'
import { composeEmail, EmailComposerHost, useEmailEnabled } from './EmailComposer'
import { docHubLabels } from './dochub'
import ActivityCommentPreview from './ActivityCommentPreview'
import NotificationCenter from './NotificationCenter'
import RecordEditDialog from './RecordEditDialog'
import LifecycleControls from './LifecycleControls'
import { assertLifecycleMutation, archivedWorkReason, isArchived, stableRecord } from './lifecycle'
import { canBrowseTeamActionCenter, itemMatchesActionCenterScope, resolveActionCenterScope, trackedActionCenterUsers, type ActionCenterScopeSelection } from './actionCenterScope'
import { applySubtaskAssignmentInheritance, normalizeSubtaskAssignmentInheritance } from './subtaskAssignment'
import { FormEvent, type ClipboardEvent, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowRight,
  Archive,
  BarChart3,
  BriefcaseBusiness,
  Building2,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleDot,
  Clock3,
  ExternalLink,
  Eye,
  EyeOff,
  FileText,
  GripVertical,
  LayoutGrid,
  Columns3,
  Inbox,
  LayoutDashboard,
  List,
  Pencil,
  Paperclip,
  HardDrive,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  LogOut,
  UserRound,
  LockKeyhole,
  MessageSquareText,
  Settings2,
  Sparkles,
  Table2,
  Trash2,
  Upload,
  Users,
  X,
} from 'lucide-react'
import AIAssistant from './AIAssistant'
import DocumentCreation from './DocumentCreation'
import InternalAdmin from './InternalAdmin'
import { ForgotPassword, ResetPassword } from './PasswordRecovery'
import { ALL_MODULES, defaultModulesForRole } from './access'
import { getAuthSession, login, logout, type AuthUser } from './auth'
import { loadCloudStore, resetCloudSession, pendingCloudEdits, queueCloudStoreSave, waitForCloudSaves, type CloudStorageStatus } from './cloudStore'
import Reports from './Reports'
import Settings, { settingsRequest } from './Settings'
import WorkHub from './WorkHub'
import './communications.css'
import './github.css'
import AccountUsers from './AccountUsers'
import ThemePreferences from './ThemePreferences'
import { askBAAssistant, type AIMessage, type AISuggestion } from './ai'
import { defaultWaitingOn, doneWaitingOn, findWaitingOn, isWaitingOnDone, openWaitingOnOptions, waitingOnOptions, waitingOnTone } from './waitingOn'
import { defaultTaskSettings, seedAccounts, seedActivity, seedClients, seedItems, seedPlannerActivities, seedProjects } from './data'
import GoogleCalendarPanel from './GoogleCalendarPanel'
import { deleteTaskEvidence, TASK_EVIDENCE_MAX_BYTES, taskEvidenceUrl, uploadTaskEvidence, type TaskEvidenceMutationResult } from './taskEvidence'
import { loadNotifications, markAllNotificationsRead, updateNotification } from './notifications'
import { addTaskComment, type TaskCommentMutationResult } from './taskComments'
import TaskBoard from './TaskBoard'
import TaskEffort from './TaskEffort'
import { type BoardGroup, type TaskLayout } from './taskBoardModel'
import { normalizeEstimate } from './effort'
import type { TimeEntryMutationResult } from './timeEntries'
import type { ActivityLog, AppModule, AppNotification, Client, ItemType, PlannerActivity, Priority, Project, TaskColumnKey, TaskEvidence, TaskSettings, UserAccount, WaitingOn, WorkActivityEvent, WorkItem } from './types'
import { normalizeAppTheme, normalizeClientThemes, themeForContext, THEME_OPTIONS, type AppTheme } from './theme'
import { normalizeInterfaceMode, type InterfaceMode } from './appearance'
import { APP_VERSION } from './version'

type View = 'action' | 'clients' | 'projects' | 'inbox' | 'items' | 'documents' | 'requirements' | 'reports' | 'ai' | 'settings' | 'internal-admin' | 'users' | 'themes'
type ClientLayout = 'tiles' | 'list' | 'table'

type Store = {
  schemaVersion: number
  rtms: RtmMatrix[]
  clients: Client[]
  projects: Project[]
  items: WorkItem[]
  activity: ActivityLog[]
  planner: PlannerActivity[]
  workEvents: WorkActivityEvent[]
  notifications: AppNotification[]
  accounts: UserAccount[]
  taskSettings: TaskSettings
}

const STORE_SCHEMA_VERSION = 6
const STORAGE_KEY = 'ba-client-ops-tracker-v2'
const LEGACY_STORAGE_KEY = 'ba-client-ops-tracker-v1'
const organizationStorageKey = (organizationId?: string) => organizationId ? `${STORAGE_KEY}:${organizationId}` : STORAGE_KEY
function localDateKey(date: Date) {
  const yyyy = date.getFullYear()
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}


const seedStore = (): Store => ({
  schemaVersion: STORE_SCHEMA_VERSION,
  rtms: [],
  clients: seedClients,
  projects: seedProjects,
  items: seedItems,
  activity: seedActivity,
  planner: seedPlannerActivities,
  workEvents: [],
  notifications: [],
  accounts: seedAccounts,
  taskSettings: defaultTaskSettings,
})

const legacyDemoIds = {
  clients: new Set(['c1', 'c2', 'c3']),
  projects: new Set(['p1', 'p2', 'p3']),
  items: new Set(['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7']),
  activity: new Set(['a1', 'a2', 'a3', 'a4']),
  planner: new Set(['pa1', 'pa2', 'pa3', 'pa4']),
  accounts: new Set(['u1', 'u2', 'u3']),
}

function normalizeAccount(value: Partial<UserAccount>, index: number): UserAccount | null {
  if (!value || !value.id || legacyDemoIds.accounts.has(String(value.id))) return null
  const role = value.role === 'Administrator' || value.role === 'Viewer' ? value.role : 'Contributor'
  const username = String(value.username || value.email?.split('@')[0] || value.name || `user${index + 1}`).replace(/\s+/g, '')
  return {
    id: String(value.id),
    username,
    passwordHash: String(value.passwordHash || ''),
    name: String(value.name || username),
    email: String(value.email || ''),
    phone: String(value.phone || ''),
    role,
    modules: Array.isArray(value.modules) ? value.modules.filter((module): module is AppModule => ALL_MODULES.includes(module as AppModule)) : defaultModulesForRole(role),
    status: value.status === 'Disabled' ? 'Disabled' : 'Active',
    createdAt: String(value.createdAt || businessDateKey()),
    theme: normalizeAppTheme(value.theme),
    interfaceMode: normalizeInterfaceMode(value.interfaceMode),
    clientThemes: normalizeClientThemes(value.clientThemes),
  }
}

function normalizeTaskSettings(value: Partial<TaskSettings> | undefined): TaskSettings {
  const statuses = Array.isArray(value?.statuses)
    ? value!.statuses
        .filter((status) => status && String(status.label || '').trim())
        .map((status, index) => ({
          id: String(status.id || `status-${index + 1}`),
          label: String(status.label).trim(),
          closed: Boolean(status.closed),
        }))
    : []
  const uniqueStatuses = statuses.filter((status, index, all) => all.findIndex((candidate) => candidate.label.toLowerCase() === status.label.toLowerCase()) === index)
  const safeStatuses = uniqueStatuses.length ? uniqueStatuses : defaultTaskSettings.statuses.map((status) => ({ ...status }))
  const allowedColumns: TaskColumnKey[] = ['status', 'client', 'project', 'type', 'waitingOn', 'priority', 'owner', 'startDate', 'dueDate', 'followUpDate']
  const visibleColumns = Array.isArray(value?.visibleColumns)
    ? value!.visibleColumns.filter((column): column is TaskColumnKey => allowedColumns.includes(column as TaskColumnKey))
    : [...defaultTaskSettings.visibleColumns]
  if (!visibleColumns.includes('status')) visibleColumns.unshift('status')
  if (!visibleColumns.includes('startDate')) {
    const dueIndex = visibleColumns.indexOf('dueDate')
    visibleColumns.splice(dueIndex >= 0 ? dueIndex : visibleColumns.length, 0, 'startDate')
  }
  return { statuses: safeStatuses, visibleColumns: [...new Set(visibleColumns)], waitingOn: waitingOnOptions(value) }
}

function isTaskClosed(status: string, settings: TaskSettings) {
  return settings.statuses.find((candidate) => candidate.label === status)?.closed ?? ['Resolved', 'Closed'].includes(status)
}

function defaultOpenTaskStatus(settings: TaskSettings) {
  return settings.statuses.find((status) => !status.closed)?.label || 'Open'
}

function defaultClosedTaskStatus(settings: TaskSettings) {
  return settings.statuses.find((status) => status.closed)?.label || 'Resolved'
}

const normalizeStore = (value: unknown, fallback: Store = seedStore()): Store => {
  const parsed = value && typeof value === 'object' ? value as Partial<Store> : {}
  const legacy = Number(parsed.schemaVersion || 0) < STORE_SCHEMA_VERSION
  const clients = Array.isArray(parsed.clients) ? parsed.clients.filter((item) => !legacy || !legacyDemoIds.clients.has(item.id)) : fallback.clients
  const rawProjects = Array.isArray(parsed.projects) ? parsed.projects.filter((item) => !legacy || !legacyDemoIds.projects.has(item.id)) : fallback.projects
  const projects: Project[] = rawProjects.map((project) => ({
    ...project,
    id: String(project.id),
    name: String(project.name || 'Untitled project'),
    status: project.status === 'Active' || project.status === 'UAT' || project.status === 'Closing' || project.status === 'Closed' ? project.status : 'Discovery',
    targetDate: String(project.targetDate || ''),
    summary: String(project.summary || ''),
  }))
  const items = Array.isArray(parsed.items) ? parsed.items.filter((item) => !legacy || !legacyDemoIds.items.has(item.id)) : fallback.items
  const activity = Array.isArray(parsed.activity) ? parsed.activity.filter((item) => !legacy || !legacyDemoIds.activity.has(item.id)) : fallback.activity
  const planner = Array.isArray(parsed.planner) ? parsed.planner.filter((item) => !legacy || !legacyDemoIds.planner.has(item.id)) : fallback.planner
  const workEvents = Array.isArray(parsed.workEvents) ? parsed.workEvents.filter((event) => event && event.id && event.taskId && event.actorUserId) : []
  const notifications = Array.isArray(parsed.notifications) ? parsed.notifications.filter((notification) => notification && notification.id && notification.recipientUserId && notification.createdAt).map((notification) => ({
    ...notification,
    id: String(notification.id),
    dedupeKey: String(notification.dedupeKey || notification.id),
    recipientUserId: String(notification.recipientUserId),
    createdAt: String(notification.createdAt),
    title: String(notification.title || 'Notification'),
    message: String(notification.message || ''),
  })) as AppNotification[] : []
  const migratedAccounts = Array.isArray(parsed.accounts) ? parsed.accounts.map((account, index) => normalizeAccount(account, index)).filter((account): account is UserAccount => Boolean(account)) : []
  const accounts = migratedAccounts.length ? migratedAccounts : [...seedAccounts]
  if (!accounts.some((account) => account.role === 'Administrator' && account.status === 'Active')) accounts.unshift(seedAccounts[0])
  const taskSettings = normalizeTaskSettings(parsed.taskSettings)
  const migratedItems = normalizeSubtaskAssignmentInheritance(items.map((item, index) => ({
    ...item,
    dueDate: item.dueDate || '',
    startDate: item.startDate || '',
    assignedToUserId: item.assignedToUserId || undefined,
    status: item.status || defaultOpenTaskStatus(taskSettings),
    subtaskOrder: item.parentTaskId ? (typeof item.subtaskOrder === 'number' && Number.isFinite(item.subtaskOrder) ? item.subtaskOrder : index) : undefined,
    evidence: Array.isArray(item.evidence) ? item.evidence.filter((entry) => entry && entry.id && entry.fileName && entry.storagePath).map((entry) => ({
      id: String(entry.id),
      fileName: String(entry.fileName),
      mimeType: String(entry.mimeType || 'application/octet-stream'),
      fileSize: Number(entry.fileSize || 0),
      storagePath: String(entry.storagePath),
      uploadedAt: String(entry.uploadedAt || ''),
      uploadedBy: String(entry.uploadedBy || ''),
      uploadedByName: String(entry.uploadedByName || ''),
      kind: entry.kind === 'Screenshot' ? 'Screenshot' as const : 'File' as const,
    })) : [],
    comments: Array.isArray(item.comments) ? item.comments.filter((comment) => comment && comment.id && comment.text).map((comment) => ({
      id: String(comment.id),
      text: String(comment.text),
      createdAt: String(comment.createdAt || ''),
      createdBy: String(comment.createdBy || 'system'),
      createdByName: String(comment.createdByName || 'System'),
      kind: comment.kind === 'User' ? 'User' as const : 'System' as const,
      eventType: comment.eventType === 'DOCHUB' ? 'DOCHUB' as const : comment.eventType === 'FOLLOW_UP_AUTO_MOVED' ? 'FOLLOW_UP_AUTO_MOVED' as const : undefined,
      documentId: comment.documentId,
      previousFollowUpDate: comment.previousFollowUpDate ? String(comment.previousFollowUpDate) : undefined,
      nextFollowUpDate: comment.nextFollowUpDate ? String(comment.nextFollowUpDate) : undefined,
      daysMoved: Number.isFinite(comment.daysMoved) ? Number(comment.daysMoved) : undefined,
    })) : [],
  })))
  return { schemaVersion: STORE_SCHEMA_VERSION, rtms: Array.isArray(parsed.rtms) ? parsed.rtms : [], clients, projects, items: migratedItems, activity, planner, workEvents, notifications, accounts, taskSettings }
}

const initialStore = (): Store => {
  for (const key of [STORAGE_KEY, LEGACY_STORAGE_KEY]) {
    const saved = localStorage.getItem(key)
    if (!saved) continue
    try {
      const normalized = normalizeStore(JSON.parse(saved), seedStore())
      localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized))
      return normalized
    } catch {
      // Try the next source.
    }
  }
  return seedStore()
}

function workEventsForItemChanges(current: Store, next: Store, actor: AuthUser | null): WorkActivityEvent[] {
  if (!actor || actor.accountType === 'platform') return []
  const occurredAt = new Date().toISOString()
  const date = businessDateKey(occurredAt)
  const before = new Map(current.items.map((item) => [item.id, item]))
  const after = new Map(next.items.map((item) => [item.id, item]))
  const assigneeName = (id?: string) => id ? next.accounts.find((user) => user.id === id)?.name || current.accounts.find((user) => user.id === id)?.name || 'Unknown user' : undefined
  const make = (item: WorkItem, action: WorkActivityEvent['action'], summary: string, field?: string, oldValue?: string, newValue?: string): WorkActivityEvent => ({
    id: crypto.randomUUID(), occurredAt, date, actorUserId: actor.id, actorName: actor.name, actorRole: actor.role,
    assignedToUserId: item.assignedToUserId, assignedToName: assigneeName(item.assignedToUserId), clientId: item.clientId,
    projectId: item.projectId, taskId: item.id, parentTaskId: item.parentTaskId, itemTitle: item.title,
    itemKind: item.parentTaskId ? 'Subtask' : 'Task', action, summary, field, oldValue, newValue,
  })
  const events: WorkActivityEvent[] = []
  for (const [id, item] of after) {
    const previous = before.get(id)
    if (!previous) {
      events.push(make(item, 'created', `${actor.name} created ${item.parentTaskId ? 'subtask' : 'task'} “${item.title}”.`))
      if (item.assignedToUserId) events.push(make(item, 'assigned', `${actor.name} assigned “${item.title}” to ${assigneeName(item.assignedToUserId)}.`, 'assignedToUserId', '', item.assignedToUserId))
      continue
    }
    if (previous.assignedToUserId !== item.assignedToUserId) {
      const action = previous.assignedToUserId ? 'reassigned' : 'assigned'
      const from = assigneeName(previous.assignedToUserId)
      const to = assigneeName(item.assignedToUserId)
      events.push(make(item, action, item.assignedToUserId ? `${actor.name} ${action === 'reassigned' ? `reassigned “${item.title}” from ${from} to` : `assigned “${item.title}” to`} ${to}.` : `${actor.name} removed the assignee from “${item.title}”.`, 'assignedToUserId', previous.assignedToUserId || '', item.assignedToUserId || ''))
    }
    if (previous.startDate !== item.startDate && item.startDate) events.push(make(item, 'started', `${actor.name} set the start date of “${item.title}” to ${item.startDate}.`, 'startDate', previous.startDate || '', item.startDate))
    if (previous.status !== item.status) {
      const wasClosed = isTaskClosed(previous.status, next.taskSettings)
      const isClosed = isTaskClosed(item.status, next.taskSettings)
      const action: WorkActivityEvent['action'] = isClosed ? 'completed' : wasClosed ? 'reopened' : item.status === 'In Progress' ? 'started' : 'status_changed'
      events.push(make(item, action, `${actor.name} changed “${item.title}” from ${previous.status} to ${item.status}.`, 'status', previous.status, item.status))
    }
    for (const [field, label] of [['priority', 'priority'], ['waitingOn', 'waiting on'], ['dueDate', 'due date'], ['followUpDate', 'follow-up date']] as const) {
      if (String(previous[field] || '') !== String(item[field] || '')) events.push(make(item, 'updated', `${actor.name} changed the ${label} for “${item.title}”.`, field, String(previous[field] || ''), String(item[field] || '')))
    }
  }
  for (const [id, item] of before) if (!after.has(id)) events.push(make(item, 'deleted', `${actor.name} deleted ${item.parentTaskId ? 'subtask' : 'task'} “${item.title}”.`))
  return events
}

const labels: Record<View, string> = {
  requirements: 'Requirements & Traceability',
  action: 'My Action Center',
  clients: 'Clients',
  projects: 'Projects',
  inbox: 'Work Hub',
  items: 'Tasks',
  documents: 'Document Creation',
  reports: 'Reports',
  ai: 'AI BA Assistant',
  settings: 'Settings',
  users: 'Users & Permissions',
  themes: 'My Themes',
  'internal-admin': 'BXI-Core Internal Admin',
}

const navItems: { id: AppModule; label: string; icon: typeof LayoutDashboard }[] = [
  { id: 'action', label: 'Action Center', icon: LayoutDashboard },
  { id: 'clients', label: 'Clients', icon: Users },
  { id: 'projects', label: 'Projects', icon: BriefcaseBusiness },
  { id: 'inbox', label: 'Work Hub', icon: Inbox },
  { id: 'items', label: 'Tasks', icon: Archive },
  { id: 'requirements', label: 'Requirements & Traceability', icon: Table2 },
  { id: 'documents', label: 'Document Creation', icon: FileText },
  { id: 'reports', label: 'Reports', icon: BarChart3 },
  { id: 'ai', label: 'AI BA Assistant', icon: Sparkles },
  { id: 'settings', label: 'Settings', icon: Settings2 },
]

const priorityRank: Record<Priority, number> = { Urgent: 4, High: 3, Medium: 2, Low: 1 }

function todayOrLater(date: string) {
  return date && date >= businessDateKey()
}

function niceDate(date: string) {
  if (!date) return '—'
  const [year, month, day] = date.split('-').map(Number)
  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: year === new Date().getFullYear() ? undefined : 'numeric' }).format(
    new Date(Date.UTC(year, month - 1, day)),
  )
}

function dateFromKey(date: string) {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(year, month - 1, day)
}

function addDays(date: string, amount: number) {
  const next = dateFromKey(date)
  next.setDate(next.getDate() + amount)
  return localDateKey(next)
}

function weekStartKey(date: string) {
  const value = dateFromKey(date)
  return addDays(date, -value.getDay())
}

function weekEndKey(date: string) {
  return addDays(weekStartKey(date), 6)
}

function activityTime(activity: PlannerActivity) {
  if (activity.allDay) return 'All day'
  if (!activity.startTime) return 'Time not set'
  return activity.endTime ? `${activity.startTime}–${activity.endTime}` : activity.startTime
}

function App() {
  const today = useBusinessDate()
  const [documentLaunch,setDocumentLaunch]=useState<{taskId:string;flow:'drf'|'signoff';nonce:number}>()

  const [resetToken, setResetToken] = useState<string | null>(() => new URLSearchParams(window.location.hash.slice(1)).get('reset-password'))
  const [store, setStore] = useState<Store>(initialStore)
  // Returning from the Google Drive consent screen opens Settings so the result is shown; others fall back below.
  const [view, setView] = useState<View>(() => { const hash = new URLSearchParams(window.location.hash.slice(1)); return hash.has('drive') ? 'settings' : hash.has('gmail') ? 'inbox' : 'action' })
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
  const [waitingFilter, setWaitingFilter] = useState<'All' | WaitingOn>('All')
  const [taskClientFilter, setTaskClientFilter] = useState('')
  const [taskProjectFilter, setTaskProjectFilter] = useState('')
  const [taskStatusFilter, setTaskStatusFilter] = useState('')
  const [taskDateFilter, setTaskDateFilter] = useState<'All' | 'due-3' | 'due-7' | 'followup-3' | 'followup-7' | 'overdue'>('All')
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null)
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [selectedProjectClientId, setSelectedProjectClientId] = useState<string | null>(null)
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null)
  const [taskEditSaving, setTaskEditSaving] = useState(false)
  const [taskPreset, setTaskPreset] = useState<{ clientId?: string; projectId?: string; type?: ItemType; parentTaskId?: string } | null>(null)
  const [modal, setModal] = useState<'item' | 'taskEdit' | 'client' | 'project' | 'activity' | null>(null)
  const [editingActivityId, setEditingActivityId] = useState<string | null>(null)
  const [aiClientId, setAiClientId] = useState('')
  const [aiProjectId, setAiProjectId] = useState('')
  const [aiPrompt, setAiPrompt] = useState('')
  const [activityRange, setActivityRange] = useState<'today' | 'week'>('today')
  const [actionCenterScope, setActionCenterScope] = useState<ActionCenterScopeSelection>('mine')
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
  const [newExternalInquiryIds, setNewExternalInquiryIds] = useState<string[]>([])
  const [notificationBusy, setNotificationBusy] = useState(false)
  const [rtmContext, setRtmContext] = useState<{ clientId?: string; projectId?: string }>({})
  const pageActive = usePageActive()
  const hubSync = useWorkHubSync()
  const hubSyncing = hubSync.allRunning || WORK_HUB_INTEGRATIONS.some(id => hubSync.integrations[id].phase === 'syncing')
  useEffect(() => { void workHubSync.setSession(authUser) }, [authUser?.id, authUser?.organizationId, authUser?.accountType, authUser?.status, authUser?.lastLoginAt, authUser?.modules.includes('inbox')])
  const storeRef = useRef(store)
  const workspaceRefreshBusy = useRef(false)
  const [refreshingCloud, setRefreshingCloud] = useState(false)

  useEffect(() => { storeRef.current = store }, [store])

  useEffect(() => {
    const onConflict = (event: Event) => {
      const message = (event as CustomEvent<string>).detail
      try { localStorage.setItem(`${organizationStorageKey(authUser?.organizationId)}:pending-edits`, JSON.stringify(pendingCloudEdits<Store>() || storeRef.current)) } catch { /* The on-screen draft remains available. */ }
      setSaveConflict(message); setCloudStatus('error'); setCloudMessage(message)
    }
    window.addEventListener('workspace-save-conflict', onConflict)
    return () => window.removeEventListener('workspace-save-conflict', onConflict)
  }, [authUser?.organizationId])

  const recoverCloud = async () => {
    setRecoveringCloud(true)
    try {
      const activePending = pendingCloudEdits<Store>()
      const pending = activePending ? JSON.stringify(activePending, null, 2) : localStorage.getItem(`${organizationStorageKey(authUser?.organizationId)}:pending-edits`) || JSON.stringify(storeRef.current, null, 2)
      localStorage.setItem(`${organizationStorageKey(authUser?.organizationId)}:pending-edits`, pending)
      const url = URL.createObjectURL(new Blob([pending], { type: 'application/json' }))
      const link = document.createElement('a'); link.href = url; link.download = `pending-workspace-edits-${Date.now()}.json`; link.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      const result = await loadCloudStore<Store>({ recover: true })
      if (!result.configured || !result.data) throw new Error('The latest workspace could not be loaded. Your pending edits are retained.')
      const next = normalizeStore(result.data, seedStore())
      storeRef.current = next; setStore(next)
      localStorage.setItem(organizationStorageKey(authUser?.organizationId), JSON.stringify(next))
      localStorage.removeItem(`${organizationStorageKey(authUser?.organizationId)}:pending-edits`)
      setLastCloudSync(result.updatedAt || ''); setSaveConflict(''); setCloudStatus('synced')
      setCloudMessage('Latest workspace loaded. Reapply your edits from the downloaded copy.')
    } catch (error) { setCloudMessage(error instanceof Error ? error.message : 'Reload failed.') }
    finally { setRecoveringCloud(false) }
  }


  useEffect(() => {
    let cancelled = false
    if (resetToken !== null) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search)
      setAuthChecking(false)
      return
    }
    void getAuthSession().then((user) => {
      if (!cancelled) setAuthUser(user)
    }).catch((error) => {
      console.error(error)
    }).finally(() => {
      if (!cancelled) setAuthChecking(false)
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => { setActionCenterScope('mine') }, [authUser?.id, authUser?.organizationId])

  useEffect(() => {
    if (!authUser) { setClientLayout('tiles'); return }
    try {
      const saved = localStorage.getItem(`ba-client-layout:${authUser.organizationId}:${authUser.id}`)
      setClientLayout(saved === 'list' || saved === 'table' ? saved : 'tiles')
    } catch { setClientLayout('tiles') }
  }, [authUser?.id, authUser?.organizationId])

  useEffect(() => {
    setTaskLayout('table'); setBoardGroup('status'); setBoardShowSubtasks(false)
    if (!authUser) return
    try {
      const saved = JSON.parse(localStorage.getItem(`ba-task-view:${authUser.organizationId}:${authUser.id}`) || '{}') as { layout?: string; group?: string; subtasks?: boolean }
      setTaskLayout(saved.layout === 'board' ? 'board' : 'table')
      setBoardGroup(saved.group === 'waiting' ? 'waiting' : 'status')
      setBoardShowSubtasks(saved.subtasks === true)
    } catch { /* Defaults already applied. */ }
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
      if (localStorage.getItem(`${tenantStorageKey}:pending-edits`)) setSaveConflict('A pending copy from a previous save conflict is available. Download it and reapply the needed edits to the latest workspace.')
      if (cached) {
        try { setStore(normalizeStore(JSON.parse(cached), seedStore())) } catch { /* cloud load will replace invalid cache */ }
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
            void queueCloudStoreSave(cloud).catch((error) => console.error('Could not save migrated tracker data:', error))
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
    return () => { cancelled = true }
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
    enabled: Boolean(authUser && authUser.accountType !== 'platform' && (cloudStatus === 'synced' || cloudStatus === 'saving') && workspaceAutoRefreshAllowed(view, selectedClientId, selectedProjectId)),
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
      storeRef.current = next; setStore(next)
      localStorage.setItem(organizationStorageKey(authUser.organizationId), JSON.stringify(next))
    } catch (error) { console.error('Notification refresh failed:', error) }
    finally { setNotificationBusy(false) }
  }

  const persist = (next: Store) => {
    try { assertLifecycleMutation(storeRef.current, next, authUser); assertRtmMutation(storeRef.current, next, authUser) }
    catch (error) { window.alert(error instanceof Error ? error.message : 'This change is not allowed.'); return false }

    const generatedEvents = workEventsForItemChanges(storeRef.current, next, authUser)
    const normalized = reconcileRtm(storeRef.current, { ...next, schemaVersion: STORE_SCHEMA_VERSION, workEvents: [...generatedEvents, ...(storeRef.current.workEvents || [])].slice(0, 10000) }, authUser)
    storeRef.current = normalized
    setStore(normalized)
    localStorage.setItem(organizationStorageKey(authUser?.organizationId), JSON.stringify(normalized))
    if (cloudStatus === 'local') return
    setCloudStatus('saving')
    setCloudMessage('Saving to database…')
    void queueCloudStoreSave(normalized).then((result) => {
      if (!result.configured) {
        setCloudStatus('local')
        setCloudMessage('Local browser storage')
        return
      }
      setLastCloudSync(result.updatedAt || new Date().toISOString())
      setCloudStatus('synced')
      setCloudMessage('Database synced')
    }).catch((error) => {
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
      setCloudStatus('synced'); setCloudMessage('Database synced')
      const refreshed = await loadCloudStore<Store>().catch(() => null)
      if (refreshed?.data) savedState = normalizeStore(refreshed.data)
    }
    storeRef.current = savedState; setStore(savedState)
    localStorage.setItem(organizationStorageKey(authUser?.organizationId), JSON.stringify(savedState))
  }
  const openRtms = (clientId?: string, projectId?: string) => {
    setRtmContext({ clientId, projectId }); setSelectedClientId(null); setSelectedProjectId(null); setView('requirements')
  }

  const saveLifecycleRecord = async (kind: 'clients' | 'projects', record: Client | Project) => {
    if (!authUser || authUser.role === 'Viewer' || !authUser.modules.includes(kind)) throw new Error('Edit access is required.')
    setLifecycleSaving(true)
    try {
      await waitForCloudSaves()
      const current = storeRef.current
      const old = current[kind].find(r => r.id === record.id)
      if (!old || (old.lifecycleVersion || 0) !== (record.lifecycleVersion || 0)) throw new Error('This record changed. Close the editor and reopen it.')
      if (stableRecord(old) === stableRecord(record)) return
      const updated = { ...record, lifecycleVersion: (old.lifecycleVersion || 0) + 1 }
      const next = { ...current, [kind]: current[kind].map(r => r.id === record.id ? updated : r) } as Store
      assertLifecycleMutation(current, next, authUser)
      if (cloudStatus !== 'local') {
        const saved = await queueCloudStoreSave(next)
        if (!saved.configured) throw new Error('The server could not save this change. Retry when storage is available.')
        setLastCloudSync(saved.updatedAt || new Date().toISOString())
        setCloudStatus('synced'); setCloudMessage('Database synced')
      }
      storeRef.current = next; setStore(next)
      localStorage.setItem(organizationStorageKey(authUser.organizationId), JSON.stringify(next))
    } finally { setLifecycleSaving(false) }
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
    const previous = current.items.find((item) => item.id === result.item.id)
    const previousEvidence = previous?.evidence?.length || 0
    const nextEvidence = result.item.evidence?.length || 0
    const evidenceEvent = authUser && previousEvidence !== nextEvidence ? workEventsForItemChanges(current, { ...current, items: current.items.map((item) => item.id === result.item.id ? result.item : item) }, authUser)[0] : undefined
    const explicitEvidenceEvent: WorkActivityEvent | undefined = authUser && previousEvidence !== nextEvidence ? {
      id: crypto.randomUUID(), occurredAt: new Date().toISOString(), date: today, actorUserId: authUser.id, actorName: authUser.name,
      actorRole: authUser.role, assignedToUserId: result.item.assignedToUserId,
      assignedToName: current.accounts.find((account) => account.id === result.item.assignedToUserId)?.name,
      clientId: result.item.clientId, projectId: result.item.projectId, taskId: result.item.id, parentTaskId: result.item.parentTaskId,
      itemTitle: result.item.title, itemKind: result.item.parentTaskId ? 'Subtask' : 'Task',
      action: nextEvidence > previousEvidence ? 'evidence_uploaded' : 'evidence_deleted',
      summary: `${authUser.name} ${nextEvidence > previousEvidence ? 'uploaded evidence to' : 'removed evidence from'} “${result.item.title}”.`,
    } : evidenceEvent
    const next: Store = {
      ...current,
      items: current.items.map((item) => item.id === result.item.id ? result.item : item),
      activity: result.activity ? [result.activity, ...current.activity.filter((entry) => entry.id !== result.activity?.id)] : current.activity,
      workEvents: explicitEvidenceEvent ? [explicitEvidenceEvent, ...current.workEvents].slice(0, 10000) : current.workEvents,
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
      items: current.items.map((item) => item.id === result.item.id ? result.item : item),
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
    const next: Store = { ...current, items: current.items.map((item) => item.id === result.item.id ? { ...item, timeEntries: result.item.timeEntries || [] } : item) }
    storeRef.current = next
    setStore(next)
    localStorage.setItem(organizationStorageKey(authUser?.organizationId), JSON.stringify(next))
    if (result.updatedAt) setLastCloudSync(result.updatedAt)
    setCloudStatus('synced')
    setCloudMessage('Time saved · Database synced')
  }

  const syncCloudNow = async () => {
    setCloudStatus('saving')
    setCloudMessage('Saving to database…')
    try {
      const result = await queueCloudStoreSave({ ...store, schemaVersion: STORE_SCHEMA_VERSION })
      if (!result.configured) {
        setCloudStatus('local')
        setCloudMessage('Database is not configured yet')
        return
      }
      setLastCloudSync(result.updatedAt || new Date().toISOString())
      setCloudStatus('synced')
      setCloudMessage('Database synced')
    } catch (error) {
      console.error(error)
      setCloudStatus('error')
      setCloudMessage('Cloud sync failed · local cache retained')
    }
  }

  const handleLogin = async (account: string, username: string, password: string) => {
    setLoginBusy(true)
    setLoginError('')
    try {
      const user = await login(account, username, password)
      void workHubSync.setSession(user, true)
      setAuthUser(user)
      if (user.accountType === 'platform' && user.isPlatformAdmin) {
        setCloudStatus('synced')
        setCloudMessage('Internal Admin · control plane')
        setView('internal-admin')
      } else {
        setCloudStatus('checking')
        setCloudMessage('Checking cloud storage…')
        setView(user.role === 'Administrator' || user.modules.includes('action') ? 'action' : (user.modules[0] as View || 'reports'))
      }
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : 'Login failed.')
    } finally {
      setLoginBusy(false)
      setAuthChecking(false)
    }
  }

  const handleLogout = async () => {
    if (logoutBusy) return
    setLogoutBusy(true)
    try {
      await logout()
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

  const accountCurrentUser = authUser ? store.accounts.find((account) => account.id === authUser.id && account.status === 'Active') : null
  const currentUser: UserAccount | null = authUser ? {
    ...(accountCurrentUser ?? { ...authUser, passwordHash: '', createdAt: today }),
    role: authUser.role,
    modules: authUser.modules,
    organizationId: authUser.organizationId,
    organizationName: authUser.organizationName,
    organizationSlug: authUser.organizationSlug,
    organizationModules: authUser.organizationModules || authUser.modules,
    isPlatformAdmin: authUser.isPlatformAdmin,
    accountType: authUser.accountType,
    accountKey: authUser.accountKey,
    interfaceMode: normalizeInterfaceMode(authUser.interfaceMode),
    lastLoginAt: authUser.lastLoginAt,
  } : null
  const workspaceModules = currentUser?.organizationModules || currentUser?.modules || []
  const canWrite = Boolean(currentUser && currentUser.role !== 'Viewer' && !lifecycleSaving)
  const canManageAccounts = currentUser?.role === 'Administrator' && currentUser.accountType !== 'platform'
  const hasModule = (module: AppModule) => Boolean(currentUser && currentUser.modules.includes(module))
  const canWriteTasks = canWrite && (hasModule('items') || hasModule('inbox'))
  const canUseAI = Boolean(currentUser && currentUser.role !== 'Viewer' && hasModule('ai'))
  const visibleNavItems = currentUser ? navItems.filter((item) => hasModule(item.id) && (item.id !== 'ai' || canUseAI)) : []

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

  useEffect(()=>{
    const open=(event:Event)=>{const detail=(event as CustomEvent).detail;if(!authUser?.modules?.includes('documents')||!detail?.taskId)return;setModal(null);setSelectedClientId(null);setSelectedProjectId(null);setDocumentLaunch({...detail,nonce:Date.now()});setView('documents')}
    window.addEventListener('dochub-create',open);return()=>window.removeEventListener('dochub-create',open)
  },[authUser?.id])
  const openNotification = (notification: AppNotification) => {
    if (!notification.readAt) void handleNotificationAction(notification, 'read')
    const item = notification.taskId ? storeRef.current.items.find((candidate) => candidate.id === notification.taskId) : undefined
    if (!item) { if(notification.documentId && hasModule('documents')){setSelectedClientId(null);setSelectedProjectId(null);setView('documents')} return }
    setSelectedClientId(null)
    setSelectedProjectId(null)
    setView(hasModule('items') ? 'items' : 'inbox')
    if (canWriteTasks) {
      setEditingTaskId(item.id)
      setModal('taskEdit')
    }
  }

  useEffect(() => {
    if (!currentUser) return
    if (currentUser.accountType === 'platform' && currentUser.isPlatformAdmin) {
      if (view !== 'internal-admin') {
        setSelectedClientId(null)
        setSelectedProjectId(null)
        setView('internal-admin')
      }
      return
    }
    if (view === 'themes' || (view === 'users' && canManageAccounts)) return
    if (!visibleNavItems.length) { setView('themes'); return }
    if (!visibleNavItems.some((item) => item.id === view)) {
      setSelectedClientId(null)
      setSelectedProjectId(null)
      setView(visibleNavItems[0].id)
    }
  }, [currentUser?.id, currentUser?.role, currentUser?.accountType, currentUser?.modules.join('|'), view])

  const acceptAccountUsers = (users: UserAccount[]) => {
    const current = storeRef.current
    const accounts = users.map((account, index) => normalizeAccount(account, index)).filter((account): account is UserAccount => Boolean(account))
    const next = { ...current, accounts }
    storeRef.current = next
    setStore(next)
    localStorage.setItem(organizationStorageKey(authUser?.organizationId), JSON.stringify(next))
  }

  const saveOwnPreferences = async (patch: { name?: string; email?: string; phone?: string; theme?: AppTheme; interfaceMode?: InterfaceMode | null; clientId?: string; clientTheme?: AppTheme | null; newPassword?: string; currentPassword?: string }) => {
    await waitForCloudSaves()
    const result = await settingsRequest('/api/account/profile', 'PATCH', patch)
    const accounts = storeRef.current.accounts
    acceptAccountUsers(accounts.map(account => account.id === result.user.id ? { ...account, ...result.user } : account))
    if (patch.newPassword) setAuthUser(await getAuthSession())
    else setAuthUser(current => current && current.id === result.user.id ? { ...current, ...result.user } : current)
  }

  const updateOwnProfile = async (profile: { name: string; email: string; phone: string; theme: AppTheme; newPassword?: string; currentPassword?: string }) => {
    try {
      await saveOwnPreferences(profile)
      return profile.newPassword ? 'Password changed. Sign in with your new password.' : 'Profile updated.'
    } catch (error) { return error instanceof Error ? error.message : 'Profile save failed.' }
  }

  // Active pages recheck the session; every server action still verifies permissions.
  useVisiblePolling(async signal => {
    const session = await getAuthSession()
    if (signal.aborted) return
    setAuthUser(session)
    if (!session) { setStore(seedStore()); setProfileOpen(false); setSelectedClientId(null); setSelectedProjectId(null) }
  }, { enabled: Boolean(authUser && workspaceAutoRefreshAllowed(view, selectedClientId, selectedProjectId)), interval: 60_000, immediate: false, scope: `${authUser?.id}:${view}` })

  const clientName = (id?: string) => id ? store.clients.find((c) => c.id === id)?.name ?? 'Unknown client' : 'General / no client'
  const projectName = (id?: string) => id ? store.projects.find((p) => p.id === id)?.name ?? 'Unknown project' : 'No project'

  const openItems = useMemo(
    () => store.items.filter((item) => (currentUser?.role !== 'Contributor' || item.assignedToUserId === currentUser.id) && !isTaskClosed(item.status, store.taskSettings) && !isWaitingOnDone(item.waitingOn, store.taskSettings)),
    [store.items, store.taskSettings, currentUser],
  )

  const chooseTaskView = (next: { layout?: TaskLayout; group?: BoardGroup; subtasks?: boolean }) => {
    const view = { layout: next.layout ?? taskLayout, group: next.group ?? boardGroup, subtasks: next.subtasks ?? boardShowSubtasks }
    setTaskLayout(view.layout); setBoardGroup(view.group); setBoardShowSubtasks(view.subtasks)
    if (!authUser) return
    try { localStorage.setItem(`ba-task-view:${authUser.organizationId}:${authUser.id}`, JSON.stringify(view)) } catch { /* Keep the view usable when storage is unavailable. */ }
  }

  const chooseClientLayout = (layout: ClientLayout) => {
    setClientLayout(layout)
    if (!authUser) return
    try { localStorage.setItem(`ba-client-layout:${authUser.organizationId}:${authUser.id}`, layout) } catch { /* Keep the view usable when storage is unavailable. */ }
  }

  const visibleClients = useMemo(() => {
    const search = clientSearch.trim().toLocaleLowerCase()
    return store.clients
      .filter((client) => clientArchiveFilter === 'all' || isArchived(client) === (clientArchiveFilter === 'archived'))
      .filter((client) => !search || [client.name, client.contact, client.email, client.notes || ''].some((part) => part.toLocaleLowerCase().includes(search)))
      .map((client) => {
        const projects = new Set(store.items.filter((item) => item.clientId === client.id && item.projectId).map((item) => item.projectId))
        const tasks = openItems.filter((item) => item.clientId === client.id)
        const next = tasks.filter((item) => item.followUpDate).sort((a, b) => a.followUpDate.localeCompare(b.followUpDate))[0]
        return { client, projectCount: projects.size, openTaskCount: tasks.length, next }
      })
      .sort((a, b) => {
        if (clientSort === 'name-desc') return b.client.name.localeCompare(a.client.name)
        if (clientSort === 'open-tasks') return b.openTaskCount - a.openTaskCount || a.client.name.localeCompare(b.client.name)
        if (clientSort === 'follow-up') return (a.next?.followUpDate || '9999-12-31').localeCompare(b.next?.followUpDate || '9999-12-31') || a.client.name.localeCompare(b.client.name)
        return a.client.name.localeCompare(b.client.name)
      })
  }, [store.clients, store.items, openItems, clientArchiveFilter, clientSearch, clientSort])

  const overdue = openItems.filter((item) => item.followUpDate && item.followUpDate < today)
  const dueToday = openItems.filter((item) => item.followUpDate === today)
  const attentionClientCount = new Set(openItems.map((item) => item.clientId).filter(Boolean)).size
  const openInquiryCount = openItems.filter((item) => item.type === 'Inquiry').length

  const searchedItems = useMemo(() => {
    const q = query.trim().toLowerCase()
    return store.items
      .filter((item) => {
        const text = [item.title, item.description, clientName(item.clientId), projectName(item.projectId), item.type, item.status].join(' ').toLowerCase()
        return !q || text.includes(q)
      })
      .filter((item) => waitingFilter === 'All' || item.waitingOn === waitingFilter)
      .sort((a, b) => {
        const aOverdue = a.followUpDate && a.followUpDate < today ? 1 : 0
        const bOverdue = b.followUpDate && b.followUpDate < today ? 1 : 0
        return bOverdue - aOverdue || priorityRank[b.priority] - priorityRank[a.priority] || (a.followUpDate || '9999').localeCompare(b.followUpDate || '9999')
      })
  }, [store.items, query, waitingFilter, store.clients, store.projects, today])

  const actionCenterUsers = trackedActionCenterUsers(store.accounts)
  const resolvedActionCenterScope = resolveActionCenterScope(actionCenterScope, currentUser?.id || '', currentUser?.role || 'Viewer', store.accounts)
  const actionCenterScopeLabel = resolvedActionCenterScope.kind === 'all' ? 'All Users’ Action Center' : resolvedActionCenterScope.kind === 'user' ? `${actionCenterUsers.find((account) => account.id === resolvedActionCenterScope.userId)?.name || 'User'}’s Action Center` : 'My Action Center'
  const matchesActionCenterScope = (item: WorkItem) => itemMatchesActionCenterScope(item, resolvedActionCenterScope)
  const actionCenterWorkItems = store.items.filter((item) => matchesActionCenterScope(item) && !isTaskClosed(item.status, store.taskSettings) && !isWaitingOnDone(item.waitingOn, store.taskSettings))
  const actionItems = searchedItems.filter((item) => matchesActionCenterScope(item) && !isTaskClosed(item.status, store.taskSettings) && !isWaitingOnDone(item.waitingOn, store.taskSettings))
  const canEditActionItem = (item: WorkItem) => canWriteTasks && (currentUser?.role === 'Administrator' || item.assignedToUserId === currentUser?.id)
  // The metric follows the built-in Developer option (by id, so a rename keeps it).
  // If an account removed it, count everything waiting on someone other than the default assignee.
  const developerWaitingOn = waitingOnOptions(store.taskSettings).find((option) => option.id === 'developer' && !option.done)
  const actionCenterWaitingTitle = developerWaitingOn ? `Waiting on ${developerWaitingOn.label}` : 'Waiting on others'
  const actionCenterWaitingDev = actionCenterWorkItems.filter((item) => developerWaitingOn ? item.waitingOn === developerWaitingOn.label : item.waitingOn !== defaultWaitingOn(store.taskSettings))
  const actionCenterClientCount = new Set(actionCenterWorkItems.map((item) => item.clientId).filter(Boolean)).size
  const actionCenterWaitingDevOverdue = actionCenterWaitingDev.filter((item) => item.followUpDate && item.followUpDate < today).length
  const actionCenterInquiryCount = actionCenterWorkItems.filter((item) => item.type === 'Inquiry').length
  useEffect(() => {
    if (actionCenterScope.startsWith('user:') && !actionCenterUsers.some((account) => account.id === actionCenterScope.slice('user:'.length))) setActionCenterScope('mine')
  }, [actionCenterScope, store.accounts])
  const dashboardAiContext = useMemo(() => {
    const client = store.clients.find((value) => value.id === aiClientId)
    const project = store.projects.find((value) => value.id === aiProjectId)
    const scopedItems = store.items.filter((item) => (!aiClientId || item.clientId === aiClientId) && (!aiProjectId || item.projectId === aiProjectId))
    const closedStatuses = new Set(store.taskSettings.statuses.filter((status) => status.closed).map((status) => status.label))
    const openItems = scopedItems.filter((item) => !closedStatuses.has(item.status) && !isWaitingOnDone(item.waitingOn, store.taskSettings)).slice(0, 20)
    const upcomingActivities = store.planner.filter((activity) => (!aiClientId || activity.clientId === aiClientId) && (!aiProjectId || activity.projectId === aiProjectId) && activity.status === 'Planned').slice(0, 15)
    const contextUser = currentUser || seedAccounts[0]
    return { currentUser: { id: contextUser.id, name: contextUser.name, role: contextUser.role, modules: contextUser.modules }, client, project, openItems, recentItems: scopedItems.slice(0, 20), upcomingActivities, myAssignments: scopedItems.filter((item) => item.assignedToUserId === contextUser.id).slice(0, 40), myRecentActivity: store.workEvents.filter((event) => event.actorUserId === contextUser.id || event.assignedToUserId === contextUser.id || (event.field === 'assignedToUserId' && event.oldValue === contextUser.id)).slice(0, 40) }
  }, [aiClientId, aiProjectId, store.clients, store.projects, store.items, store.planner, store.taskSettings, store.workEvents, currentUser])
  const inquiryItems = searchedItems.filter((item) => item.type === 'Inquiry' && !isTaskClosed(item.status, store.taskSettings))
  const archivedInquiryItems = useMemo(() => {
    const q = query.trim().toLowerCase()
    return store.items
      .filter((item) => item.source === 'Discord' && (item.type !== 'Inquiry' || isTaskClosed(item.status, store.taskSettings) || isWaitingOnDone(item.waitingOn, store.taskSettings)))
      .filter((item) => {
        const text = [item.title, item.description, clientName(item.clientId), projectName(item.projectId), item.type, item.status, item.sourceSender || ''].join(' ').toLowerCase()
        return !q || text.includes(q)
      })
      .sort((a, b) => (b.resolvedDate || b.dateRaised).localeCompare(a.resolvedDate || a.dateRaised))
  }, [store.items, store.taskSettings, store.clients, store.projects, query])
  const newExternalInquiryCount = newExternalInquiryIds.filter((id) => store.items.some((item) => item.id === id && item.type === 'Inquiry' && !isTaskClosed(item.status, store.taskSettings) && !isWaitingOnDone(item.waitingOn, store.taskSettings))).length

  const filteredTasks = useMemo(() => {
    const due3 = addDays(today, 3)
    const due7 = addDays(today, 7)
    return searchedItems.filter((item) => {
      if (taskClientFilter === '__none__' && item.clientId) return false
      if (taskClientFilter && taskClientFilter !== '__none__' && item.clientId !== taskClientFilter) return false
      if (taskProjectFilter === '__none__' && item.projectId) return false
      if (taskProjectFilter && taskProjectFilter !== '__none__' && item.projectId !== taskProjectFilter) return false
      if (taskStatusFilter && item.status !== taskStatusFilter) return false
      if (taskDateFilter === 'due-3') return Boolean(item.dueDate && item.dueDate >= today && item.dueDate <= due3)
      if (taskDateFilter === 'due-7') return Boolean(item.dueDate && item.dueDate >= today && item.dueDate <= due7)
      if (taskDateFilter === 'followup-3') return Boolean(item.followUpDate && item.followUpDate >= today && item.followUpDate <= due3)
      if (taskDateFilter === 'followup-7') return Boolean(item.followUpDate && item.followUpDate >= today && item.followUpDate <= due7)
      if (taskDateFilter === 'overdue') return Boolean((item.dueDate && item.dueDate < today) || (item.followUpDate && item.followUpDate < today)) && !isTaskClosed(item.status, store.taskSettings)
      return true
    })
  }, [searchedItems, taskClientFilter, taskProjectFilter, taskStatusFilter, taskDateFilter, store.taskSettings, today])
  const selectedClient = store.clients.find((client) => client.id === selectedClientId) ?? null
  const selectedProject = store.projects.find((project) => project.id === selectedProjectId) ?? null
  const editingTask = editingTaskId ? store.items.find((item) => item.id === editingTaskId) ?? null : null

  const resolveItem = (id: string) => {
    if (!canWriteTasks) return
    const now = new Date().toISOString().slice(0, 10)
    const target = store.items.find((item) => item.id === id)
    if (!target) return
    const openSubtasks = store.items.filter((item) => item.parentTaskId === id && !isTaskClosed(item.status, store.taskSettings) && !isWaitingOnDone(item.waitingOn, store.taskSettings))
    if (openSubtasks.length) {
      window.alert(`Complete the ${openSubtasks.length} open subtask${openSubtasks.length === 1 ? '' : 's'} before completing this task.`)
      return
    }
    const closedStatus = defaultClosedTaskStatus(store.taskSettings)
    persist({
      ...store,
      items: store.items.map((item) => (item.id === id ? { ...item, status: closedStatus, waitingOn: doneWaitingOn(store.taskSettings), followUpDate: '', resolvedDate: now } : item)),
      activity: [
        { id: crypto.randomUUID(), clientId: target.clientId, projectId: target.projectId, date: now, text: `Completed task: ${target.title}` },
        ...store.activity,
      ],
    })
  }

  const updateTaskStatus = (id: string, status: string) => {
    if (!canWriteTasks) return
    const target = store.items.find((item) => item.id === id)
    if (!target || target.status === status) return
    const closed = isTaskClosed(status, store.taskSettings)
    const openSubtasks = closed ? store.items.filter((item) => item.parentTaskId === id && !isTaskClosed(item.status, store.taskSettings) && !isWaitingOnDone(item.waitingOn, store.taskSettings)) : []
    if (openSubtasks.length) {
      window.alert(`Complete the ${openSubtasks.length} open subtask${openSubtasks.length === 1 ? '' : 's'} before closing this task.`)
      return
    }
    const reopened = isTaskClosed(target.status, store.taskSettings) && !closed
    persist({
      ...store,
      items: store.items.map((item) => item.id === id ? {
        ...item,
        status,
        startDate: status === 'In Progress' && !item.startDate ? today : item.startDate,
        resolvedDate: closed ? (item.resolvedDate || today) : undefined,
        waitingOn: closed ? doneWaitingOn(store.taskSettings) : reopened && isWaitingOnDone(item.waitingOn, store.taskSettings) ? defaultWaitingOn(store.taskSettings) : item.waitingOn,
      } : item),
      activity: [
        { id: crypto.randomUUID(), clientId: target.clientId, projectId: target.projectId, date: today, text: `Task status changed: ${target.title} → ${status}` },
        ...store.activity,
      ],
    })
  }

  const updateTaskWaitingOn = (id: string, waitingOn: WaitingOn) => {
    if (!canWriteTasks) return
    const target = store.items.find((item) => item.id === id)
    if (!target || target.waitingOn === waitingOn || isWaitingOnDone(waitingOn, store.taskSettings) || !findWaitingOn(waitingOn, store.taskSettings) || isTaskClosed(target.status, store.taskSettings)) return
    persist({
      ...store,
      items: store.items.map((item) => item.id === id ? { ...item, waitingOn } : item),
      activity: [
        { id: crypto.randomUUID(), clientId: target.clientId, projectId: target.projectId, date: today, text: `Task now waiting on ${waitingOn}: ${target.title}` },
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
    const current = storeRef.current
    const previous = current.items.find((item) => item.id === updated.id)
    if (!previous) throw new Error('This task is no longer available. Reload the workspace and try again.')
    const closed = isTaskClosed(updated.status, current.taskSettings)
    const openSubtasks = closed ? current.items.filter((item) => item.parentTaskId === updated.id && !isTaskClosed(item.status, current.taskSettings) && !isWaitingOnDone(item.waitingOn, current.taskSettings)) : []
    if (openSubtasks.length) {
      throw new Error(`Complete the ${openSubtasks.length} open subtask${openSubtasks.length === 1 ? '' : 's'} before closing this task.`)
    }
    const normalized: WorkItem = {
      ...updated,
      title: previous.title,
      clientId: previous.clientId,
      projectId: previous.parentTaskId ? previous.projectId : updated.projectId,
      waitingOn: closed ? doneWaitingOn(current.taskSettings) : isWaitingOnDone(updated.waitingOn, current.taskSettings) ? defaultWaitingOn(current.taskSettings) : updated.waitingOn,
      startDate: updated.status === 'In Progress' && !updated.startDate ? today : updated.startDate,
      resolvedDate: closed ? (previous.resolvedDate || today) : undefined,
    }
    const editedItems = current.items.map((item) => item.id === updated.id ? normalized : item.parentTaskId === updated.id ? { ...item, projectId: normalized.projectId } : item)
    const inheritedItems = applySubtaskAssignmentInheritance(current.items, editedItems)
    const next: Store = {
      ...current,
      items: inheritedItems.map((item) => ({
        ...item,
        owner: item.assignedToUserId ? current.accounts.find((account) => account.id === item.assignedToUserId)?.name || item.owner : '',
      })),
      activity: [
        { id: crypto.randomUUID(), clientId: previous.clientId, projectId: normalized.projectId, date: today, text: `Updated task: ${previous.title}` },
        ...current.activity,
      ],
    }
    assertLifecycleMutation(current, next, authUser)
    const generatedEvents = workEventsForItemChanges(current, next, authUser)
    assertRtmMutation(current, next, authUser)
    const candidate = reconcileRtm(current, { ...next, schemaVersion: STORE_SCHEMA_VERSION, workEvents: [...generatedEvents, ...current.workEvents].slice(0, 10000) }, authUser)
    if (cloudStatus !== 'local') {
      setCloudStatus('saving')
      setCloudMessage('Saving to database…')
      try {
        const result = await queueCloudStoreSave(candidate)
        if (!result.configured) throw new Error('Cloud storage is unavailable. Your edit was not saved; please retry when the database is connected.')
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

  const deleteTask = (id: string) => {
    if (!canWriteTasks) return
    const target = store.items.find((item) => item.id === id)
    if (!target) return
    const childCount = store.items.filter((item) => item.parentTaskId === id).length
    const deleteMessage = childCount
      ? `Delete task "${target.title}" and its ${childCount} subtask${childCount === 1 ? '' : 's'}? This cannot be undone.`
      : `Delete task "${target.title}"? This cannot be undone.`
    if (!window.confirm(deleteMessage)) return
    persist({
      ...store,
      items: store.items.filter((item) => item.id !== id && item.parentTaskId !== id),
      activity: [
        { id: crypto.randomUUID(), clientId: target.clientId, projectId: target.projectId, date: today, text: `Deleted task: ${target.title}` },
        ...store.activity,
      ],
    })
    if (editingTaskId === id) {
      setEditingTaskId(null)
      setModal(null)
    }
  }

  const openTaskEditor = (id: string) => {
    if (!canWriteTasks) return
    const target = store.items.find(item => item.id === id)
    if (target && archivedWorkReason(store, target)) { window.alert(archivedWorkReason(store, target)); return }
    setEditingTaskId(id)
    setModal('taskEdit')
  }

  const openSubtaskCreator = (parentTaskId: string) => {
    if (!canWriteTasks) return
    const parent = store.items.find((item) => item.id === parentTaskId)
    if (!parent || parent.parentTaskId) return
    if (archivedWorkReason(store, parent)) { window.alert(archivedWorkReason(store, parent)); return }
    setTaskPreset({ clientId: parent.clientId, projectId: parent.projectId, type: 'Task', parentTaskId: parent.id })
    setModal('item')
  }

  const reorderSubtasks = (parentTaskId: string, orderedIds: string[]) => {
    if (!canWriteTasks || !orderedIds.length) return
    const valid = new Set(store.items.filter((item) => item.parentTaskId === parentTaskId).map((item) => item.id))
    const normalizedIds = orderedIds.filter((id) => valid.has(id))
    if (normalizedIds.length !== valid.size) return
    const orderMap = new Map(normalizedIds.map((id, index) => [id, index]))
    persist({
      ...store,
      items: store.items.map((item) => item.parentTaskId === parentTaskId ? { ...item, subtaskOrder: orderMap.get(item.id) ?? item.subtaskOrder } : item),
    })
  }

  const convertInquiry = (id: string, type: 'Requirement' | 'Issue') => {
    if (!canWriteTasks) return
    const target = store.items.find((item) => item.id === id)
    if (!target) return
    persist({
      ...store,
      items: store.items.map((item) => (item.id === id ? { ...item, type } : item)),
      activity: [
        { id: crypto.randomUUID(), clientId: target.clientId, projectId: target.projectId, date: today, text: `Inquiry converted to ${type.toLowerCase()}: ${target.title}` },
        ...store.activity,
      ],
    })
  }

  const weekStart = weekStartKey(today)
  const weekEnd = weekEndKey(today)
  const sortedPlanner = [...store.planner].sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime))
  const todayActivities = sortedPlanner.filter((item) => item.date === today && item.status !== 'Cancelled')
  const weekActivities = sortedPlanner.filter((item) => item.date >= weekStart && item.date <= weekEnd && item.status !== 'Cancelled')
  const todayFollowUps = actionCenterWorkItems
    .filter((item) => item.followUpDate === today)
    .sort((a, b) => priorityRank[b.priority] - priorityRank[a.priority] || a.title.localeCompare(b.title))
  const weekFollowUps = actionCenterWorkItems
    .filter((item) => item.followUpDate && item.followUpDate >= weekStart && item.followUpDate <= weekEnd)
    .sort((a, b) => a.followUpDate.localeCompare(b.followUpDate) || priorityRank[b.priority] - priorityRank[a.priority] || a.title.localeCompare(b.title))
  const editingActivity = editingActivityId ? store.planner.find((item) => item.id === editingActivityId) ?? null : null

  const openActivityModal = (activity?: PlannerActivity) => {
    if (!canWrite) return
    setEditingActivityId(activity?.id ?? null)
    setModal('activity')
  }

  const saveActivity = (activity: PlannerActivity) => {
    if (!canWrite) return
    const exists = store.planner.some((item) => item.id === activity.id)
    persist({ ...store, planner: exists ? store.planner.map((item) => item.id === activity.id ? activity : item) : [activity, ...store.planner] })
    setModal(null)
    setEditingActivityId(null)
  }

  const toggleActivityDone = (id: string) => {
    if (!canWrite) return
    persist({ ...store, planner: store.planner.map((item) => item.id === id ? { ...item, status: item.status === 'Done' ? 'Planned' : 'Done' } : item) })
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
    try { threads = JSON.parse(localStorage.getItem('ba-client-ops-ai-threads-v1') || '{}') as Record<string, AIMessage[]> } catch { threads = {} }
    const history = Array.isArray(threads[threadKey]) ? threads[threadKey] : []

    try {
      const result = await askBAAssistant({ message: text, context: dashboardAiContext, history: history.slice(-8) })
      const now = new Date().toISOString()
      const userMessage: AIMessage = { id: crypto.randomUUID(), role: 'user', content: text, createdAt: now }
      const assistantMessage: AIMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: result.message,
        suggestions: result.suggestions.map((suggestion) => ({ ...suggestion, id: suggestion.id || crypto.randomUUID() })),
        createdAt: new Date().toISOString(),
      }
      const nextThreads = { ...threads, [threadKey]: [...history, userMessage, assistantMessage] }
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

    const type: ItemType = suggestion.kind === 'issue' ? 'Issue' : suggestion.kind === 'requirement' ? 'Requirement' : 'Follow-up'
    const item: WorkItem = {
      id: crypto.randomUUID(),
      clientId,
      projectId,
      title: suggestion.title,
      type,
      priority: suggestion.priority || 'Medium',
      status: defaultOpenTaskStatus(store.taskSettings),
      waitingOn: suggestion.waitingOn && openWaitingOnOptions(store.taskSettings).some((option) => option.label === suggestion.waitingOn) ? suggestion.waitingOn : defaultWaitingOn(store.taskSettings),
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
      activity: [{ id: crypto.randomUUID(), clientId, projectId, date: today, text: `AI suggestion approved: created ${type.toLowerCase()} task — ${suggestion.title}` }, ...store.activity],
    })
    return `Created ${type.toLowerCase()} task: ${suggestion.title}`
  }

  if (resetToken !== null) return <ResetPassword token={resetToken} onBack={() => { setResetToken(null); setAuthUser(null); setLoginError('') }} />
  if (authChecking) return <AuthSplash />
  if (!authUser || !currentUser) return <LoginScreen busy={loginBusy} error={loginError} onLogin={handleLogin} />

  const currentTheme = themeForContext(currentUser)

  return (
    <div className={`app-shell ui-refresh theme-${currentTheme}`} data-theme={currentTheme} data-interface-mode={normalizeInterfaceMode(currentUser.interfaceMode) || undefined}>
      <aside className="sidebar">
        <div className="brand"><img className="brand-logo" src="/client-ops-logo.png" alt="Client Ops Tracker" /></div>
        <nav>
          {visibleNavItems.map(({ id, label, icon: Icon }) => (
            <button key={id} className={view === id ? 'nav-button active' : 'nav-button'} onClick={() => { setView(id); if (id === 'requirements') setRtmContext({}); setSelectedClientId(null); setSelectedProjectId(null) }}>
              <Icon size={18} /><span>{label}</span>{id === 'inbox' && inquiryItems.length > 0 && <b className={newExternalInquiryCount > 0 ? 'has-new' : ''} title={newExternalInquiryCount > 0 ? `${newExternalInquiryCount} new external inquiry${newExternalInquiryCount === 1 ? '' : 'ies'}` : `${inquiryItems.length} open inquiries`}>{newExternalInquiryCount > 0 ? newExternalInquiryCount : openInquiryCount}</b>}
            </button>
          ))}
          {currentUser.accountType !== 'platform' && <>
            {canManageAccounts && <button className={view === 'users' ? 'nav-button active' : 'nav-button'} onClick={() => { setView('users'); setSelectedClientId(null); setSelectedProjectId(null) }}><Users size={18} /><span>Users &amp; Permissions</span></button>}
            <button className={view === 'themes' ? 'nav-button active' : 'nav-button'} onClick={() => { setView('themes'); setSelectedClientId(null); setSelectedProjectId(null) }}><Sparkles size={18} /><span>My Themes</span></button>
          </>}
        </nav>
        {currentUser.isPlatformAdmin && currentUser.accountType === 'platform' && <div className="platform-admin-nav"><button className={view === 'internal-admin' ? 'nav-button active' : 'nav-button'} onClick={() => { setView('internal-admin'); setSelectedClientId(null); setSelectedProjectId(null) }}><ShieldCheck size={18} /><span>BXI-Core Admin</span></button></div>}
        <div className="sidebar-footer">
          {currentUser.organizationName && <div className="workspace-chip"><Building2 size={14} /><span>{currentUser.organizationName}</span></div>}
          {currentUser.accountType === 'platform' ? <div className="session-card platform-session-card">
            <div className="session-avatar"><ShieldCheck size={17} /></div><div><strong>{currentUser.name}</strong><span>internal_admin · Platform Admin</span></div>
          </div> : <button className="session-card session-card-button" type="button" onClick={() => setProfileOpen(true)} title="Edit your profile">
            <div className="session-avatar"><UserRound size={17} /></div><div><strong>{currentUser.name}</strong><span>{currentUser.role} · My profile</span></div><Pencil size={14} />
          </button>}
          <button className="nav-button signout-button" type="button" disabled={logoutBusy} onClick={() => void handleLogout()}><LogOut size={18} /><span>{logoutBusy ? 'Signing out…' : 'Sign out'}</span></button>
          <div className={`local-note storage-${cloudStatus}`} title={lastCloudSync ? `Last cloud sync: ${lastCloudSync}` : undefined}><CircleDot size={12} /> {cloudMessage}</div>
        </div>
      </aside>

      <main>
        {saveConflict && <div className="panel" role="alert"><strong>Save conflict — your edits are kept locally.</strong><p>{saveConflict}</p><p>Download your pending workspace copy and reload, then reapply your edits to the current records. Open editors stay open for reference; reopen them before saving.</p><button className="secondary" disabled={recoveringCloud} onClick={() => void recoverCloud()}>{recoveringCloud ? 'Reloading…' : 'Download edits and reload latest'}</button></div>}
        <header className="topbar">
          <div><p className="eyebrow">{currentUser.accountType === 'platform' ? 'BXI-CORE PLATFORM' : 'BA CLIENT OPERATIONS'}</p><div className="record-title-line"><h1>{selectedProject ? selectedProject.name : selectedClient ? selectedClient.name : labels[view]}</h1>{canWrite && ((selectedClient && hasModule('clients')) || (selectedProject && hasModule('projects'))) && <button className="secondary record-title-edit" onClick={() => setEditingRecord(selectedProject ? { kind: 'projects', id: selectedProject.id } : { kind: 'clients', id: selectedClient!.id })}><Pencil size={16} />{selectedProject ? 'Edit project' : 'Edit client'}</button>}</div></div>
          <div className="top-actions">
            {currentUser.accountType !== 'platform' && <button className="secondary" disabled={refreshingCloud || hubSyncing || cloudStatus === 'checking' || cloudStatus === 'saving' || Boolean(saveConflict)} onClick={() => { void refreshWorkspace(true); void workHubSync.syncAll() }} title="Fetch the latest workspace and sync all connected Work Hub integrations"><RefreshCw size={16} />{refreshingCloud || hubSyncing ? 'Refreshing…' : 'Refresh now'}</button>}
            {currentUser.accountType !== 'platform' && <NotificationCenter notifications={store.notifications} clients={store.clients} projects={store.projects} isAdmin={currentUser.role === 'Administrator'} busy={notificationBusy} onOpen={openNotification} onAction={handleNotificationAction} onReadAll={handleReadAllNotifications} onRefresh={() => void refreshNotifications()} />}
            <span className="top-role-pill">{view === 'internal-admin' && currentUser.accountType === 'platform' ? 'Platform Admin' : currentUser.role}</span>
            {view !== 'internal-admin' && canWrite && hasModule('clients') && <button className="secondary" onClick={() => setModal('client')}><Users size={17} /> Add client</button>}
            {view !== 'internal-admin' && canWrite && !isArchived(selectedClient || undefined) && !isArchived(selectedProject || undefined) && !isArchived(store.clients.find(client => client.id === selectedProjectClientId)) && (hasModule('items') || hasModule('inbox')) && <button className="primary" onClick={() => {
              if (selectedClient) setTaskPreset({ clientId: selectedClient.id, type: 'Task' })
              else if (selectedProject) setTaskPreset({ clientId: selectedProjectClientId || undefined, projectId: selectedProject.id, type: 'Task' })
              else setTaskPreset(null)
              setModal('item')
            }}><Plus size={18} /> Add task</button>}
          </div>
        </header>

        {!visibleNavItems.length && view !== 'themes' && view !== 'users' && currentUser.accountType !== 'platform' && <section className="page-stack"><div className="panel no-access-panel"><LockKeyhole size={24} /><div><h2>No modules assigned</h2><p>Your account is active, but an Administrator has not assigned any modules yet. You can still open My profile or sign out.</p></div></div></section>}

        {!selectedClient && !selectedProject && view === 'internal-admin' && currentUser.isPlatformAdmin && currentUser.accountType === 'platform' && <InternalAdmin mustChangePassword={Boolean(authUser.mustChangePassword)} recoveryEmail={authUser.email} onRecoveryEmailChange={(email) => setAuthUser({ ...authUser, email })} />}

        {!selectedClient && !selectedProject && view === 'action' && hasModule('action') && (
          <section className="page-stack dashboard-stack">
            <div className="metric-grid dashboard-metrics">
              <Metric title="Needs attention" value={actionCenterWorkItems.length} detail={`Across ${actionCenterClientCount} client${actionCenterClientCount === 1 ? '' : 's'}`} icon={<AlertTriangle size={18} />} />
              <Metric title={actionCenterWaitingTitle} value={actionCenterWaitingDev.length} detail={`${actionCenterWaitingDevOverdue} overdue`} icon={<Settings2 size={18} />} />
              <Metric title="Activities today" value={todayActivities.length + todayFollowUps.length} detail={`${todayActivities.filter((item) => item.source === 'Google Calendar').length} meetings · ${todayActivities.filter((item) => item.source === 'Local').length} tracker activities · ${todayFollowUps.length} follow-ups`} icon={<CalendarDays size={18} />} />
              <Metric title="Open inquiries" value={actionCenterInquiryCount} detail="Need classification" icon={<Inbox size={18} />} />
            </div>

            <div className="panel planner-panel dashboard-panel">
              <div className="panel-heading planner-heading dashboard-panel-heading">
                <div><h2>Activities</h2><p>Shared tracker activities and legacy calendar copies, plus follow-ups for {resolvedActionCenterScope.kind === 'all' ? 'all users' : resolvedActionCenterScope.kind === 'user' ? actionCenterUsers.find((account) => account.id === resolvedActionCenterScope.userId)?.name || 'the selected user' : 'you'}.</p></div>
                <div className="planner-actions dashboard-tabs">
                  <button className={activityRange === 'today' ? 'secondary active-tab' : 'secondary'} onClick={() => setActivityRange('today')}>Today</button>
                  <button className={activityRange === 'week' ? 'secondary active-tab' : 'secondary'} onClick={() => setActivityRange('week')}>This Week</button>
                  {currentUser.role !== 'Viewer' && canBrowseTeamActionCenter(currentUser.role) && <label className="action-center-scope"><Users size={15} /><span>Work view</span><select aria-label="Action Center work view" value={actionCenterScope} onChange={(event) => setActionCenterScope(event.target.value as ActionCenterScopeSelection)}><option value="mine">My Action Center</option><option value="all">View all users</option>{actionCenterUsers.filter((account) => account.id !== currentUser.id).map((account) => <option key={account.id} value={`user:${account.id}`}>View {account.name}</option>)}</select></label>}
                  {canWrite && <button className="secondary" onClick={() => openActivityModal()}><Plus size={16} /> Add activity</button>}
                </div>
              </div>
              <div className="activity-legend">
                <span>Legacy calendar copies = shared</span><span>Tracker = shared, local only</span><span>Follow-up = assigned task/subtask</span><span>Week = Sunday–Saturday</span>{actionCenterScope === 'all' && <span>All users includes unassigned work</span>}
              </div>
              <DashboardActivityTimeline
                mode={activityRange}
                items={activityRange === 'today' ? todayActivities : weekActivities}
                followUps={activityRange === 'today' ? todayFollowUps : weekFollowUps}
                allItems={store.items}
                accounts={store.accounts}
                clients={store.clients}
                projects={store.projects}
                onEdit={openActivityModal}
                onToggle={toggleActivityDone}
                onEditTask={openTaskEditor}
                canEdit={canWrite}
                canEditTask={canEditActionItem}
              />
            </div>

            <GoogleCalendarPanel key={`${currentUser.organizationId}:${currentUser.id}`} />

            {canUseAI && <div className="panel dashboard-panel dashboard-ai-card">
              <div className="panel-heading dashboard-panel-heading">
                <div><div className="ai-title-line"><Sparkles size={18} /><h2>AI BA Assistant</h2></div><p>Drop a client inquiry, meeting note, or problem here and let AI organize the next steps.</p></div>
                <button className="secondary" onClick={() => setView('ai')}>Open full assistant <ChevronRight size={16} /></button>
              </div>
              <form className="dashboard-ai-body" onSubmit={assessDashboardAI}>
                <div className="dashboard-ai-context">
                  <label>Client<select value={aiClientId} onChange={(e) => { setAiClientId(e.target.value); setAiProjectId(''); setDashboardAiResult(null); setDashboardAiError('') }}><option value="">General / all clients</option>{store.clients.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}</select></label>
                  <label>Project<select value={aiProjectId} onChange={(e) => { setAiProjectId(e.target.value); setDashboardAiResult(null); setDashboardAiError('') }}><option value="">All projects</option>{store.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
                </div>
                <textarea value={dashboardAiPrompt} onChange={(e) => setDashboardAiPrompt(e.target.value)} rows={3} placeholder="Example: Client says search should support @gmail but it does not. Assess what I should do next." />
                <div className="dashboard-ai-footer"><span>Suggestions only — nothing is saved to tracker records until you approve it.</span><button className="primary" disabled={dashboardAiBusy || !dashboardAiPrompt.trim()}><Sparkles size={16} /> {dashboardAiBusy ? 'Assessing…' : 'Assess with AI'}</button></div>
                {dashboardAiError && <div className="dashboard-ai-error">{dashboardAiError}</div>}
                {dashboardAiResult && <div className="dashboard-ai-result">
                  <div className="dashboard-ai-result-head"><strong>AI assessment</strong><span>{dashboardAiResult.wordCount} words</span></div>
                  <textarea className="dashboard-ai-result-box" readOnly rows={5} value={dashboardAiResult.wordCount >= 200 ? `${dashboardAiResult.message.trim().split(/\s+/).slice(0, 200).join(' ')}${dashboardAiResult.wordCount > 200 ? '…' : ''}` : dashboardAiResult.message} />
                  {dashboardAiResult.wordCount >= 200 && <div className="dashboard-ai-result-footer"><span>Showing the first 200 words here.</span><button className="secondary" type="button" onClick={openDashboardAiResult}>View in AI BA Assistant <ChevronRight size={16} /></button></div>}
                </div>}
              </form>
            </div>}

            <div className="panel dashboard-panel action-center-panel">
              <div className="panel-heading dashboard-panel-heading"><div><h2>{actionCenterScopeLabel}</h2><p>Open tasks and subtasks for the selected user view. {resolvedActionCenterScope.kind === 'all' ? 'Unassigned work is included.' : ''}</p></div>{hasModule('items') && <button className="secondary" onClick={() => setView('items')}>View all tasks</button>}</div>
              <DashboardActionTable key={actionCenterScope} items={actionItems} accounts={store.accounts} clients={store.clients} projects={store.projects} planner={store.planner} />
            </div>
          </section>
        )}

        {!selectedClient && !selectedProject && view === 'clients' && hasModule('clients') && (
          <section className="page-stack">
            <div className="section-actions"><p className="page-intro">Clients hold relationship context. Projects are global; client association happens on each task.</p>{canWrite && <button className="primary" onClick={() => setModal('client')}><Plus size={18} /> New client</button>}</div>
            <div className="client-controls">
              <label className="lifecycle-filter">Show clients<select value={clientArchiveFilter} onChange={e => setClientArchiveFilter(e.target.value)}><option value="active">Active</option><option value="archived">Archived / Inactive</option><option value="all">All</option></select></label>
              <label className="client-search"><Search size={16} /><input type="search" value={clientSearch} onChange={e => setClientSearch(e.target.value)} placeholder="Search clients, contacts, email" aria-label="Search clients" /></label>
              <label className="lifecycle-filter">Sort by<select value={clientSort} onChange={e => setClientSort(e.target.value)}><option value="name">Name A–Z</option><option value="name-desc">Name Z–A</option><option value="open-tasks">Most open tasks</option><option value="follow-up">Next follow-up</option></select></label>
              <div className="client-layout-switch" role="group" aria-label="Client layout">
                <button type="button" aria-pressed={clientLayout === 'tiles'} onClick={() => chooseClientLayout('tiles')} title="Tiles"><LayoutGrid size={16} /><span>Tiles</span></button>
                <button type="button" aria-pressed={clientLayout === 'list'} onClick={() => chooseClientLayout('list')} title="List"><List size={16} /><span>List</span></button>
                <button type="button" aria-pressed={clientLayout === 'table'} onClick={() => chooseClientLayout('table')} title="Table"><Table2 size={16} /><span>Table</span></button>
              </div>
            </div>
            <p className="client-result-count">{visibleClients.length} client{visibleClients.length === 1 ? '' : 's'} shown</p>
            {visibleClients.length === 0 ? <div className="panel empty-start-card"><Users size={24} /><div><h3>No clients found</h3><p>Try another search or status filter.</p></div></div> : clientLayout === 'table' ? (
              <div className="panel table-panel client-table-panel"><table><thead><tr><th>Client</th><th>Contact</th><th>Status</th><th>Projects</th><th>Open tasks</th><th>Next follow-up</th><th>Actions</th></tr></thead><tbody>
                {visibleClients.map(({ client, projectCount, openTaskCount, next }) => <tr key={client.id}>
                  <td><button type="button" className="table-link" onClick={() => setSelectedClientId(client.id)}><strong>{client.name}</strong></button></td>
                  <td><span>{client.contact}</span><small className="client-table-email">{client.email}</small></td>
                  <td><StatusChip value={isArchived(client) ? 'Archived · Inactive' : client.status} /></td>
                  <td>{projectCount}</td><td>{openTaskCount}</td>
                  <td>{next ? <span title={next.title}>{niceDate(next.followUpDate)}<small className="client-table-email">{next.title}</small></span> : '—'}</td>
                  <td>{canWrite && <button type="button" className="secondary compact" onClick={() => setEditingRecord({ kind: 'clients', id: client.id })}><Pencil size={14} /> Edit</button>}</td>
                </tr>)}
              </tbody></table></div>
            ) : <div className={`client-grid ${clientLayout === 'list' ? 'client-grid-list' : ''}`}>
              {visibleClients.map(({ client, projectCount, openTaskCount, next }) => <div key={client.id} className="client-card-wrap"><button className="client-card" onClick={() => setSelectedClientId(client.id)}>
                  <div className="card-top"><div className="client-avatar">{client.name.slice(0, 2).toUpperCase()}</div><StatusChip value={isArchived(client) ? 'Archived · Inactive' : client.status} /><ChevronRight size={18} /></div>
                  <div className="client-identity"><h3>{client.name}</h3><p>{client.contact} · {client.email}</p></div>
                  <div className="card-stats"><span><b>{projectCount}</b> projects</span><span><b>{openTaskCount}</b> open tasks</span></div>
                  <div className="next-line"><Clock3 size={15} /><span>{next ? `Next: ${niceDate(next.followUpDate)} — ${next.title}` : 'No follow-up scheduled'}</span></div>
                </button>{canWrite && <button className="secondary compact client-card-edit" onClick={() => setEditingRecord({ kind: 'clients', id: client.id })}><Pencil size={14} /> Edit client</button>}</div>)}
            </div>}
          </section>
        )}

        {!selectedClient && !selectedProject && view === 'projects' && hasModule('projects') && (
          <section className="page-stack">
            <div className="section-actions"><p className="page-intro">Projects are global delivery containers. Client association lives on tasks, so one project can serve multiple clients without mixing their client views.</p>{canWrite && <button className="primary" onClick={() => setModal('project')}><Plus size={18} /> New project</button>}</div>
            <label className="lifecycle-filter">Show projects<select value={projectArchiveFilter} onChange={e => setProjectArchiveFilter(e.target.value)}><option value="active">Active</option><option value="archived">Archived / Inactive</option><option value="all">All</option></select></label><div className="panel table-panel"><table><thead><tr><th>Project</th><th>Clients with tasks</th><th>Status</th><th>Target</th><th>Open tasks</th><th>Actions</th></tr></thead><tbody>{store.projects.filter(project => projectArchiveFilter === 'all' || isArchived(project) === (projectArchiveFilter === 'archived')).length === 0 ? <tr><td colSpan={6}><Empty text="No projects in this view. Choose another filter or create a project." /></td></tr> : store.projects.filter(project => projectArchiveFilter === 'all' || isArchived(project) === (projectArchiveFilter === 'archived')).map((project) => {
              const clientIds = [...new Set(store.items.filter((item) => item.projectId === project.id && item.clientId).map((item) => item.clientId as string))]
              const clientLabel = clientIds.length ? clientIds.map((id) => clientName(id)).join(', ') : 'No client tasks yet'
              return <tr key={project.id}><td><button className="table-link project-name-link" type="button" onClick={() => { setSelectedProjectClientId(null); setSelectedProjectId(project.id) }}><strong>{project.name}</strong><small>{project.summary || 'Open project dashboard'}</small></button></td><td>{clientLabel}</td><td><StatusChip value={isArchived(project) ? 'Archived · Inactive' : project.status} /></td><td>{niceDate(project.targetDate)}</td><td>{openItems.filter((item) => item.projectId === project.id).length}</td><td>{canWrite && hasModule('projects') && <button className="secondary compact" onClick={() => setEditingRecord({ kind: 'projects', id: project.id })}><Pencil size={14} /> Edit project</button>}</td></tr>
            })}</tbody></table></div>
          </section>
        )}

        {!selectedClient && !selectedProject && view === 'inbox' && hasModule('inbox') && (
          <section className="page-stack">
            <WorkHub key={`${currentUser.organizationId}:${currentUser.id}`} tasks={store.items} taskSettings={store.taskSettings} clients={store.clients} projects={store.projects} accounts={store.accounts} currentUser={currentUser} onTaskCreated={async () => { const result = await loadCloudStore<Store>(); if (result.data) setStore(normalizeStore(result.data, seedStore())) }} />
            <details className="work-hub-shared-inquiries"><summary>Existing shared inquiries</summary>
            <div className="callout"><Inbox size={22} /><div><strong>Capture first, classify later.</strong><p>Client questions can stay here until you know whether they should become a requirement, issue, decision, or simply be answered.</p></div></div>
            <div className="panel">
              <div className="panel-heading"><div><h2>Existing shared inquiries</h2><p>Continue managing inquiries created in the earlier shared workspace workflow.</p></div><div className="inquiry-heading-actions">{newExternalInquiryCount > 0 && <button className="secondary" type="button" onClick={() => setNewExternalInquiryIds([])}>{newExternalInquiryCount} new · Mark seen</button>}{canWrite && <button className="primary" onClick={() => { setTaskPreset({ type: 'Inquiry' }); setModal('item') }}><Plus size={18} /> Capture inquiry</button>}</div></div>
              <FilterBar query={query} setQuery={setQuery} waiting={waitingFilter} setWaiting={setWaitingFilter} options={waitingOnOptions(store.taskSettings).map((option) => option.label)} />
              {inquiryItems.length ? <div className="inquiry-list">{inquiryItems.map((item) => { const isNewDiscord = item.source === 'Discord' && newExternalInquiryIds.includes(item.id); return <div className={`inquiry-card${item.source === 'Discord' ? ' inquiry-discord' : ''}${isNewDiscord ? ' inquiry-new' : ''}`} key={item.id}><div><div className="row-meta"><PriorityChip value={item.priority} /><InquirySourceBadge source={item.source} isNew={isNewDiscord} /><span>{clientName(item.clientId)} · {projectName(item.projectId)}</span></div><h3>{item.title}</h3><p>{item.description}</p><div className="row-meta"><span>Waiting on <b>{item.waitingOn}</b></span><span>Follow-up {niceDate(item.followUpDate)}</span>{item.sourceSender && <span>From: {item.sourceSender}</span>}</div></div><div className="inquiry-actions">{canUseAI && <button className="secondary" onClick={() => { setAiClientId(item.clientId ?? ''); setAiProjectId(item.projectId ?? ''); setAiPrompt(`Assess this client inquiry and recommend what I should do next.\n\nTitle: ${item.title}\nDetails: ${item.description}`); setView('ai') }}><Sparkles size={15} /> Ask AI</button>}{canWrite && <><button className="secondary" onClick={() => convertInquiry(item.id, 'Requirement')}>→ Requirement</button><button className="secondary" onClick={() => convertInquiry(item.id, 'Issue')}>→ Issue</button><button className="success" onClick={() => resolveItem(item.id)}><CheckCircle2 size={16} /> Answered</button></>}</div></div> })}</div> : <Empty text="No open inquiries match your filters." />}
              <details className="inquiry-archive">
                <summary><span>Discord inquiry archive</span><b>{archivedInquiryItems.length}</b></summary>
                <p className="inquiry-archive-help">Resolved Discord inquiries and inquiries converted into tasks remain here as a historical record.</p>
                {archivedInquiryItems.length ? <div className="inquiry-archive-list">{archivedInquiryItems.map((item) => {
                  const closed = isTaskClosed(item.status, store.taskSettings) || isWaitingOnDone(item.waitingOn, store.taskSettings)
                  const outcome = item.type !== 'Inquiry' ? `Converted to ${item.type}` : closed ? item.status : 'Archived'
                  return <div className="inquiry-archive-row" key={`archive-${item.id}`}>
                    <div><div className="row-meta"><InquirySourceBadge source={item.source} /><span>{outcome}</span><span>{clientName(item.clientId)} · {projectName(item.projectId)}</span>{item.sourceSender && <span>From: {item.sourceSender}</span>}</div><strong>{item.title}</strong>{item.docHubDocuments?.map(d=><span className="dochub-task-badge" key={d.id}>DocHub · {docHubLabels[d.status] || d.status} · {d.signed}/{d.total}</span>)}<small>{item.description || 'No description'}</small></div>
                    <div className="inquiry-archive-meta"><StatusChip value={item.status} /><span>{item.resolvedDate ? `Resolved ${niceDate(item.resolvedDate)}` : `Received ${niceDate(item.dateRaised)}`}</span></div>
                  </div>
                })}</div> : <Empty text="No archived Discord inquiries yet." />}
              </details>
            </div>
            </details>
          </section>
        )}

        {!selectedClient && !selectedProject && view === 'items' && hasModule('items') && (
          <section className="page-stack">
            <div className="panel">
              <div className="panel-heading"><div><h2>All tasks</h2><p>Tasks, requirements, issues, inquiries, decisions, and follow-ups in one searchable list.</p></div><span className="count-pill">{filteredTasks.length} shown · {store.items.length} total</span></div>
              <FilterBar query={query} setQuery={setQuery} waiting={waitingFilter} setWaiting={setWaitingFilter} options={waitingOnOptions(store.taskSettings).map((option) => option.label)} />
              <div className="task-filter-grid">
                <label>Status<select value={taskStatusFilter} onChange={(event) => setTaskStatusFilter(event.target.value)}><option value="">All statuses</option>{[...new Set([...store.taskSettings.statuses.map((status) => status.label), ...store.items.map((item) => item.status)])].filter(Boolean).map((status) => <option key={status} value={status}>{status}</option>)}</select></label>
                <label>Client<select value={taskClientFilter} onChange={(event) => { setTaskClientFilter(event.target.value); setTaskProjectFilter('') }}><option value="">All clients</option><option value="__none__">General / no client</option>{store.clients.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}</select></label>
                <label>Project<select value={taskProjectFilter} onChange={(event) => setTaskProjectFilter(event.target.value)}><option value="">All projects</option><option value="__none__">No project</option>{store.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
                <label>Due / follow-up<select value={taskDateFilter} onChange={(event) => setTaskDateFilter(event.target.value as typeof taskDateFilter)}><option value="All">All dates</option><option value="due-3">Due in next 3 days</option><option value="due-7">Due in next 7 days</option><option value="followup-3">Follow-up in next 3 days</option><option value="followup-7">Follow-up in next 7 days</option><option value="overdue">Overdue due/follow-up</option></select></label>
                <button className="secondary task-filter-clear" type="button" onClick={() => { setTaskClientFilter(''); setTaskProjectFilter(''); setTaskStatusFilter(''); setTaskDateFilter('All'); setWaitingFilter('All'); setQuery('') }}>Clear filters</button>
              </div>
              <div className="task-view-toolbar">
                <div className="client-layout-switch" role="group" aria-label="Task layout">
                  <button type="button" aria-pressed={taskLayout === 'table'} onClick={() => chooseTaskView({ layout: 'table' })} title="Table"><Table2 size={16} /><span>Table</span></button>
                  <button type="button" aria-pressed={taskLayout === 'board'} onClick={() => chooseTaskView({ layout: 'board' })} title="Board"><Columns3 size={16} /><span>Board</span></button>
                </div>
                {taskLayout === 'board' && <>
                  <span className="toolbar-label" id="board-group-label">Group by</span>
                  <div className="client-layout-switch" role="group" aria-labelledby="board-group-label">
                    <button type="button" aria-pressed={boardGroup === 'status'} onClick={() => chooseTaskView({ group: 'status' })}><span>Status</span></button>
                    <button type="button" aria-pressed={boardGroup === 'waiting'} onClick={() => chooseTaskView({ group: 'waiting' })}><span>Waiting on</span></button>
                  </div>
                  <label className="toolbar-check"><input type="checkbox" checked={boardShowSubtasks} onChange={(event) => chooseTaskView({ subtasks: event.target.checked })} /> Show subtasks as cards</label>
                </>}
              </div>
              {taskLayout === 'board'
                ? <TaskBoard items={filteredTasks} allItems={store.items} clients={store.clients} projects={store.projects} accounts={store.accounts} taskSettings={store.taskSettings} group={boardGroup} showSubtasks={boardShowSubtasks} today={today} canEdit={canWriteTasks} onStatusChange={updateTaskStatus} onWaitingChange={updateTaskWaitingOn} onOpen={canWriteTasks ? openTaskEditor : undefined} />
                : <TaskTable items={filteredTasks} allItems={store.items} clients={store.clients} projects={store.projects} taskSettings={store.taskSettings} onResolve={resolveItem} onStatusChange={updateTaskStatus} onEdit={openTaskEditor} onDelete={deleteTask} onCreateSubtask={openSubtaskCreator} onReorderSubtasks={reorderSubtasks} canEdit={canWriteTasks} />}
            </div>
          </section>
        )}

        {!selectedClient && !selectedProject && view === 'requirements' && hasModule('requirements') && <RequirementsTraceability key={`${authUser?.organizationId}:${authUser?.id}:${rtmContext.clientId || ''}:${rtmContext.projectId || ''}`} store={store} canEdit={canWrite} canLink={canWrite && hasModule('items')} canOverride={currentUser?.role === 'Administrator'} context={rtmContext} onSave={saveRtms} onOpenTask={canWriteTasks && hasModule('items') ? openTaskEditor : undefined} />}
        {hasModule('documents') && <div className="document-retained" hidden={Boolean(selectedClient || selectedProject || view !== 'documents')}><DocumentCreation key={`${authUser?.organizationId}:${authUser?.id}`} clients={store.clients} projects={store.projects} items={store.items} launch={documentLaunch} canGenerate={canWrite} draftKey={`${authUser?.organizationId}:${authUser?.id}`} active={pageActive && !selectedClient && !selectedProject && view === 'documents'} /></div>}

        {!selectedClient && !selectedProject && view === 'reports' && hasModule('reports') && <Reports clients={store.clients} projects={store.projects} items={store.items} planner={store.planner} taskSettings={store.taskSettings} accounts={store.accounts} workEvents={store.workEvents} currentUser={currentUser} />}

        {!selectedClient && !selectedProject && view === 'users' && canManageAccounts && <AccountUsers currentUser={currentUser} onChanged={acceptAccountUsers} />}
        {!selectedClient && !selectedProject && view === 'themes' && currentUser.accountType !== 'platform' && <ThemePreferences user={currentUser} onSave={saveOwnPreferences} />}

        {!selectedClient && !selectedProject && view === 'settings' && hasModule('settings') && <Settings key={`${currentUser.organizationId}:${currentUser.id}`} currentUser={currentUser} />}

        {!selectedClient && !selectedProject && view === 'ai' && hasModule('ai') && (
          <section className="page-stack"><AIAssistant clients={store.clients.filter(client => !isArchived(client))} projects={store.projects.filter(project => !isArchived(project))} items={store.items} planner={store.planner} taskSettings={store.taskSettings} accounts={store.accounts} workEvents={store.workEvents} currentUser={currentUser} initialClientId={aiClientId} initialProjectId={aiProjectId} initialPrompt={aiPrompt} onContextChange={(clientId, projectId) => { setAiClientId(clientId); setAiProjectId(projectId); setAiPrompt('') }} onApplySuggestion={applyAISuggestion} /></section>
        )}

        {selectedClient && <ClientDetail onOpenRtms={hasModule('requirements') ? () => openRtms(selectedClient.id) : undefined} controls={<LifecycleControls key={selectedClient.id} kind="clients" record={selectedClient} store={store} canEdit={canWrite && hasModule('clients')} onSave={record => saveLifecycleRecord('clients', record)} />} client={selectedClient} store={store} onBack={() => setSelectedClientId(null)} onOpenProject={(projectId, clientId) => { setSelectedClientId(null); setSelectedProjectClientId(clientId); setSelectedProjectId(projectId) }} onAddTask={(clientId) => { setTaskPreset({ clientId, type: 'Task' }); setModal('item') }} onAskAI={(clientId, projectId = '') => { setAiClientId(clientId); setAiProjectId(projectId); setAiPrompt(''); setSelectedClientId(null); setView('ai') }} canUseAI={canUseAI} canWrite={canWriteTasks} />}

        {selectedProject && <ProjectDetail onOpenRtms={hasModule('requirements') ? () => openRtms(selectedProjectClientId || undefined, selectedProject.id) : undefined} controls={<LifecycleControls key={selectedProject.id} kind="projects" record={selectedProject} store={store} canEdit={canWrite && hasModule('projects')} onSave={record => saveLifecycleRecord('projects', record)} />} project={selectedProject} clientContextId={selectedProjectClientId} store={store} setStore={persist} onBack={() => { const clientId = selectedProjectClientId; setSelectedProjectId(null); setSelectedProjectClientId(null); if (clientId) setSelectedClientId(clientId) }} onAddTask={() => { setTaskPreset({ clientId: selectedProjectClientId || undefined, projectId: selectedProject.id, type: 'Task' }); setModal('item') }} onCreateSubtask={openSubtaskCreator} onReorderSubtasks={reorderSubtasks} onStatusChange={updateTaskStatus} onResolve={resolveItem} onEditTask={openTaskEditor} onDeleteTask={deleteTask} canWrite={canWrite} canEditTasks={canWriteTasks} />}
      </main>

      {modal && canWrite && <Modal title={modal === 'item' ? (taskPreset?.parentTaskId ? 'Add subtask' : taskPreset?.type === 'Inquiry' ? 'Capture inquiry' : 'Add task') : modal === 'taskEdit' ? 'Edit task' : modal === 'client' ? 'Add client' : modal === 'project' ? 'Add project' : editingActivity ? 'Edit activity' : 'Add activity'} closeDisabled={modal === 'taskEdit' && taskEditSaving} onClose={() => { setModal(null); setEditingActivityId(null); setEditingTaskId(null); setTaskPreset(null) }}>
        {modal === 'item' && <TaskForm canLinkRtm={hasModule('requirements') && hasModule('items')} store={store} preset={taskPreset} onSubmit={(item) => { const parent = item.parentTaskId ? store.items.find((candidate) => candidate.id === item.parentTaskId) : undefined; persist({ ...store, items: [item, ...store.items], activity: [{ id: crypto.randomUUID(), clientId: item.clientId, projectId: item.projectId, date: item.dateRaised, text: parent ? `Created subtask under ${parent.title}: ${item.title}` : `Created ${item.type.toLowerCase()} task: ${item.title}` }, ...store.activity] }); setModal(null); setTaskPreset(null) }} />}
        {modal === 'taskEdit' && editingTask && <TaskEditForm autoRefreshDocuments={workspaceAutoRefreshAllowed(view, selectedClientId, selectedProjectId)} canLinkRtm={hasModule('requirements') && hasModule('items')} store={store} item={editingTask} onSubmit={saveTaskEdit} onDelete={deleteTask} onEvidenceMutation={applyEvidenceMutation} onCommentMutation={applyCommentMutation} onTimeEntryMutation={applyTimeEntryMutation} currentUser={currentUser} today={today} />}
        {modal === 'client' && <ClientForm onSubmit={(client) => { persist({ ...store, clients: [...store.clients, client] }); setModal(null) }} />}
        {modal === 'project' && <ProjectForm onSubmit={(project) => { persist({ ...store, projects: [...store.projects, project] }); setModal(null) }} />}
        {modal === 'activity' && <ActivityForm clients={store.clients} projects={store.projects} initial={editingActivity} onSubmit={saveActivity} />}
      </Modal>}
      {editingRecord && currentUser.role !== 'Viewer' && hasModule(editingRecord.kind) && (() => {
        const record = store[editingRecord.kind].find(row => row.id === editingRecord.id)
        return record ? <RecordEditDialog key={`${editingRecord.kind}:${record.id}`} kind={editingRecord.kind} record={record} canRenameClient={currentUser.role === 'Administrator'} onClose={() => setEditingRecord(null)} onSave={updated => saveLifecycleRecord(editingRecord.kind, updated)} /> : null
      })()}
      {profileOpen && currentUser.accountType !== 'platform' && <ProfileModal user={currentUser} onClose={() => setProfileOpen(false)} onSave={updateOwnProfile} />}
      <EmailComposerHost enabled={hasModule('inbox') && currentUser.role !== 'Viewer'} items={store.items} clients={store.clients} projects={store.projects} accounts={store.accounts} currentUser={currentUser} onSent={async () => { const result = await loadCloudStore<Store>(); if (result.data) setStore(normalizeStore(result.data, seedStore())) }} />
    </div>
  )
}

function AuthSplash() {
  return <div className="auth-shell auth-shell-recovery"><div className="auth-card auth-loading"><div className="auth-brand"><img className="auth-brand-logo" src="/client-ops-logo.png" alt="Client Ops Tracker" /></div><div className="auth-spinner" /><p>Checking your session…</p></div></div>
}

function LoginScreen({ busy, error, onLogin }: { busy: boolean; error: string; onLogin: (account: string, username: string, password: string) => Promise<void> }) {
  const [forgot, setForgot] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const rememberedLogin = localStorage.getItem('client-ops-login-remember') === '1'
  const [remember, setRemember] = useState(rememberedLogin)
  const [account, setAccount] = useState(() => rememberedLogin ? localStorage.getItem('client-ops-login-account') || '' : '')
  const [username, setUsername] = useState(() => rememberedLogin ? localStorage.getItem('client-ops-login-user') || '' : '')
  if (forgot) return <ForgotPassword account={account} username={username} onBack={() => setForgot(false)} />
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const nextAccount = String(form.get('account') || '').trim()
    const nextUsername = String(form.get('username') || '').trim()
    if (remember) {
      localStorage.setItem('client-ops-login-remember', '1')
      localStorage.setItem('client-ops-login-account', nextAccount)
      localStorage.setItem('client-ops-login-user', nextUsername)
    } else {
      localStorage.removeItem('client-ops-login-remember')
      localStorage.removeItem('client-ops-login-account')
      localStorage.removeItem('client-ops-login-user')
    }
    void onLogin(nextAccount, nextUsername, String(form.get('password') || ''))
  }
  return <div className="auth-shell auth-shell-login">
    <aside className="auth-login-visual" aria-hidden="true"><img src="/login-hero.webp" alt="" /></aside>
    <main className="auth-login-panel">
      <div className="auth-version">v{APP_VERSION}</div>
      <div className="auth-card account-login-card auth-card-modern">
        <div className="auth-brand auth-brand-modern">
          <img className="auth-app-icon" src="/ba-app-icon.png" alt="" />
          <div className="auth-brand-copy"><strong>Client Ops Tracker</strong><span>Sign in to your workspace</span></div>
        </div>
        <form className="auth-form auth-form-modern" onSubmit={submit}>
          <label><span>Account</span><div className="auth-input-shell"><Building2 size={18} /><input name="account" value={account} onChange={(event) => setAccount(event.target.value)} autoComplete="organization" placeholder="BXI-Core or customer account" required /></div></label>
          <label><span>User</span><div className="auth-input-shell"><UserRound size={18} /><input name="username" value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" required /></div></label>
          <label><span>Password</span><div className="auth-input-shell"><LockKeyhole size={18} /><input name="password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" required /><button className="auth-password-toggle" type="button" onClick={() => setShowPassword(value => !value)} aria-label={showPassword ? 'Hide password' : 'Show password'}>{showPassword ? <EyeOff size={18} /> : <Eye size={18} />}</button></div></label>
          <div className="auth-form-options"><label className="auth-remember"><input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} /><span>Remember me</span></label><button className="auth-inline-link" type="button" disabled={busy} onClick={() => setForgot(true)}>Forgot password?</button></div>
          {error && <div className="auth-error" role="alert">{error}</div>}
          <button className="primary auth-submit auth-submit-modern" disabled={busy}>{busy ? 'Signing in…' : <><span>Sign in</span><ArrowRight size={18} /></>}</button>
        </form>
        <div className="auth-divider" aria-hidden="true"><span>OR</span></div>
        <div className="auth-security-note"><ShieldCheck size={21} /><div><strong>Secure. Simple. Productive.</strong><span>Your client operations, always within reach.</span></div></div>
      </div>
      <div className="auth-copyright">© 2026 Client Ops Tracker. All rights reserved.</div>
    </main>
  </div>
}

function ProfileModal({ user, onClose, onSave }: { user: UserAccount; onClose: () => void; onSave: (profile: { name: string; email: string; phone: string; theme: AppTheme; newPassword?: string; currentPassword?: string }) => Promise<string | void> }) {
  const [message, setMessage] = useState('')
  const [saving, setSaving] = useState(false)
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSaving(true)
    setMessage('')
    const form = new FormData(event.currentTarget)
    const password = String(form.get('newPassword') || '')
    const confirm = String(form.get('confirmPassword') || '')
    const currentPassword = String(form.get('currentPassword') || '')
    const email = String(form.get('email') || '').trim()
    if (password && password !== confirm) {
      setMessage('The new password and confirmation do not match.')
      setSaving(false)
      return
    }
    if ((password || email.toLowerCase() !== String(user.email || '').trim().toLowerCase()) && !currentPassword) {
      setMessage('Enter your current password to change your email address or password.')
      setSaving(false)
      return
    }
    const result = await onSave({
      name: String(form.get('name') || '').trim(),
      email,
      phone: String(form.get('phone') || '').trim(),
      theme: normalizeAppTheme(form.get('theme')),
      newPassword: password || undefined,
      currentPassword: currentPassword || undefined,
    })
    setMessage(result || 'Profile updated.')
    setSaving(false)
  }
  return <div className="modal-backdrop" role="presentation">
    <div className="modal profile-modal" role="dialog" aria-modal="true" aria-label="My profile">
      <div className="modal-head"><div><h2>My profile</h2><p>Update your personal details. Your role and module access are controlled by an Administrator.</p></div><button className="icon-button" type="button" onClick={onClose}><X size={20} /></button></div>
      <form className="profile-form" onSubmit={(event) => void submit(event)}>
        <div className="profile-summary"><div className="settings-avatar">{user.name.split(' ').map((part) => part[0]).slice(0, 2).join('').toUpperCase() || 'U'}</div><div><strong>{user.name}</strong><span>@{user.username} · {user.role}</span></div></div>
        <label>Display name<input name="name" defaultValue={user.name} required /></label>
        <label>Email<input name="email" type="email" defaultValue={user.email} placeholder="name@company.com" /></label>
        <label>Contact number<input name="phone" defaultValue={user.phone} placeholder="+63 900 000 0000" /></label>
        <label>Background theme<select name="theme" defaultValue={normalizeAppTheme(user.theme)}>{THEME_OPTIONS.map((theme) => <option key={theme.id} value={theme.id}>{theme.name}</option>)}</select><small>Open My Themes for Dark, Light, or Gray interface modes and client-specific backgrounds.</small></label>
        <div className="profile-password-grid">
          <label>New password <small>Optional</small><input name="newPassword" type="password" minLength={8} autoComplete="new-password" /></label>
          <label>Confirm new password<input name="confirmPassword" type="password" minLength={8} autoComplete="new-password" /></label>
        </div>
        <label>Current password <small>Required to change your email address or password</small><input name="currentPassword" type="password" autoComplete="current-password" /></label>
        {message && <div className="settings-message">{message}</div>}
        <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Close</button><button className="primary" disabled={saving}>{saving ? 'Saving…' : 'Save profile'}</button></div>
      </form>
    </div>
  </div>
}



function DashboardActivityTimeline({ mode, items, followUps, allItems, accounts, clients, projects, onEdit, onToggle, onEditTask, canEdit, canEditTask }: { mode: 'today' | 'week'; items: PlannerActivity[]; followUps: WorkItem[]; allItems: WorkItem[]; accounts: UserAccount[]; clients: Client[]; projects: Project[]; onEdit: (activity: PlannerActivity) => void; onToggle: (id: string) => void; onEditTask: (id: string) => void; canEdit: boolean; canEditTask: (item: WorkItem) => boolean }) {
  const clientName = (id?: string) => id ? clients.find((client) => client.id === id)?.name : ''
  const projectName = (id?: string) => id ? projects.find((project) => project.id === id)?.name : ''
  const entries = [
    ...items.map((activity) => ({ kind: 'activity' as const, date: activity.date, sortTime: activity.startTime || '99:99', activity })),
    ...followUps.map((item) => ({ kind: 'followup' as const, date: item.followUpDate, sortTime: '99:98', item })),
  ].sort((a, b) => a.date.localeCompare(b.date) || a.sortTime.localeCompare(b.sortTime))
  if (!entries.length) return <div className="activity-empty dashboard-activity-empty">No activities or follow-ups scheduled for this view.</div>
  return <div className="activity-tile-grid" aria-label={mode === 'today' ? "Today's activities" : "This week's activities"}>{entries.map((entry) => {
    if (entry.kind === 'followup') {
      const item = entry.item
      const parent = item.parentTaskId ? allItems.find((candidate) => candidate.id === item.parentTaskId) : undefined
      const context = [clientName(item.clientId), projectName(item.projectId)].filter(Boolean).join(' · ')
      const overdue = Boolean((item.dueDate && item.dueDate < businessDateKey()) || item.followUpDate < businessDateKey())
      const assignedTo = accounts.find((account) => account.id === item.assignedToUserId)?.name || 'Unassigned'
      const canEditThisItem = canEditTask(item)
      return <article className={`activity-tile${overdue ? ' activity-tile-overdue' : ''}`} key={`followup-${item.id}`}>
        <div className="activity-tile-top"><span className="activity-tile-kind">{item.parentTaskId ? 'Subtask' : 'Task'} follow-up</span>{overdue && <span className="activity-overdue-label">Overdue</span>}</div>
        <h3>{canEditThisItem ? <button type="button" className="activity-tile-title" onClick={() => onEditTask(item.id)}>{item.title}</button> : item.title}</h3>
        <p className="activity-tile-context">{context || 'General'}</p>
        {parent && <p className="activity-tile-parent">Parent task: {parent.title}</p>}
        <div className="activity-tile-badges"><StatusChip value={item.status} /><PriorityChip value={item.priority} /></div>
        <div className="activity-tile-details"><span>Assigned to: <b>{assignedTo}</b></span><span>Follow-up: <b>{niceDate(item.followUpDate)}</b></span>{item.dueDate && <span>Due: <b>{niceDate(item.dueDate)}</b></span>}<span>Waiting on: <b>{item.waitingOn}</b></span></div>
        {item.docHubDocuments?.map(d=><span className="dochub-task-badge" key={d.id}>DocHub · {docHubLabels[d.status] || d.status} · {d.signed}/{d.total}</span>)}
        <ActivityCommentPreview text={[item.description, ...(item.comments || []).slice(-3).map((comment) => `${comment.createdByName}: ${comment.text}`)].filter(Boolean).join('\n\n')} title={item.title} />
        {canEditThisItem && <div className="activity-tile-actions"><button className="secondary compact" type="button" onClick={() => onEditTask(item.id)}>Edit {item.parentTaskId ? 'subtask' : 'task'}</button></div>}
      </article>
    }
    const activity = entry.activity
    const context = [clientName(activity.clientId), projectName(activity.projectId)].filter(Boolean).join(' · ')
    const overdue = activity.status === 'Planned' && (activity.endDate || activity.date) < businessDateKey()
    return <article className={`activity-tile${activity.status === 'Done' ? ' activity-tile-done' : ''}${overdue ? ' activity-tile-overdue' : ''}`} key={`activity-${activity.id}`}>
      <div className="activity-tile-top"><span className="activity-tile-kind">{activity.source === 'Google Calendar' ? 'Calendar' : 'Tracker'}</span>{overdue && <span className="activity-overdue-label">Overdue</span>}</div>
      <h3>{canEdit ? <button type="button" className="activity-tile-title" onClick={() => onEdit(activity)}>{activity.title}</button> : activity.title}</h3>
      <p className="activity-tile-context">{context || 'General'}</p>
      <div className="activity-tile-badges"><StatusChip value={activity.status} /></div>
      <div className="activity-tile-details"><span><CalendarDays size={14} /> {niceDate(activity.date)}</span><span><Clock3 size={14} /> {activity.allDay ? 'All day' : [activity.startTime, activity.endTime].filter(Boolean).join(' – ') || 'Time not set'}</span></div>
      <ActivityCommentPreview text={activity.notes} title={activity.title} />
      <div className="activity-tile-actions">
        {canEdit && <button className="secondary compact" type="button" onClick={() => onEdit(activity)}>{activity.source === 'Google Calendar' ? 'Edit local copy' : 'Edit'}</button>}
        {canEdit && <button className="secondary compact" type="button" onClick={() => onToggle(activity.id)}>{activity.status === 'Done' ? 'Mark planned' : 'Mark done'}</button>}
        {activity.calendarLink && <a className="secondary compact dashboard-link-button" href={activity.calendarLink} target="_blank" rel="noreferrer">Open original</a>}
      </div>
    </article>
  })}</div>
}

function DashboardActionTable({ items, accounts, clients, projects, planner }: { items: WorkItem[]; accounts: UserAccount[]; clients: Client[]; projects: Project[]; planner: PlannerActivity[] }) {
  const [pageSize, setPageSize] = useState(10)
  const [page, setPage] = useState(1)
  const clientName = (id?: string) => id ? clients.find((client) => client.id === id)?.name ?? 'Unknown' : 'General'
  const nextActivity = (item: WorkItem) => planner
    .filter((activity) => activity.status === 'Planned' && activity.date >= businessDateKey() && activity.clientId === item.clientId && (!activity.projectId || activity.projectId === item.projectId))
    .sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime))[0]
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize))
  const safePage = Math.min(page, totalPages)
  const start = (safePage - 1) * pageSize
  const visibleItems = items.slice(start, start + pageSize)
  useEffect(() => { if (page !== safePage) setPage(safePage) }, [page, safePage])
  if (!items.length) return <Empty text="Nothing needs your attention right now." />
  return <>
    <div className="table-scroll"><table className="dashboard-action-table"><thead><tr><th>Client</th><th>Task</th><th>Assigned to</th><th>Waiting on</th><th>Follow-up</th><th>Next activity</th></tr></thead><tbody>{visibleItems.map((item) => {
      const activity = nextActivity(item)
      const activityLabel = activity ? `${activity.date === businessDateKey() ? activityTime(activity) : `${niceDate(activity.date)} · ${activityTime(activity)}`} — ${activity.title}` : '—'
      const assignee = accounts.find((account) => account.id === item.assignedToUserId)?.name || 'Unassigned'
      return <tr key={item.id}><td><strong>{clientName(item.clientId)}</strong></td><td><strong>{item.title}</strong><small>{projects.find((project) => project.id === item.projectId)?.name ?? ''}</small></td><td>{assignee}</td><td>{item.waitingOn}</td><td className={item.followUpDate && item.followUpDate < businessDateKey() ? 'overdue-date' : ''}>{item.followUpDate === businessDateKey() ? 'Today' : niceDate(item.followUpDate)}</td><td>{activityLabel}</td></tr>
    })}</tbody></table></div>
    <div className="dashboard-action-pagination">
      <label>Items per page<select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1) }}><option value={10}>10</option><option value={25}>25</option><option value={50}>50</option></select></label>
      <span>Showing {start + 1}–{Math.min(start + pageSize, items.length)} of {items.length}</span>
      <div className="dashboard-page-buttons"><button className="secondary compact" type="button" disabled={safePage <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>Previous</button><span>Page {safePage} of {totalPages}</span><button className="secondary compact" type="button" disabled={safePage >= totalPages} onClick={() => setPage((value) => Math.min(totalPages, value + 1))}>Next</button></div>
    </div>
  </>
}

function ActivityColumn({ title, subtitle, items, clients, projects, onEdit, onToggle }: { title: string; subtitle: string; items: PlannerActivity[]; clients: Client[]; projects: Project[]; onEdit: (activity: PlannerActivity) => void; onToggle: (id: string) => void }) {
  const clientName = (id?: string) => id ? clients.find((client) => client.id === id)?.name : ''
  const projectName = (id?: string) => id ? projects.find((project) => project.id === id)?.name : ''
  return <div className="activity-column">
    <div className="activity-column-head"><div><h3>{title}</h3><span>{subtitle}</span></div><b>{items.length}</b></div>
    <div className="activity-list">
      {items.length === 0 && <div className="activity-empty">No activities scheduled.</div>}
      {items.map((activity) => <div className={`activity-card ${activity.status === 'Done' ? 'done' : ''}`} key={activity.id}>
        <button className="activity-check" title={activity.status === 'Done' ? 'Mark planned' : 'Mark done'} onClick={() => onToggle(activity.id)}><CheckCircle2 size={18} /></button>
        <div className="activity-main">
          <div className="activity-meta"><span>{title === 'Today' ? activityTime(activity) : `${niceDate(activity.date)} · ${activityTime(activity)}`}</span><span className={activity.source === 'Google Calendar' ? 'source-google' : 'source-local'}>{activity.source}</span></div>
          <strong>{activity.title}</strong>
          {(clientName(activity.clientId) || projectName(activity.projectId)) && <small>{[clientName(activity.clientId), projectName(activity.projectId)].filter(Boolean).join(' · ')}</small>}
          {activity.notes && <p>{activity.notes}</p>}
        </div>
        <div className="activity-controls">
          <button className="icon-button" title="Edit local tracker copy" onClick={() => onEdit(activity)}><Pencil size={16} /></button>
          {activity.calendarLink && <a className="icon-button" title="Open original Google Calendar event" href={activity.calendarLink} target="_blank" rel="noreferrer"><ExternalLink size={16} /></a>}
        </div>
      </div>)}
    </div>
  </div>
}

function ActivityForm({ clients, projects, initial, onSubmit }: { clients: Client[]; projects: Project[]; initial: PlannerActivity | null; onSubmit: (activity: PlannerActivity) => void }) {
  const [clientId, setClientId] = useState(initial?.clientId ?? '')
  const [allDay, setAllDay] = useState(initial?.allDay ?? false)
  const linkedProjects = projects
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    const startDate = String(form.get('date') || businessDateKey())
    const requestedEndDate = String(form.get('endDate') || startDate)
    const endDate = requestedEndDate >= startDate ? requestedEndDate : startDate
    onSubmit({
      id: initial?.id ?? crypto.randomUUID(),
      title: String(form.get('title') || '').trim(),
      date: startDate,
      startTime: allDay ? '' : String(form.get('startTime') || ''),
      endTime: allDay ? '' : String(form.get('endTime') || ''),
      endDate,
      allDay,
      source: initial?.source ?? 'Local',
      status: (form.get('status') as PlannerActivity['status']) || 'Planned',
      clientId: String(form.get('clientId') || '') || undefined,
      projectId: String(form.get('projectId') || '') || undefined,
      notes: String(form.get('notes') || ''),
      calendarEventId: initial?.calendarEventId,
      calendarLink: initial?.calendarLink,
    })
  }
  return <form className="form-grid" onSubmit={submit}>
    {initial?.source === 'Google Calendar' && <div className="readonly-notice span-2"><CalendarDays size={18} /><div><strong>Local calendar copy</strong><span>Your edits here stay in the BA Tracker. They are never sent back to Google Calendar.</span></div></div>}
    <label className="span-2">Activity title<input name="title" required defaultValue={initial?.title ?? ''} placeholder="Meeting, prep work, follow-up, review..." /></label>
    <label>Start date<input name="date" type="date" required defaultValue={initial?.date ?? businessDateKey()} /></label>
    <label>End date<input name="endDate" type="date" defaultValue={initial?.endDate ?? initial?.date ?? businessDateKey()} /></label>
    <label>Status<select name="status" defaultValue={initial?.status ?? 'Planned'}><option>Planned</option><option>Done</option><option>Cancelled</option></select></label>
    <label className="checkbox-label"><input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} /> All-day activity</label><div />
    {!allDay && <><label>Start time<input name="startTime" type="time" defaultValue={initial?.startTime ?? ''} /></label><label>End time<input name="endTime" type="time" defaultValue={initial?.endTime ?? ''} /></label></>}
    <label>Client<select name="clientId" value={clientId} onChange={(e) => setClientId(e.target.value)}><option value="">No client</option>{clients.filter(client => !isArchived(client) || client.id === initial?.clientId).map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}</select></label>
    <label>Project<select name="projectId" defaultValue={initial?.projectId ?? ''}><option value="">No project</option>{linkedProjects.filter(project => !isArchived(project) || project.id === initial?.projectId).map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
    <label className="span-2">BA notes<textarea name="notes" rows={4} defaultValue={initial?.notes ?? ''} placeholder="Preparation notes, agenda, follow-up context, decisions..." /></label>
    <div className="form-actions span-2"><button className="primary">{initial ? 'Save local changes' : 'Add activity'}</button></div>
  </form>
}

function Metric({ title, value, detail, tone = '', icon }: { title: string; value: number; detail: string; tone?: string; icon: React.ReactNode }) {
  return <div className={`metric-card ${tone}`}><div className="metric-icon">{icon}</div><div><span>{title}</span><strong>{value}</strong><small>{detail}</small></div></div>
}

function FilterBar({ query, setQuery, waiting, setWaiting, options }: { query: string; setQuery: (v: string) => void; waiting: 'All' | WaitingOn; setWaiting: (v: 'All' | WaitingOn) => void; options: string[] }) {
  return <div className="filters"><label className="search-box"><Search size={17} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search title, client, project..." /></label><select aria-label="Filter by waiting on" value={waiting} onChange={(e) => setWaiting(e.target.value as 'All' | WaitingOn)}><option>All</option>{(waiting === 'All' || options.includes(waiting) ? options : [...options, waiting]).map((option) => <option key={option}>{option}</option>)}</select></div>
}

function TaskTable({ items, allItems, clients, projects, taskSettings, onResolve, onStatusChange, onEdit, onDelete, onCreateSubtask, onReorderSubtasks, canEdit = true, hiddenColumns = [] }: { items: WorkItem[]; allItems?: WorkItem[]; clients: Client[]; projects: Project[]; taskSettings: TaskSettings; onResolve: (id: string) => void; onStatusChange: (id: string, status: string) => void; onEdit: (id: string) => void; onDelete: (id: string) => void; onCreateSubtask: (id: string) => void; onReorderSubtasks: (parentTaskId: string, orderedIds: string[]) => void; canEdit?: boolean; hiddenColumns?: TaskColumnKey[] }) {
  const sourceItems = allItems || items
  const visibleIds = new Set(items.map((item) => item.id))
  const [draggedSubtaskId, setDraggedSubtaskId] = useState<string | null>(null)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)
  const [collapsedParents, setCollapsedParents] = useState<Set<string>>(() => new Set())
  const clientName = (id?: string) => id ? clients.find((client) => client.id === id)?.name ?? 'Unknown client' : 'General / no client'
  const projectName = (id?: string) => id ? projects.find((project) => project.id === id)?.name ?? 'Unknown project' : 'No project'
  const labels: Record<TaskColumnKey, string> = { status: 'Status', client: 'Client', project: 'Project', type: 'Type', waitingOn: 'Waiting on', priority: 'Priority', owner: 'Assigned to', startDate: 'Start date', dueDate: 'Due date', followUpDate: 'Follow-up' }
  const columns = taskSettings.visibleColumns.filter((column) => !hiddenColumns.includes(column))
  // Start Date is a core scheduling field in v0.6.22. Keep it visible even when
  // an older saved column preference does not contain the newly introduced key.
  if (!hiddenColumns.includes('startDate') && !columns.includes('startDate')) {
    const dueDateIndex = columns.indexOf('dueDate')
    columns.splice(dueDateIndex >= 0 ? dueDateIndex : columns.length, 0, 'startDate')
  }
  if (!items.length) return <Empty text="No tasks match this view." />

  const sortedChildren = (parentTaskId: string) => sourceItems
    .filter((candidate) => candidate.parentTaskId === parentTaskId)
    .sort((a, b) => (a.subtaskOrder ?? Number.MAX_SAFE_INTEGER) - (b.subtaskOrder ?? Number.MAX_SAFE_INTEGER) || a.dateRaised.localeCompare(b.dateRaised) || a.title.localeCompare(b.title))

  const parentIdsWithChildren = items.filter((item) => !item.parentTaskId && sortedChildren(item.id).length > 0).map((item) => item.id)
  const allVisibleParentsCollapsed = parentIdsWithChildren.length > 0 && parentIdsWithChildren.every((id) => collapsedParents.has(id))
  const toggleParent = (id: string) => setCollapsedParents((current) => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  const toggleAllParents = () => setCollapsedParents((current) => {
    const next = new Set(current)
    if (allVisibleParentsCollapsed) parentIdsWithChildren.forEach((id) => next.delete(id))
    else parentIdsWithChildren.forEach((id) => next.add(id))
    return next
  })

  const moveSubtask = (item: WorkItem, direction: -1 | 1) => {
    if (!item.parentTaskId) return
    const siblings = sortedChildren(item.parentTaskId)
    const currentIndex = siblings.findIndex((candidate) => candidate.id === item.id)
    const nextIndex = currentIndex + direction
    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= siblings.length) return
    const next = [...siblings]
    const [moved] = next.splice(currentIndex, 1)
    next.splice(nextIndex, 0, moved)
    onReorderSubtasks(item.parentTaskId, next.map((candidate) => candidate.id))
  }

  const dropSubtask = (target: WorkItem) => {
    if (!draggedSubtaskId || !target.parentTaskId || draggedSubtaskId === target.id) {
      setDraggedSubtaskId(null)
      setDropTargetId(null)
      return
    }
    const dragged = sourceItems.find((candidate) => candidate.id === draggedSubtaskId)
    if (!dragged?.parentTaskId || dragged.parentTaskId !== target.parentTaskId) {
      setDraggedSubtaskId(null)
      setDropTargetId(null)
      return
    }
    const siblings = sortedChildren(target.parentTaskId)
    const from = siblings.findIndex((candidate) => candidate.id === dragged.id)
    const to = siblings.findIndex((candidate) => candidate.id === target.id)
    if (from >= 0 && to >= 0 && from !== to) {
      const next = [...siblings]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      onReorderSubtasks(target.parentTaskId, next.map((candidate) => candidate.id))
    }
    setDraggedSubtaskId(null)
    setDropTargetId(null)
  }

  const renderRow = (item: WorkItem, isSubtask = false) => {
    const rowEditable = canEdit && !archivedWorkReason({ clients, projects, items: sourceItems, taskSettings }, item)
    const closed = isTaskClosed(item.status, taskSettings)
    const overdue = !closed && Boolean((item.dueDate && item.dueDate < businessDateKey()) || (item.followUpDate && item.followUpDate < businessDateKey()))
    const children = sortedChildren(item.id)
    const completedChildren = children.filter((child) => isTaskClosed(child.status, taskSettings) || isWaitingOnDone(child.waitingOn, taskSettings)).length
    const siblings = isSubtask && item.parentTaskId ? sortedChildren(item.parentTaskId) : []
    const siblingIndex = siblings.findIndex((candidate) => candidate.id === item.id)
    const rowClass = `${overdue ? 'overdue-row ' : ''}${isSubtask ? 'subtask-row ' : ''}${draggedSubtaskId === item.id ? 'subtask-dragging ' : ''}${dropTargetId === item.id ? 'subtask-drop-target' : ''}`.trim()
    return <tr
      key={item.id}
      className={rowClass}
      draggable={Boolean(rowEditable && isSubtask)}
      onDragStart={isSubtask ? (event) => { setDraggedSubtaskId(item.id); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', item.id) } : undefined}
      onDragOver={isSubtask ? (event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDropTargetId(item.id) } : undefined}
      onDragLeave={isSubtask ? () => { if (dropTargetId === item.id) setDropTargetId(null) } : undefined}
      onDrop={isSubtask ? (event) => { event.preventDefault(); dropSubtask(item) } : undefined}
      onDragEnd={isSubtask ? () => { setDraggedSubtaskId(null); setDropTargetId(null) } : undefined}
    >
      <td><div className={isSubtask ? 'subtask-title' : 'task-title-with-toggle'}>{isSubtask && <><span className="subtask-branch">↳</span>{rowEditable && <span className="subtask-drag-handle" title="Drag to reorder"><GripVertical size={15} /></span>}</>}{!isSubtask && children.length > 0 && <button className="subtask-collapse-button" type="button" title={collapsedParents.has(item.id) ? 'Expand subtasks' : 'Collapse subtasks'} aria-label={collapsedParents.has(item.id) ? 'Expand subtasks' : 'Collapse subtasks'} onClick={() => toggleParent(item.id)}>{collapsedParents.has(item.id) ? <ChevronRight size={16} /> : <ChevronDown size={16} />}</button>}<div><strong>{item.title}</strong>{item.docHubDocuments?.map(d=><span className="dochub-task-badge" key={d.id}>DocHub · {docHubLabels[d.status] || d.status} · {d.signed}/{d.total}</span>)}<small>{item.description || (isSubtask ? 'Subtask' : 'No description')}{isSubtask && item.evidence?.length ? ` · ${item.evidence.length} evidence file${item.evidence.length === 1 ? '' : 's'}` : ''}{isSubtask && item.comments?.length ? ` · ${item.comments.length} system update${item.comments.length === 1 ? '' : 's'}` : ''}{!isSubtask && children.length ? ` · ${completedChildren}/${children.length} subtasks completed${collapsedParents.has(item.id) ? ' · collapsed' : ''}` : ''}</small>{isSubtask && <span className="subtask-schedule-summary">Start: {item.startDate ? niceDate(item.startDate) : 'Not set'} · Due: {item.dueDate ? niceDate(item.dueDate) : 'Not set'}</span>}</div></div></td>
      {columns.map((column) => <td key={column}>{column === 'status' ? (rowEditable ? <select className="task-status-select" value={item.status} onChange={(event) => onStatusChange(item.id, event.target.value)}>{taskSettings.statuses.map((status) => <option key={status.id} value={status.label}>{status.label}</option>)}</select> : <StatusChip value={item.status} />) : column === 'client' ? clientName(item.clientId) : column === 'project' ? projectName(item.projectId) : column === 'type' ? <TypeChip value={item.type} /> : column === 'waitingOn' ? <WaitingChip value={item.waitingOn} settings={taskSettings} /> : column === 'priority' ? <PriorityChip value={item.priority} /> : column === 'owner' ? item.owner || 'Unassigned' : column === 'startDate' ? niceDate(item.startDate || '') : column === 'dueDate' ? <span className={item.dueDate && item.dueDate < businessDateKey() && !closed ? 'overdue-date' : ''}>{niceDate(item.dueDate || '')}</span> : <span className={item.followUpDate && item.followUpDate < businessDateKey() && !closed ? 'overdue-date' : ''}>{niceDate(item.followUpDate)}</span>}</td>)}
      <td><div className="task-row-actions">{!rowEditable && (item.evidence || []).map(entry => <a key={entry.id} className="secondary compact" href={taskEvidenceUrl(item.id, entry)} target="_blank" rel="noreferrer">{entry.fileName}</a>)}{rowEditable && isSubtask && <><button className="icon-button" title="Move subtask up" disabled={siblingIndex <= 0} onClick={() => moveSubtask(item, -1)}><ChevronUp size={16} /></button><button className="icon-button" title="Move subtask down" disabled={siblingIndex < 0 || siblingIndex >= siblings.length - 1} onClick={() => moveSubtask(item, 1)}><ChevronDown size={16} /></button></>}{rowEditable && !isSubtask && !item.parentTaskId && <button className="icon-button" title="Create subtask" onClick={() => onCreateSubtask(item.id)}><Plus size={17} /></button>}{rowEditable && isSubtask && <button className="icon-button" title={item.evidence?.length ? `Evidence (${item.evidence.length})` : 'Add evidence'} onClick={() => onEdit(item.id)}><Paperclip size={17} /></button>}{rowEditable && <button className="icon-button" title={isSubtask ? 'Edit subtask' : 'Edit task'} onClick={() => onEdit(item.id)}><Pencil size={17} /></button>}{rowEditable && !closed && <button className="icon-button" title={isSubtask ? 'Mark subtask completed' : 'Mark task completed'} onClick={() => onResolve(item.id)}><CheckCircle2 size={18} /></button>}{rowEditable && <button className="icon-button danger-button" title={isSubtask ? 'Delete subtask' : 'Delete task'} onClick={() => onDelete(item.id)}><Trash2 size={17} /></button>}</div></td>
    </tr>
  }

  const topLevel = items.filter((item) => !item.parentTaskId || !visibleIds.has(item.parentTaskId))
  const rows = topLevel.flatMap((item) => [
    renderRow(item, Boolean(item.parentTaskId)),
    ...(collapsedParents.has(item.id) ? [] : sortedChildren(item.id).filter((child) => visibleIds.has(child.id) || visibleIds.has(item.id)).map((child) => renderRow(child, true))),
  ])
  return <div className="task-table-wrap">{parentIdsWithChildren.length > 0 && <div className="task-table-tools"><button className="secondary compact" type="button" onClick={toggleAllParents}>{allVisibleParentsCollapsed ? 'Expand all subtasks' : 'Collapse all subtasks'}</button></div>}<div className="table-scroll"><table className="item-table task-table"><thead><tr><th>Task / Subtask</th>{columns.map((column) => <th key={column}>{labels[column]}</th>)}<th>Actions</th></tr></thead><tbody>{rows}</tbody></table></div></div>
}

function ClientDetail({ onOpenRtms, controls, client, store, onBack, onOpenProject, onAddTask, onAskAI, canUseAI, canWrite }: { onOpenRtms?: () => void; controls: React.ReactNode; client: Client; store: Store; onBack: () => void; onOpenProject: (projectId: string, clientId: string) => void; onAddTask: (clientId: string) => void; onAskAI: (clientId: string, projectId?: string) => void; canUseAI: boolean; canWrite: boolean }) {
  const projectTaskCounts = new Map<string, number>()
  store.items.filter((item) => item.clientId === client.id && item.projectId).forEach((item) => projectTaskCounts.set(item.projectId as string, (projectTaskCounts.get(item.projectId as string) || 0) + 1))
  const projects = store.projects.filter((project) => projectTaskCounts.has(project.id))
  return <section className="page-stack">
    <button className="back-link" onClick={onBack}>← Back to clients</button>
    {onOpenRtms && <button className="secondary" onClick={onOpenRtms}><Table2 size={17} /> RTMs ({store.rtms.filter(m => m.clientId === client.id).length})</button>}
    {controls}<div className="client-hero"><div><div className="row-meta"><StatusChip value={client.status} /><HealthChip value={client.health} /></div><p>{client.contact} · {client.email}</p><p>{client.notes}</p></div><div className="client-hero-actions">{canWrite && !isArchived(client) && <button className="primary" onClick={() => onAddTask(client.id)}><Plus size={17} /> Add task</button>}{canUseAI && !isArchived(client) && <button className="secondary" onClick={() => onAskAI(client.id)}><Sparkles size={17} /> Ask AI</button>}</div></div>
    <div className="panel"><div className="panel-heading"><div><h2>Projects</h2><p>Projects are global. Only projects containing tasks for {client.name} are shown here.</p></div></div>{projects.length ? <div className="client-project-list">{projects.map((project) => <button type="button" className="mini-project mini-project-button" key={project.id} onClick={() => onOpenProject(project.id, client.id)}><div><strong>{project.name}</strong><p>{project.summary || 'Open project dashboard'}</p></div><div><StatusChip value={isArchived(project) ? 'Archived · Inactive' : project.status} /><small>{projectTaskCounts.get(project.id) || 0} task{projectTaskCounts.get(project.id) === 1 ? '' : 's'} · Target {niceDate(project.targetDate)}</small><ChevronRight size={16} /></div></button>)}</div> : <Empty text="No tasks for this client are assigned to a project yet." />}</div>
  </section>
}

function ProjectDetail({ onOpenRtms, controls, project, clientContextId, store, setStore, onBack, onAddTask, onCreateSubtask, onReorderSubtasks, onStatusChange, onResolve, onEditTask, onDeleteTask, canWrite, canEditTasks }: { onOpenRtms?: () => void; controls: React.ReactNode; project: Project; clientContextId: string | null; store: Store; setStore: (store: Store) => void; onBack: () => void; onAddTask: () => void; onCreateSubtask: (id: string) => void; onReorderSubtasks: (parentTaskId: string, orderedIds: string[]) => void; onStatusChange: (id: string, status: string) => void; onResolve: (id: string) => void; onEditTask: (id: string) => void; onDeleteTask: (id: string) => void; canWrite: boolean; canEditTasks: boolean }) {
  const contextClient = clientContextId ? store.clients.find((client) => client.id === clientContextId) : undefined
  const allProjectTasks = store.items.filter((item) => item.projectId === project.id)
  const tasks = clientContextId ? allProjectTasks.filter((item) => item.clientId === clientContextId) : allProjectTasks
  const parentTasks = tasks.filter((item) => !item.parentTaskId)
  const subtasks = tasks.filter((item) => Boolean(item.parentTaskId))
  const openTasks = tasks.filter((item) => !isTaskClosed(item.status, store.taskSettings) && !isWaitingOnDone(item.waitingOn, store.taskSettings))
  const dueSoon = openTasks.filter((item) => item.dueDate && item.dueDate >= businessDateKey() && item.dueDate <= addDays(businessDateKey(), 7))
  const completedSubtasks = subtasks.filter((item) => isTaskClosed(item.status, store.taskSettings) || isWaitingOnDone(item.waitingOn, store.taskSettings)).length
  const clientCount = new Set(allProjectTasks.map((item) => item.clientId).filter(Boolean)).size
  const communication = store.activity.filter((entry) => entry.projectId === project.id && (!clientContextId || entry.clientId === clientContextId)).sort((a, b) => b.date.localeCompare(a.date))
  const [note, setNote] = useState('')
  const addNote = (event: FormEvent) => {
    event.preventDefault()
    if (!canWrite || !note.trim()) return
    setStore({ ...store, activity: [{ id: crypto.randomUUID(), clientId: clientContextId || undefined, projectId: project.id, date: businessDateKey(), text: note.trim() }, ...store.activity] })
    setNote('')
  }
  return <section className="page-stack project-detail-page">
    <button className="back-link" onClick={onBack}>{contextClient ? `← Back to ${contextClient.name}` : '← Back to projects'}</button>
    {onOpenRtms && <button className="secondary" onClick={onOpenRtms}><Table2 size={17} /> Requirements / RTMs ({store.rtms.filter(m => m.projectId === project.id && (!clientContextId || m.clientId === clientContextId)).length})</button>}
    {controls}<div className="project-hero">
      <div><div className="row-meta"><StatusChip value={isArchived(project) ? 'Archived · Inactive' : project.status} /><span>{contextClient ? `${contextClient.name} view` : `Global project · ${clientCount} client${clientCount === 1 ? '' : 's'} with tasks`}</span></div><p>{project.summary || 'No project summary yet.'}</p><small>Target {niceDate(project.targetDate)}</small></div>
      {canEditTasks && !isArchived(project) && !isArchived(contextClient) && <button className="primary" onClick={onAddTask}><Plus size={18} /> Add task{contextClient ? ` for ${contextClient.name}` : ''}</button>}
    </div>
    {contextClient && <div className="project-context-banner"><strong>{contextClient.name}</strong><span>Only this client's tasks, subtasks, and communications are shown. Work from other clients in {project.name} is hidden.</span></div>}
    <div className="project-stat-grid">
      <div className="project-stat"><span>Parent tasks</span><strong>{parentTasks.length}</strong></div>
      <div className="project-stat"><span>Subtasks</span><strong>{subtasks.length}</strong><small>{subtasks.length ? `${completedSubtasks}/${subtasks.length} completed` : 'No subtasks yet'}</small></div>
      <div className="project-stat"><span>Open work</span><strong>{openTasks.length}</strong></div>
      <div className="project-stat"><span>Due in 7 days</span><strong>{dueSoon.length}</strong></div>
    </div>
    <div className="panel"><div className="panel-heading"><div><h2>{contextClient ? `${contextClient.name} tasks` : 'Project tasks'}</h2><p>{contextClient ? `Tasks and subtasks for ${contextClient.name} under ${project.name}.` : 'All client and general tasks created under this global project, with subtasks nested below their parent.'}</p></div><span className="count-pill">{parentTasks.length} tasks · {subtasks.length} subtasks</span></div><TaskTable items={tasks} allItems={store.items} clients={store.clients} projects={store.projects} taskSettings={store.taskSettings} onResolve={onResolve} onStatusChange={onStatusChange} onEdit={onEditTask} onDelete={onDeleteTask} onCreateSubtask={onCreateSubtask} onReorderSubtasks={onReorderSubtasks} canEdit={canEditTasks} hiddenColumns={contextClient ? ['project', 'client'] : ['project']} /></div>
    <div className="panel project-communication-panel"><div className="panel-heading"><div><h2>Communication log</h2><p>{contextClient ? `Communication for ${contextClient.name} within this project.` : 'Project notes, decisions, task events, and follow-up context across all clients.'}</p></div></div>{canWrite && !isArchived(project) && !isArchived(contextClient) && <form className="quick-note" onSubmit={addNote}><input value={note} onChange={(event) => setNote(event.target.value)} placeholder={contextClient ? `Add a ${contextClient.name} communication note...` : 'Add a project communication note...'} /><button className="secondary">Add</button></form>}<div className="timeline">{communication.length ? communication.map((entry) => <div key={entry.id}><span>{niceDate(entry.date)}{!clientContextId && entry.clientId ? ` · ${store.clients.find((client) => client.id === entry.clientId)?.name || 'Unknown client'}` : ''}</span><p>{entry.text}</p></div>) : <div className="activity-empty">No communication logged for this view yet.</div>}</div></div>
  </section>
}

function Modal({ title, onClose, closeDisabled = false, children }: { title: string; onClose: () => void; closeDisabled?: boolean; children: React.ReactNode }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (!closeDisabled && event.currentTarget === event.target) onClose() }}><div className="modal" role="dialog" aria-modal="true" aria-label={title}><div className="modal-head"><h2>{title}</h2><button className="icon-button" disabled={closeDisabled} onClick={onClose}><X size={20} /></button></div>{children}</div></div>
}

function WorkScheduleFields({ itemKind, startDate = '', dueDate = '', followUpDate = '' }: { itemKind: 'Task' | 'Subtask'; startDate?: string; dueDate?: string; followUpDate?: string }) {
  return <fieldset className="work-schedule-fields span-2">
    <legend>{itemKind} schedule</legend>
    <p>Set when this {itemKind.toLowerCase()} starts, when it is due, and when it needs follow-up.</p>
    <div className="work-schedule-grid">
      <label>Start date<input name="startDate" type="date" defaultValue={startDate} /></label>
      <label>Due date<input name="dueDate" type="date" defaultValue={dueDate} /></label>
      <label>Follow-up date<input name="followUpDate" type="date" defaultValue={followUpDate} /></label>
    </div>
  </fieldset>
}

function TaskForm({ canLinkRtm, store, preset, onSubmit }: { canLinkRtm: boolean; store: Store; preset: { clientId?: string; projectId?: string; type?: ItemType; parentTaskId?: string } | null; onSubmit: (item: WorkItem) => void }) {
  const parent = preset?.parentTaskId ? store.items.find((item) => item.id === preset.parentTaskId) : undefined
  const [clientId, setClientId] = useState(parent?.clientId || preset?.clientId || '')
  const [projectId, setProjectId] = useState(parent?.projectId || preset?.projectId || '')
  const clientLocked = Boolean(parent || preset?.clientId)
  const [rtmLinks, setRtmLinks] = useState<RtmLink[]>([])
  const [type, setType] = useState<ItemType>(preset?.type || 'Task')
  const [status, setStatus] = useState(defaultOpenTaskStatus(store.taskSettings))
  const assignableUsers = store.accounts.filter((account) => account.status === 'Active' && (account.role === 'Administrator' || account.role === 'Contributor'))
  const workloadFor = (userId: string) => { const active = store.items.filter((item) => item.assignedToUserId === userId && !isTaskClosed(item.status, store.taskSettings) && !isWaitingOnDone(item.waitingOn, store.taskSettings)); return `${active.length} active · ${active.filter((item) => Boolean(item.dueDate && item.dueDate < businessDateKey())).length} overdue` }
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const startDate = String(form.get('startDate') || '')
    const dueDate = String(form.get('dueDate') || '')
    const assignedToUserId = parent?.assignedToUserId || String(form.get('assignedToUserId') || '') || undefined
    if (startDate && dueDate && dueDate < startDate) { window.alert('Due Date cannot be earlier than Start Date.'); return }
    const estimate = normalizeEstimate(form.get('estimateHours'))
    if (!estimate.ok) { window.alert(estimate.error); return }
    onSubmit({
      estimateHours: estimate.value,
      id: crypto.randomUUID(),
      clientId: parent?.clientId || clientId || undefined,
      projectId: parent?.projectId || projectId || undefined,
      rtmLinks,
      qaResult: String(form.get('qaResult') || 'Not Run') as WorkItem['qaResult'],
      parentTaskId: parent?.id,
      subtaskOrder: parent ? Math.max(-1, ...store.items.filter((item) => item.parentTaskId === parent.id).map((item) => item.subtaskOrder ?? -1)) + 1 : undefined,
      title: String(form.get('title') || '').trim(),
      type,
      priority: form.get('priority') as Priority,
      status,
      waitingOn: form.get('waitingOn') as WaitingOn,
      assignedToUserId,
      assignmentInherited: parent ? true : undefined,
      owner: assignedToUserId ? assignableUsers.find((account) => account.id === assignedToUserId)?.name || parent?.owner || '' : '',
      dateRaised: businessDateKey(),
      startDate,
      dueDate,
      followUpDate: String(form.get('followUpDate') || ''),
      description: String(form.get('description') || ''),
      resolution: '',
      source: form.get('source') as WorkItem['source'],
    })
  }
  const lockedClientId = parent?.clientId || preset?.clientId || ''
  const clientLabel = lockedClientId ? store.clients.find((client) => client.id === lockedClientId)?.name || 'Unknown client' : 'Select client'
  const projectLabel = parent?.projectId ? store.projects.find((project) => project.id === parent.projectId)?.name || 'Unknown project' : 'No project'
  return <form className="form-grid" onSubmit={submit}>
    {parent && <div className="readonly-notice span-2"><CircleDot size={18} /><div><strong>Subtask of: {parent.title}</strong><span>Client and project are inherited from the parent task so the hierarchy stays consistent.</span></div></div>}
    {!parent && preset?.clientId && <div className="readonly-notice span-2"><CircleDot size={18} /><div><strong>Client context: {clientLabel}</strong><span>This task is being created from the client record, so the client stays fixed. You can assign any global project to it.</span></div></div>}
    <label className="span-2">{parent ? 'Subtask title' : 'Task title'}<input name="title" required placeholder={parent ? 'Enter the work needed under this task...' : 'Rollout, sign-off, client follow-up, QA review...'} /></label>
    {parent ? <><label>Client<input value={clientLabel} readOnly disabled /></label><label>Project<input value={projectLabel} readOnly disabled /></label></> : <><label>Client{clientLocked ? <input value={clientLabel} readOnly disabled /> : <select value={clientId} required={type !== 'Inquiry'} onChange={(event) => setClientId(event.target.value)}><option value="">{type === 'Inquiry' ? 'Unassigned / select client' : 'Select client'}</option>{store.clients.filter(client => !isArchived(client)).map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}</select>}</label><label>Project<select value={projectId} disabled={!clientId} onChange={(event) => setProjectId(event.target.value)}><option value="">{clientId ? 'No project' : 'Select a client first'}</option>{store.projects.filter(project => !isArchived(project)).map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label></>}
    <label>Type<select value={type} onChange={(event) => setType(event.target.value as ItemType)}><option>Task</option><option>Inquiry</option><option>Requirement</option><option>Issue</option><option>Decision</option><option>Follow-up</option></select></label>
    <label>Status<select value={status} onChange={(event) => setStatus(event.target.value)}>{store.taskSettings.statuses.map((taskStatus) => <option key={taskStatus.id} value={taskStatus.label}>{taskStatus.label}</option>)}</select></label>
    <label>Priority<select name="priority" defaultValue="Medium"><option>Low</option><option>Medium</option><option>High</option><option>Urgent</option></select></label>
    <label>Waiting on<select name="waitingOn" defaultValue={defaultWaitingOn(store.taskSettings)}>{waitingOnOptions(store.taskSettings).map((option) => <option key={option.id}>{option.label}</option>)}</select></label>
    {parent
      ? <label>Assigned to<input value={assignableUsers.find((account) => account.id === parent.assignedToUserId)?.name || 'Unassigned'} readOnly disabled /><small>Inherited from the main task. You can override it after creating the subtask.</small></label>
      : <label>Assigned to<select name="assignedToUserId" defaultValue=""><option value="">Unassigned</option>{assignableUsers.map((account) => <option key={account.id} value={account.id}>{account.name} · {workloadFor(account.id)}</option>)}</select></label>}
    {canLinkRtm && <RtmTaskLinks store={store} clientId={clientId} projectId={projectId} value={rtmLinks} onChange={setRtmLinks} />}
    <label>QA result<select name="qaResult" defaultValue="Not Run"><option>Not Run</option><option>Passed</option><option>Failed</option><option>Blocked</option></select><small>Used by linked Testing stages. Passed requires completed work.</small></label>
    <WorkScheduleFields itemKind={parent ? 'Subtask' : 'Task'} />
    <label>Estimate (hours)<input name="estimateHours" type="number" inputMode="decimal" min="0" max="1000" step="0.25" placeholder="Optional" /></label>
    <label>Source<select name="source" defaultValue={type === 'Inquiry' ? 'Chat' : 'Internal'}><option>Email</option><option>Meeting</option><option>Chat</option><option>Discord</option><option>Internal</option><option>Other</option></select></label>
    <label className="span-2">Description / comments<textarea name="description" rows={4} placeholder="Context, comments, acceptance details, dependencies, or what needs to be done..." /></label>
    <div className="form-actions span-2"><button className="primary">{parent ? 'Create subtask' : type === 'Inquiry' ? 'Capture inquiry' : 'Create task'}</button></div>
  </form>
}

function TaskEditForm({ autoRefreshDocuments=true, canLinkRtm, store, item, onSubmit, onDelete, onEvidenceMutation, onCommentMutation, onTimeEntryMutation, currentUser, today }: { autoRefreshDocuments?: boolean; canLinkRtm: boolean; store: Store; item: WorkItem; onSubmit: (item: WorkItem) => Promise<void>; onDelete: (id: string) => void; onEvidenceMutation: (result: TaskEvidenceMutationResult) => void; onCommentMutation: (result: TaskCommentMutationResult) => void; onTimeEntryMutation: (result: TimeEntryMutationResult) => void; currentUser: { id: string; role?: string }; today: string }) {
  const [rtmLinks, setRtmLinks] = useState<RtmLink[]>(item.rtmLinks || [])
  const [editProjectId, setEditProjectId] = useState(item.projectId || '')
  const [type, setType] = useState<ItemType>(item.type)
  const [status, setStatus] = useState(item.status)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const parent = item.parentTaskId ? store.items.find((candidate) => candidate.id === item.parentTaskId) : undefined
  const inheritAssignmentValue = '__inherit_parent_assignment__'
  const inheritsParentAssignment = Boolean(parent && (typeof item.assignmentInherited === 'boolean' ? item.assignmentInherited : String(item.assignedToUserId || '') === String(parent.assignedToUserId || '')))
  const assignableUsers = store.accounts.filter((account) => account.status === 'Active' && (account.role === 'Administrator' || account.role === 'Contributor'))
  const workloadFor = (userId: string) => { const active = store.items.filter((candidate) => candidate.assignedToUserId === userId && !isTaskClosed(candidate.status, store.taskSettings) && !isWaitingOnDone(candidate.waitingOn, store.taskSettings)); return `${active.length} active · ${active.filter((candidate) => Boolean(candidate.dueDate && candidate.dueDate < businessDateKey())).length} overdue` }
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (saving) return
    const form = new FormData(event.currentTarget)
    const startDate = String(form.get('startDate') || '')
    const dueDate = String(form.get('dueDate') || '')
    const assignmentSelection = String(form.get('assignedToUserId') || '')
    const assignedToUserId = parent && assignmentSelection === inheritAssignmentValue ? parent.assignedToUserId : assignmentSelection || undefined
    if (startDate && dueDate && dueDate < startDate) { window.alert('Due Date cannot be earlier than Start Date.'); return }
    const estimate = normalizeEstimate(form.get('estimateHours'))
    if (!estimate.ok) { setSaveError(estimate.error); return }
    const changes: WorkItem = {
      ...item,
      estimateHours: estimate.value,
      rtmLinks,
      qaResult: String(form.get('qaResult') || 'Not Run') as WorkItem['qaResult'],
      title: item.title,
      clientId: item.clientId,
      projectId: parent ? item.projectId : editProjectId || undefined,
      type,
      status,
      priority: form.get('priority') as Priority,
      waitingOn: form.get('waitingOn') as WaitingOn,
      assignedToUserId,
      assignmentInherited: parent ? assignmentSelection === inheritAssignmentValue : undefined,
      owner: assignedToUserId ? assignableUsers.find((account) => account.id === assignedToUserId)?.name || '' : '',
      startDate,
      dueDate,
      followUpDate: String(form.get('followUpDate') || ''),
      source: form.get('source') as WorkItem['source'],
      description: String(form.get('description') || ''),
    }
    setSaveError('')
    setSaving(true)
    try { await onSubmit(changes) }
    catch (error) { setSaveError(error instanceof Error ? error.message : 'Your changes could not be saved. Please try again.') }
    finally { setSaving(false) }
  }
  const clientLabel = item.clientId ? store.clients.find((client) => client.id === item.clientId)?.name || 'Unknown client' : 'General / no client'
  const projectLabel = item.projectId ? store.projects.find((project) => project.id === item.projectId)?.name || 'Unknown project' : 'No project'
  return <form className="form-grid" onSubmit={(event) => void submit(event)}>
    <div className="readonly-notice span-2"><LockKeyhole size={18} /><div><strong>{parent ? `Subtask of: ${parent.title}` : 'Task identity is locked'}</strong><span>{parent ? 'Subtask name, client, and parent project stay fixed. You can update its execution fields below.' : 'Task name and client cannot be changed after creation.'}</span></div></div>
    <label className="span-2">{parent ? 'Subtask title' : 'Task title'}<input value={item.title} readOnly disabled /></label>
    <label>Client<input value={clientLabel} readOnly disabled /></label>
    {parent ? <label>Project<input value={projectLabel} readOnly disabled /></label> : <label>Project<select name="projectId" value={editProjectId} onChange={e => setEditProjectId(e.target.value)}><option value="">No project</option>{store.projects.filter(project => !isArchived(project)).map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>}
    <label>Type<select value={type} onChange={(event) => setType(event.target.value as ItemType)}><option>Task</option><option>Inquiry</option><option>Requirement</option><option>Issue</option><option>Decision</option><option>Follow-up</option></select></label>
    <label>Status<select value={status} onChange={(event) => setStatus(event.target.value)}>{store.taskSettings.statuses.map((taskStatus) => <option key={taskStatus.id} value={taskStatus.label}>{taskStatus.label}</option>)}</select></label>
    <label>Priority<select name="priority" defaultValue={item.priority}><option>Low</option><option>Medium</option><option>High</option><option>Urgent</option></select></label>
    <label>Waiting on<select name="waitingOn" defaultValue={item.waitingOn}>{waitingOnOptions(store.taskSettings).map((option) => <option key={option.id}>{option.label}</option>)}{item.waitingOn && !findWaitingOn(item.waitingOn, store.taskSettings) && <option>{item.waitingOn}</option>}</select></label>
    <label>Assigned to<select name="assignedToUserId" defaultValue={parent && inheritsParentAssignment ? inheritAssignmentValue : item.assignedToUserId || ''}>{parent && <option value={inheritAssignmentValue}>Same as main task · {assignableUsers.find((account) => account.id === parent.assignedToUserId)?.name || 'Unassigned'}</option>}<option value="">Unassigned</option>{assignableUsers.map((account) => <option key={account.id} value={account.id}>{account.name} · {workloadFor(account.id)}</option>)}</select>{parent && <small>{inheritsParentAssignment ? 'This subtask follows main-task assignment changes.' : 'This subtask has its own assignee override.'}</small>}</label>
    {canLinkRtm && <RtmTaskLinks store={store} clientId={item.clientId || parent?.clientId} projectId={editProjectId || parent?.projectId} value={rtmLinks} onChange={setRtmLinks} />}
    <label>QA result<select name="qaResult" defaultValue={item.qaResult || 'Not Run'}><option>Not Run</option><option>Passed</option><option>Failed</option><option>Blocked</option></select><small>Completed work without an explicit pass shows Done, not Passed.</small></label>
    <WorkScheduleFields itemKind={parent ? 'Subtask' : 'Task'} startDate={item.startDate || ''} dueDate={item.dueDate || ''} followUpDate={item.followUpDate || ''} />
    <label>Estimate (hours)<input name="estimateHours" type="number" inputMode="decimal" min="0" max="1000" step="0.25" defaultValue={item.estimateHours ?? ''} placeholder="Optional" /><small>{parent ? 'Rolls up to the main task when it has no estimate.' : 'Leave blank to use the sum of subtask estimates.'}</small></label>
    <label>Source<select name="source" defaultValue={item.source}><option>Email</option><option>Meeting</option><option>Chat</option><option>Discord</option><option>Internal</option><option>Other</option></select></label>
    <label className="span-2">Description / comments<textarea name="description" rows={4} defaultValue={item.description} /></label>
    <DocHubHistory active={autoRefreshDocuments} taskId={item.id} canCreate onComplete={() => { const closed=store.taskSettings.statuses.find(s=>s.closed); if(closed)setStatus(closed.label) }} />
    <TaskEffort item={item} allItems={store.items} currentUser={currentUser} canLog={currentUser.role !== 'Viewer'} today={today} onMutation={onTimeEntryMutation} />
    <WorkCommentTrail item={item} onMutation={onCommentMutation} />
    {parent && <SubtaskEvidencePanel item={item} onMutation={onEvidenceMutation} />}
    <TaskDriveFiles item={item} />
    {saveError && <p className="record-editor-error span-2" role="alert">{saveError}</p>}
    <div className="form-actions span-2 task-edit-actions"><button type="button" className="secondary danger-button" disabled={saving} onClick={() => onDelete(item.id)}><Trash2 size={16} /> Delete {parent ? 'subtask' : 'task'}</button><button className="primary" disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</button></div>
  </form>
}

function WorkCommentTrail({ item, onMutation }: { item: WorkItem; onMutation: (result: TaskCommentMutationResult) => void }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [pageSize, setPageSize] = useState<2 | 3 | 5>(3)
  const [page, setPage] = useState(1)
  const comments = [...(item.comments || [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const totalPages = Math.max(1, Math.ceil(comments.length / pageSize))
  const currentPage = Math.min(page, totalPages)
  const pageStart = (currentPage - 1) * pageSize
  const visibleComments = comments.slice(pageStart, pageStart + pageSize)
  useEffect(() => setPage(1), [item.id])
  useEffect(() => { if (page > totalPages) setPage(totalPages) }, [page, totalPages])
  const submitComment = async () => {
    const trimmed = text.trim()
    if (!trimmed || busy) return
    setBusy(true)
    setMessage('')
    try {
      const result = await addTaskComment(item.id, trimmed)
      onMutation(result)
      setText('')
      setPage(1)
      setMessage('Comment added.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Comment could not be saved.')
    } finally {
      setBusy(false)
    }
  }
  return <section className="subtask-comment-trail span-2">
    <div className="subtask-comment-heading"><div><strong><MessageSquareText size={15} /> Activity comments</strong><span>User notes and permanent System follow-up entries.</span></div><span className="count-pill">{comments.length}</span></div>
    <div className="task-comment-composer"><textarea value={text} maxLength={2000} rows={2} placeholder="Add a comment for the assignee or team…" onChange={(event) => setText(event.target.value)} /><button className="secondary" type="button" disabled={!text.trim() || busy} onClick={() => void submitComment()}>{busy ? 'Adding…' : 'Add comment'}</button></div>
    {message && <div className={`task-comment-message${message === 'Comment added.' ? ' success' : ''}`}>{message}</div>}
    {comments.length ? <>
      <div className="subtask-comment-list">{visibleComments.map((comment) => <article key={comment.id} className="subtask-comment-entry">
        <div><span className={comment.kind === 'System' ? 'system-comment-badge' : 'user-comment-badge'}>{comment.kind === 'System' ? 'System' : comment.createdByName || 'User'}</span><time>{evidenceDate(comment.createdAt)}</time></div>
        <p>{comment.text}</p>
      </article>)}</div>
      <div className="task-comment-pagination">
        <span>{pageStart + 1}–{Math.min(pageStart + pageSize, comments.length)} of {comments.length}</span>
        <label>Show<select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value) as 2 | 3 | 5); setPage(1) }}><option value={2}>2</option><option value={3}>3</option><option value={5}>5</option></select></label>
        <div className="task-comment-page-buttons">
          <button type="button" className="secondary compact" disabled={currentPage <= 1} onClick={() => setPage(value => Math.max(1, value - 1))}>Previous</button>
          <span>Page {currentPage} of {totalPages}</span>
          <button type="button" className="secondary compact" disabled={currentPage >= totalPages} onClick={() => setPage(value => Math.min(totalPages, value + 1))}>Next</button>
        </div>
      </div>
    </> : <div className="subtask-comment-empty">No comments yet.</div>}
  </section>
}


function evidenceSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return 'Unknown size'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function evidenceDate(value: string) {
  const date = value ? new Date(value) : null
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleString() : 'Uploaded'
}

/** Gmail attachments saved to the team Google Drive from Work Hub. Links only; the files live in Drive. */
function TaskDriveFiles({ item }: { item: WorkItem }) {
  const canEmail = useEmailEnabled()
  const files = (item.driveFiles || []).filter((file) => file && file.id && file.name && /^https:\/\/drive\.google\.com\//.test(String(file.url || '')))
  if (!files.length) return null
  return <section className="subtask-evidence-panel span-2 task-drive-files">
    <div className="subtask-evidence-heading">
      <div><strong><HardDrive size={15} /> Saved to Google Drive</strong><span>Email attachments and documents filed in the team Drive under this {item.parentTaskId ? 'subtask' : 'task'}’s folder.</span></div>
      <span className="count-pill">{files.length}</span>
    </div>
    <div className="subtask-evidence-list">
      {files.map((file) => <div className="subtask-evidence-item" key={file.id}>
        <div className="subtask-evidence-file"><Paperclip size={15} /><div><strong title={file.name}>{file.name}</strong><span>{file.size ? `${evidenceSize(file.size)} · ` : ''}{evidenceDate(file.savedAt)}{file.savedByName ? ` · ${file.savedByName}` : ''}</span></div></div>
        <div className="subtask-evidence-actions"><a className="secondary compact" href={file.url} target="_blank" rel="noopener noreferrer">Open in Drive</a>{canEmail && <button type="button" className="secondary compact" title="Email this file from your Gmail, linked to this work" onClick={() => composeEmail({ taskIds: [item.id], driveFiles: [{ taskId: item.id, fileId: file.id, name: file.name, size: file.size || 0 }], subject: file.name.replace(/\.[^.]+$/, '') })}>Email</button>}</div>
      </div>)}
    </div>
  </section>
}

function SubtaskEvidencePanel({ item, onMutation }: { item: WorkItem; onMutation: (result: TaskEvidenceMutationResult) => void }) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const evidence = item.evidence || []

  const uploadFiles = async (files: File[]) => {
    if (!files.length || busy) return
    const oversized = files.find((file) => file.size > TASK_EVIDENCE_MAX_BYTES)
    if (oversized) {
      setMessage(`${oversized.name} is larger than the 10 MB evidence limit.`)
      return
    }
    setBusy(true)
    setMessage('')
    try {
      let uploaded = 0
      for (const file of files) {
        const result = await uploadTaskEvidence(item.id, file)
        onMutation(result)
        uploaded += 1
      }
      setMessage(`${uploaded} evidence file${uploaded === 1 ? '' : 's'} uploaded.`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not upload evidence.')
    } finally {
      setBusy(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  const removeEvidence = async (entry: TaskEvidence) => {
    if (busy || !window.confirm(`Remove evidence "${entry.fileName}" from this subtask?`)) return
    setBusy(true)
    setMessage('')
    try {
      const result = await deleteTaskEvidence(item.id, entry.id)
      onMutation(result)
      setMessage('Evidence removed.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not remove evidence.')
    } finally {
      setBusy(false)
    }
  }

  const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
    const files = Array.from(event.clipboardData.files || [])
    const images = files.filter((file) => file.type.startsWith('image/'))
    if (!images.length) return
    event.preventDefault()
    const stamped = images.map((file, index) => {
      if (file.name && file.name !== 'image.png') return file
      const extension = file.type === 'image/jpeg' ? 'jpg' : file.type === 'image/webp' ? 'webp' : 'png'
      return new File([file], `screenshot-${new Date().toISOString().replace(/[:.]/g, '-')}${index ? `-${index + 1}` : ''}.${extension}`, { type: file.type })
    })
    void uploadFiles(stamped)
  }

  return <section className="subtask-evidence-panel span-2">
    <div className="subtask-evidence-heading">
      <div><strong><Paperclip size={15} /> Activity evidence</strong><span>Attach a file, drag and drop, or paste a screenshot with Ctrl+V. Files are stored privately in the database.</span></div>
      <span className="count-pill">{evidence.length}</span>
    </div>
    <div
      className={`subtask-evidence-dropzone ${busy ? 'is-busy' : ''}`}
      tabIndex={0}
      onPaste={handlePaste}
      onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' }}
      onDrop={(event) => { event.preventDefault(); void uploadFiles(Array.from(event.dataTransfer.files || [])) }}
    >
      <Upload size={20} />
      <div><b>{busy ? 'Uploading evidence…' : 'Drop evidence here or paste a screenshot'}</b><span>Images, PDF, Office files, TXT/CSV or ZIP · maximum 10 MB each</span></div>
      <button type="button" className="secondary compact" disabled={busy} onClick={() => inputRef.current?.click()}>Choose files</button>
      <input ref={inputRef} className="evidence-file-input" type="file" multiple disabled={busy} accept="image/png,image/jpeg,image/webp,image/gif,image/bmp,application/pdf,text/plain,text/csv,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.zip" onChange={(event) => void uploadFiles(Array.from(event.target.files || []))} />
    </div>
    {message && <div className="subtask-evidence-message">{message}</div>}
    {evidence.length > 0 && <div className="subtask-evidence-list">
      {evidence.map((entry) => <div className="subtask-evidence-item" key={entry.id}>
        <div className="subtask-evidence-file"><Paperclip size={15} /><div><strong>{entry.fileName}</strong><span>{entry.kind} · {evidenceSize(entry.fileSize)} · {evidenceDate(entry.uploadedAt)}{entry.uploadedByName ? ` · ${entry.uploadedByName}` : ''}</span></div></div>
        <div className="subtask-evidence-actions"><a className="secondary compact" href={taskEvidenceUrl(item.id, entry)} target="_blank" rel="noreferrer">Open</a><button type="button" className="icon-button danger-button" title="Remove evidence" disabled={busy} onClick={() => void removeEvidence(entry)}><Trash2 size={16} /></button></div>
      </div>)}
    </div>}
  </section>
}

function ClientForm({ onSubmit }: { onSubmit: (client: Client) => void }) {
  const submit = (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); const f = new FormData(e.currentTarget); onSubmit({ id: crypto.randomUUID(), name: String(f.get('name')), contact: String(f.get('contact')), email: String(f.get('email')), status: 'Active', health: 'Good', notes: String(f.get('notes') || '') }) }
  return <form className="form-grid" onSubmit={submit}><label>Client name<input name="name" required /></label><label>Primary contact<input name="contact" required /></label><label className="span-2">Email<input name="email" type="email" required /></label><label className="span-2">Notes<textarea name="notes" rows={4} /></label><div className="form-actions span-2"><button className="primary">Create client</button></div></form>
}

function ProjectForm({ onSubmit }: { onSubmit: (project: Project) => void }) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    onSubmit({ id: crypto.randomUUID(), name: String(form.get('name')), status: 'Discovery', targetDate: String(form.get('targetDate') || ''), summary: String(form.get('summary') || '') })
  }
  return <form className="form-grid" onSubmit={submit}><div className="readonly-notice span-2"><BriefcaseBusiness size={18} /><div><strong>Global project</strong><span>Projects are not owned by one client. Client association happens on each task.</span></div></div><label className="span-2">Project name<input name="name" required /></label><label>Target date<input name="targetDate" type="date" /></label><div /><label className="span-2">Summary<textarea name="summary" rows={4} placeholder="Purpose, scope, rollout context, sign-off expectations..." /></label><div className="form-actions span-2"><button className="primary">Create project</button></div></form>
}

function Empty({ text }: { text: string }) { return <div className="empty"><CheckCircle2 size={28} /><p>{text}</p></div> }
function TypeChip({ value }: { value: ItemType }) { return <span className={`chip type-${value.toLowerCase().replace(' ', '-')}`}>{value}</span> }
function PriorityChip({ value }: { value: Priority }) { return <span className={`chip priority-${value.toLowerCase()}`}>{value}</span> }
function InquirySourceBadge({ source, isNew = false }: { source: WorkItem['source']; isNew?: boolean }) { return <span className={`inquiry-source source-${source.toLowerCase().replace(/\s+/g, '-')} ${isNew ? 'is-new' : ''}`}>{source}{isNew ? ' · New' : ''}</span> }
function WaitingChip({ value, settings }: { value: WaitingOn; settings: TaskSettings }) { return <span className={`chip waiting-${waitingOnTone(value, settings)}`}>{value}</span> }
function StatusChip({ value }: { value: string }) { return <span className="chip neutral">{value}</span> }
function HealthChip({ value }: { value: Client['health'] }) { return <span className={`chip health-${value.toLowerCase().replace(' ', '-')}`}>{value}</span> }

export default App
