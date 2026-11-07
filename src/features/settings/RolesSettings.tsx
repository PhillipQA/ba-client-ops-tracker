/**
 * Settings › Roles: what each job role sees and changes, and the titles Seeds uses for it. Administrators always see
 * and change everything; these roles are for everyone else. Give people roles in Users & Permissions, or let Seeds
 * give them per client or project.
 */
import { Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { type JobRole, MAX_JOB_ROLES, ROLE_MODULES } from '../../shared/roles'
import type { AppModule } from '../../shared/types'
import { MODULE_DEFINITIONS } from '../accounts/access'

type Request = (url: string, method?: string, body?: unknown) => Promise<any>
const label = (module: AppModule) => MODULE_DEFINITIONS.find(definition => definition.id === module)?.label || module

export function RolesSettings({ request }: { request: Request }) {
  const [roles, setRoles] = useState<JobRole[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [open, setOpen] = useState('')
  useEffect(() => {
    void request('/api/account/roles')
      .then(result => setRoles(result.roles))
      .catch(error => setMessage(error instanceof Error ? error.message : 'Roles could not be loaded.'))
  }, [request])
  if (!roles)
    return (
      <section className="panel">
        <p>{message || 'Loading roles…'}</p>
      </section>
    )
  const change = (id: string, patch: Partial<JobRole>) =>
    setRoles(roles.map(role => (role.id === id ? { ...role, ...patch } : role)))
  const toggle = (role: JobRole, module: AppModule, kind: 'see' | 'edit') => {
    if (kind === 'see') {
      const sees = role.modules.includes(module)
      change(role.id, {
        modules: sees ? role.modules.filter(m => m !== module) : [...role.modules, module],
        edit: sees ? role.edit.filter(m => m !== module) : role.edit,
      })
    } else {
      const edits = role.edit.includes(module)
      change(role.id, {
        edit: edits ? role.edit.filter(m => m !== module) : [...role.edit, module],
        modules: role.modules.includes(module) ? role.modules : [...role.modules, module],
      })
    }
  }
  const save = () => {
    setBusy(true)
    setMessage('')
    void request('/api/account/roles', 'PUT', { roles })
      .then(result => {
        setRoles(result.roles)
        setMessage('Roles saved. People see the change after their next refresh.')
      })
      .catch(error => setMessage(error instanceof Error ? error.message : 'Roles could not be saved.'))
      .finally(() => setBusy(false))
  }
  return (
    <section className="panel roles-settings">
      <div className="panel-heading">
        <div>
          <h2>Roles</h2>
          <p>
            What each job role sees and can change. Administrators always see and change everything. Give people roles
            in Users &amp; Permissions, or let Seeds give them per client or project; roles add up. A role that can
            change nothing is read-only.
          </p>
        </div>
      </div>
      <div className="roles-list">
        {roles.map(role => (
          <div key={role.id} className="role-card">
            <button
              type="button"
              className="role-card-head"
              aria-expanded={open === role.id}
              onClick={() => setOpen(open === role.id ? '' : role.id)}
            >
              <strong>{role.name}</strong>
              <small>
                {role.id} · sees {role.modules.length} · changes {role.edit.length || 'nothing (read-only)'}
              </small>
            </button>
            {open === role.id && (
              <div className="role-card-body">
                <div className="role-fields">
                  <label>
                    Name
                    <input
                      value={role.name}
                      maxLength={40}
                      onChange={event => change(role.id, { name: event.target.value })}
                    />
                  </label>
                  <label>
                    Titles in Seeds (comma-separated)
                    <input
                      value={role.seedsTitles.join(', ')}
                      onChange={event =>
                        change(role.id, {
                          seedsTitles: event.target.value
                            .split(',')
                            .map(title => title.trimStart())
                            .filter((title, index, all) => title || index === all.length - 1),
                        })
                      }
                    />
                  </label>
                </div>
                <table className="role-modules">
                  <thead>
                    <tr>
                      <th>Page</th>
                      <th>Sees</th>
                      <th>Changes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ROLE_MODULES.map(module => (
                      <tr key={module}>
                        <td>{label(module)}</td>
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`${role.name} sees ${label(module)}`}
                            checked={role.modules.includes(module)}
                            onChange={() => toggle(role, module, 'see')}
                          />
                        </td>
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`${role.name} changes ${label(module)}`}
                            checked={role.edit.includes(module)}
                            onChange={() => toggle(role, module, 'edit')}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!role.builtIn && (
                  <button
                    type="button"
                    className="secondary danger"
                    onClick={() => setRoles(roles.filter(candidate => candidate.id !== role.id))}
                  >
                    <Trash2 size={15} /> Remove role
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="integration-actions">
        <button
          type="button"
          className="secondary"
          disabled={roles.length >= MAX_JOB_ROLES}
          onClick={() => {
            const name = window.prompt('Name of the new role (for example, Business Owner)')?.trim()
            if (!name) return
            const id =
              name
                .toUpperCase()
                .replace(/[^A-Z0-9]+/g, '_')
                .replace(/^_|_$/g, '')
                .slice(0, 20) || `ROLE${roles.length + 1}`
            if (roles.some(role => role.id === id)) return setMessage('A role with that code already exists.')
            setRoles([...roles, { id, name, modules: ['action'], edit: [], seedsTitles: [name] }])
            setOpen(id)
          }}
        >
          <Plus size={16} /> Add role
        </button>
        <button type="button" className="primary" disabled={busy} onClick={save}>
          Save roles
        </button>
      </div>
      {message && (
        <p role="status" className="settings-message">
          {message}
        </p>
      )}
    </section>
  )
}
