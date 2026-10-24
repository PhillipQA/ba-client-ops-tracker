import type { AppModule, Priority } from '../shared/types'
import {
  Archive,
  BarChart3,
  BriefcaseBusiness,
  Columns3,
  FileText,
  Inbox,
  LayoutDashboard,
  Settings2,
  Sparkles,
  Table2,
  Users,
} from 'lucide-react'

export type View =
  | 'action'
  | 'clients'
  | 'projects'
  | 'inbox'
  | 'items'
  | 'documents'
  | 'requirements'
  | 'trackers'
  | 'reports'
  | 'ai'
  | 'settings'
  | 'internal-admin'
  | 'users'
  | 'themes'

export type ClientLayout = 'tiles' | 'list' | 'table'

export const labels: Record<View, string> = {
  requirements: 'Requirements & Traceability',
  trackers: 'Trackers',
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

export const navItems: { id: AppModule; label: string; icon: typeof LayoutDashboard }[] = [
  { id: 'action', label: 'Action Center', icon: LayoutDashboard },
  { id: 'clients', label: 'Clients', icon: Users },
  { id: 'projects', label: 'Projects', icon: BriefcaseBusiness },
  { id: 'inbox', label: 'Work Hub', icon: Inbox },
  { id: 'items', label: 'Tasks', icon: Archive },
  { id: 'requirements', label: 'Requirements & Traceability', icon: Table2 },
  { id: 'trackers', label: 'Trackers', icon: Columns3 },
  { id: 'documents', label: 'Document Creation', icon: FileText },
  { id: 'reports', label: 'Reports', icon: BarChart3 },
  { id: 'ai', label: 'AI BA Assistant', icon: Sparkles },
  { id: 'settings', label: 'Settings', icon: Settings2 },
]

export const priorityRank: Record<Priority, number> = { Urgent: 4, High: 3, Medium: 2, Low: 1 }
