/**
 * Administrators: Seeds for the account (Settings › Integrations) and who sees what (Settings › Access).
 * The server holds the Seeds application token; people are matched to Seeds by email.
 */
import { Plus, RefreshCw, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { SeedsRole } from '../../shared/access'
import {
  type AccessSetup,
  type AssignmentInput,
  loadAccessSetup,
  loadSeedsAccount,
  type SeedsAccount,
  saveAccessSetup,
  progressText,
  type SyncResult,
  fullSyncSeeds,
  syncSeeds,
  turnOffSeeds,
  turnOnSeeds,
} from './seedsApi'
import './seeds.css'

const failure = (error: unknown) => (error instanceof Error ? error.message : 'Request failed.')

export function SeedsConnectionCard() {
  const [account, setAccount] = useState<SeedsAccount | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const load = async () => setAccount(await loadSeedsAccount())
  useEffect(() => {
    void load().catch(error => setMessage(failure(error)))
  }, [])
  // While a sync runs, check on it every few seconds.
  useEffect(() => {
    if (!account?.running) return
    const timer = setTimeout(() => void load().catch(() => {}), 4000)
    return () => clearTimeout(timer)
  }, [account])
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
  const synced = (result: SyncResult) =>
    result.running
      ? 'Syncing in the background. A first sync can take a few minutes; this card updates as it goes.'
      : result.ok
        ? `Synced. Seeds found ${result.matched ?? 0} of your people on its projects${result.unmatched ? `; ${result.unmatched} not found` : ''}.${result.pending ? ` ${result.pending} close match${result.pending === 1 ? '' : 'es'} to confirm on the Seeds page.` : ''}`
        : result.error || 'Seeds could not be read.'
  const people = account?.people || []
  const found = people.filter(person => person.connected)
  const missing = people.filter(person => !person.connected)
  const sync = account?.sync
  const fields = Object.entries(sync?.fields || {}).filter(([, names]) => names.length)
  return (
    <section className="panel account-integration-card">
      <div className="panel-heading">
        <div>
          <h2>Seeds</h2>
          <p>
            Reads clients, projects, tasks and project members from Seeds. Each person is matched by email and sees the
            projects Seeds lists them on. Every 10 minutes a delta sync reads only the projects Seeds changed since the
            last sync (members, tasks, contract, product and deletions); once a week a full sync checks them all.
          </p>
        </div>
        <span className={account?.connected ? (sync?.lastError ? 'role-badge warn' : 'role-badge ok') : 'role-badge'}>
          {account?.connected ? (sync?.lastError ? 'Needs attention' : 'On') : 'Off'}
        </span>
      </div>
      {account && !account.tokenReady && (
        <p role="alert" className="settings-message">
          The server has no Seeds token yet. Ask a SEEDS Admin for an application token, then add it in Northflank as
          the secret SEEDS_API_TOKEN and redeploy.
        </p>
      )}
      {account?.running && (
        <p className="seeds-access-line" role="status">
          <RefreshCw size={14} className="spin" aria-hidden="true" /> Syncing: {progressText(account.progress)}
        </p>
      )}
      {account?.connected && sync && !account.running && (
        <p className="seeds-access-line">
          {sync.lastSuccessAt ? `Last synced ${new Date(sync.lastSuccessAt).toLocaleString()}` : 'Not synced yet.'}
          {sync.lastSuccessAt && sync.mode
            ? ` (${sync.mode}: ${sync.checked ?? 0} project${sync.checked === 1 ? '' : 's'} checked).`
            : sync.lastSuccessAt
              ? '.'
              : ''}
          {sync.lastFullAt ? ` Last full sync ${new Date(sync.lastFullAt).toLocaleString()}.` : ''}
          {sync.lastError ? ` Last try failed: ${sync.lastError}` : ''}
        </p>
      )}
      <div className="integration-actions">
        {!account?.connected ? (
          <button
            type="button"
            className="primary"
            disabled={busy || !account?.tokenReady}
            onClick={() => {
              if (
                !window.confirm(
                  'Turn on Seeds? Seeds becomes the source of truth: every client and project that exists now moves to the Before Seeds folder (still there, still editable, open to everyone), and new clients and projects come only from Seeds.',
                )
              )
                return
              void act(async () => {
                const result = await turnOnSeeds()
                return `Seeds is on. Existing clients and projects are in Before Seeds. ${synced(result.sync)}`
              })
            }}
          >
            Turn on Seeds
          </button>
        ) : (
          <>
            <button
              type="button"
              className="primary"
              disabled={busy || !account.tokenReady || account.running}
              onClick={() => void act(async () => synced(await syncSeeds()))}
            >
              Sync now
            </button>
            <button
              type="button"
              className="secondary"
              title="Reads the members of every open Seeds project, not only the ones that changed. Takes a few minutes."
              disabled={busy || !account.tokenReady || account.running}
              onClick={() => void act(async () => synced(await fullSyncSeeds()))}
            >
              Full sync
            </button>
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
          </>
        )}
      </div>
      {message && (
        <p role="status" className="settings-message">
          {message}
        </p>
      )}
      {account?.connected && sync?.skipped ? (
        <p className="seeds-access-line">
          Seeds would not give the members or tasks of {sync.skipped} project{sync.skipped === 1 ? '' : 's'}; they were
          skipped.
        </p>
      ) : null}
      {account?.connected && fields.length > 0 && !sync?.lastSuccessAt && (
        <details>
          <summary>Fields Seeds sent</summary>
          <dl className="seeds-fields">
            {fields.map(([list, names]) => (
              <div key={list}>
                <dt>{list}</dt>
                <dd>{names.join(', ')}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
      {account?.connected && sync?.lastSuccessAt && (
        <>
          <h3>Found in Seeds ({found.length})</h3>
          {found.length ? (
            <ul className="seeds-list">
              {found.map(person => (
                <li key={person.userId}>
                  <div>
                    <strong>{person.name}</strong>
                    <small>
                      {' '}
                      · {person.counts?.assignments ?? 0} project role{person.counts?.assignments === 1 ? '' : 's'}
                      {person.unknownRoles?.length
                        ? ` · Seeds roles with no job role yet: ${person.unknownRoles.join(', ')} (add them in Settings › Roles)`
                        : ''}
                    </small>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p>Nobody yet. Check that people's emails here match their Seeds emails.</p>
          )}
          {missing.length > 0 && (
            <>
              <h3>Not on any Seeds project ({missing.length})</h3>
              <p>Their email here may differ from Seeds. Their hand-entered assignments (Settings › Access) apply.</p>
              <p>{missing.map(person => person.name).join(', ')}</p>
            </>
          )}
          {fields.length > 0 && (
            <details>
              <summary>Fields Seeds sent</summary>
              <dl className="seeds-fields">
                {fields.map(([list, names]) => (
                  <div key={list}>
                    <dt>{list}</dt>
                    <dd>{list === 'paging' ? names.map(line => <div key={line}>{line}</div>) : names.join(', ')}</dd>
                  </div>
                ))}
              </dl>
            </details>
          )}
        </>
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
  // In force per person: from Seeds once it lists them on a project, otherwise the ones entered here.
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
                ? 'People Seeds lists on a project get their access from Seeds (it changes there). For everyone else, enter it here.'
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
