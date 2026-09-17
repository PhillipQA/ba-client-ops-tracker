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

// Initial administrator requested for first setup.
// Username: Admin
// Password: admin
// Passwords are stored as SHA-256 hashes in this MVP, never as plaintext.
export const seedAccounts: UserAccount[] = [
  {
    id: 'admin',
    username: 'Admin',
    passwordHash: '8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918',
    name: 'Administrator',
    email: '',
    phone: '',
    role: 'Administrator',
    modules: [...ALL_MODULES],
    status: 'Active',
    createdAt: '2026-09-17',
  },
]
