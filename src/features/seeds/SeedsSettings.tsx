/**
 * Administrators: the Seeds connection (Settings › Integrations) and who sees what (Settings › Access).
 * Saving a Seeds API key is what turns Seeds on; it syncs straight away and every 30 minutes after.
 */
import { Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { SEEDS_ROLE_LABELS, SEEDS_ROLES, type SeedsRole } from '../../shared/access'
import {
  type AccessSetup,
  type AssignmentInput,
  loadAccessSetup,
  loadSeedsConnection,
  removeSeedsConnection,
  type SeedsConnection,
  saveAccessSetup,
  saveSeedsConnection,
  syncSeeds,
} from './seedsApi'
import './seeds.css'

const failure = (error: unknown) => (error instanceof Error ? error.message : 'Request failed.')

export function SeedsConnectionCard({ onChanged }: { onChanged?: () => void }) {
  const [connection, setConnection] = useState<SeedsConnection | null>(null)
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const load = async () => {
    const next = await loadSeedsConnection()
    setConnection(next)
    setBaseUrl(current => current || next.baseUrl)
  }
  useEffect(() => {
    void load().catch(error => setMessage(failure(error)))
  }, [])
  const act = async (action: () => Promise<string>) => {
    setBusy(true)
    setMessage('')
    try {
      setMessage(await action())
      await load()
      onChanged?.()
    } catch (error) {
      setMessage(failure(error))
    } finally {
      setBusy(false)
    }
  }
  const status = connection?.status
  return (
    <section className="panel account-integration-card">
      <div className="panel-heading">
        <div>
          <h2>Seeds</h2>
          <p>
            Clients, projects (with contract numbers), tasks and who is assigned to them come from Seeds. Saving the API
            key turns Seeds on.
          </p>
        </div>
        <span
          className={connection?.configured ? (status?.lastError ? 'role-badge warn' : 'role-badge ok') : 'role-badge'}
        >
          {connection?.configured ? (status?.lastError ? 'Needs attention' : 'Connected') : 'Not connected'}
        </span>
      </div>
      {connection?.configured && (
        <p>
          Saved key: <b>{connection.maskedKey}</b> · Last sync:{' '}
          {status?.lastSuccessAt ? new Date(status.lastSuccessAt).toLocaleString() : 'not yet'}
          {status?.lastError ? ` · ${status.lastError}` : ''}
        </p>
      )}
      {connection && !connection.encryptionReady && (
        <p role="alert" className="settings-message">
          Integration storage needs setup by Internal Admin before a Seeds key can be saved.
        </p>
      )}
      <div className="integration-form">
        <label>
          Seeds API address
          <input
            type="url"
            placeholder="https://seeds.example.com/api/v1"
            value={baseUrl}
            onChange={event => setBaseUrl(event.target.value)}
            autoComplete="off"
          />
        </label>
        <label>
          {connection?.configured ? 'Replace API key (leave blank to keep it)' : 'Seeds API key'}
          <input
            type="password"
            value={apiKey}
            onChange={event => setApiKey(event.target.value)}
            autoComplete="new-password"
          />
        </label>
      </div>
      <div className="integration-actions">
        <button
          type="button"
          className="primary"
          disabled={busy || !baseUrl.trim() || (!apiKey.trim() && !connection?.configured)}
          onClick={() =>
            void act(async () => {
              const result = await saveSeedsConnection(baseUrl.trim(), apiKey.trim())
              setApiKey('')
              return result.sync.ok
                ? `Seeds is connected and synced.${result.sync.pending ? ` ${result.sync.pending} match${result.sync.pending === 1 ? '' : 'es'} to confirm on the Seeds page.` : ''}`
                : `Saved, but the first sync failed: ${result.sync.error}`
            })
          }
        >
          {connection?.configured ? 'Save' : 'Connect Seeds'}
        </button>
        {connection?.configured && (
          <>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  const result = await syncSeeds()
                  return result.ok ? 'Synced.' : result.error || 'Seeds could not be read.'
                })
              }
            >
              Sync now
            </button>
            <button
              type="button"
              className="secondary danger"
              disabled={busy}
              onClick={() => {
                if (!window.confirm('Disconnect Seeds? Hand-entered assignments count again until it is reconnected.'))
                  return
                void act(async () => {
                  await removeSeedsConnection()
                  return 'Seeds disconnected.'
                })
              }}
            >
              Disconnect
            </button>
          </>
        )}
      </div>
      {message && (
        <p role="status" className="settings-message">
          {message}
        </p>
      )}
    </section>
  )
}

