import { ALL_MODULES, defaultModulesForRole } from '../access'
import { normalizeInterfaceMode } from '../appearance'
import { type AuthUser } from '../auth'
import { businessDateKey } from '../businessDate'
import { defaultTaskSettings, seedAccounts, seedActivity, seedClients, seedItems, seedPlannerActivities, seedProjects } from '../data'
import { type RtmMatrix } from '../rtm'
import { normalizeSubtaskAssignmentInheritance } from '../subtaskAssignment'
import { normalizeAppTheme, normalizeClientThemes } from '../theme'
import { type ActivityLog, type AppModule, type AppNotification, type Client, type PlannerActivity, type Project, type TaskColumnKey, type TaskSettings, type UserAccount, type WorkActivityEvent, type WorkItem } from '../types'
import { waitingOnOptions } from '../waitingOn'

export const STORE_SCHEMA_VERSION = 6
export const STORAGE_KEY = 'ba-client-ops-tracker-v2'
export const LEGACY_STORAGE_KEY = 'ba-client-ops-tracker-v1'

export type Store = {
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

export const organizationStorageKey = (organizationId?: string) => organizationId ? `${STORAGE_KEY}:${organizationId}` : STORAGE_KEY

export const seedStore = (): Store => ({
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

export const legacyDemoIds = {
  clients: new Set(['c1', 'c2', 'c3']),
  projects: new Set(['p1', 'p2', 'p3']),
  items: new Set(['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7']),
  activity: new Set(['a1', 'a2', 'a3', 'a4']),
  planner: new Set(['pa1', 'pa2', 'pa3', 'pa4']),
  accounts: new Set(['u1', 'u2', 'u3']),
}

export function normalizeAccount(value: Partial<UserAccount>, index: number): UserAccount | null {
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

export function normalizeTaskSettings(value: Partial<TaskSettings> | undefined): TaskSettings {
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

export function isTaskClosed(status: string, settings: TaskSettings) {
  return settings.statuses.find((candidate) => candidate.label === status)?.closed ?? ['Resolved', 'Closed'].includes(status)
}

export function defaultOpenTaskStatus(settings: TaskSettings) {
  return settings.statuses.find((status) => !status.closed)?.label || 'Open'
}

export function defaultClosedTaskStatus(settings: TaskSettings) {
  return settings.statuses.find((status) => status.closed)?.label || 'Resolved'
}

export const normalizeStore = (value: unknown, fallback: Store = seedStore()): Store => {
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

export const initialStore = (): Store => {
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

export function workEventsForItemChanges(current: Store, next: Store, actor: AuthUser | null): WorkActivityEvent[] {
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
