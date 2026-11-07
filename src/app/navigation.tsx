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
  Sprout,
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
  | 'seeds'

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
  seeds: 'Seeds sync',
  'internal-admin': 'BXI-Core Internal Admin',
}

/** Modules that are pages of their own. Data explorer lives inside Reports. */
export type PageModule = Exclude<AppModule, 'explorer'>
export const navItems: { id: PageModule; label: string; icon: typeof LayoutDashboard }[] = [
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

/** Pages that live inside Seeds: one sidebar entry, with tabs across the top. */
export const SEEDS_PAGES: PageModule[] = ['clients', 'projects', 'items']
export const isSeedsView = (view: View) => view === 'seeds' || (SEEDS_PAGES as View[]).includes(view)

export type SidebarItem = { id: PageModule; label: string; icon: typeof LayoutDashboard; seeds?: boolean }
/** The sidebar: Clients, Projects and Tasks fold into one Seeds entry, where Clients used to be. */
export function sidebarItems(items: typeof navItems): SidebarItem[] {
  const first = items.find(item => SEEDS_PAGES.includes(item.id))
  return items
    .filter(item => !SEEDS_PAGES.includes(item.id) || item === first)
    .map(item => (item === first ? { ...item, label: 'Seeds', icon: Sprout, seeds: true } : item))
}

export const priorityRank: Record<Priority, number> = { Urgent: 4, High: 3, Medium: 2, Low: 1 }
