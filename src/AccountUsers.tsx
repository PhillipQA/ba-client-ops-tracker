import { useEffect, useState, type FormEvent } from 'react'
import { MODULE_DEFINITIONS, defaultModulesForRole } from './access'
import { settingsRequest } from './Settings'
import { waitForCloudSaves } from './cloudStore'
import type { AppModule, UserAccount, UserRole } from './types'

export default function AccountUsers({ currentUser, onChanged }: { currentUser: UserAccount; onChanged: (users: UserAccount[]) => void }) {
  const [users, setUsers] = useState<UserAccount[]>([])
  const [enabled, setEnabled] = useState<AppModule[]>([])
  const [editing, setEditing] = useState<UserAccount | 'new' | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const load = async () => {
    await waitForCloudSaves()
    const result = await settingsRequest('/api/account/users')
    setUsers(result.users); setEnabled(result.enabledModules); setLoaded(true); onChanged(result.users)
  }
  useEffect(() => { void load().catch(e => setMessage(e.message)) }, [currentUser.id, currentUser.organizationId])
  const save = async (body: unknown) => {
    setBusy(true); setMessage('')
    try {
      await waitForCloudSaves()
      await settingsRequest(editing === 'new' ? '/api/account/users' : `/api/account/users/${(editing as UserAccount).id}`, editing === 'new' ? 'POST' : 'PATCH', body)
      setEditing(null)
      await load()
      setMessage('User and permissions saved.')
    } catch (e) { setMessage((e as Error).message) } finally { setBusy(false) }
  }
  return <section className="page-stack account-users-page">
    <div className="page-heading"><div><h1>Users &amp; Permissions</h1><p>{currentUser.organizationName} · Manage users in this account.</p></div><button className="primary" disabled={!loaded || busy} onClick={() => { setEditing('new'); setMessage('') }}>Add user</button></div>
    <div className="panel"><h2>Role permissions</h2><div className="table-scroll"><table><thead><tr><th>Role</th><th>Allowed actions</th></tr></thead><tbody>
      <tr><td>Administrator</td><td>Manage account users, account settings, and all modules enabled by Internal Admin.</td></tr>
      <tr><td>Contributor</td><td>Create, edit, and delete records through assigned modules. Cannot manage other users or integration credentials.</td></tr>
      <tr><td>Viewer</td><td>View assigned modules and reports. Cannot change operational records or use AI actions.</td></tr>
    </tbody></table></div><p>Every user can edit their own profile and themes. Module assignments control feature access; they do not provide client-by-client data restrictions within this account.</p></div>
    {message && <p className="settings-message" role="status">{message}</p>}
    {editing && <UserForm key={editing === 'new' ? 'new' : editing.id} user={editing === 'new' ? undefined : editing} ownId={currentUser.id} enabled={enabled} busy={busy} onSave={save} onCancel={() => setEditing(null)} />}
    <div className="panel"><div className="panel-heading"><h2>Account users</h2><button className="secondary" disabled={busy} onClick={() => void load().catch(e => setMessage(e.message))}>Refresh</button></div><div className="table-scroll"><table><thead><tr><th>User</th><th>Role</th><th>Status</th><th>Assigned modules</th><th>Actions</th></tr></thead><tbody>{users.map(user => <tr key={user.id}><td><strong>{user.name}</strong><div>@{user.username}{user.id === currentUser.id ? ' · You' : ''}</div><small>{user.email}</small></td><td>{user.role}</td><td>{user.status}</td><td>{user.role === 'Administrator' ? 'All enabled account modules' : MODULE_DEFINITIONS.filter(m => user.modules.includes(m.id)).map(m => m.label).join(', ') || 'No modules'}</td><td><button className="secondary compact" disabled={busy} onClick={() => { setEditing(user); setMessage('') }}>Edit access</button></td></tr>)}</tbody></table></div>{!loaded && <p>Loading account users…</p>}</div>
  </section>
}

function UserForm({ user, ownId, enabled, busy, onSave, onCancel }: { user?: UserAccount; ownId: string; enabled: AppModule[]; busy: boolean; onSave: (body: unknown) => Promise<void>; onCancel: () => void }) {
  const [role, setRole] = useState<UserRole>(user?.role || 'Contributor')
  const [modules, setModules] = useState<AppModule[]>((user?.modules || defaultModulesForRole('Contributor')).filter(m => enabled.includes(m)))
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    void onSave({ name: form.get('name'), email: form.get('email'), phone: form.get('phone'), role, status: user?.id === ownId ? 'Active' : form.get('status'), modules: role === 'Administrator' ? enabled : modules, ...(!user ? { username: form.get('username'), password: form.get('password') } : {}) })
  }
  return <form className="panel account-user-form" onSubmit={submit}><h2>{user ? `Edit ${user.username}` : 'Add user'}</h2><fieldset disabled={busy}><div className="internal-admin-form-grid">
    <label>Name<input name="name" required maxLength={254} defaultValue={user?.name || ''} /></label>
    {!user && <label>Username<input name="username" required maxLength={100} autoComplete="off" /></label>}
    <label>Email<input name="email" type="email" maxLength={254} defaultValue={user?.email || ''} /></label>
    <label>Phone<input name="phone" maxLength={254} defaultValue={user?.phone || ''} /></label>
    {!user && <label>Initial password<input name="password" type="password" minLength={8} maxLength={256} required autoComplete="new-password" /></label>}
    <label>Role<select value={role} disabled={user?.id === ownId} onChange={e => { const next = e.target.value as UserRole; setRole(next); setModules(defaultModulesForRole(next).filter(m => enabled.includes(m))) }}><option>Administrator</option><option>Contributor</option><option>Viewer</option></select></label>
    <label>Status<select name="status" defaultValue={user?.status || 'Active'} disabled={user?.id === ownId}><option>Active</option><option>Disabled</option></select></label>
  </div><h3>Module access</h3><p>Only modules enabled for this account are available. Role restrictions still apply.</p><div className="module-check-grid">{MODULE_DEFINITIONS.filter(m => enabled.includes(m.id)).map(m => <label className="module-check" key={m.id}><input type="checkbox" checked={role === 'Administrator' || modules.includes(m.id)} disabled={role === 'Administrator'} onChange={() => setModules(previous => previous.includes(m.id) ? previous.filter(id => id !== m.id) : [...previous, m.id])} /><div><b>{m.label}</b><small>{m.description}</small></div></label>)}</div>
    <div className="dialog-actions"><button type="button" className="secondary" onClick={onCancel}>Cancel</button><button className="primary">{busy ? 'Saving…' : 'Save user'}</button></div>
  </fieldset></form>
}
