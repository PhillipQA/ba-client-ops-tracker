import { FormEvent, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  Archive,
  BarChart3,
  BriefcaseBusiness,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  Clock3,
  ExternalLink,
  Inbox,
  LayoutDashboard,
  Pencil,
  Plus,
  Search,
  LogOut,
  UserRound,
  LockKeyhole,
  Settings2,
  Sparkles,
  Users,
  X,
} from 'lucide-react'
import AIAssistant from './AIAssistant'
import { ALL_MODULES, defaultModulesForRole } from './access'
import { getAuthSession, hashPassword, login, logout, type AuthUser } from './auth'
import { loadCloudStore, queueCloudStoreSave, type CloudStorageStatus } from './cloudStore'
import Reports from './Reports'
import Settings from './Settings'
import type { AISuggestion } from './ai'
import { seedAccounts, seedActivity, seedClients, seedItems, seedPlannerActivities, seedProjects } from './data'
import { importPrimaryCalendar } from './googleCalendar'
import type { ActivityLog, AppModule, Client, ItemType, PlannerActivity, Priority, Project, UserAccount, WaitingOn, WorkItem } from './types'

type View = 'action' | 'clients' | 'projects' | 'inbox' | 'items' | 'reports' | 'ai' | 'settings'

type Store = {
  schemaVersion: number
  clients: Client[]
  projects: Project[]
  items: WorkItem[]
  activity: ActivityLog[]
  planner: PlannerActivity[]
  accounts: UserAccount[]
}

const STORE_SCHEMA_VERSION = 2
const STORAGE_KEY = 'ba-client-ops-tracker-v2'
const LEGACY_STORAGE_KEY = 'ba-client-ops-tracker-v1'
function localDateKey(date: Date) {
  const yyyy = date.getFullYear()
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

const TODAY = localDateKey(new Date())

const seedStore = (): Store => ({
  schemaVersion: STORE_SCHEMA_VERSION,
  clients: seedClients,
  projects: seedProjects,
  items: seedItems,
  activity: seedActivity,
  planner: seedPlannerActivities,
  accounts: seedAccounts,
})

const legacyDemoIds = {
  clients: new Set(['c1', 'c2', 'c3']),
  projects: new Set(['p1', 'p2', 'p3']),
  items: new Set(['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7']),
  activity: new Set(['a1', 'a2', 'a3', 'a4']),
  planner: new Set(['pa1', 'pa2', 'pa3', 'pa4']),
  accounts: new Set(['u1', 'u2', 'u3']),
}

function normalizeAccount(value: Partial<UserAccount>, index: number): UserAccount | null {
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
    modules: role === 'Administrator' ? [...ALL_MODULES] : Array.isArray(value.modules) ? value.modules.filter((module): module is AppModule => ALL_MODULES.includes(module as AppModule)) : defaultModulesForRole(role),
    status: value.status === 'Disabled' ? 'Disabled' : 'Active',
    createdAt: String(value.createdAt || TODAY),
  }
}

const normalizeStore = (value: unknown, fallback: Store = seedStore()): Store => {
  const parsed = value && typeof value === 'object' ? value as Partial<Store> : {}
  const legacy = Number(parsed.schemaVersion || 0) < STORE_SCHEMA_VERSION
  const clients = Array.isArray(parsed.clients) ? parsed.clients.filter((item) => !legacy || !legacyDemoIds.clients.has(item.id)) : fallback.clients
  const projects = Array.isArray(parsed.projects) ? parsed.projects.filter((item) => !legacy || !legacyDemoIds.projects.has(item.id)) : fallback.projects
  const items = Array.isArray(parsed.items) ? parsed.items.filter((item) => !legacy || !legacyDemoIds.items.has(item.id)) : fallback.items
  const activity = Array.isArray(parsed.activity) ? parsed.activity.filter((item) => !legacy || !legacyDemoIds.activity.has(item.id)) : fallback.activity
  const planner = Array.isArray(parsed.planner) ? parsed.planner.filter((item) => !legacy || !legacyDemoIds.planner.has(item.id)) : fallback.planner
  const migratedAccounts = Array.isArray(parsed.accounts) ? parsed.accounts.map((account, index) => normalizeAccount(account, index)).filter((account): account is UserAccount => Boolean(account)) : []
  const accounts = migratedAccounts.length ? migratedAccounts : [...seedAccounts]
  if (!accounts.some((account) => account.role === 'Administrator' && account.status === 'Active')) accounts.unshift(seedAccounts[0])
  return { schemaVersion: STORE_SCHEMA_VERSION, clients, projects, items, activity, planner, accounts }
}

const initialStore = (): Store => {
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

const labels: Record<View, string> = {
  action: 'My Action Center',
  clients: 'Clients',
  projects: 'Projects',
  inbox: 'Inbox / Inquiries',
  items: 'All Items',
  reports: 'Reports',
  ai: 'AI BA Assistant',
  settings: 'Settings',
}

const navItems: { id: View; label: string; icon: typeof LayoutDashboard }[] = [
  { id: 'action', label: 'Action Center', icon: LayoutDashboard },
  { id: 'clients', label: 'Clients', icon: Users },
  { id: 'projects', label: 'Projects', icon: BriefcaseBusiness },
  { id: 'inbox', label: 'Inbox / Inquiries', icon: Inbox },
  { id: 'items', label: 'All Items', icon: Archive },
  { id: 'reports', label: 'Reports', icon: BarChart3 },
  { id: 'ai', label: 'AI BA Assistant', icon: Sparkles },
  { id: 'settings', label: 'Settings', icon: Settings2 },
]

const priorityRank: Record<Priority, number> = { Urgent: 4, High: 3, Medium: 2, Low: 1 }

function todayOrLater(date: string) {
  return date && date >= TODAY
}

function niceDate(date: string) {
  if (!date) return '—'
  const [year, month, day] = date.split('-').map(Number)
  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: year === new Date().getFullYear() ? undefined : 'numeric' }).format(
    new Date(Date.UTC(year, month - 1, day)),
  )
}

function dateFromKey(date: string) {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(year, month - 1, day)
}

function addDays(date: string, amount: number) {
  const next = dateFromKey(date)
  next.setDate(next.getDate() + amount)
  return localDateKey(next)
}

function weekEndKey(date: string) {
  const value = dateFromKey(date)
  const day = value.getDay()
  const daysUntilSunday = day === 0 ? 0 : 7 - day
  return addDays(date, daysUntilSunday)
}

function activityTime(activity: PlannerActivity) {
  if (activity.allDay) return 'All day'
  if (!activity.startTime) return 'Time not set'
  return activity.endTime ? `${activity.startTime}–${activity.endTime}` : activity.startTime
}

