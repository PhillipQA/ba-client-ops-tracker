import { FormEvent, useEffect, useMemo, useState } from 'react'
import { ArchiveRestore, Bot, Check, Cloud, Database, KeyRound, MessageCircleMore, PackageCheck, Palette, RefreshCw, ShieldCheck, Terminal, Trash2, UserPlus, Users } from 'lucide-react'
import { defaultModulesForRole, MODULE_DEFINITIONS } from './access'
import { hashPassword } from './auth'
import type { CloudStorageStatus } from './cloudStore'
import type { AppModule, TaskColumnKey, TaskSettings, UserAccount, UserRole } from './types'
import { normalizeAppTheme, THEME_OPTIONS, type AppTheme } from './theme'
import { APP_VERSION } from './version'

type DiscordStatus = {
  configured: boolean
  online: boolean
  botName: string
  guildCount: number
  allowedUsersConfigured: number
  lastMessageAt: string
  lastError: string
  dmCapture: boolean
  mentionCapture: boolean
}

type DataArchitectureStatus = {
  ready: boolean
  syncedAt?: string
  counts?: Record<string, number>
  error?: string
}

const roleDescriptions: Record<UserRole, { summary: string; permissions: string[] }> = {
  Administrator: { summary: 'Full system access.', permissions: ['Can access every module', 'Create, read, update, and delete operational records', 'Use AI and Calendar import', 'Add, update, disable, and delete accounts'] },
  Contributor: { summary: 'Day-to-day BA delivery access.', permissions: ['CRUD access to modules assigned by an Administrator', 'Can use AI when the AI module is assigned', 'Can view/export Reports when assigned', 'Cannot add or manage other accounts'] },
  Viewer: { summary: 'Read-only access.', permissions: ['Can only view modules assigned by an Administrator', 'Reports can be assigned as the default module', 'Cannot create, edit, delete, import, or approve AI actions', 'Cannot manage accounts'] },
}

