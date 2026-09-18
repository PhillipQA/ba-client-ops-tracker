import { FormEvent, useEffect, useMemo, useState } from 'react'
import {
  Building2,
  CheckCircle2,
  CircleGauge,
  KeyRound,
  Layers3,
  LockKeyhole,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  UserPlus,
  Users,
} from 'lucide-react'
import { MODULE_DEFINITIONS } from './access'
import type { AppModule, UserRole } from './types'

type OrganizationSummary = {
  id: string
  name: string
  slug: string
  status: 'Active' | 'Suspended'
  enabledModules: AppModule[]
  createdAt: string
  userCount: number
  activeUserCount: number
}

type PlatformUser = {
  id: string
  organizationId: string
  username: string
  name: string
  email: string
  phone: string
  role: UserRole
  modules: AppModule[]
  status: 'Active' | 'Disabled'
  isPlatformAdmin: boolean
  createdAt: string
  lastLoginAt?: string
}

type DashboardPayload = {
  organizations: OrganizationSummary[]
  users: PlatformUser[]
  totals: {
    organizations: number
    activeOrganizations: number
    users: number
    activeUsers: number
  }
}

async function request(path: string, options?: RequestInit) {
  const response = await fetch(path, {
    ...options,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(options?.headers || {}) },
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error || 'The request could not be completed.')
  return body
}

const ALL_MODULE_IDS = MODULE_DEFINITIONS.map((module) => module.id)

function moduleLabel(module: AppModule) {
  return MODULE_DEFINITIONS.find((candidate) => candidate.id === module)?.label || module
}