function App() {
  const [store, setStore] = useState<Store>(initialStore)
  const [view, setView] = useState<View>('action')
  const [query, setQuery] = useState('')
  const [waitingFilter, setWaitingFilter] = useState<'All' | WaitingOn>('All')
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null)
  const [modal, setModal] = useState<'item' | 'client' | 'project' | 'activity' | null>(null)
  const [editingActivityId, setEditingActivityId] = useState<string | null>(null)
  const [calendarMessage, setCalendarMessage] = useState('')
  const [calendarBusy, setCalendarBusy] = useState(false)
  const [aiClientId, setAiClientId] = useState('')
  const [aiProjectId, setAiProjectId] = useState('')
  const [aiPrompt, setAiPrompt] = useState('')
  const [activityRange, setActivityRange] = useState<'today' | 'week'>('today')
  const [dashboardAiPrompt, setDashboardAiPrompt] = useState('')
  const [cloudStatus, setCloudStatus] = useState<CloudStorageStatus>('checking')
  const [cloudMessage, setCloudMessage] = useState('Checking cloud storage…')
  const [lastCloudSync, setLastCloudSync] = useState<string>('')
  const [authUser, setAuthUser] = useState<AuthUser | null>(null)
  const [authChecking, setAuthChecking] = useState(true)
  const [loginError, setLoginError] = useState('')
  const [loginBusy, setLoginBusy] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    void getAuthSession().then((user) => {
      if (!cancelled) setAuthUser(user)
    }).catch((error) => {
      console.error(error)
    }).finally(() => {
      if (!cancelled) setAuthChecking(false)
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!authUser) return
    let cancelled = false
    const connectCloud = async () => {
      setCloudStatus('checking')
      setCloudMessage('Checking cloud storage…')
      try {
        const result = await loadCloudStore<Store>()
        if (cancelled) return
        if (!result.configured) {
          setCloudStatus('local')
          setCloudMessage('Local browser storage')
          return
        }
        if (result.data) {
          const sourceVersion = Number((result.data as Partial<Store>).schemaVersion || 0)
          const cloud = normalizeStore(result.data, initialStore())
          setStore(cloud)
          localStorage.setItem(STORAGE_KEY, JSON.stringify(cloud))
          setLastCloudSync(result.updatedAt || new Date().toISOString())
          setCloudMessage('Supabase synced')
          setCloudStatus('synced')
          if (sourceVersion < STORE_SCHEMA_VERSION) {
            void queueCloudStoreSave(cloud).catch((error) => console.error('Could not save migrated tracker data:', error))
          }
          return
        }
        const local = initialStore()
        const saved = await queueCloudStoreSave(local)
        if (cancelled) return
        setLastCloudSync(saved.updatedAt || new Date().toISOString())
        setCloudMessage('Supabase initialized from this browser')
        setCloudStatus('synced')
      } catch (error) {
        if (cancelled) return
        console.error(error)
        setCloudStatus('error')
        setCloudMessage('Cloud unavailable · using local cache')
      }
    }
    void connectCloud()
    return () => { cancelled = true }
  }, [authUser?.id])

  const persist = (next: Store) => {
    const normalized = { ...next, schemaVersion: STORE_SCHEMA_VERSION }
    setStore(normalized)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized))
    if (cloudStatus === 'local') return
    setCloudStatus('saving')
    setCloudMessage('Saving to Supabase…')
    void queueCloudStoreSave(normalized).then((result) => {
      if (!result.configured) {
        setCloudStatus('local')
        setCloudMessage('Local browser storage')
        return
      }
      setLastCloudSync(result.updatedAt || new Date().toISOString())
      setCloudStatus('synced')
      setCloudMessage('Supabase synced')
    }).catch((error) => {
      console.error(error)
      setCloudStatus('error')
      setCloudMessage('Cloud save failed · local cache retained')
    })
  }

  const syncCloudNow = async () => {
    setCloudStatus('saving')
    setCloudMessage('Saving to Supabase…')
    try {
      const result = await queueCloudStoreSave({ ...store, schemaVersion: STORE_SCHEMA_VERSION })
      if (!result.configured) {
        setCloudStatus('local')
        setCloudMessage('Supabase is not configured yet')
        return
      }
      setLastCloudSync(result.updatedAt || new Date().toISOString())
      setCloudStatus('synced')
      setCloudMessage('Supabase synced')
    } catch (error) {
      console.error(error)
      setCloudStatus('error')
      setCloudMessage('Cloud sync failed · local cache retained')
    }
  }

  const handleLogin = async (username: string, password: string) => {
    setLoginBusy(true)
    setLoginError('')
    try {
      const user = await login(username, password)
      setAuthUser(user)
      setCloudStatus('checking')
      setCloudMessage('Checking cloud storage…')
      setView(user.role === 'Administrator' || user.modules.includes('action') ? 'action' : (user.modules[0] as View || 'reports'))
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : 'Login failed.')
    } finally {
      setLoginBusy(false)
      setAuthChecking(false)
    }
  }

  const handleLogout = async () => {
    try { await logout() } catch (error) { console.error(error) }
    setAuthUser(null)
    setProfileOpen(false)
    setSelectedClientId(null)
    setLoginError('')
  }

  const accountCurrentUser = authUser ? store.accounts.find((account) => account.id === authUser.id && account.status === 'Active') : null
  const currentUser: UserAccount | null = authUser ? accountCurrentUser ?? {
    ...authUser,
    passwordHash: '',
    createdAt: TODAY,
    modules: authUser.role === 'Administrator' ? [...ALL_MODULES] : authUser.modules,
  } : null
  const canWrite = Boolean(currentUser && currentUser.role !== 'Viewer')
  const canManageAccounts = currentUser?.role === 'Administrator'
  const hasModule = (module: AppModule) => Boolean(currentUser && (currentUser.role === 'Administrator' || currentUser.modules.includes(module)))
  const canUseAI = Boolean(currentUser && currentUser.role !== 'Viewer' && hasModule('ai'))
  const visibleNavItems = currentUser ? navItems.filter((item) => hasModule(item.id) && (item.id !== 'ai' || canUseAI)) : []

  useEffect(() => {
    if (!currentUser || !visibleNavItems.length) return
    if (!visibleNavItems.some((item) => item.id === view)) {
      setSelectedClientId(null)
      setView(visibleNavItems[0].id)
    }
  }, [currentUser?.id, currentUser?.role, currentUser?.modules.join('|'), view])

  const updateOwnProfile = async (profile: { name: string; email: string; phone: string; newPassword?: string }) => {
    if (!currentUser || !authUser) return 'No signed-in account.'
    const patch: Partial<UserAccount> = { name: profile.name.trim(), email: profile.email.trim(), phone: profile.phone.trim() }
    if (profile.newPassword) {
      if (profile.newPassword.length < 4) return 'Use a password with at least 4 characters.'
      patch.passwordHash = await hashPassword(profile.newPassword)
    }
    const next = {
      ...store,
      accounts: store.accounts.map((account) => account.id === currentUser.id ? { ...account, ...patch } : account),
    }
    persist(next)
    setAuthUser({ ...authUser, name: patch.name || authUser.name, email: patch.email ?? authUser.email, phone: patch.phone ?? authUser.phone })
    return 'Profile updated.'
  }

  const clientName = (id: string) => store.clients.find((c) => c.id === id)?.name ?? 'Unknown client'
  const projectName = (id: string) => store.projects.find((p) => p.id === id)?.name ?? 'No project'

  const openItems = useMemo(
    () => store.items.filter((item) => !['Resolved', 'Closed'].includes(item.status) && item.waitingOn !== 'Done'),
    [store.items],
  )

  const overdue = openItems.filter((item) => item.followUpDate && item.followUpDate < TODAY)
  const dueToday = openItems.filter((item) => item.followUpDate === TODAY)
  const waitingDev = openItems.filter((item) => item.waitingOn === 'Developer')
  const waitingClient = openItems.filter((item) => item.waitingOn === 'Client')
  const attentionClientCount = new Set(openItems.map((item) => item.clientId)).size
  const waitingDevOverdue = waitingDev.filter((item) => item.followUpDate && item.followUpDate < TODAY).length
  const openInquiryCount = openItems.filter((item) => item.type === 'Inquiry').length

  const searchedItems = useMemo(() => {
    const q = query.trim().toLowerCase()
    return store.items
      .filter((item) => {
        const text = [item.title, item.description, clientName(item.clientId), projectName(item.projectId), item.type, item.status].join(' ').toLowerCase()
        return !q || text.includes(q)
      })
      .filter((item) => waitingFilter === 'All' || item.waitingOn === waitingFilter)
      .sort((a, b) => {
        const aOverdue = a.followUpDate && a.followUpDate < TODAY ? 1 : 0
        const bOverdue = b.followUpDate && b.followUpDate < TODAY ? 1 : 0
        return bOverdue - aOverdue || priorityRank[b.priority] - priorityRank[a.priority] || (a.followUpDate || '9999').localeCompare(b.followUpDate || '9999')
      })
  }, [store.items, query, waitingFilter, store.clients, store.projects])

  const actionItems = searchedItems.filter((item) => !['Resolved', 'Closed'].includes(item.status) && item.waitingOn !== 'Done')
  const inquiryItems = searchedItems.filter((item) => item.type === 'Inquiry' && !['Resolved', 'Closed'].includes(item.status))
  const selectedClient = store.clients.find((client) => client.id === selectedClientId) ?? null

  const resolveItem = (id: string) => {
    if (!canWrite) return
    const now = new Date().toISOString().slice(0, 10)
    const target = store.items.find((item) => item.id === id)
    if (!target) return
    persist({
      ...store,
      items: store.items.map((item) => (item.id === id ? { ...item, status: 'Resolved', waitingOn: 'Done', followUpDate: '', resolvedDate: now } : item)),
      activity: [
        { id: crypto.randomUUID(), clientId: target.clientId, projectId: target.projectId, date: now, text: `Resolved: ${target.title}` },
        ...store.activity,
      ],
    })
  }

  const convertInquiry = (id: string, type: 'Requirement' | 'Issue') => {
    if (!canWrite) return
    persist({ ...store, items: store.items.map((item) => (item.id === id ? { ...item, type } : item)) })
  }

  const weekEnd = weekEndKey(TODAY)
  const sortedPlanner = [...store.planner].sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime))
  const todayActivities = sortedPlanner.filter((item) => item.date === TODAY && item.status !== 'Cancelled')
  const weekActivities = sortedPlanner.filter((item) => item.date > TODAY && item.date <= weekEnd && item.status !== 'Cancelled')
  const editingActivity = editingActivityId ? store.planner.find((item) => item.id === editingActivityId) ?? null : null

  const openActivityModal = (activity?: PlannerActivity) => {
    if (!canWrite) return
    setEditingActivityId(activity?.id ?? null)
    setModal('activity')
  }

  const saveActivity = (activity: PlannerActivity) => {
    if (!canWrite) return
    const exists = store.planner.some((item) => item.id === activity.id)
    persist({ ...store, planner: exists ? store.planner.map((item) => item.id === activity.id ? activity : item) : [activity, ...store.planner] })
    setModal(null)
    setEditingActivityId(null)
  }

  const toggleActivityDone = (id: string) => {
    if (!canWrite) return
    persist({ ...store, planner: store.planner.map((item) => item.id === id ? { ...item, status: item.status === 'Done' ? 'Planned' : 'Done' } : item) })
  }

  const importCalendar = async () => {
    if (!canWrite) return
    const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined
    if (!clientId) {
      setCalendarMessage('Add VITE_GOOGLE_CLIENT_ID in .env.local to enable Google Calendar import. See README.')
      return
    }
    setCalendarBusy(true)
    setCalendarMessage('')
    try {
      const start = dateFromKey(TODAY)
      start.setHours(0, 0, 0, 0)
      const end = dateFromKey(addDays(weekEnd, 1))
      end.setHours(0, 0, 0, 0)
      const imported = await importPrimaryCalendar(clientId, start.toISOString(), end.toISOString())
      const existingIds = new Set(store.planner.map((item) => item.calendarEventId).filter(Boolean))
      const fresh = imported.filter((item) => !item.calendarEventId || !existingIds.has(item.calendarEventId))
      persist({ ...store, planner: [...fresh, ...store.planner] })
      setCalendarMessage(`${fresh.length} new calendar event${fresh.length === 1 ? '' : 's'} imported as local read-only copies.`)
    } catch (error) {
      setCalendarMessage(error instanceof Error ? error.message : 'Calendar import failed.')
    } finally {
      setCalendarBusy(false)
    }
  }


  const applyAISuggestion = (suggestion: AISuggestion, contextClientId: string, contextProjectId: string) => {
    if (!canWrite) return 'Your Viewer role is read-only. Ask an Administrator or Contributor to approve tracker changes.'
    const clientId = contextClientId
    const projectId = contextProjectId
    if (!clientId) return 'Select a client in the AI context before approving this suggestion.'

    if (suggestion.kind === 'activity') {
      const activity: PlannerActivity = {
        id: crypto.randomUUID(),
        title: suggestion.title,
        date: suggestion.activityDate || suggestion.followUpDate || TODAY,
        startTime: suggestion.activityTime || '',
        endTime: '',
        allDay: !suggestion.activityTime,
        source: 'Local',
        status: 'Planned',
        clientId,
        projectId: projectId || undefined,
        notes: suggestion.description || suggestion.rationale,
      }
      persist({ ...store, planner: [activity, ...store.planner] })
      return `Added tracker activity: ${suggestion.title}`
    }

    if (!projectId) return 'Add or select a project before approving this work-item suggestion.'
    const type: ItemType = suggestion.kind === 'issue' ? 'Issue' : suggestion.kind === 'requirement' ? 'Requirement' : 'Follow-up'
    const item: WorkItem = {
      id: crypto.randomUUID(),
      clientId,
      projectId,
      title: suggestion.title,
      type,
      priority: suggestion.priority || 'Medium',
      status: 'Open',
      waitingOn: suggestion.waitingOn || 'Me',
      owner: 'Me',
      dateRaised: TODAY,
      followUpDate: suggestion.followUpDate || '',
      description: suggestion.description || suggestion.rationale,
      resolution: '',
      source: 'Internal',
    }
    persist({
      ...store,
      items: [item, ...store.items],
      activity: [{ id: crypto.randomUUID(), clientId, projectId, date: TODAY, text: `AI suggestion approved: created ${type.toLowerCase()} — ${suggestion.title}` }, ...store.activity],
    })
    return `Created ${type.toLowerCase()}: ${suggestion.title}`
  }

  const createAccount = (account: UserAccount) => {
    if (!canManageAccounts) return 'Only Administrators can manage accounts.'
    if (store.accounts.some((candidate) => candidate.username.trim().toLowerCase() === account.username.trim().toLowerCase())) return 'That username is already in use.'
    persist({ ...store, accounts: [...store.accounts, account] })
  }

  const updateAccount = (id: string, patch: Partial<UserAccount>) => {
    if (!canManageAccounts || !currentUser) return 'Only Administrators can manage accounts.'
    const target = store.accounts.find((account) => account.id === id)
    if (!target) return 'Account not found.'
    if (id === currentUser.id && (patch.role || patch.status)) return 'You cannot change the role or status of your own signed-in account.'
    const activeAdmins = store.accounts.filter((account) => account.role === 'Administrator' && account.status === 'Active')
    const changesRoleAway = patch.role !== undefined && patch.role !== 'Administrator'
    const disablesAccount = patch.status === 'Disabled'
    const removesLastAdmin = target.role === 'Administrator' && target.status === 'Active' && activeAdmins.length === 1 && (changesRoleAway || disablesAccount)
    if (removesLastAdmin) return 'Keep at least one active Administrator account.'
    persist({ ...store, accounts: store.accounts.map((account) => account.id === id ? { ...account, ...patch, modules: patch.role === 'Administrator' ? [...ALL_MODULES] : (patch.modules ?? account.modules) } : account) })
  }

  const deleteAccount = (id: string) => {
    if (!canManageAccounts || !currentUser) return 'Only Administrators can manage accounts.'
    if (id === currentUser.id) return 'You cannot delete your own signed-in account.'
    const target = store.accounts.find((account) => account.id === id)
    if (!target) return 'Account not found.'
    const activeAdmins = store.accounts.filter((account) => account.role === 'Administrator' && account.status === 'Active')
    if (target.role === 'Administrator' && target.status === 'Active' && activeAdmins.length === 1) return 'Keep at least one active Administrator account.'
    persist({ ...store, accounts: store.accounts.filter((account) => account.id !== id) })
  }

  if (authChecking) return <AuthSplash />
  if (!authUser || !currentUser) return <LoginScreen busy={loginBusy} error={loginError} onLogin={handleLogin} />

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark">BA</div><div><strong>Client Ops</strong><span>Tracker</span></div></div>
        <nav>
          {visibleNavItems.map(({ id, label, icon: Icon }) => (
            <button key={id} className={view === id ? 'nav-button active' : 'nav-button'} onClick={() => { setView(id); setSelectedClientId(null) }}>
              <Icon size={18} /><span>{label}</span>{id === 'inbox' && inquiryItems.length > 0 && <b>{inquiryItems.length}</b>}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <button className="session-card session-card-button" type="button" onClick={() => setProfileOpen(true)} title="Edit your profile">
            <div className="session-avatar"><UserRound size={17} /></div><div><strong>{currentUser.name}</strong><span>{currentUser.role} · My profile</span></div><Pencil size={14} />
          </button>
          <button className="nav-button signout-button" type="button" onClick={() => void handleLogout()}><LogOut size={18} /><span>Sign out</span></button>
          <div className={`local-note storage-${cloudStatus}`} title={lastCloudSync ? `Last cloud sync: ${lastCloudSync}` : undefined}><CircleDot size={12} /> {cloudMessage}</div>
        </div>
      </aside>

      <main>
        <header className="topbar">
          <div><p className="eyebrow">BA CLIENT OPERATIONS</p><h1>{selectedClient ? selectedClient.name : labels[view]}</h1></div>
          <div className="top-actions">
            <span className="top-role-pill">{currentUser.role}</span>
            {canWrite && hasModule('clients') && <button className="secondary" onClick={() => setModal('client')}><Users size={17} /> Add client</button>}
            {canWrite && (hasModule('items') || hasModule('inbox')) && <button className="primary" onClick={() => setModal('item')}><Plus size={18} /> Add item</button>}
          </div>
        </header>

        {!visibleNavItems.length && <section className="page-stack"><div className="panel no-access-panel"><LockKeyhole size={24} /><div><h2>No modules assigned</h2><p>Your account is active, but an Administrator has not assigned any modules yet. You can still open My profile or sign out.</p></div></div></section>}

        {!selectedClient && view === 'action' && hasModule('action') && (
          <section className="page-stack dashboard-stack">
            <div className="metric-grid dashboard-metrics">
              <Metric title="Needs attention" value={openItems.length} detail={`Across ${attentionClientCount} client${attentionClientCount === 1 ? '' : 's'}`} icon={<AlertTriangle size={18} />} />
              <Metric title="Waiting on Dev" value={waitingDev.length} detail={`${waitingDevOverdue} overdue`} icon={<Settings2 size={18} />} />
              <Metric title="Activities today" value={todayActivities.length} detail={`${todayActivities.filter((item) => item.source === 'Google Calendar').length} meetings · ${todayActivities.filter((item) => item.source === 'Local').length} BA tasks`} icon={<CalendarDays size={18} />} />
              <Metric title="Open inquiries" value={openInquiryCount} detail="Need classification" icon={<Inbox size={18} />} />
            </div>

            <div className="panel planner-panel dashboard-panel">
              <div className="panel-heading planner-heading dashboard-panel-heading">
                <div><h2>Activities</h2><p>Meetings and your own BA work in one place.</p></div>
                <div className="planner-actions dashboard-tabs">
                  <button className={activityRange === 'today' ? 'secondary active-tab' : 'secondary'} onClick={() => setActivityRange('today')}>Today</button>
                  <button className={activityRange === 'week' ? 'secondary active-tab' : 'secondary'} onClick={() => setActivityRange('week')}>This Week</button>
                  {canWrite && <button className="secondary" onClick={importCalendar} disabled={calendarBusy}><CalendarDays size={16} /> {calendarBusy ? 'Importing…' : 'Import Calendar'}</button>}
                  {canWrite && <button className="secondary" onClick={() => openActivityModal()}><Plus size={16} /> Add activity</button>}
                </div>
              </div>
              <div className="activity-legend">
                <span>Calendar = imported</span><span>Tracker = local only</span><span>Local edit = Google unchanged</span>
              </div>
              {calendarMessage && <div className="calendar-message">{calendarMessage}</div>}
              <DashboardActivityTimeline
                mode={activityRange}
                items={activityRange === 'today' ? todayActivities : weekActivities}
                clients={store.clients}
                projects={store.projects}
                onEdit={openActivityModal}
                onToggle={toggleActivityDone}
                canEdit={canWrite}
              />
            </div>

            {canUseAI && <div className="panel dashboard-panel dashboard-ai-card">
              <div className="panel-heading dashboard-panel-heading">
                <div><div className="ai-title-line"><Sparkles size={18} /><h2>AI BA Assistant</h2></div><p>Drop a client inquiry, meeting note, or problem here and let AI organize the next steps.</p></div>
                <button className="secondary" onClick={() => setView('ai')}>Open full assistant <ChevronRight size={16} /></button>
              </div>
              <form className="dashboard-ai-body" onSubmit={(event) => {
                event.preventDefault()
                if (!dashboardAiPrompt.trim()) return
                setAiPrompt(dashboardAiPrompt.trim())
                setDashboardAiPrompt('')
                setView('ai')
              }}>
                <div className="dashboard-ai-context">
                  <label>Client<select value={aiClientId} onChange={(e) => { setAiClientId(e.target.value); setAiProjectId('') }}><option value="">General / all clients</option>{store.clients.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}</select></label>
                  <label>Project<select value={aiProjectId} onChange={(e) => setAiProjectId(e.target.value)}><option value="">All projects</option>{store.projects.filter((project) => !aiClientId || project.clientId === aiClientId).map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
                </div>
                <textarea value={dashboardAiPrompt} onChange={(e) => setDashboardAiPrompt(e.target.value)} rows={3} placeholder="Example: Client says search should support @gmail but it does not. Assess what I should do next." />
                <div className="dashboard-ai-footer"><span>Suggestions only — nothing is saved until you approve it.</span><button className="primary" disabled={!dashboardAiPrompt.trim()}><Sparkles size={16} /> Assess with AI</button></div>
              </form>
            </div>}

            <div className="panel dashboard-panel action-center-panel">
              <div className="panel-heading dashboard-panel-heading"><div><h2>My Action Center</h2><p>Activities and follow-ups stay connected, but remain different concepts.</p></div>{hasModule('items') && <button className="secondary" onClick={() => setView('items')}>View all items</button>}</div>
              <DashboardActionTable items={actionItems} clients={store.clients} projects={store.projects} planner={store.planner} />
            </div>
          </section>
        )}

        {!selectedClient && view === 'clients' && hasModule('clients') && (
          <section className="page-stack">
            <div className="section-actions"><p className="page-intro">Your client list is the starting point for all projects, requirements, issues, inquiries, and communication history.</p>{canWrite && <button className="primary" onClick={() => setModal('client')}><Plus size={18} /> New client</button>}</div>
            <div className="client-grid">
              {store.clients.length === 0 && <div className="panel empty-start-card"><Users size={24} /><div><h3>No clients yet</h3><p>Add your first client to start organizing projects, inquiries, activities, and follow-ups.</p></div></div>}
              {store.clients.map((client) => {
                const projects = store.projects.filter((p) => p.clientId === client.id)
                const open = openItems.filter((i) => i.clientId === client.id)
                const next = open.filter((i) => i.followUpDate).sort((a, b) => a.followUpDate.localeCompare(b.followUpDate))[0]
                return <button key={client.id} className="client-card" onClick={() => setSelectedClientId(client.id)}>
                  <div className="card-top"><div className="client-avatar">{client.name.slice(0, 2).toUpperCase()}</div><StatusChip value={client.status} /><ChevronRight size={18} /></div>
                  <h3>{client.name}</h3><p>{client.contact} · {client.email}</p>
                  <div className="card-stats"><span><b>{projects.length}</b> projects</span><span><b>{open.length}</b> open items</span></div>
                  <div className="next-line"><Clock3 size={15} /><span>{next ? `Next: ${niceDate(next.followUpDate)} — ${next.title}` : 'No follow-up scheduled'}</span></div>
                </button>
              })}
            </div>
          </section>
        )}

        {!selectedClient && view === 'projects' && hasModule('projects') && (
          <section className="page-stack">
            <div className="section-actions"><p className="page-intro">Projects group delivery context without adding sprint or story-point overhead.</p>{canWrite && <button className="primary" onClick={() => setModal('project')}><Plus size={18} /> New project</button>}</div>
            <div className="panel table-panel"><table><thead><tr><th>Project</th><th>Client</th><th>Status</th><th>Target</th><th>Open items</th></tr></thead><tbody>{store.projects.length === 0 ? <tr><td colSpan={5}><Empty text={store.clients.length ? 'No projects yet. Add a project when you are ready.' : 'Add a client first, then create projects under that client.'} /></td></tr> : store.projects.map((project) => <tr key={project.id}><td><strong>{project.name}</strong><small>{project.summary}</small></td><td>{clientName(project.clientId)}</td><td><StatusChip value={project.status} /></td><td>{niceDate(project.targetDate)}</td><td>{openItems.filter((item) => item.projectId === project.id).length}</td></tr>)}</tbody></table></div>
          </section>
        )}

        {!selectedClient && view === 'inbox' && hasModule('inbox') && (
          <section className="page-stack">
            <div className="callout"><Inbox size={22} /><div><strong>Capture first, classify later.</strong><p>Client questions can stay here until you know whether they should become a requirement, issue, decision, or simply be answered.</p></div></div>
            <div className="panel">
              <div className="panel-heading"><div><h2>Open inquiries</h2><p>Convert an inquiry once its real nature is clear.</p></div>{canWrite && <button className="primary" onClick={() => setModal('item')}><Plus size={18} /> Capture inquiry</button>}</div>
              <FilterBar query={query} setQuery={setQuery} waiting={waitingFilter} setWaiting={setWaitingFilter} />
              {inquiryItems.length ? <div className="inquiry-list">{inquiryItems.map((item) => <div className="inquiry-card" key={item.id}><div><div className="row-meta"><PriorityChip value={item.priority} /><span>{clientName(item.clientId)} · {projectName(item.projectId)}</span></div><h3>{item.title}</h3><p>{item.description}</p><div className="row-meta"><span>Waiting on <b>{item.waitingOn}</b></span><span>Follow-up {niceDate(item.followUpDate)}</span><span>Source: {item.source}</span></div></div><div className="inquiry-actions">{canUseAI && <button className="secondary" onClick={() => { setAiClientId(item.clientId); setAiProjectId(item.projectId); setAiPrompt(`Assess this client inquiry and recommend what I should do next.\n\nTitle: ${item.title}\nDetails: ${item.description}`); setView('ai') }}><Sparkles size={15} /> Ask AI</button>}{canWrite && <><button className="secondary" onClick={() => convertInquiry(item.id, 'Requirement')}>→ Requirement</button><button className="secondary" onClick={() => convertInquiry(item.id, 'Issue')}>→ Issue</button><button className="success" onClick={() => resolveItem(item.id)}><CheckCircle2 size={16} /> Answered</button></>}</div></div>)}</div> : <Empty text="No open inquiries match your filters." />}
            </div>
          </section>
        )}

        {!selectedClient && view === 'items' && hasModule('items') && (
          <section className="page-stack"><div className="panel"><div className="panel-heading"><div><h2>All work items</h2><p>Requirements, issues, inquiries, decisions, and follow-ups in one searchable list.</p></div><span className="count-pill">{store.items.length} total</span></div><FilterBar query={query} setQuery={setQuery} waiting={waitingFilter} setWaiting={setWaitingFilter} /><ItemTable items={searchedItems} clients={store.clients} projects={store.projects} onResolve={resolveItem} showClosed canEdit={canWrite} /></div></section>
        )}

        {!selectedClient && view === 'reports' && hasModule('reports') && <Reports clients={store.clients} projects={store.projects} items={store.items} planner={store.planner} />}

        {!selectedClient && view === 'settings' && hasModule('settings') && <Settings currentUser={currentUser} accounts={store.accounts} onCreate={createAccount} onUpdate={updateAccount} onDelete={deleteAccount} cloudStatus={cloudStatus} cloudMessage={cloudMessage} lastCloudSync={lastCloudSync} onSyncNow={syncCloudNow} />}

        {!selectedClient && view === 'ai' && hasModule('ai') && (
          <section className="page-stack"><AIAssistant clients={store.clients} projects={store.projects} items={store.items} planner={store.planner} initialClientId={aiClientId} initialProjectId={aiProjectId} initialPrompt={aiPrompt} onContextChange={(clientId, projectId) => { setAiClientId(clientId); setAiProjectId(projectId); setAiPrompt('') }} onApplySuggestion={applyAISuggestion} /></section>
        )}

        {selectedClient && <ClientDetail client={selectedClient} store={store} setStore={persist} onBack={() => setSelectedClientId(null)} onAddItem={() => setModal('item')} onAskAI={(clientId, projectId = '') => { setAiClientId(clientId); setAiProjectId(projectId); setAiPrompt(''); setSelectedClientId(null); setView('ai') }} canWrite={canWrite} canUseAI={canUseAI} />}
      </main>

      {modal && canWrite && <Modal title={modal === 'item' ? 'Add work item' : modal === 'client' ? 'Add client' : modal === 'project' ? 'Add project' : editingActivity ? 'Edit activity' : 'Add activity'} onClose={() => { setModal(null); setEditingActivityId(null) }}>
        {modal === 'item' && <ItemForm store={store} onSubmit={(item) => { persist({ ...store, items: [item, ...store.items], activity: [{ id: crypto.randomUUID(), clientId: item.clientId, projectId: item.projectId, date: item.dateRaised, text: `Created ${item.type.toLowerCase()}: ${item.title}` }, ...store.activity] }); setModal(null) }} />}
        {modal === 'client' && <ClientForm onSubmit={(client) => { persist({ ...store, clients: [...store.clients, client] }); setModal(null) }} />}
        {modal === 'project' && <ProjectForm clients={store.clients} onSubmit={(project) => { persist({ ...store, projects: [...store.projects, project] }); setModal(null) }} />}
        {modal === 'activity' && <ActivityForm clients={store.clients} projects={store.projects} initial={editingActivity} onSubmit={saveActivity} />}
      </Modal>}
      {profileOpen && <ProfileModal user={currentUser} onClose={() => setProfileOpen(false)} onSave={updateOwnProfile} />}
    </div>
  )
}

function AuthSplash() {
  return <div className="auth-shell"><div className="auth-card auth-loading"><div className="auth-brand"><div className="brand-mark">BA</div><div><strong>Client Ops</strong><span>Tracker</span></div></div><div className="auth-spinner" /><p>Checking your session…</p></div></div>
}

function LoginScreen({ busy, error, onLogin }: { busy: boolean; error: string; onLogin: (username: string, password: string) => Promise<void> }) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    void onLogin(String(form.get('username') || '').trim(), String(form.get('password') || ''))
  }
  return <div className="auth-shell">
    <div className="auth-card">
      <div className="auth-brand"><div className="brand-mark">BA</div><div><strong>Client Ops</strong><span>Tracker</span></div></div>
      <div className="auth-copy"><span className="auth-icon"><LockKeyhole size={22} /></span><div><h1>Sign in</h1><p>Access your BA workspace, client records, activities, reports, and AI assistant.</p></div></div>
      <form className="auth-form" onSubmit={submit}>
        <label>Username<input name="username" defaultValue="Admin" autoComplete="username" required /></label>
        <label>Password<input name="password" type="password" defaultValue="admin" autoComplete="current-password" required /></label>
        {error && <div className="auth-error">{error}</div>}
        <button className="primary auth-submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
      <div className="auth-first-login"><strong>Initial administrator</strong><span>Username: <b>Admin</b> · Password: <b>admin</b></span><small>Change the password from My profile after your first login.</small></div>
    </div>
  </div>
}

