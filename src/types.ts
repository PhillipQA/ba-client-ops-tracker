import type { AppTheme } from './theme'
export type ItemType = 'Task' | 'Requirement' | 'Issue' | 'Inquiry' | 'Decision' | 'Follow-up'
export type WaitingOn = 'Me' | 'Developer' | 'Client' | 'QA' | 'Design' | 'Done'
export type Priority = 'Low' | 'Medium' | 'High' | 'Urgent'
export type UserRole = 'Administrator' | 'Contributor' | 'Viewer'
export type AppModule = 'action' | 'clients' | 'projects' | 'inbox' | 'items' | 'documents' | 'reports' | 'ai' | 'settings'

export type TaskColumnKey = 'status' | 'client' | 'project' | 'type' | 'waitingOn' | 'priority' | 'owner' | 'dueDate' | 'followUpDate'

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
  id: string
  name: string
  contact: string
  email: string
  status: 'Active' | 'Closing' | 'Closed'
  health: 'Good' | 'Watch' | 'At Risk'
  notes: string
}

export interface Project {
  id: string
  name: string
  status: 'Discovery' | 'Active' | 'UAT' | 'Closing' | 'Closed'
  targetDate: string
  summary: string
}

export interface WorkItem {
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
  dateRaised: string
  dueDate?: string
  followUpDate: string
  description: string
  resolution: string
  resolvedDate?: string
  source: 'Email' | 'Meeting' | 'Chat' | 'Discord' | 'Internal' | 'Other'
  externalSourceId?: string
  sourceSender?: string
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
}
