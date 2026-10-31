import { useEffect, useState } from 'react'
import { settingsRequest } from './Settings'
import type { TaskColumnKey, TaskSettings, WaitingOnDefinition } from '../../shared/types'
import { WAITING_ON_LIMITS, waitingOnOptions } from '../tasks/waitingOn'
const withWaitingOn = (settings: TaskSettings | null | undefined): TaskSettings | null =>
  settings ? { ...settings, waitingOn: waitingOnOptions(settings) } : null
const columns: [TaskColumnKey, string][] = [
  ['status', 'Status'],
  ['client', 'Client'],
  ['project', 'Project'],
  ['type', 'Type'],
  ['waitingOn', 'Waiting on'],
  ['priority', 'Priority'],
  ['owner', 'Owner'],
  ['dueDate', 'Due date'],
  ['followUpDate', 'Follow-up date'],
]
function waitingOnProblem(options: WaitingOnDefinition[]) {
  if (options.some(option => !option.label.trim())) return 'Every waiting-on option needs a name.'
  const labels = options.map(option => option.label.trim().toLowerCase())
  if (new Set(labels).size !== labels.length) return 'Waiting-on names must be unique.'
  if (!options.some(option => !option.done)) return 'Keep at least one option besides the completion option.'
  return ''
}

/**
 * Waiting-on options for one account. The first open option is the default
 * for new and reopened tasks; the completion option can be renamed but not
 * removed. Renames carry over to existing tasks when saved.
 */