function ProfileModal({ user, onClose, onSave }: { user: UserAccount; onClose: () => void; onSave: (profile: { name: string; email: string; phone: string; newPassword?: string }) => Promise<string | void> }) {
  const [message, setMessage] = useState('')
  const [saving, setSaving] = useState(false)
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSaving(true)
    setMessage('')
    const form = new FormData(event.currentTarget)
    const password = String(form.get('newPassword') || '')
    const confirm = String(form.get('confirmPassword') || '')
    if (password && password !== confirm) {
      setMessage('The new password and confirmation do not match.')
      setSaving(false)
      return
    }
    const result = await onSave({
      name: String(form.get('name') || '').trim(),
      email: String(form.get('email') || '').trim(),
      phone: String(form.get('phone') || '').trim(),
      newPassword: password || undefined,
    })
    setMessage(result || 'Profile updated.')
    setSaving(false)
  }
  return <div className="modal-backdrop" role="presentation">
    <div className="modal profile-modal" role="dialog" aria-modal="true" aria-label="My profile">
      <div className="modal-head"><div><h2>My profile</h2><p>Update your personal details. Your role and module access are controlled by an Administrator.</p></div><button className="icon-button" type="button" onClick={onClose}><X size={20} /></button></div>
      <form className="profile-form" onSubmit={(event) => void submit(event)}>
        <div className="profile-summary"><div className="settings-avatar">{user.name.split(' ').map((part) => part[0]).slice(0, 2).join('').toUpperCase() || 'U'}</div><div><strong>{user.name}</strong><span>@{user.username} · {user.role}</span></div></div>
        <label>Display name<input name="name" defaultValue={user.name} required /></label>
        <label>Email<input name="email" type="email" defaultValue={user.email} placeholder="name@company.com" /></label>
        <label>Contact number<input name="phone" defaultValue={user.phone} placeholder="+63 900 000 0000" /></label>
        <div className="profile-password-grid">
          <label>New password <small>Optional</small><input name="newPassword" type="password" minLength={4} autoComplete="new-password" /></label>
          <label>Confirm new password<input name="confirmPassword" type="password" minLength={4} autoComplete="new-password" /></label>
        </div>
        {message && <div className="settings-message">{message}</div>}
        <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Close</button><button className="primary" disabled={saving}>{saving ? 'Saving…' : 'Save profile'}</button></div>
      </form>
    </div>
  </div>
}


