import type { AppModule, UserRole } from './types'

export const MODULE_DEFINITIONS: { id: AppModule; label: string; description: string }[] = [
  { id: 'action', label: 'Action Center', description: 'Dashboard, activities, and follow-ups.' },
  { id: 'clients', label: 'Clients', description: 'Client records and client detail.' },
  { id: 'projects', label: 'Projects', description: 'General or client-linked projects and their tasks.' },
  { id: 'inbox', label: 'Inbox / Inquiries', description: 'Capture and classify client inquiries.' },
  { id: 'items', label: 'Tasks', description: 'Tasks, requirements, issues, decisions, and follow-ups.' },
  { id: 'reports', label: 'Reports', description: 'Gantt, turnaround time, workload, and exports.' },
  { id: 'ai', label: 'AI BA Assistant', description: 'Contextual AI assessment and suggested actions.' },
  { id: 'settings', label: 'Settings', description: 'Storage, roles, and account management.' },
]

export const ALL_MODULES = MODULE_DEFINITIONS.map((module) => module.id)

export function defaultModulesForRole(role: UserRole): AppModule[] {
  if (role === 'Administrator') return [...ALL_MODULES]
  if (role === 'Contributor') return ['action', 'clients', 'projects', 'inbox', 'items', 'reports', 'ai']
  return ['reports']
}
