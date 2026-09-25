import type { AppTheme } from './theme'
export type ItemType = 'Task' | 'Requirement' | 'Issue' | 'Inquiry' | 'Decision' | 'Follow-up'
export type WaitingOn = 'Me' | 'Developer' | 'Client' | 'QA' | 'Design' | 'Done'
export type Priority = 'Low' | 'Medium' | 'High' | 'Urgent'
export type UserRole = 'Administrator' | 'Contributor' | 'Viewer'
export type AppModule = 'action' | 'clients' | 'projects' | 'inbox' | 'items' | 'documents' | 'requirements' | 'reports' | 'ai' | 'settings'

export type TaskColumnKey = 'status' | 'client' | 'project' | 'type' | 'waitingOn' | 'priority' | 'owner' | 'startDate' | 'dueDate' | 'followUpDate'

export interface TaskStatusDefinition {
  id: string
  label: string
  closed: boolean
}

export interface TaskSettings {
  statuses: TaskStatusDefinition[]
  visibleColumns: TaskColumnKey[]
}

export interface Client {
  archived?: boolean
  lifecycleVersion?: number
  id: string
  name: string
  contact: string
  email: string
  status: 'Active' | 'Closing' | 'Closed'
  health: 'Good' | 'Watch' | 'At Risk'
  notes: string
}

export interface Project {
  archived?: boolean
  lifecycleVersion?: number
  id: string
  name: string
  status: 'Discovery' | 'Active' | 'UAT' | 'Closing' | 'Closed'
  targetDate: string
  summary: string
}

export interface TaskEvidence {
  id: string
  fileName: string
  mimeType: string
  fileSize: number
  storagePath: string
  uploadedAt: string
  uploadedBy: string
  uploadedByName: string
  kind: 'Screenshot' | 'File'
}

export interface TaskComment {
  id: string
  text: string
  createdAt: string
  createdBy: string
  createdByName: string
  kind: 'System' | 'User'
  eventType?: 'FOLLOW_UP_AUTO_MOVED' | 'DOCHUB'
  documentId?: string
  previousFollowUpDate?: string
  nextFollowUpDate?: string
  daysMoved?: number
}

export interface WorkItem {
  rtmLinks?: import('./rtm').RtmLink[]
  qaResult?: 'Not Run' | 'Passed' | 'Failed' | 'Blocked'
  docHubDocuments?: import('./dochub').DocHubLink[]
  id: string
  clientId?: string
  projectId?: string
  parentTaskId?: string
  subtaskOrder?: number
  title: string
  type: ItemType
  priority: Priority
  status: string
  waitingOn: WaitingOn
  owner: string
  assignedToUserId?: string
  assignmentInherited?: boolean
  dateRaised: string
  startDate?: string
  dueDate?: string
  followUpDate: string
  description: string
  resolution: string
  resolvedDate?: string
  source: 'Email' | 'Meeting' | 'Chat' | 'Discord' | 'Internal' | 'Other'
  externalSourceId?: string
  sourceSender?: string
  evidence?: TaskEvidence[]
  comments?: TaskComment[]
}

export type WorkActivityAction = 'created' | 'assigned' | 'reassigned' | 'started' | 'status_changed' | 'updated' | 'completed' | 'reopened' | 'deleted' | 'evidence_uploaded' | 'evidence_deleted' | 'follow_up_auto_moved' | 'comment_added'

export interface WorkActivityEvent {
  id: string
  occurredAt: string
  date: string
  actorUserId: string
  actorName: string
  actorRole: UserRole | 'System'
  assignedToUserId?: string
  assignedToName?: string
  clientId?: string
  projectId?: string
  taskId: string
  parentTaskId?: string
  itemTitle: string
  itemKind: 'Task' | 'Subtask'
  action: WorkActivityAction
  summary: string
  field?: string
  oldValue?: string
  newValue?: string
}

export type NotificationType = 'signature_completed' | 'assigned' | 'reassigned' | 'due_today' | 'overdue' | 'follow_up_today' | 'follow_up_moved' | 'completed' | 'reopened' | 'evidence_uploaded' | 'comment_added'
export type NotificationSeverity = 'info' | 'warning' | 'urgent' | 'success'

export interface AppNotification {
  documentId?: string
  id: string
  dedupeKey: string
  recipientUserId: string
  createdAt: string
  type: NotificationType
  scope: 'personal' | 'team'
  severity: NotificationSeverity
  title: string
  message: string
  taskId?: string
  parentTaskId?: string
  clientId?: string
  projectId?: string
  actorUserId?: string
  actorName?: string
  readAt?: string
  dismissedAt?: string
}

export interface ActivityLog {
  id: string
  clientId?: string
  projectId?: string
  date: string
  text: string
}

export type PlannerActivitySource = 'Local' | 'Google Calendar'
export type PlannerActivityStatus = 'Planned' | 'Done' | 'Cancelled'

export interface PlannerActivity {
  id: string
  title: string
  date: string
  startTime: string
  endTime: string
  endDate?: string
  allDay: boolean
  source: PlannerActivitySource
  status: PlannerActivityStatus
  clientId?: string
  projectId?: string
  notes: string
  calendarEventId?: string
  calendarLink?: string
}

export interface UserAccount {
  id: string
  username: string
  passwordHash: string
  name: string
  email: string
  phone: string
  role: UserRole
  modules: AppModule[]
  status: 'Active' | 'Disabled'
  createdAt: string
  theme?: AppTheme
  clientThemes?: Record<string, AppTheme>
  organizationId?: string
  organizationName?: string
  organizationSlug?: string
  organizationModules?: AppModule[]
  isPlatformAdmin?: boolean
  accountType?: 'tenant' | 'platform'
  accountKey?: string
  mustChangePassword?: boolean
  lastLoginAt?: string
}