function DashboardActivityTimeline({ mode, items, clients, projects, onEdit, onToggle, canEdit }: { mode: 'today' | 'week'; items: PlannerActivity[]; clients: Client[]; projects: Project[]; onEdit: (activity: PlannerActivity) => void; onToggle: (id: string) => void; canEdit: boolean }) {
  const clientName = (id?: string) => id ? clients.find((client) => client.id === id)?.name : ''
  const projectName = (id?: string) => id ? projects.find((project) => project.id === id)?.name : ''
  if (!items.length) return <div className="activity-empty dashboard-activity-empty">No activities scheduled for this view.</div>
  return <div className="dashboard-activity-list">{items.map((activity) => {
    const timeLabel = activity.allDay ? 'All day' : activity.startTime || '—'
    const context = [clientName(activity.clientId), projectName(activity.projectId)].filter(Boolean).join(' · ')
    return <div className={`dashboard-activity-row ${activity.status === 'Done' ? 'done' : ''}`} key={activity.id}>
      <div className="dashboard-activity-time">{mode === 'week' && <small>{niceDate(activity.date)}</small>}<strong>{timeLabel}</strong></div>
      <div className="dashboard-activity-card">
        <div className="dashboard-activity-top">
          <div><strong>{activity.title}</strong>{context && <p>{context}</p>}{activity.notes && <small>{activity.notes}</small>}</div>
          <div className="dashboard-activity-badges"><span>{activity.source === 'Google Calendar' ? 'Calendar' : 'Tracker'}</span>{activity.source === 'Google Calendar' && <span>Local edit</span>}</div>
        </div>
        <div className="dashboard-activity-actions">
          {canEdit && <button className="secondary compact" type="button" onClick={() => onEdit(activity)}>{activity.source === 'Google Calendar' ? 'Edit local copy' : 'Edit'}</button>}
          {canEdit && <button className="secondary compact" type="button" onClick={() => onToggle(activity.id)}>{activity.status === 'Done' ? 'Mark planned' : 'Mark done'}</button>}
          {activity.calendarLink && <a className="secondary compact dashboard-link-button" href={activity.calendarLink} target="_blank" rel="noreferrer">Open original</a>}
        </div>
      </div>
    </div>
  })}</div>
}