export default function Settings({ currentUser, accounts, onCreate, onUpdate, onDelete, onThemeChange, cloudStatus, cloudMessage, lastCloudSync, onSyncNow, taskSettings, taskStatusUsage, onTaskSettingsChange }: {
  currentUser: UserAccount
  accounts: UserAccount[]
  onCreate: (account: UserAccount) => string | void
  onUpdate: (id: string, patch: Partial<UserAccount>) => string | void
  onDelete: (id: string) => string | void
  onThemeChange: (theme: AppTheme) => string | void
  cloudStatus: CloudStorageStatus
  cloudMessage: string
  lastCloudSync: string
  onSyncNow: () => Promise<void>
  taskSettings: TaskSettings
  taskStatusUsage: Record<string, number>
  onTaskSettingsChange: (settings: TaskSettings) => string | void
}) {
  const isAdmin = currentUser.role === 'Administrator'
  const [showAdd, setShowAdd] = useState(false)
  const [message, setMessage] = useState('')
  const [themeMessage, setThemeMessage] = useState('')
  const [newRole, setNewRole] = useState<UserRole>('Contributor')
  const [newModules, setNewModules] = useState<AppModule[]>(defaultModulesForRole('Contributor'))
  const [expandedAccountId, setExpandedAccountId] = useState<string | null>(null)
  const [discordStatus, setDiscordStatus] = useState<DiscordStatus | null>(null)
  const [discordLoading, setDiscordLoading] = useState(true)
  const [newTaskStatus, setNewTaskStatus] = useState('')
  const [newTaskStatusClosed, setNewTaskStatusClosed] = useState(false)
  const [taskMessage, setTaskMessage] = useState('')
  const [dataArchitecture, setDataArchitecture] = useState<DataArchitectureStatus | null>(null)
  const [dataArchitectureLoading, setDataArchitectureLoading] = useState(true)
  const [dataArchitectureMessage, setDataArchitectureMessage] = useState('')
  const usernameLookup = useMemo(() => new Set(accounts.map((account) => account.username.trim().toLowerCase())), [accounts])

  const loadDataArchitectureStatus = async () => {
    setDataArchitectureLoading(true)
    try {
      const response = await fetch('/api/data-architecture/status', { credentials: 'include' })
      const body = await response.json().catch(() => ({})) as DataArchitectureStatus
      if (!response.ok) throw new Error(body.error || 'Could not load data architecture status.')
      setDataArchitecture(body)
    } catch (error) {
      setDataArchitecture({ ready: false, error: error instanceof Error ? error.message : 'Could not load data architecture status.' })
    } finally {
      setDataArchitectureLoading(false)
    }
  }

  const migrateDataArchitecture = async () => {
    if (!isAdmin) return
    setDataArchitectureLoading(true)
    setDataArchitectureMessage('')
    try {
      const response = await fetch('/api/data-architecture/migrate', { method: 'POST', credentials: 'include' })
      const body = await response.json().catch(() => ({})) as DataArchitectureStatus
      if (!response.ok) throw new Error(body.error || 'Migration failed.')
      setDataArchitecture(body)
      setDataArchitectureMessage('Migration completed. Structured Supabase tables are now synchronized with tracker_state.')
    } catch (error) {
      setDataArchitectureMessage(error instanceof Error ? error.message : 'Migration failed.')
    } finally {
      setDataArchitectureLoading(false)
    }
  }

  const loadDiscordStatus = async () => {
    setDiscordLoading(true)
    try {
      const response = await fetch('/api/integrations/discord/status', { credentials: 'include' })
      if (!response.ok) throw new Error('Could not load Discord status.')
      setDiscordStatus(await response.json() as DiscordStatus)
    } catch {
      setDiscordStatus(null)
    } finally {
      setDiscordLoading(false)
    }
  }

  useEffect(() => {
    void loadDiscordStatus()
    void loadDataArchitectureStatus()
  }, [])

  const changeNewRole = (role: UserRole) => {
    setNewRole(role)
    setNewModules(defaultModulesForRole(role))
  }

  const toggleNewModule = (module: AppModule) => {
    if (newRole === 'Administrator') return
    setNewModules((value) => value.includes(module) ? value.filter((item) => item !== module) : [...value, module])
  }

  const createAccount = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!isAdmin) return
    const form = new FormData(event.currentTarget)
    const username = String(form.get('username') || '').trim()
    const password = String(form.get('password') || '')
    const name = String(form.get('name') || '').trim()
    const email = String(form.get('email') || '').trim()
    const phone = String(form.get('phone') || '').trim()
    if (usernameLookup.has(username.toLowerCase())) {
      setMessage('That username is already in use.')
      return
    }
    if (password.length < 4) {
      setMessage('Use an initial password with at least 4 characters.')
      return
    }
    const result = onCreate({
      id: crypto.randomUUID(),
      username,
      passwordHash: await hashPassword(password),
      name,
      email,
      phone,
      role: newRole,
      modules: newRole === 'Administrator' ? defaultModulesForRole('Administrator') : newModules,
      status: 'Active',
      createdAt: new Date().toISOString().slice(0, 10),
    })
    if (result) {
      setMessage(result)
      return
    }
    event.currentTarget.reset()
    setNewRole('Contributor')
    setNewModules(defaultModulesForRole('Contributor'))
    setShowAdd(false)
    setMessage('Account added. The user can sign in with the username and initial password you provided.')
  }

  const update = (id: string, patch: Partial<UserAccount>) => {
    const result = onUpdate(id, patch)
    setMessage(result || 'Account updated.')
  }

  const remove = (id: string) => {
    if (!window.confirm('Delete this account from the tracker?')) return
    const result = onDelete(id)
    setMessage(result || 'Account deleted.')
  }

  const toggleAccountModule = (account: UserAccount, module: AppModule) => {
    if (!isAdmin || account.role === 'Administrator') return
    const modules = account.modules.includes(module) ? account.modules.filter((item) => item !== module) : [...account.modules, module]
    update(account.id, { modules })
  }

  const saveTaskSettings = (next: TaskSettings, successMessage: string) => {
    const result = onTaskSettingsChange(next)
    setTaskMessage(result || successMessage)
  }

  const addTaskStatus = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!isAdmin) return
    const label = newTaskStatus.trim()
    if (!label) return
    if (taskSettings.statuses.some((status) => status.label.toLowerCase() === label.toLowerCase())) {
      setTaskMessage('That task status already exists.')
      return
    }
    saveTaskSettings({ ...taskSettings, statuses: [...taskSettings.statuses, { id: crypto.randomUUID(), label, closed: newTaskStatusClosed }] }, `Added task status: ${label}`)
    setNewTaskStatus('')
    setNewTaskStatusClosed(false)
  }

  const toggleTaskStatusClosed = (id: string) => {
    if (!isAdmin) return
    const next = { ...taskSettings, statuses: taskSettings.statuses.map((status) => status.id === id ? { ...status, closed: !status.closed } : status) }
    saveTaskSettings(next, 'Task status updated.')
  }

  const removeTaskStatus = (id: string) => {
    if (!isAdmin) return
    const status = taskSettings.statuses.find((candidate) => candidate.id === id)
    if (!status) return
    if ((taskStatusUsage[status.label] || 0) > 0) {
      setTaskMessage(`Cannot remove ${status.label} while tasks are using it.`)
      return
    }
    saveTaskSettings({ ...taskSettings, statuses: taskSettings.statuses.filter((candidate) => candidate.id !== id) }, `Removed task status: ${status.label}`)
  }

  const toggleTaskColumn = (column: TaskColumnKey) => {
    if (!isAdmin || column === 'status') return
    const visibleColumns = taskSettings.visibleColumns.includes(column) ? taskSettings.visibleColumns.filter((candidate) => candidate !== column) : [...taskSettings.visibleColumns, column]
    saveTaskSettings({ ...taskSettings, visibleColumns }, 'Task table columns updated.')
  }

  const selectTheme = (theme: AppTheme) => {
    const result = onThemeChange(theme)
    setThemeMessage(result || 'Theme updated.')
  }

  const activeTheme = normalizeAppTheme(currentUser.theme)

  return <section className="page-stack settings-page">
    <div className="panel settings-current">
      <div className="panel-heading"><div><h2>Access & settings</h2><p>Role-based access plus module-level permissions.</p></div><span className="role-badge"><ShieldCheck size={15} /> {currentUser.role}</span></div>
      <div className="current-user-card"><div className="settings-avatar">{currentUser.name.split(' ').map((part) => part[0]).slice(0, 2).join('').toUpperCase() || 'U'}</div><div><strong>{currentUser.name}</strong><span>@{currentUser.username}{currentUser.email ? ` · ${currentUser.email}` : ''}</span></div><div className="current-user-role"><small>Signed-in account</small><b>{currentUser.role}</b></div></div>
      <div className="settings-note">Use <b>My profile</b> in the left sidebar to update your own name, email, contact number, or password. Administrators manage other accounts and module access here.</div>
    </div>

    <div className="panel settings-theme-panel">
      <div className="panel-heading"><div><h2>Personalization</h2><p>Choose a visual theme for your account. Your selection is saved with your user profile and follows you after Supabase sync.</p></div><span className="role-badge"><Palette size={15} /> Personal</span></div>
      {themeMessage && <div className="settings-message">{themeMessage}</div>}
      <div className="theme-picker-grid">{THEME_OPTIONS.map((theme) => {
        const selected = activeTheme === theme.id
        return <button type="button" className={`theme-option-card${selected ? ' selected' : ''}`} key={theme.id} onClick={() => selectTheme(theme.id)} aria-pressed={selected}>
          <div className={`theme-preview theme-preview-${theme.id}`} style={theme.image ? { backgroundImage: `url(${theme.image})` } : undefined}><span>{selected ? <Check size={18} /> : null}</span></div>
          <div className="theme-option-copy"><strong>{theme.name}</strong><p>{theme.description}</p><small>{theme.palette}</small></div>
        </button>
      })}</div>
      <div className="settings-note"><b>Default behavior:</b> new accounts start on the existing Default theme. Theme choice is personal; changing yours does not affect other users.</div>
    </div>

    <div className="panel settings-storage-panel">
      <div className="panel-heading"><div><h2>Data storage</h2><p>Supabase is the persistent cloud copy when configured; browser storage remains a local cache.</p></div><span className={`storage-badge storage-${cloudStatus}`}><Cloud size={15} /> {cloudMessage}</span></div>
      <div className="storage-grid">
        <div className="storage-card"><Database size={20} /><div><strong>Cloud database</strong><span>{cloudStatus === 'local' ? 'Not configured — additional users require Supabase to sign in.' : cloudStatus === 'error' ? 'Unavailable right now — local cache is still retained.' : 'Supabase PostgreSQL is the persistent shared copy.'}</span></div></div>
        <div className="storage-card"><Cloud size={20} /><div><strong>Last sync</strong><span>{lastCloudSync ? new Date(lastCloudSync).toLocaleString() : 'No cloud sync yet'}</span></div></div>
        <button type="button" className="secondary storage-sync-button" onClick={() => void onSyncNow()} disabled={cloudStatus === 'saving' || cloudStatus === 'checking'}><RefreshCw size={16} /> {cloudStatus === 'saving' ? 'Syncing…' : 'Sync now'}</button>
      </div>
    </div>

    <div className="panel settings-storage-panel">
      <div className="panel-heading"><div><h2>Data Architecture v2</h2><p>Normalized Supabase tables for migration, recovery, reporting, soft-delete history, and audit tracking.</p></div><span className={`storage-badge ${dataArchitecture?.ready ? 'storage-synced' : 'storage-local'}`}><Database size={15} /> {dataArchitectureLoading ? 'Checking…' : dataArchitecture?.ready ? 'Ready' : 'Setup required'}</span></div>
      <div className="storage-grid">
        <div className="storage-card"><Database size={20} /><div><strong>Structured tables</strong><span>{dataArchitecture?.ready ? 'Clients, projects, tasks, inquiries, activities, users, statuses, documents, and audit history are available.' : 'Run supabase/schema-v2.sql in the Supabase SQL Editor first.'}</span></div></div>
        <div className="storage-card"><ArchiveRestore size={20} /><div><strong>Last normalized sync</strong><span>{dataArchitecture?.syncedAt ? new Date(dataArchitecture.syncedAt).toLocaleString() : 'No migration run recorded yet'}</span><small>{dataArchitecture?.counts ? Object.entries(dataArchitecture.counts).map(([key, value]) => `${key}: ${value}`).join(' · ') : 'tracker_state remains the compatibility fallback.'}</small></div></div>
        {isAdmin && <button type="button" className="secondary storage-sync-button" onClick={() => void migrateDataArchitecture()} disabled={dataArchitectureLoading || !dataArchitecture?.ready}><RefreshCw size={16} /> {dataArchitectureLoading ? 'Working…' : 'Migrate / Sync now'}</button>}
      </div>
      {dataArchitectureMessage && <div className="settings-message">{dataArchitectureMessage}</div>}
      {!dataArchitecture?.ready && dataArchitecture?.error && <div className="settings-note"><b>Setup note:</b> {dataArchitecture.error.includes('does not exist') || dataArchitecture.error.includes('schema cache') ? 'The v2 tables have not been created yet. Open Supabase SQL Editor and run supabase/schema-v2.sql, then return here and refresh.' : dataArchitecture.error}</div>}
      <div className="settings-note"><b>Safety:</b> v0.4.0 keeps <code>tracker_state</code> intact. New saves dual-write into normalized tables when v2 is ready. Deleted records are soft-deleted there, and changes are recorded in <code>audit_logs</code>.</div>
    </div>

    <div className="panel settings-task-panel">
      <div className="panel-heading"><div><h2>Task configuration</h2><p>Control the status workflow and which columns appear in project and task tables.</p></div><span className="role-badge"><ShieldCheck size={15} /> {isAdmin ? 'Administrator editable' : 'View only'}</span></div>
      {taskMessage && <div className="settings-message">{taskMessage}</div>}
      <div className="task-settings-grid">
        <div className="task-settings-section">
          <div className="task-settings-head"><div><strong>Status workflow</strong><span>Add the statuses your BA process actually uses. Completed statuses are excluded from open-task counts.</span></div></div>
          {isAdmin && <form className="task-status-create" onSubmit={addTaskStatus}><input value={newTaskStatus} onChange={(event) => setNewTaskStatus(event.target.value)} placeholder="e.g. Ready for Sign-off" /><label className="checkbox-label"><input type="checkbox" checked={newTaskStatusClosed} onChange={(event) => setNewTaskStatusClosed(event.target.checked)} /> Completed status</label><button className="secondary">Add status</button></form>}
          <div className="task-status-list">{taskSettings.statuses.map((status) => <div className="task-status-row" key={status.id}><div><strong>{status.label}</strong><span>{taskStatusUsage[status.label] || 0} task{(taskStatusUsage[status.label] || 0) === 1 ? '' : 's'} using this status</span></div><label className="task-status-closed"><input type="checkbox" checked={status.closed} disabled={!isAdmin} onChange={() => toggleTaskStatusClosed(status.id)} /> Completed</label>{isAdmin && <button type="button" className="icon-button danger-button" title={(taskStatusUsage[status.label] || 0) > 0 ? 'Status is in use' : 'Remove status'} disabled={(taskStatusUsage[status.label] || 0) > 0} onClick={() => removeTaskStatus(status.id)}><Trash2 size={15} /></button>}</div>)}</div>
        </div>
        <div className="task-settings-section">
          <div className="task-settings-head"><div><strong>Task table columns</strong><span>Choose the standard columns shown under Projects and in the Tasks module. Task title is always shown.</span></div></div>
          <div className="task-column-grid">{([
            ['status', 'Status'], ['client', 'Client'], ['project', 'Project'], ['type', 'Type'], ['waitingOn', 'Waiting on'], ['priority', 'Priority'], ['owner', 'Owner'], ['dueDate', 'Due date'], ['followUpDate', 'Follow-up date'],
          ] as [TaskColumnKey, string][]).map(([column, label]) => <label className="module-check" key={column}><input type="checkbox" checked={taskSettings.visibleColumns.includes(column)} disabled={!isAdmin || column === 'status'} onChange={() => toggleTaskColumn(column)} /><div><b>{label}</b><small>{column === 'status' ? 'Required column' : 'Show this column in task tables'}</small></div></label>)}</div>
        </div>
      </div>
    </div>

    <div className="panel settings-integration-panel">
      <div className="panel-heading"><div><h2>Discord Inquiry Capture</h2><p>DM the bot or @mention it in a server to create a cleaned Inquiry in the tracker.</p></div><span className={`discord-status ${discordStatus?.online ? 'discord-online' : 'discord-offline'}`}><Bot size={15} /> {discordLoading ? 'Checking…' : discordStatus?.online ? 'Online' : discordStatus?.configured ? 'Offline' : 'Not configured'}</span></div>
      <div className="integration-grid">
        <div className="integration-card"><MessageCircleMore size={20} /><div><strong>Incoming capture</strong><span>Direct messages: {discordStatus?.dmCapture ? 'Enabled' : 'Unavailable'} · @mentions: {discordStatus?.mentionCapture ? 'Enabled' : 'Unavailable'}</span><small>Each Discord message is de-duplicated, summarized with AI when configured, and saved as an Inquiry.</small></div></div>
        <div className="integration-card"><Bot size={20} /><div><strong>{discordStatus?.botName || 'BA Inquiry Bot'}</strong><span>{discordStatus?.online ? `Connected to ${discordStatus.guildCount} server${discordStatus.guildCount === 1 ? '' : 's'}` : discordStatus?.configured ? 'Token is configured, but the Gateway is not currently online.' : 'Add DISCORD_BOT_TOKEN to Render Environment.'}</span><small>{discordStatus?.allowedUsersConfigured ? `${discordStatus.allowedUsersConfigured} Discord user ID${discordStatus.allowedUsersConfigured === 1 ? '' : 's'} allowed.` : 'No sender allowlist configured — any user who can DM or mention the bot can create an inquiry.'}</small></div></div>
        <div className="integration-card integration-status-card"><RefreshCw size={20} /><div><strong>Last capture</strong><span>{discordStatus?.lastMessageAt ? new Date(discordStatus.lastMessageAt).toLocaleString() : 'No Discord inquiry captured since this server started.'}</span>{discordStatus?.lastError && <small className="integration-error">Last error: {discordStatus.lastError}</small>}</div><button type="button" className="secondary compact" onClick={() => void loadDiscordStatus()} disabled={discordLoading}>{discordLoading ? 'Checking…' : 'Refresh'}</button></div>
      </div>
      <div className="settings-note"><b>Render setup:</b> add <code>DISCORD_BOT_TOKEN</code>. Optional: <code>DISCORD_ALLOWED_USER_IDS</code> (comma-separated Discord user IDs) and <code>APP_BASE_URL</code> for the confirmation link. The token is never shown in this page.</div>
    </div>

    <div className="panel settings-update-panel">
      <div className="panel-heading"><div><h2>System updates</h2><p>Apply small code patches without replacing the full project folder.</p></div><span className="version-badge"><PackageCheck size={15} /> v{APP_VERSION}</span></div>
      <div className="update-grid">
        <div className="update-card"><Terminal size={20} /><div><strong>Patch update</strong><span>{isAdmin ? 'Download the patch ZIP, then run the command from the project folder. A backup is created automatically.' : 'Only an Administrator should apply application code updates.'}</span>{isAdmin && <code>npm run patch -- &quot;C:\Downloads\ba-client-ops-patch-vX.Y.Z.zip&quot;</code>}</div></div>
        <div className="update-card"><ArchiveRestore size={20} /><div><strong>Rollback</strong><span>If a patch causes a problem, restore the project files from the automatic pre-update backup.</span>{isAdmin && <code>npm run patch:rollback</code>}</div></div>
        <div className="update-protection"><ShieldCheck size={17} /><div><strong>Protected during patches</strong><span>.env.local, node_modules, .git, Supabase data, and browser/database records are not replaced by the patch updater.</span></div></div>
      </div>
    </div>

    <div className="panel settings-role-panel">
      <div className="panel-heading"><div><h2>Role permissions</h2><p>Roles define what a user can do; module access defines where they can do it.</p></div></div>
      <div className="role-grid">{(['Administrator', 'Contributor', 'Viewer'] as UserRole[]).map((role) => <div className="role-card" key={role}><div className="role-card-head"><strong>{role}</strong>{role === currentUser.role && <span>Current</span>}</div><p>{roleDescriptions[role].summary}</p><ul>{roleDescriptions[role].permissions.map((permission) => <li key={permission}><Check size={14} /> {permission}</li>)}</ul></div>)}</div>
    </div>

    <div className="panel settings-account-panel">
      <div className="panel-heading"><div><h2>Accounts & module access</h2><p>{isAdmin ? 'Create accounts, assign roles, and choose which modules each account can open.' : 'Only Administrators can manage other accounts and module access.'}</p></div>{isAdmin && <button className="primary" onClick={() => setShowAdd((value) => !value)}><UserPlus size={16} /> Add account</button>}</div>
      {message && <div className="settings-message">{message}</div>}
      {showAdd && isAdmin && <form className="account-create-form account-create-expanded" onSubmit={(event) => void createAccount(event)}>
        <label>Name<input name="name" required placeholder="Team member name" /></label>
        <label>Username<input name="username" required placeholder="e.g. jsantos" autoComplete="off" /></label>
        <label>Email<input name="email" type="email" placeholder="name@company.com" /></label>
        <label>Contact number<input name="phone" placeholder="e.g. +63 900 000 0000" /></label>
        <label>Initial password<input name="password" type="password" required minLength={4} autoComplete="new-password" /></label>
        <label>Role<select name="role" value={newRole} onChange={(event) => changeNewRole(event.target.value as UserRole)}><option>Administrator</option><option>Contributor</option><option>Viewer</option></select></label>
        <div className="module-picker account-form-modules"><strong>Module access</strong><span>{newRole === 'Administrator' ? 'Administrators always have every module.' : 'Select the modules this account can open.'}</span><div className="module-check-grid">{MODULE_DEFINITIONS.map((module) => <label className="module-check" key={module.id}><input type="checkbox" checked={newRole === 'Administrator' || newModules.includes(module.id)} disabled={newRole === 'Administrator'} onChange={() => toggleNewModule(module.id)} /><div><b>{module.label}</b><small>{module.description}</small></div></label>)}</div></div>
        <button className="primary"><KeyRound size={16} /> Create account</button>
      </form>}

      <div className="table-scroll"><table className="accounts-table"><thead><tr><th>Account</th><th>Role</th><th>Status</th><th>Modules</th><th>Created</th><th></th></tr></thead><tbody>{accounts.map((account) => <tr key={account.id}><td><strong>{account.name}</strong><small>@{account.username}{account.email ? ` · ${account.email}` : ''}{account.id === currentUser.id ? ' · Current session' : ''}</small></td><td>{isAdmin ? <select value={account.role} disabled={account.id === currentUser.id} onChange={(event) => { const role = event.target.value as UserRole; update(account.id, { role, modules: defaultModulesForRole(role) }) }}><option>Administrator</option><option>Contributor</option><option>Viewer</option></select> : <span className="role-chip">{account.role}</span>}</td><td>{isAdmin ? <select value={account.status} disabled={account.id === currentUser.id} onChange={(event) => update(account.id, { status: event.target.value as UserAccount['status'] })}><option>Active</option><option>Disabled</option></select> : account.status}</td><td><button type="button" className="secondary compact" disabled={!isAdmin && account.id !== currentUser.id} onClick={() => setExpandedAccountId((value) => value === account.id ? null : account.id)}>{account.role === 'Administrator' ? 'All modules' : `${account.modules.length} module${account.modules.length === 1 ? '' : 's'}`}</button></td><td>{account.createdAt}</td><td>{isAdmin && account.id !== currentUser.id && <button className="icon-button danger-button" title="Delete account" onClick={() => remove(account.id)}><Trash2 size={16} /></button>}</td></tr>)}</tbody></table></div>

      {expandedAccountId && (() => {
        const account = accounts.find((candidate) => candidate.id === expandedAccountId)
        if (!account) return null
        return <div className="account-module-panel"><div className="account-module-head"><div><strong>{account.name} · Module access</strong><span>{account.role === 'Administrator' ? 'Administrator access cannot be restricted.' : 'Changes take effect for this account after sync/reload.'}</span></div><button className="secondary compact" type="button" onClick={() => setExpandedAccountId(null)}>Close</button></div><div className="module-check-grid">{MODULE_DEFINITIONS.map((module) => <label className="module-check" key={module.id}><input type="checkbox" checked={account.role === 'Administrator' || account.modules.includes(module.id)} disabled={!isAdmin || account.role === 'Administrator'} onChange={() => toggleAccountModule(account, module.id)} /><div><b>{module.label}</b><small>{module.description}</small></div></label>)}</div></div>
      })()}

      {!isAdmin && <div className="read-only-account-note"><Users size={17} /> Account management is read-only for your role.</div>}
    </div>
  </section>
}
