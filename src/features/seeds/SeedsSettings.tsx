/**
 * Administrators: Seeds for the account (Settings › Integrations) and who sees what (Settings › Access).
 * Each person connects Seeds with their own API key on the Seeds page › Sync.
 */
import { Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { SeedsRole } from '../../shared/access'
import {
  type AccessSetup,
  type AssignmentInput,
  loadAccessSetup,
  loadSeedsAccount,
  type SeedsAccount,
  saveAccessSetup,
  saveSeedsAccount,
  turnOffSeeds,
} from './seedsApi'
import './seeds.css'

const failure = (error: unknown) => (error instanceof Error ? error.message : 'Request failed.')

export function SeedsConnectionCard() {
  const [account, setAccount] = useState<SeedsAccount | null>(null)
  const [baseUrl, setBaseUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const load = async () => {
    const next = await loadSeedsAccount()
    setAccount(next)
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
    } catch (error) {
      setMessage(failure(error))
    } finally {
      setBusy(false)
    }
  }
  const people = account?.people || []
  return (
    <section className="panel account-integration-card">
      <div className="panel-heading">
        <div>
          <h2>Seeds</h2>
          <p>
            Turn Seeds on and give its API address. Each person then connects with their own Seeds API key on the Seeds
            page › Sync, and sees only what Seeds shows them.
          </p>
        </div>
        <span className={account?.connected ? 'role-badge ok' : 'role-badge'}>{account?.connected ? 'On' : 'Off'}</span>
      </div>
      {account && !account.encryptionReady && (
        <p role="alert" className="settings-message">
          Credential storage needs setup by Internal Admin before people can save their Seeds keys.
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
      </div>
      <div className="integration-actions">
        <button
          type="button"
          className="primary"
          disabled={busy || !baseUrl.trim()}
          onClick={() =>
            void act(async () => {
              await saveSeedsAccount(baseUrl.trim())
              return 'Seeds is on. People can now connect their own Seeds key on the Seeds page › Sync.'
            })
          }
        >
          {account?.connected ? 'Save address' : 'Turn on Seeds'}
        </button>
        {account?.connected && (
          <button
            type="button"
            className="secondary danger"
            disabled={busy}
            onClick={() => {
              if (!window.confirm('Turn Seeds off? Hand-entered assignments count again until it is turned back on.'))
                return
              void act(async () => {
                await turnOffSeeds()
                return 'Seeds is off.'
              })
            }}
          >
            Turn off
          </button>
        )}
      </div>
      {account?.connected && (
        <>
          <h3>Who has connected</h3>
          {people.length ? (
            <ul className="seeds-list">
              {people.map(person => (
                <li key={person.userId}>
                  <div>
                    <strong>{person.name}</strong>
                    <small>
                      {' '}
                      ·{' '}
                      {person.lastSuccessAt
                        ? `synced ${new Date(person.lastSuccessAt).toLocaleString()}`
                        : 'not synced yet'}
                      {person.lastError ? ` · ${person.lastError}` : ''}
                      {person.unknownRoles?.length
                        ? ` · Seeds titles with no role yet: ${person.unknownRoles.join(', ')} (add them in Settings › Roles)`
                        : ''}
                    </small>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p>Nobody yet.</p>
          )}
        </>
      )}
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
  const roleName = (id: string) => setup.roles.find(role => role.id === id)?.name || id
  const users = new Map<string, AccessSetup['users'][number]>(setup.users.map(user => [user.id, user]))
  const clients = new Map<string, AccessSetup['clients'][number]>(setup.clients.map(client => [client.id, client]))
  const projects = new Map<string, AccessSetup['projects'][number]>(
    setup.projects.map(project => [project.id, project]),
  )
  // In force per person: from their own Seeds sync once they have one, otherwise the ones entered here.
  const fromSeeds = new Set(setup.seedsConnected ? setup.seedsUsers : [])
  const shown = setup.assignments.filter(a => a.source === (fromSeeds.has(a.userId) ? 'seeds' : 'manual'))
  const manualAssignments = setup.assignments.filter(a => a.source === 'manual')
  const toInput = ({ userId, role, clientId, projectId }: AssignmentInput): AssignmentInput => ({
    userId,
    role,
    ...(projectId ? { projectId } : { clientId }),
  })
  const manual = manualAssignments.map(toInput)
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
              {setup.seedsConnected
                ? 'People who have connected their own Seeds get their access from Seeds (it changes there). For everyone else, enter it here.'
                : 'Until Seeds is on, enter who works on which client or project here. Roles add up: someone can be PM on one project and BA on another.'}
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
                <th>From</th>
                <th aria-label="Remove" />
              </tr>
            </thead>
            <tbody>
              {shown.map(assignment => (
                <tr key={assignment.id}>
                  <td>{users.get(assignment.userId)?.name || 'Former user'}</td>
                  <td>{roleName(assignment.role)}</td>
                  <td>{where(assignment)}</td>
                  <td>{assignment.source === 'seeds' ? 'Seeds' : 'Entered here'}</td>
                  {assignment.source === 'manual' ? (
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
                  ) : (
                    <td />
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p>No assignments yet.</p>
        )}
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
              {setup.roles.map(({ id: role }) => (
                <option key={role} value={role}>
                  {roleName(role)}
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
        {message && (
          <p role="status" className="settings-message">
            {message}
          </p>
        )}
      </section>
    </div>
  )
}