function DashboardActionTable({ items, clients, projects, planner }: { items: WorkItem[]; clients: Client[]; projects: Project[]; planner: PlannerActivity[] }) {
  const clientName = (id: string) => clients.find((client) => client.id === id)?.name ?? 'Unknown'
  const nextActivity = (item: WorkItem) => planner
    .filter((activity) => activity.status === 'Planned' && activity.date >= TODAY && activity.clientId === item.clientId && (!activity.projectId || activity.projectId === item.projectId))
    .sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime))[0]
  if (!items.length) return <Empty text="Nothing needs your attention right now." />
  return <div className="table-scroll"><table className="dashboard-action-table"><thead><tr><th>Client</th><th>Item</th><th>Waiting on</th><th>Follow-up</th><th>Next activity</th></tr></thead><tbody>{items.map((item) => {
    const activity = nextActivity(item)
    const activityLabel = activity ? `${activity.date === TODAY ? activityTime(activity) : `${niceDate(activity.date)} · ${activityTime(activity)}`} — ${activity.title}` : '—'
    return <tr key={item.id}><td><strong>{clientName(item.clientId)}</strong></td><td><strong>{item.title}</strong><small>{projects.find((project) => project.id === item.projectId)?.name ?? ''}</small></td><td>{item.waitingOn}</td><td className={item.followUpDate && item.followUpDate < TODAY ? 'overdue-date' : ''}>{item.followUpDate === TODAY ? 'Today' : niceDate(item.followUpDate)}</td><td>{activityLabel}</td></tr>
  })}</tbody></table></div>
}

