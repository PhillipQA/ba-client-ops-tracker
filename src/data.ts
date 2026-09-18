import { ALL_MODULES } from './access'
import type { ActivityLog, Client, PlannerActivity, Project, TaskSettings, UserAccount, WorkItem } from './types'

// The tracker intentionally starts without preset clients, projects, tasks, or activities.
export const seedClients: Client[] = []
export const seedProjects: Project[] = []
export const seedItems: WorkItem[] = []
export const seedActivity: ActivityLog[] = []
export const seedPlannerActivities: PlannerActivity[] = []

export const defaultTaskSettings: TaskSettings = {
  statuses: [
    { id: 'open', label: 'Open', closed: false },
    { id: 'in-progress', label: 'In Progress', closed: false },
    { id: 'blocked', label: 'Blocked', closed: false },
    { id: 'resolved', label: 'Resolved', closed: true },
    { id: 'closed', label: 'Closed', closed: true },
  ],
  visibleColumns: ['status', 'client', 'project', 'type', 'waitingOn', 'priority', 'owner', 'dueDate', 'followUpDate'],
}

// Initial account metadata only. Password material is never seeded in client code;
// the server/database bootstrap flow owns credential initialization.
export const seedAccounts: UserAccount[] = [
  {
    id: 'admin',
    username: 'Admin',
    passwordHash: '',
    name: 'Administrator',
    email: '',
    phone: '',
    role: 'Administrator',
    modules: [...ALL_MODULES],
    status: 'Active',
    createdAt: '2026-09-17',
  },
]