function WaitingOnEditor({
  options,
  onChange,
}: {
  options: WaitingOnDefinition[]
  onChange: (next: WaitingOnDefinition[]) => void
}) {
  const [draft, setDraft] = useState('')
  const move = (index: number, by: number) => {
    const next = [...options],
      target = index + by
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target], next[index]]
    onChange(next)
  }
  const defaultId = options.find(option => !option.done)?.id
  const canAdd =
    Boolean(draft.trim()) &&
    options.length < WAITING_ON_LIMITS.maxOptions &&
    !options.some(option => option.label.trim().toLowerCase() === draft.trim().toLowerCase())
  const add = () => {
    if (!canAdd) return
    onChange([...options, { id: crypto.randomUUID(), label: draft.trim(), done: false }])
    setDraft('')
  }
  return (
    <div className="waiting-on-editor">
      <h5>Waiting on options</h5>
      <p>
        The first option is the default for new tasks. Renaming an option updates the tasks that use it. An option still
        used by tasks can't be removed.
      </p>
      <div className="task-status-list">
        {options.map((option, index) => (
          <div key={option.id} className="task-status-row waiting-on-row">
            <input
              aria-label={`Name for waiting-on option ${index + 1}`}
              value={option.label}
              maxLength={WAITING_ON_LIMITS.maxLabel}
              onChange={e => onChange(options.map(o => (o.id === option.id ? { ...o, label: e.target.value } : o)))}
            />
            <span className="waiting-on-role">
              {option.done ? 'Marks the task done' : option.id === defaultId ? 'Default for new tasks' : ''}
            </span>
            <div className="waiting-on-actions">
              <button
                type="button"
                className="secondary compact"
                aria-label={`Move ${option.label || 'option'} up`}
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                ↑
              </button>
              <button
                type="button"
                className="secondary compact"
                aria-label={`Move ${option.label || 'option'} down`}
                disabled={index === options.length - 1}
                onClick={() => move(index, 1)}
              >
                ↓
              </button>
              {!option.done && (
                <button
                  type="button"
                  className="secondary compact"
                  onClick={() => onChange(options.filter(o => o.id !== option.id))}
                >
                  Remove
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="integration-actions">
        <input
          aria-label="New waiting-on option"
          value={draft}
          maxLength={WAITING_ON_LIMITS.maxLabel}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add()
            }
          }}
          placeholder="New option, e.g. Vendor"
        />
        <button type="button" className="secondary" disabled={!canAdd} onClick={add}>
          Add option
        </button>
      </div>
    </div>
  )
}

export default function PlatformSettings({
  organizationId,
  organizationName,
}: {
  organizationId: string
  organizationName: string
}) {
  const [system, setSystem] = useState<any>(null),
    [account, setAccount] = useState<any>(null)
  const [taskSettings, setTaskSettings] = useState<TaskSettings | null>(null),
    [newStatus, setNewStatus] = useState('')
  const [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false)
  const load = async () => {
    setSystem(await settingsRequest('/api/internal-admin/system'))
    if (organizationId) {
      const result = await settingsRequest(`/api/internal-admin/organizations/${organizationId}/system`)
      setAccount(result)
      setTaskSettings(withWaitingOn(result.taskSettings))
    }
  }
  useEffect(() => {
    let active = true
    setAccount(null)
    setTaskSettings(null)
    setMessage('')
    void Promise.all([
      settingsRequest('/api/internal-admin/system'),
      organizationId
        ? settingsRequest(`/api/internal-admin/organizations/${organizationId}/system`)
        : Promise.resolve(null),
    ])
      .then(([s, a]) => {
        if (active) {
          setSystem(s)
          setAccount(a)
          setTaskSettings(withWaitingOn(a?.taskSettings))
        }
      })
      .catch(e => {
        if (active) setMessage(e.message)
      })
    return () => {
      active = false
    }
  }, [organizationId])
  const run = async (fn: () => Promise<any>) => {
    setBusy(true)
    setMessage('')
    try {
      const result = await fn()
      await load()
      setMessage(result.message || 'Completed successfully.')
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Request failed.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="panel platform-settings">
      <div className="panel-heading">
        <div>
          <h2>Platform settings</h2>
          <p>Database sync and account configuration.</p>
        </div>
        <span className="version-badge">v{system?.version || '…'}</span>
      </div>
      {message && (
        <p className="settings-message" role="status">
          {message}
        </p>
      )}
      <div className="platform-settings-grid">
        <section>
          <h3>Database & credential storage</h3>
          <p>
            {system?.databaseProvider || 'Database'}: {system?.databaseConfigured ? 'Configured' : 'Not configured'}
          </p>
          <p>Integration tables: {system?.integrationsReady ? 'Ready' : 'Setup required'}</p>
          <p>Encryption key: {system?.encryptionReady ? 'Configured' : 'Setup required'}</p>
          <small>
            The server uses DATABASE_URL and TENANT_INTEGRATION_MASTER_KEY. Keep these infrastructure secrets
            server-side.
          </small>
        </section>
      </div>
      <h3>{organizationName ? `${organizationName} — account configuration` : 'Choose an account above'}</h3>
      {organizationId && (
        <>
          <section>
            <h4>Database Sync</h4>
            <p>
              Last normalized sync:{' '}
              {account?.sync?.syncedAt ? new Date(account.sync.syncedAt).toLocaleString() : 'No sync recorded'}
            </p>
            <button
              className="secondary"
              disabled={busy || !account?.sync?.ready}
              onClick={() =>
                void run(() => settingsRequest('/api/data-architecture/migrate', 'POST', { organizationId }))
              }
            >
              Migrate / Sync selected account
            </button>
          </section>
          <section>
            <h4>Integration health</h4>
            {['discord', 'openai'].map(kind => {
              const row = system?.health?.find(
                (r: any) => r.tenant_id === organizationId && r.integration_type === kind,
              )
              return (
                <p key={kind}>
                  {kind === 'discord' ? 'Discord' : 'AI'}:{' '}
                  {row ? `${row.is_enabled ? 'Enabled' : 'Disabled'} · ${row.connection_status}` : 'Not configured'}
                </p>
              )
            })}
          </section>
          {(system?.legacy?.discord || system?.legacy?.openai) && (
            <section>
              <h4>Import existing Render credentials</h4>
              <p>
                Import into <b>{organizationName}</b> as disabled credentials. Existing account credentials cannot be
                overwritten.
              </p>
              <div className="integration-actions">
                {(['discord', 'openai'] as const)
                  .filter(kind => system.legacy[kind])
                  .map(kind => (
                    <button
                      className="secondary"
                      key={kind}
                      disabled={busy}
                      onClick={() => {
                        if (
                          window.confirm(
                            `Import the old ${kind} credential into ${organizationName}? It will be saved disabled.`,
                          )
                        )
                          void run(() =>
                            settingsRequest(
                              `/api/internal-admin/organizations/${organizationId}/import-legacy/${kind}`,
                              'POST',
                            ),
                          )
                      }}
                    >
                      Import {kind === 'discord' ? 'Discord' : 'AI'}
                    </button>
                  ))}
              </div>
              <small>
                Test and enable from that account’s Settings, then remove the old provider variables from Render.
              </small>
            </section>
          )}
          {taskSettings && (
            <section>
              <h4>Task configuration</h4>
              <p>Changes apply to {organizationName}. Users should reload their workspace after changes.</p>
              <div className="task-status-list">
                {taskSettings.statuses.map(status => (
                  <div key={status.id} className="task-status-row">
                    <strong>{status.label}</strong>
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={status.closed}
                        onChange={e =>
                          setTaskSettings({
                            ...taskSettings,
                            statuses: taskSettings.statuses.map(s =>
                              s.id === status.id ? { ...s, closed: e.target.checked } : s,
                            ),
                          })
                        }
                      />{' '}
                      Completed
                    </label>
                    <button
                      className="secondary"
                      onClick={() =>
                        setTaskSettings({
                          ...taskSettings,
                          statuses: taskSettings.statuses.filter(s => s.id !== status.id),
                        })
                      }
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
              <div className="integration-actions">
                <input
                  aria-label="New task status"
                  value={newStatus}
                  onChange={e => setNewStatus(e.target.value)}
                  placeholder="New status"
                />
                <button
                  className="secondary"
                  disabled={!newStatus.trim()}
                  onClick={() => {
                    setTaskSettings({
                      ...taskSettings,
                      statuses: [
                        ...taskSettings.statuses,
                        { id: crypto.randomUUID(), label: newStatus.trim(), closed: false },
                      ],
                    })
                    setNewStatus('')
                  }}
                >
                  Add status
                </button>
              </div>
              <WaitingOnEditor
                options={taskSettings.waitingOn || []}
                onChange={waitingOn => setTaskSettings({ ...taskSettings, waitingOn })}
              />
              <h5>Visible task columns</h5>
              <div className="module-check-grid">
                {columns.map(([key, label]) => (
                  <label key={key} className="checkbox-label">
                    <input
                      type="checkbox"
                      disabled={key === 'status'}
                      checked={taskSettings.visibleColumns.includes(key)}
                      onChange={e =>
                        setTaskSettings({
                          ...taskSettings,
                          visibleColumns: e.target.checked
                            ? [...taskSettings.visibleColumns, key]
                            : taskSettings.visibleColumns.filter(k => k !== key),
                        })
                      }
                    />
                    {label}
                  </label>
                ))}
              </div>
              {waitingOnProblem(taskSettings.waitingOn || []) && (
                <p className="settings-message" role="alert">
                  {waitingOnProblem(taskSettings.waitingOn || [])}
                </p>
              )}
              <button
                className="primary"
                disabled={busy || Boolean(waitingOnProblem(taskSettings.waitingOn || []))}
                onClick={() =>
                  void run(async () => {
                    const result = await settingsRequest(
                      `/api/internal-admin/organizations/${organizationId}/task-settings`,
                      'PUT',
                      {
                        ...taskSettings,
                        waitingOn: (taskSettings.waitingOn || []).map(option => ({
                          ...option,
                          label: option.label.trim(),
                        })),
                      },
                    )
                    return {
                      ...result,
                      message: result.renamedTasks
                        ? `Task configuration saved. ${result.renamedTasks} task${result.renamedTasks === 1 ? '' : 's'} moved to the renamed waiting-on option${result.renamedTasks === 1 ? '' : 's'}.`
                        : 'Task configuration saved.',
                    }
                  })
                }
              >
                Save task configuration
              </button>
            </section>
          )}
        </>
      )}
    </div>
  )
}
