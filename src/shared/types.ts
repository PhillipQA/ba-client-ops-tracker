import type { AppTheme } from '../features/settings/theme'
import type { InterfaceMode } from '../features/settings/appearance'
export type ItemType = 'Task' | 'Requirement' | 'Issue' | 'Inquiry' | 'Decision' | 'Follow-up'
/** Label of one of the account's configured waiting-on options (see src/waitingOn.ts). */
export type WaitingOn = string
export type Priority = 'Low' | 'Medium' | 'High' | 'Urgent'
export type UserRole = 'Administrator' | 'Contributor' | 'Viewer'
export type AppModule =
  | 'action'
  | 'clients'
  | 'projects'
  | 'inbox'
  | 'items'
  | 'documents'
  | 'requirements'
  | 'trackers'
  | 'reports'
  | 'explorer'
  | 'ai'
  | 'settings'

export type TaskColumnKey =
  | 'status'
  | 'client'
  | 'project'
  | 'type'
  | 'waitingOn'
  | 'priority'
  | 'owner'
  | 'startDate'
  | 'dueDate'
  | 'followUpDate'

export interface TaskStatusDefinition {
  id: string
  label: string
  closed: boolean
}

export interface WaitingOnDefinition {
  id: string
  label: string
  /** The single completion option. Completing a task sets it; work waiting on it counts as done. */
  done: boolean
}

export interface TaskSettings {
  statuses: TaskStatusDefinition[]
  visibleColumns: TaskColumnKey[]
  /** Optional for workspaces saved before v0.6.83; read through waitingOnOptions(). */
  waitingOn?: WaitingOnDefinition[]
  /** The account's own names for priorities and client health (features/tasks/workflow.ts). */
  labels?: WorkflowLabels
}

export interface WorkflowLabels {
  priority?: Partial<Record<Priority, string>>
  health?: Partial<Record<'Good' | 'Watch' | 'At Risk', string>>
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
  /** Linked to this Seeds client; the name follows Seeds. */
  seedsId?: string
  seedsArchived?: boolean
  /** Existed before Seeds was turned on: kept in the Before Seeds folder, still editable. */
  beforeSeeds?: boolean
  /** Shown by name only: this person is assigned to some of its work, not to the client. */
  accessLimited?: boolean
}

export interface Project {
  archived?: boolean
  lifecycleVersion?: number
  id: string
  name: string
  status: 'Discovery' | 'Active' | 'UAT' | 'Closing' | 'Closed'
  targetDate: string
  summary: string
  /** The client this project belongs to (from Seeds). Older projects take their client from their tasks. */
  clientId?: string
  seedsId?: string
  /** When the Seeds sync first brought the project in. */
  seedsAddedAt?: string
  contractNumber?: string
  seedsArchived?: boolean
  /** Existed before Seeds was turned on: kept in the Before Seeds folder, still editable. */
  beforeSeeds?: boolean
  /** The Seeds product (Barter CX…) its time entries carry, when Seeds names one. */
  seedsProductId?: string
  /** What a time entry on this project must carry, and its defaults (Seeds Projects API). */
  seedsTimeRules?: {
    productRequired?: boolean
    taskRequired?: boolean
    remarksRequired?: boolean
    parentRequired?: boolean
    defaultProductId?: string
    defaultTaskId?: string
    defaultParentId?: string
  }
  /** This project's Seeds tasks (Go Live, Meetings…), from the sync: what its tasks and subtasks link to. */
  seedsTasks?: { id: string; name: string; productRequired?: boolean; defaultProductId?: string; archived?: boolean }[]
  accessLimited?: boolean
}

export interface TaskEvidence {
  id: string
  fileName: string
  mimeType: string
  fileSize: number
  /** Where the file is in the database (tracker_evidence_files); empty once it is in Google Drive. */
  storagePath: string
  /** The file in the account's shared Google Drive, in the task's folder. */
  driveFileId?: string
  driveUrl?: string
  uploadedAt: string
  uploadedBy: string
  uploadedByName: string
  kind: 'Screenshot' | 'File'
}

export interface TaskDriveFile {
  id: string
  name: string
  url: string
  mimeType: string
  size: number
  savedAt: string
  savedBy: string
  savedByName: string
  source?: 'gmail' | 'generated' | 'dochub'
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
  rtmLinks?: import('../features/requirements/rtm').RtmLink[]
  qaResult?: 'Not Run' | 'Passed' | 'Failed' | 'Blocked'
  docHubDocuments?: import('../features/documents/dochub').DocHubLink[]
  /** Gmail attachments saved to the account's Google Drive. Written only by the save-to-Drive API. */
  driveFiles?: TaskDriveFile[]
  /** Tasks that block this one (their ids): shown in the editor, table, board and Timeline; see dependencies.ts. */
  blockedBy?: string[]
  /** Optional estimate in hours. */
  estimateHours?: number
  /** Time logged against this task. Written only through the time-entry API. */
  timeEntries?: import('../features/tasks/effort').TimeEntry[]
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
  /** Closed and put away: hidden from Tasks until reopened. Only top-level tasks; their subtasks go with them. */
  archived?: boolean
  archivedAt?: string
  /** A parent task that is this Seeds task; the title follows Seeds. */
  seedsId?: string
  seedsArchived?: boolean
  /** The Seeds task (from the project's list) this work counts toward. A subtask without one follows its parent. */
  seedsTaskId?: string
  /**
   * The Seeds product (from Seeds' product list) this task's time carries. Picked on top-level tasks, where time is
   * logged; required before sending when the Seeds project or Seeds task requires a product.
   */
  productId?: string
}

export type WorkActivityAction =
  | 'created'
  | 'assigned'
  | 'reassigned'
  | 'started'
  | 'status_changed'
  | 'updated'
  | 'completed'
  | 'reopened'
  | 'deleted'
  | 'evidence_uploaded'
  | 'evidence_deleted'
  | 'follow_up_auto_moved'
  | 'comment_added'

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

export type NotificationType =
  | 'signature_completed'
  | 'assigned'
  | 'reassigned'
  | 'due_today'
  | 'overdue'
  | 'follow_up_today'
  | 'follow_up_moved'
  | 'completed'
  | 'reopened'
  | 'evidence_uploaded'
  | 'comment_added'
  | 'tracker_reminder'
  | 'tracker_automation'
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
  /** A mention in a tracker row's comments, or a date reminder: opens that row. */
  trackerId?: string
  trackerRowId?: string
  /** A tracker date reminder: what Snooze snoozes. */
  trackerReminderId?: string
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
  /** Job roles (shared/roles.ts) picked in Users & Permissions; Seeds adds more per client or project. */
  jobRoles?: string[]
  status: 'Active' | 'Disabled'
  createdAt: string
  theme?: AppTheme
  interfaceMode?: InterfaceMode | null
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
