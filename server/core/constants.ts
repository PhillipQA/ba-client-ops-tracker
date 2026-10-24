// Fixed ids, defaults and bootstrap settings shared by the routes.
import './env'

export const ALL_MODULES = ['action', 'clients', 'projects', 'inbox', 'items', 'documents', 'requirements', 'trackers', 'reports', 'ai', 'settings']

export const BXI_CORE_ORG_ID = '00000000-0000-0000-0000-000000000001'

export const BXI_CORE_ORG_NAME = 'BXI-Core'

export const BXI_CORE_ORG_SLUG = 'bxi-core'

export const INTERNAL_ADMIN_ACCOUNT_KEY = 'internal_admin'

export const INTERNAL_ADMIN_USER_ID = '00000000-0000-0000-0000-000000000100'

export const PASSWORD_BOOTSTRAP_MARKER = '__BOOTSTRAP_REQUIRED__'

export const BCRYPT_ROUNDS = 12

export const internalAdminBootstrapPassword = process.env.INTERNAL_ADMIN_BOOTSTRAP_PASSWORD || ''

export const bxiCoreBootstrapPassword = process.env.BXI_CORE_BOOTSTRAP_PASSWORD || ''

export const defaultAdmin = {
  id: 'admin', username: 'Admin', passwordHash: '', name: 'Administrator', email: '', phone: '', role: 'Administrator',
  modules: ALL_MODULES, status: 'Active', createdAt: '2026-09-17',
}

export const defaultTaskSettings = {
  statuses: [
    { id: 'open', label: 'Open', closed: false },
    { id: 'in-progress', label: 'In Progress', closed: false },
    { id: 'blocked', label: 'Blocked', closed: false },
    { id: 'resolved', label: 'Resolved', closed: true },
    { id: 'closed', label: 'Closed', closed: true },
  ],
  visibleColumns: ['status', 'client', 'project', 'type', 'waitingOn', 'priority', 'owner', 'dueDate', 'followUpDate'],
}

export function openTaskStatus(state: any) {
  const statuses = Array.isArray(state?.taskSettings?.statuses) ? state.taskSettings.statuses : defaultTaskSettings.statuses
  return String(statuses.find((status: any) => !status?.closed)?.label || 'Open')
}