function ActivityColumn({ title, subtitle, items, clients, projects, onEdit, onToggle }: { title: string; subtitle: string; items: PlannerActivity[]; clients: Client[]; projects: Project[]; onEdit: (activity: PlannerActivity) => void; onToggle: (id: string) => void }) {
  const clientName = (id?: string) => id ? clients.find((client) => client.id === id)?.name : ''
  const projectName = (id?: string) => id ? projects.find((project) => project.id === id)?.name : ''
  return <div className="activity-column">
    <div className="activity-column-head"><div><h3>{title}</h3><span>{subtitle}</span></div><b>{items.length}</b></div>
    <div className="activity-list">
      {items.length === 0 && <div className="activity-empty">No activities scheduled.</div>}
      {items.map((activity) => <div className={`activity-card ${activity.status === 'Done' ? 'done' : ''}`} key={activity.id}>
        <button className="activity-check" title={activity.status === 'Done' ? 'Mark planned' : 'Mark done'} onClick={() => onToggle(activity.id)}><CheckCircle2 size={18} /></button>
        <div className="activity-main">
          <div className="activity-meta"><span>{title === 'Today' ? activityTime(activity) : `${niceDate(activity.date)} · ${activityTime(activity)}`}</span><span className={activity.source === 'Google Calendar' ? 'source-google' : 'source-local'}>{activity.source}</span></div>
          <strong>{activity.title}</strong>
          {(clientName(activity.clientId) || projectName(activity.projectId)) && <small>{[clientName(activity.clientId), projectName(activity.projectId)].filter(Boolean).join(' · ')}</small>}
          {activity.notes && <p>{activity.notes}</p>}
        </div>
        <div className="activity-controls">
          <button className="icon-button" title="Edit local tracker copy" onClick={() => onEdit(activity)}><Pencil size={16} /></button>
          {activity.calendarLink && <a className="icon-button" title="Open original Google Calendar event" href={activity.calendarLink} target="_blank" rel="noreferrer"><ExternalLink size={16} /></a>}
        </div>
      </div>)}
    </div>
  </div>
}