export default function InternalAdmin({ mustChangePassword = false }: { mustChangePassword?: boolean }) {
  const [dashboard, setDashboard] = useState<DashboardPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('')
  const [search, setSearch] = useState('')
  const [selectedOrganizationId, setSelectedOrganizationId] = useState('')
  const [showCreateOrganization, setShowCreateOrganization] = useState(false)
  const [showCreateUser, setShowCreateUser] = useState(false)
  const [expandedUserId, setExpandedUserId] = useState('')
  const [newOrganizationModules, setNewOrganizationModules] = useState<AppModule[]>([...ALL_MODULE_IDS])
  const [newUserRole, setNewUserRole] = useState<UserRole>('Contributor')
  const [newUserModules, setNewUserModules] = useState<AppModule[]>(['action', 'clients', 'projects', 'inbox', 'items', 'documents', 'reports', 'ai'])
  const [showPlatformSecurity, setShowPlatformSecurity] = useState(mustChangePassword)
  const [platformPasswordChanged, setPlatformPasswordChanged] = useState(false)

  const loadDashboard = async () => {
    setLoading(true)
    setMessage('')
    try {
      const result = await request('/api/internal-admin/dashboard') as DashboardPayload
      setDashboard(result)
      if (!selectedOrganizationId && result.organizations.length) setSelectedOrganizationId(result.organizations[0].id)
      if (selectedOrganizationId && !result.organizations.some((org) => org.id === selectedOrganizationId)) setSelectedOrganizationId(result.organizations[0]?.id || '')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not load BXI-Core Internal Admin.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void loadDashboard() }, [])

  const organizations = dashboard?.organizations || []
  const users = dashboard?.users || []
  const filteredOrganizations = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return organizations
    return organizations.filter((organization) => {
      const organizationUsers = users.filter((user) => user.organizationId === organization.id)
      return [organization.name, organization.slug, ...organizationUsers.flatMap((user) => [user.name, user.username, user.email])].join(' ').toLowerCase().includes(query)
    })
  }, [organizations, users, search])
  const selectedOrganization = organizations.find((organization) => organization.id === selectedOrganizationId) || null
  const selectedUsers = users.filter((user) => user.organizationId === selectedOrganizationId)

  const createOrganization = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const password = String(form.get('password') || '')
    if (password.length < 8) return void setMessage('Use an initial administrator password with at least 8 characters.')
    try {
      const result = await request('/api/internal-admin/organizations', {
        method: 'POST',
        body: JSON.stringify({
          name: String(form.get('name') || '').trim(),
          slug: String(form.get('slug') || '').trim(),
          enabledModules: newOrganizationModules,
          administrator: {
            name: String(form.get('adminName') || '').trim(),
            username: String(form.get('username') || '').trim(),
            email: String(form.get('email') || '').trim(),
            phone: String(form.get('phone') || '').trim(),
            password,
          },
        }),
      })
      setMessage(`Created account: ${result.organization?.name || 'workspace'}.`)
      setShowCreateOrganization(false)
      event.currentTarget.reset()
      setNewOrganizationModules([...ALL_MODULE_IDS])
      await loadDashboard()
      if (result.organization?.id) setSelectedOrganizationId(result.organization.id)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not create account.')
    }
  }

  const updateOrganization = async (patch: Partial<Pick<OrganizationSummary, 'name' | 'status' | 'enabledModules'>>) => {
    if (!selectedOrganization) return
    try {
      await request(`/api/internal-admin/organizations/${selectedOrganization.id}`, { method: 'PATCH', body: JSON.stringify(patch) })
      setMessage('Account settings updated.')
      await loadDashboard()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not update account.')
    }
  }

  const toggleOrganizationModule = (module: AppModule) => {
    if (!selectedOrganization) return
    const enabledModules = selectedOrganization.enabledModules.includes(module)
      ? selectedOrganization.enabledModules.filter((value) => value !== module)
      : [...selectedOrganization.enabledModules, module]
    void updateOrganization({ enabledModules })
  }

  const createUser = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!selectedOrganization) return
    const form = new FormData(event.currentTarget)
    const password = String(form.get('password') || '')
    if (password.length < 8) return void setMessage('Use an initial password with at least 8 characters.')
    try {
      await request(`/api/internal-admin/organizations/${selectedOrganization.id}/users`, {
        method: 'POST',
        body: JSON.stringify({
          name: String(form.get('name') || '').trim(),
          username: String(form.get('username') || '').trim(),
          email: String(form.get('email') || '').trim(),
          phone: String(form.get('phone') || '').trim(),
          password,
          role: newUserRole,
          modules: newUserRole === 'Administrator' ? selectedOrganization.enabledModules : newUserModules.filter((module) => selectedOrganization.enabledModules.includes(module)),
        }),
      })
      setMessage('User created.')
      setShowCreateUser(false)
      event.currentTarget.reset()
      await loadDashboard()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not create user.')
    }
  }

  const updateUser = async (user: PlatformUser, patch: Partial<PlatformUser>) => {
    try {
      await request(`/api/internal-admin/users/${user.id}`, { method: 'PATCH', body: JSON.stringify(patch) })
      setMessage('User updated.')
      await loadDashboard()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not update user.')
    }
  }

  const resetPassword = async (user: PlatformUser) => {
    const password = window.prompt(`Set a temporary password for ${user.name || user.username}. The user can change it later from My Profile.`)
    if (password === null) return
    if (password.length < 8) return void setMessage('Use a temporary password with at least 8 characters.')
    try {
      await request(`/api/internal-admin/users/${user.id}/password`, { method: 'POST', body: JSON.stringify({ password }) })
      setMessage(`Password updated for ${user.name || user.username}. Their active sessions were signed out.`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not reset password.')
    }
  }

  const changePlatformPassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const currentPassword = String(form.get('currentPassword') || '')
    const newPassword = String(form.get('newPassword') || '')
    const confirmPassword = String(form.get('confirmPassword') || '')
    if (newPassword.length < 8) return void setMessage('Use a new Internal Admin password with at least 8 characters.')
    if (newPassword !== confirmPassword) return void setMessage('The new password and confirmation do not match.')
    try {
      await request('/api/internal-admin/password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) })
      setMessage('Internal Admin password changed.')
      setPlatformPasswordChanged(true)
      event.currentTarget.reset()
      setShowPlatformSecurity(false)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not change Internal Admin password.')
    }
  }

  return <section className="page-stack internal-admin-page">
    <div className="internal-admin-hero">
      <div><span className="eyebrow"><ShieldCheck size={15} /> INTERNAL ADMIN CONTROL PLANE</span><h1>BXI-Core Multi-Tenant Admin</h1><p>Manage tenant accounts, enabled modules, users, and password recovery from the dedicated <b>internal_admin</b> account.</p></div>
      <div className="internal-admin-hero-actions"><button className="secondary" type="button" onClick={() => setShowPlatformSecurity((value) => !value)}><LockKeyhole size={16} /> Security</button><button className="primary" onClick={() => setShowCreateOrganization((value) => !value)}><Plus size={16} /> Create account</button></div>
    </div>

    {mustChangePassword && !platformPasswordChanged && <div className="internal-admin-security-warning"><LockKeyhole size={17} /><div><strong>Change the default Internal Admin password</strong><span>The bootstrap password is still active. Open Security below and replace it before using this outside initial setup.</span></div></div>}
    {message && <div className="settings-message">{message}</div>}

    {showPlatformSecurity && <form className="panel internal-admin-security" onSubmit={(event) => void changePlatformPassword(event)}>
      <div className="panel-heading"><div><h2>Internal Admin security</h2><p>Change the password for <b>Account: internal_admin · User: admin</b>. This identity is separate from every tenant workspace.</p></div></div>
      <div className="internal-admin-security-grid"><label>Current password<input name="currentPassword" type="password" required autoComplete="current-password" /></label><label>New password<input name="newPassword" type="password" required minLength={8} autoComplete="new-password" /></label><label>Confirm new password<input name="confirmPassword" type="password" required minLength={8} autoComplete="new-password" /></label></div>
      <div className="dialog-actions"><button type="button" className="secondary" onClick={() => setShowPlatformSecurity(false)}>Cancel</button><button className="primary"><KeyRound size={16} /> Change password</button></div>
    </form>}

    <div className="internal-admin-metrics">
      <div className="metric-card"><Building2 size={20} /><div><span>Total accounts</span><strong>{dashboard?.totals.organizations ?? '—'}</strong></div></div>
      <div className="metric-card"><CheckCircle2 size={20} /><div><span>Active accounts</span><strong>{dashboard?.totals.activeOrganizations ?? '—'}</strong></div></div>
      <div className="metric-card"><Users size={20} /><div><span>Total users</span><strong>{dashboard?.totals.users ?? '—'}</strong></div></div>
      <div className="metric-card"><CircleGauge size={20} /><div><span>Active users</span><strong>{dashboard?.totals.activeUsers ?? '—'}</strong></div></div>
    </div>

    {showCreateOrganization && <form className="panel internal-admin-create" onSubmit={(event) => void createOrganization(event)}>
      <div className="panel-heading"><div><h2>Create tenant account</h2><p>Create a workspace and its first Administrator.</p></div></div>
      <div className="internal-admin-form-grid">
        <label>Account / organization name<input name="name" required placeholder="e.g. Acme Corporation" /></label>
        <label>Account Login ID <small>Used in the Account box on sign-in</small><input name="slug" required placeholder="e.g. acme" pattern="[a-zA-Z0-9-]+" /></label>
        <label>Administrator name<input name="adminName" required /></label>
        <label>Administrator username<input name="username" required autoComplete="off" placeholder="admin" /></label>
        <label>Email<input name="email" type="email" /></label>
        <label>Contact number<input name="phone" /></label>
        <label>Initial password<input name="password" type="password" required minLength={8} autoComplete="new-password" /></label>
      </div>
      <div className="internal-admin-module-picker"><strong>Enabled modules for this account</strong><span>Tenant users can only be assigned modules enabled here.</span><div className="module-check-grid">{MODULE_DEFINITIONS.map((module) => <label className="module-check" key={module.id}><input type="checkbox" checked={newOrganizationModules.includes(module.id)} onChange={() => setNewOrganizationModules((value) => value.includes(module.id) ? value.filter((item) => item !== module.id) : [...value, module.id])} /><div><b>{module.label}</b><small>{module.description}</small></div></label>)}</div></div>
      <div className="dialog-actions"><button type="button" className="secondary" onClick={() => setShowCreateOrganization(false)}>Cancel</button><button className="primary"><Building2 size={16} /> Create account</button></div>
    </form>}

    <div className="internal-admin-layout">
      <div className="panel internal-admin-list-panel">
        <div className="panel-heading"><div><h2>Tenant accounts</h2><p>Each account has isolated users and workspace data. Users sign in with this account ID plus their username.</p></div><button className="secondary compact" type="button" onClick={() => void loadDashboard()} disabled={loading}><RefreshCw size={15} /> Refresh</button></div>
        <div className="internal-admin-search"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search accounts, users, or email…" /></div>
        <div className="table-scroll"><table className="internal-admin-table"><thead><tr><th>Account</th><th>Status</th><th>Users</th><th>Modules</th><th>Created</th><th></th></tr></thead><tbody>{filteredOrganizations.map((organization) => <tr key={organization.id} className={selectedOrganizationId === organization.id ? 'selected' : ''}><td><strong>{organization.name}</strong><small>Login account: {organization.slug}</small></td><td><span className={`workspace-status ${organization.status === 'Active' ? 'active' : 'suspended'}`}>{organization.status}</span></td><td>{organization.activeUserCount}/{organization.userCount} active</td><td>{organization.enabledModules.length}/{MODULE_DEFINITIONS.length}</td><td>{organization.createdAt ? new Date(organization.createdAt).toLocaleDateString() : '—'}</td><td><button className="secondary compact" type="button" onClick={() => setSelectedOrganizationId(organization.id)}>Manage</button></td></tr>)}</tbody></table></div>
        {!loading && !filteredOrganizations.length && <div className="empty-state">No accounts match your search.</div>}
      </div>

      <aside className="panel internal-admin-detail">
        {selectedOrganization ? <>
          <div className="internal-admin-account-head"><div className="account-icon"><Building2 size={22} /></div><div><h2>{selectedOrganization.name}</h2><span>Login account: {selectedOrganization.slug}</span></div><span className={`workspace-status ${selectedOrganization.status === 'Active' ? 'active' : 'suspended'}`}>{selectedOrganization.status}</span></div>
          <div className="internal-admin-detail-section"><div className="section-title"><strong>Account controls</strong></div><div className="internal-admin-control-row"><span>Status</span><select value={selectedOrganization.status} onChange={(event) => void updateOrganization({ status: event.target.value as OrganizationSummary['status'] })}><option>Active</option><option>Suspended</option></select></div></div>
          <div className="internal-admin-detail-section"><div className="section-title"><strong>Enabled modules</strong><span>{selectedOrganization.enabledModules.length}/{MODULE_DEFINITIONS.length}</span></div><div className="internal-admin-module-list">{MODULE_DEFINITIONS.map((module) => <label key={module.id}><input type="checkbox" checked={selectedOrganization.enabledModules.includes(module.id)} onChange={() => toggleOrganizationModule(module.id)} /><span>{module.label}</span></label>)}</div></div>
          <div className="internal-admin-detail-section"><div className="section-title"><strong>Users</strong><button className="secondary compact" type="button" onClick={() => setShowCreateUser((value) => !value)}><UserPlus size={14} /> Add user</button></div>
            {showCreateUser && <form className="internal-admin-user-form" onSubmit={(event) => void createUser(event)}>
              <label>Name<input name="name" required /></label><label>Username<input name="username" required /></label><label>Email<input name="email" type="email" /></label><label>Phone<input name="phone" /></label><label>Password<input name="password" type="password" required minLength={8} /></label><label>Role<select value={newUserRole} onChange={(event) => { const role = event.target.value as UserRole; setNewUserRole(role); setNewUserModules(role === 'Administrator' ? selectedOrganization.enabledModules : selectedOrganization.enabledModules.filter((module) => module !== 'settings')) }}><option>Administrator</option><option>Contributor</option><option>Viewer</option></select></label>
              {newUserRole !== 'Administrator' && <div className="internal-admin-user-modules">{selectedOrganization.enabledModules.map((module) => <label key={module}><input type="checkbox" checked={newUserModules.includes(module)} onChange={() => setNewUserModules((value) => value.includes(module) ? value.filter((item) => item !== module) : [...value, module])} /> {moduleLabel(module)}</label>)}</div>}
              <div className="dialog-actions"><button type="button" className="secondary compact" onClick={() => setShowCreateUser(false)}>Cancel</button><button className="primary compact">Create user</button></div>
            </form>}
            <div className="internal-admin-user-list">{selectedUsers.map((user) => <div className="internal-admin-user-stack" key={user.id}><div className="internal-admin-user-card"><div><strong>{user.name || user.username}</strong><span>@{user.username}{user.email ? ` · ${user.email}` : ''}</span><small>{user.role} · {user.modules.length} module{user.modules.length === 1 ? '' : 's'} · {user.lastLoginAt ? `Last login ${new Date(user.lastLoginAt).toLocaleString()}` : 'Never signed in'}</small></div><div className="internal-admin-user-actions"><select value={user.status} disabled={user.isPlatformAdmin} title={user.isPlatformAdmin ? 'Platform administrator cannot be disabled.' : undefined} onChange={(event) => void updateUser(user, { status: event.target.value as PlatformUser['status'] })}><option>Active</option><option>Disabled</option></select><button type="button" className="secondary compact" onClick={() => setExpandedUserId((value) => value === user.id ? '' : user.id)}><Layers3 size={14} /> Access</button><button type="button" className="secondary compact" onClick={() => void resetPassword(user)}><KeyRound size={14} /> Password</button></div></div>{expandedUserId === user.id && <div className="internal-admin-user-access"><label>Role<select value={user.role} disabled={user.isPlatformAdmin} onChange={(event) => void updateUser(user, { role: event.target.value as UserRole })}><option>Administrator</option><option>Contributor</option><option>Viewer</option></select></label><div><strong>Module access</strong><div className="internal-admin-user-modules">{selectedOrganization.enabledModules.map((module) => { const checked = user.role === 'Administrator' || user.modules.includes(module); return <label key={module}><input type="checkbox" checked={checked} disabled={user.role === 'Administrator' || user.isPlatformAdmin} onChange={() => { const modules = user.modules.includes(module) ? user.modules.filter((item) => item !== module) : [...user.modules, module]; void updateUser(user, { modules }) }} /> {moduleLabel(module)}</label> })}</div></div></div>}</div>)}</div>
          </div>
        </> : <div className="empty-state"><Layers3 size={28} /><p>Select an account to manage modules and users.</p></div>}
      </aside>
    </div>
  </section>
}