export function AccessSettings() {
  const [setup, setSetup] = useState<AccessSetup | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [draft, setDraft] = useState<{ userId: string; role: SeedsRole; target: string }>({
    userId: '',
    role: 'BA',
    target: '',
  })
  const load = async () => setSetup(await loadAccessSetup())
  useEffect(() => {
    void load().catch(error => setMessage(failure(error)))
  }, [])
  const save = async (changes: { strictVisibility?: boolean; assignments?: AssignmentInput[] }, done: string) => {
    setBusy(true)
    setMessage('')
    try {
      await saveAccessSetup(changes)
      await load()
      setMessage(done)
    } catch (error) {
      setMessage(failure(error))
    } finally {
      setBusy(false)
    }
  }
  if (!setup)
    return (
      <div className="panel">
        <p>{message || 'Loading access…'}</p>
      </div>
    )
  const users = new Map<string, AccessSetup['users'][number]>(setup.users.map(user => [user.id, user]))
  const clients = new Map<string, AccessSetup['clients'][number]>(setup.clients.map(client => [client.id, client]))
  const projects = new Map<string, AccessSetup['projects'][number]>(
    setup.projects.map(project => [project.id, project]),
  )
  const shown = setup.assignments.filter(a => a.source === (setup.assignmentsFromSeeds ? 'seeds' : 'manual'))
  const manualAssignments = setup.assignments.filter(a => a.source === 'manual')
  const toInput = ({ userId, role, clientId, projectId }: AssignmentInput): AssignmentInput => ({
    userId,
    role,
    ...(projectId ? { projectId } : { clientId }),
  })
  const manual = manualAssignments.map(toInput)
  const locked = setup.assignmentsFromSeeds
  const where = (a: { clientId?: string; projectId?: string }) =>
    a.projectId
      ? `${projects.get(a.projectId)?.name || 'Project'}${projects.get(a.projectId)?.clientId ? ` · ${clients.get(String(projects.get(a.projectId)?.clientId))?.name || ''}` : ''}`
      : clients.get(String(a.clientId))?.name || 'Client'
  const active = setup.users.filter(user => user.status !== 'Disabled')
  const noAssignments = !shown.length

  return (
    <div className="page-stack">
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Per-person visibility</h2>
            <p>
              When on, each person sees only the clients and projects they are assigned to, with all the work under
              them. Administrators set things up but see no client data unless they are assigned too. Account Managers
              become Viewers of Action Center, Reports and AI BA Assistant.
            </p>
          </div>
          <span className={setup.strictVisibility ? 'role-badge ok' : 'role-badge'}>
            {setup.strictVisibility ? 'On' : 'Off'}
          </span>
        </div>
        <label className="access-switch">
          <input
            type="checkbox"
            checked={setup.strictVisibility}
            disabled={busy}
            onChange={event => {
              const on = event.target.checked
              if (
                on &&
                noAssignments &&
                !window.confirm('No one is assigned yet, so everyone will see an empty workspace. Turn it on anyway?')
              )
                return
              void save(
                { strictVisibility: on },
                on ? 'Per-person visibility is on.' : 'Everyone sees all clients again.',
              )
            }}
          />
          Show each person only their assigned clients and projects
        </label>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Assignments</h2>
            <p>
              {locked
                ? 'These come from Seeds and change there. They refresh on every sync.'
                : setup.seedsConnected
                  ? 'Seeds is connected; its assignments replace these after the first successful sync.'
                  : 'Until Seeds is connected, enter who works on which client or project here. Roles add up: someone can be PM on one project and BA on another.'}
            </p>
          </div>
        </div>
        {shown.length ? (
          <table className="access-assignments">
            <thead>
              <tr>
                <th>Person</th>
                <th>Role</th>
                <th>Client or project</th>
                {!locked && <th aria-label="Remove" />}
              </tr>
            </thead>
            <tbody>
              {shown.map(assignment => (
                <tr key={assignment.id}>
                  <td>{users.get(assignment.userId)?.name || 'Former user'}</td>
                  <td>{SEEDS_ROLE_LABELS[assignment.role]}</td>
                  <td>{where(assignment)}</td>
                  {!locked && (
                    <td>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label="Remove assignment"
                        disabled={busy}
                        onClick={() =>
                          void save(
                            { assignments: manualAssignments.filter(a => a.id !== assignment.id).map(toInput) },
                            'Assignment removed.',
                          )
                        }
                      >
                        <Trash2 size={16} />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p>No assignments yet.</p>
        )}
        {!locked && (
          <div className="access-add">
            <label>
              Person
              <select value={draft.userId} onChange={event => setDraft({ ...draft, userId: event.target.value })}>
                <option value="">Choose…</option>
                {active.map(user => (
                  <option key={user.id} value={user.id}>
                    {user.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Role
              <select
                value={draft.role}
                onChange={event => setDraft({ ...draft, role: event.target.value as SeedsRole })}
              >
                {SEEDS_ROLES.map(role => (
                  <option key={role} value={role}>
                    {SEEDS_ROLE_LABELS[role]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Client or project
              <select value={draft.target} onChange={event => setDraft({ ...draft, target: event.target.value })}>
                <option value="">Choose…</option>
                <optgroup label="Whole client">
                  {setup.clients
                    .filter(client => !client.archived)
                    .map(client => (
                      <option key={client.id} value={`client:${client.id}`}>
                        {client.name}
                      </option>
                    ))}
                </optgroup>
                <optgroup label="One project">
                  {setup.projects
                    .filter(project => !project.archived)
                    .map(project => (
                      <option key={project.id} value={`project:${project.id}`}>
                        {project.name}
                        {project.contractNumber ? ` (${project.contractNumber})` : ''}
                      </option>
                    ))}
                </optgroup>
              </select>
            </label>
            <button
              type="button"
              className="primary"
              disabled={busy || !draft.userId || !draft.target}
              onClick={() => {
                const [kind, id] = draft.target.split(/:(.*)/s)
                const next: AssignmentInput = {
                  userId: draft.userId,
                  role: draft.role,
                  ...(kind === 'project' ? { projectId: id } : { clientId: id }),
                }
                void save({ assignments: [...manual, next] }, 'Assignment added.').then(() =>
                  setDraft({ ...draft, target: '' }),
                )
              }}
            >
              <Plus size={16} /> Assign
            </button>
          </div>
        )}
        {message && (
          <p role="status" className="settings-message">
            {message}
          </p>
        )}
      </section>
    </div>
  )
}