function ActivityForm({ clients, projects, initial, onSubmit }: { clients: Client[]; projects: Project[]; initial: PlannerActivity | null; onSubmit: (activity: PlannerActivity) => void }) {
  const [clientId, setClientId] = useState(initial?.clientId ?? '')
  const [allDay, setAllDay] = useState(initial?.allDay ?? false)
  const linkedProjects = clientId ? projects.filter((project) => project.clientId === clientId) : projects
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    const startDate = String(form.get('date') || TODAY)
    const requestedEndDate = String(form.get('endDate') || startDate)
    const endDate = requestedEndDate >= startDate ? requestedEndDate : startDate
    onSubmit({
      id: initial?.id ?? crypto.randomUUID(),
      title: String(form.get('title') || '').trim(),
      date: startDate,
      startTime: allDay ? '' : String(form.get('startTime') || ''),
      endTime: allDay ? '' : String(form.get('endTime') || ''),
      endDate,
      allDay,
      source: initial?.source ?? 'Local',
      status: (form.get('status') as PlannerActivity['status']) || 'Planned',
      clientId: String(form.get('clientId') || '') || undefined,
      projectId: String(form.get('projectId') || '') || undefined,
      notes: String(form.get('notes') || ''),
      calendarEventId: initial?.calendarEventId,
      calendarLink: initial?.calendarLink,
    })
  }
  return <form className="form-grid" onSubmit={submit}>
    {initial?.source === 'Google Calendar' && <div className="readonly-notice span-2"><CalendarDays size={18} /><div><strong>Local calendar copy</strong><span>Your edits here stay in the BA Tracker. They are never sent back to Google Calendar.</span></div></div>}
    <label className="span-2">Activity title<input name="title" required defaultValue={initial?.title ?? ''} placeholder="Meeting, prep work, follow-up, review..." /></label>
    <label>Start date<input name="date" type="date" required defaultValue={initial?.date ?? TODAY} /></label>
    <label>End date<input name="endDate" type="date" defaultValue={initial?.endDate ?? initial?.date ?? TODAY} /></label>
    <label>Status<select name="status" defaultValue={initial?.status ?? 'Planned'}><option>Planned</option><option>Done</option><option>Cancelled</option></select></label>
    <label className="checkbox-label"><input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} /> All-day activity</label><div />
    {!allDay && <><label>Start time<input name="startTime" type="time" defaultValue={initial?.startTime ?? ''} /></label><label>End time<input name="endTime" type="time" defaultValue={initial?.endTime ?? ''} /></label></>}
    <label>Client<select name="clientId" value={clientId} onChange={(e) => setClientId(e.target.value)}><option value="">No client</option>{clients.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}</select></label>
    <label>Project<select name="projectId" defaultValue={initial?.projectId ?? ''}><option value="">No project</option>{linkedProjects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
    <label className="span-2">BA notes<textarea name="notes" rows={4} defaultValue={initial?.notes ?? ''} placeholder="Preparation notes, agenda, follow-up context, decisions..." /></label>
    <div className="form-actions span-2"><button className="primary">{initial ? 'Save local changes' : 'Add activity'}</button></div>
  </form>
}

function Metric({ title, value, detail, tone = '', icon }: { title: string; value: number; detail: string; tone?: string; icon: React.ReactNode }) {
  return <div className={`metric-card ${tone}`}><div className="metric-icon">{icon}</div><div><span>{title}</span><strong>{value}</strong><small>{detail}</small></div></div>
}

function FilterBar({ query, setQuery, waiting, setWaiting }: { query: string; setQuery: (v: string) => void; waiting: 'All' | WaitingOn; setWaiting: (v: 'All' | WaitingOn) => void }) {
  return <div className="filters"><label className="search-box"><Search size={17} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search title, client, project..." /></label><select value={waiting} onChange={(e) => setWaiting(e.target.value as 'All' | WaitingOn)}><option>All</option><option>Me</option><option>Developer</option><option>Client</option><option>QA</option><option>Design</option><option>Done</option></select></div>
}

function ItemTable({ items, clients, projects, onResolve, showClosed = false, canEdit = true }: { items: WorkItem[]; clients: Client[]; projects: Project[]; onResolve: (id: string) => void; showClosed?: boolean; canEdit?: boolean }) {
  const clientName = (id: string) => clients.find((c) => c.id === id)?.name ?? 'Unknown'
  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? 'Unknown'
  if (!items.length) return <Empty text="Nothing matches this view." />
  return <div className="table-scroll"><table className="item-table"><thead><tr><th>Item</th><th>Client / project</th><th>Type</th><th>Waiting on</th><th>Priority</th><th>Follow-up</th><th></th></tr></thead><tbody>{items.map((item) => {
    const overdue = item.followUpDate && item.followUpDate < TODAY && !['Resolved', 'Closed'].includes(item.status)
    return <tr key={item.id} className={overdue ? 'overdue-row' : ''}><td><strong>{item.title}</strong><small>{item.status}</small></td><td><span>{clientName(item.clientId)}</span><small>{projectName(item.projectId)}</small></td><td><TypeChip value={item.type} /></td><td><WaitingChip value={item.waitingOn} /></td><td><PriorityChip value={item.priority} /></td><td><span className={overdue ? 'overdue-date' : ''}>{niceDate(item.followUpDate)}</span>{overdue && <small>Overdue</small>}</td><td>{canEdit && !['Resolved', 'Closed'].includes(item.status) && <button className="icon-button" title="Mark resolved" onClick={() => onResolve(item.id)}><CheckCircle2 size={18} /></button>}</td></tr>
  })}</tbody></table></div>
}

function ClientDetail({ client, store, setStore, onBack, onAddItem, onAskAI, canWrite, canUseAI }: { client: Client; store: Store; setStore: (s: Store) => void; onBack: () => void; onAddItem: () => void; onAskAI: (clientId: string, projectId?: string) => void; canWrite: boolean; canUseAI: boolean }) {
  const projects = store.projects.filter((p) => p.clientId === client.id)
  const items = store.items.filter((i) => i.clientId === client.id)
  const activity = store.activity.filter((a) => a.clientId === client.id).sort((a, b) => b.date.localeCompare(a.date))
  const [note, setNote] = useState('')
  const addNote = (e: FormEvent) => {
    e.preventDefault()
    if (!canWrite || !note.trim()) return
    setStore({ ...store, activity: [{ id: crypto.randomUUID(), clientId: client.id, date: TODAY, text: note.trim() }, ...store.activity] })
    setNote('')
  }
  return <section className="page-stack">
    <button className="back-link" onClick={onBack}>← Back to clients</button>
    <div className="client-hero"><div><div className="row-meta"><StatusChip value={client.status} /><HealthChip value={client.health} /></div><p>{client.contact} · {client.email}</p><p>{client.notes}</p></div><div className="client-hero-actions">{canUseAI && <button className="secondary" onClick={() => onAskAI(client.id)}><Sparkles size={17} /> Ask AI</button>}{canWrite && <button className="primary" onClick={onAddItem}><Plus size={18} /> Add item</button>}</div></div>
    <div className="detail-grid"><div className="panel"><div className="panel-heading"><div><h2>Projects</h2><p>{projects.length} linked project{projects.length === 1 ? '' : 's'}</p></div></div>{projects.map((p) => <div className="mini-project" key={p.id}><div><strong>{p.name}</strong><p>{p.summary}</p></div><div><StatusChip value={p.status} /><small>Target {niceDate(p.targetDate)}</small></div></div>)}</div>
    <div className="panel"><div className="panel-heading"><div><h2>Communication log</h2><p>Keep decisions and follow-ups reconstructable.</p></div></div>{canWrite && <form className="quick-note" onSubmit={addNote}><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a quick client note..." /><button className="secondary">Add</button></form>}<div className="timeline">{activity.map((a) => <div key={a.id}><span>{niceDate(a.date)}</span><p>{a.text}</p></div>)}</div></div></div>
    <div className="panel"><div className="panel-heading"><div><h2>Client items</h2><p>Everything connected to this client.</p></div><span className="count-pill">{items.length}</span></div><ItemTable items={items} clients={store.clients} projects={store.projects} onResolve={(id) => { if (!canWrite) return; setStore({ ...store, items: store.items.map((i) => i.id === id ? { ...i, status: 'Resolved', waitingOn: 'Done', followUpDate: '', resolvedDate: TODAY } : i) }) }} showClosed canEdit={canWrite} /></div>
  </section>
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.currentTarget === e.target) onClose() }}><div className="modal" role="dialog" aria-modal="true" aria-label={title}><div className="modal-head"><h2>{title}</h2><button className="icon-button" onClick={onClose}><X size={20} /></button></div>{children}</div></div>
}

function ItemForm({ store, onSubmit }: { store: Store; onSubmit: (item: WorkItem) => void }) {
  const [clientId, setClientId] = useState(store.clients[0]?.id ?? '')
  const projects = store.projects.filter((p) => p.clientId === clientId)
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '')
  const [type, setType] = useState<ItemType>('Inquiry')
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    const selectedProject = projectId || store.projects.find((p) => p.clientId === clientId)?.id || ''
    onSubmit({ id: crypto.randomUUID(), clientId, projectId: selectedProject, title: String(form.get('title')), type, priority: form.get('priority') as Priority, status: 'Open', waitingOn: form.get('waitingOn') as WaitingOn, owner: String(form.get('owner') || 'Me'), dateRaised: TODAY, followUpDate: String(form.get('followUpDate') || ''), description: String(form.get('description') || ''), resolution: '', source: form.get('source') as WorkItem['source'] })
  }
  return <form className="form-grid" onSubmit={submit}><label className="span-2">Title<input name="title" required placeholder="What needs to be tracked?" /></label><label>Client<select value={clientId} onChange={(e) => { const next = e.target.value; setClientId(next); setProjectId(store.projects.find((p) => p.clientId === next)?.id ?? '') }}>{store.clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label><label>Project<select value={projectId} onChange={(e) => setProjectId(e.target.value)}>{store.projects.filter((p) => p.clientId === clientId).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label><label>Type<select value={type} onChange={(e) => setType(e.target.value as ItemType)}><option>Inquiry</option><option>Requirement</option><option>Issue</option><option>Decision</option><option>Follow-up</option></select></label><label>Priority<select name="priority" defaultValue="Medium"><option>Low</option><option>Medium</option><option>High</option><option>Urgent</option></select></label><label>Waiting on<select name="waitingOn" defaultValue="Me"><option>Me</option><option>Developer</option><option>Client</option><option>QA</option><option>Design</option><option>Done</option></select></label><label>Follow-up date<input name="followUpDate" type="date" /></label><label>Source<select name="source" defaultValue="Email"><option>Email</option><option>Meeting</option><option>Chat</option><option>Internal</option><option>Other</option></select></label><label>Owner<input name="owner" defaultValue="Me" /></label><label className="span-2">Description<textarea name="description" rows={4} placeholder="Context, acceptance details, or what the client actually asked..." /></label><div className="form-actions span-2"><button className="primary">Create item</button></div></form>
}

function ClientForm({ onSubmit }: { onSubmit: (client: Client) => void }) {
  const submit = (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); const f = new FormData(e.currentTarget); onSubmit({ id: crypto.randomUUID(), name: String(f.get('name')), contact: String(f.get('contact')), email: String(f.get('email')), status: 'Active', health: 'Good', notes: String(f.get('notes') || '') }) }
  return <form className="form-grid" onSubmit={submit}><label>Client name<input name="name" required /></label><label>Primary contact<input name="contact" required /></label><label className="span-2">Email<input name="email" type="email" required /></label><label className="span-2">Notes<textarea name="notes" rows={4} /></label><div className="form-actions span-2"><button className="primary">Create client</button></div></form>
}

function ProjectForm({ clients, onSubmit }: { clients: Client[]; onSubmit: (project: Project) => void }) {
  const submit = (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); const f = new FormData(e.currentTarget); onSubmit({ id: crypto.randomUUID(), clientId: String(f.get('clientId')), name: String(f.get('name')), status: 'Discovery', targetDate: String(f.get('targetDate') || ''), summary: String(f.get('summary') || '') }) }
  return <form className="form-grid" onSubmit={submit}><label className="span-2">Project name<input name="name" required /></label><label>Client<select name="clientId">{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label><label>Target date<input name="targetDate" type="date" /></label><label className="span-2">Summary<textarea name="summary" rows={4} /></label><div className="form-actions span-2"><button className="primary">Create project</button></div></form>
}

function Empty({ text }: { text: string }) { return <div className="empty"><CheckCircle2 size={28} /><p>{text}</p></div> }
function TypeChip({ value }: { value: ItemType }) { return <span className={`chip type-${value.toLowerCase().replace(' ', '-')}`}>{value}</span> }
function PriorityChip({ value }: { value: Priority }) { return <span className={`chip priority-${value.toLowerCase()}`}>{value}</span> }
function WaitingChip({ value }: { value: WaitingOn }) { return <span className={`chip waiting-${value.toLowerCase()}`}>{value}</span> }
function StatusChip({ value }: { value: string }) { return <span className="chip neutral">{value}</span> }
function HealthChip({ value }: { value: Client['health'] }) { return <span className={`chip health-${value.toLowerCase().replace(' ', '-')}`}>{value}</span> }

export default App
