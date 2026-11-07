/**
 * The workflow editor: statuses, waiting-on options, visible task columns, and the names of priorities and client
 * health. Used by each account's Administrator (Settings › Workflow) and by Internal Admin for any account.
 */
import { ArrowDown, ArrowUp } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { TaskSettings, WaitingOnDefinition } from '../../shared/types'
import { WAITING_ON_LIMITS, waitingOnOptions } from '../tasks/waitingOn'
import { HEALTHS, PRIORITIES, TASK_COLUMNS, WORKFLOW_LIMITS, type WorkflowLabels } from '../tasks/workflow'

export type WorkflowUsage = { statuses: Record<string, number>; waitingOn: Record<string, number> }
export type WorkflowSave = TaskSettings & { statusMoves: Record<string, string> }

export function waitingOnProblem(options: WaitingOnDefinition[]) {
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
export function WaitingOnEditor({
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

function statusProblem(statuses: TaskSettings['statuses']) {
  if (statuses.some(status => !status.label.trim())) return 'Every status needs a name.'
  const labels = statuses.map(status => status.label.trim().toLowerCase())
  if (new Set(labels).size !== labels.length) return 'Status names must be unique.'
  if (!statuses.some(status => !status.closed)) return 'Keep at least one status that is not done.'
  if (!statuses.some(status => status.closed)) return 'Keep at least one status that marks work as done.'
  return ''
}

export function WorkflowEditor({
  initial,
  usage,
  busy,
  onSave,
}: {
  initial: TaskSettings
  usage?: WorkflowUsage
  busy: boolean
  onSave: (input: WorkflowSave) => void
}) {
  const [settings, setSettings] = useState<TaskSettings>({ ...initial, waitingOn: waitingOnOptions(initial) })
  const [moves, setMoves] = useState<Record<string, string>>({})
  const [newStatus, setNewStatus] = useState('')
  const used = (label: string) => usage?.statuses?.[label] || 0
  const removed = initial.statuses.filter(
    status => used(status.label) && !settings.statuses.some(kept => kept.id === status.id),
  )
  const labels: WorkflowLabels = settings.labels || {}
  const setLabel = (kind: 'priority' | 'health', key: string, value: string) =>
    setSettings({ ...settings, labels: { ...labels, [kind]: { ...(labels[kind] || {}), [key]: value } } })
  const moveStatus = (index: number, by: number) => {
    const statuses = [...settings.statuses]
    const target = index + by
    if (target < 0 || target >= statuses.length) return
    ;[statuses[index], statuses[target]] = [statuses[target], statuses[index]]
    setSettings({ ...settings, statuses })
  }
  const problem =
    statusProblem(settings.statuses) ||
    waitingOnProblem(settings.waitingOn || []) ||
    (removed.some(status => !settings.statuses.some(kept => kept.id === moves[status.id]))
      ? 'Choose where the tasks of each removed status move.'
      : '')

  return (
    <div className="workflow-editor">
      <h5>Task statuses</h5>
      <p>
        Renaming a status updates every task that uses it. Tick Done for statuses that mean the work is finished. A
        status that tasks still use can be removed once you choose where those tasks move.
      </p>
      <div className="task-status-list">
        {settings.statuses.map((status, index) => (
          <div key={status.id} className="task-status-row">
            <input
              aria-label="Status name"
              value={status.label}
              maxLength={WORKFLOW_LIMITS.maxStatusLabel}
              onChange={e =>
                setSettings({
                  ...settings,
                  statuses: settings.statuses.map(s => (s.id === status.id ? { ...s, label: e.target.value } : s)),
                })
              }
            />
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={status.closed}
                onChange={e =>
                  setSettings({
                    ...settings,
                    statuses: settings.statuses.map(s => (s.id === status.id ? { ...s, closed: e.target.checked } : s)),
                  })
                }
              />{' '}
              Done
            </label>
            <small>{used(initial.statuses.find(s => s.id === status.id)?.label || '') || 0} tasks</small>
            <button type="button" className="icon-button" aria-label="Move up" onClick={() => moveStatus(index, -1)}>
              <ArrowUp size={15} />
            </button>
            <button type="button" className="icon-button" aria-label="Move down" onClick={() => moveStatus(index, 1)}>
              <ArrowDown size={15} />
            </button>
            <button
              type="button"
              className="secondary"
              disabled={settings.statuses.length <= 2}
              onClick={() => setSettings({ ...settings, statuses: settings.statuses.filter(s => s.id !== status.id) })}
            >
              Remove
            </button>
          </div>
        ))}
      </div>
      {removed.map(status => (
        <label key={status.id} className="workflow-move">
          Move the {used(status.label)} task{used(status.label) === 1 ? '' : 's'} in “{status.label}” to
          <select value={moves[status.id] || ''} onChange={e => setMoves({ ...moves, [status.id]: e.target.value })}>
            <option value="">Choose a status…</option>
            {settings.statuses.map(target => (
              <option key={target.id} value={target.id}>
                {target.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="link-button"
            onClick={() => setSettings({ ...settings, statuses: [...settings.statuses, status] })}
          >
            Keep it instead
          </button>
        </label>
      ))}
      <div className="integration-actions">
        <input
          aria-label="New task status"
          value={newStatus}
          maxLength={WORKFLOW_LIMITS.maxStatusLabel}
          onChange={e => setNewStatus(e.target.value)}
          placeholder="New status"
        />
        <button
          type="button"
          className="secondary"
          disabled={!newStatus.trim() || settings.statuses.length >= WORKFLOW_LIMITS.maxStatuses}
          onClick={() => {
            setSettings({
              ...settings,
              statuses: [...settings.statuses, { id: crypto.randomUUID(), label: newStatus.trim(), closed: false }],
            })
            setNewStatus('')
          }}
        >
          Add status
        </button>
      </div>

      <WaitingOnEditor
        options={settings.waitingOn || []}
        onChange={waitingOn => setSettings({ ...settings, waitingOn })}
      />

      <h5>Visible task columns</h5>
      <div className="module-check-grid">
        {TASK_COLUMNS.filter(([key]) => key !== 'startDate').map(([key, label]) => (
          <label key={key} className="checkbox-label">
            <input
              type="checkbox"
              disabled={key === 'status'}
              checked={settings.visibleColumns.includes(key)}
              onChange={e =>
                setSettings({
                  ...settings,
                  visibleColumns: e.target.checked
                    ? [...settings.visibleColumns, key]
                    : settings.visibleColumns.filter(k => k !== key),
                })
              }
            />
            {label}
          </label>
        ))}
      </div>

      <h5>Names for priorities and client health</h5>
      <p>Only the names change; the order and colours stay. Leave a box empty to use the built-in name.</p>
      <div className="workflow-labels">
        {PRIORITIES.map(value => (
          <label key={value}>
            Priority: {value}
            <input
              value={labels.priority?.[value] || ''}
              placeholder={value}
              maxLength={WORKFLOW_LIMITS.maxLabel}
              onChange={e => setLabel('priority', value, e.target.value)}
            />
          </label>
        ))}
        {HEALTHS.map(value => (
          <label key={value}>
            Health: {value}
            <input
              value={labels.health?.[value] || ''}
              placeholder={value}
              maxLength={WORKFLOW_LIMITS.maxLabel}
              onChange={e => setLabel('health', value, e.target.value)}
            />
          </label>
        ))}
      </div>

      {problem && (
        <p className="settings-message" role="alert">
          {problem}
        </p>
      )}
      <button
        type="button"
        className="primary"
        disabled={busy || Boolean(problem)}
        onClick={() =>
          onSave({
            ...settings,
            statuses: settings.statuses.map(status => ({ ...status, label: status.label.trim() })),
            waitingOn: (settings.waitingOn || []).map(option => ({ ...option, label: option.label.trim() })),
            statusMoves: moves,
          })
        }
      >
        Save workflow
      </button>
    </div>
  )
}

export function workflowSavedMessage(result: { renamedTasks?: number; movedTasks?: number }) {
  const parts = [
    result.renamedTasks ? `${result.renamedTasks} task${result.renamedTasks === 1 ? '' : 's'} renamed` : '',
    result.movedTasks ? `${result.movedTasks} moved` : '',
  ].filter(Boolean)
  return `Workflow saved.${parts.length ? ` ${parts.join(', ')}.` : ''} Others see it after their next refresh.`
}

/** Settings › Workflow for this account's Administrator. */
export function AccountWorkflow({
  request,
}: {
  request: (url: string, method?: string, body?: unknown) => Promise<any>
}) {
  const [view, setView] = useState<{ taskSettings: TaskSettings; usage: WorkflowUsage } | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [version, setVersion] = useState(0)
  const load = async () => {
    setView(await request('/api/account/workflow'))
    setVersion(current => current + 1)
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: load once when the page opens
  useEffect(() => {
    void load().catch(error => setMessage(error instanceof Error ? error.message : 'Workflow could not be loaded.'))
  }, [])
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>Workflow</h2>
          <p>Your account’s task statuses, waiting-on options, task columns and names for priorities and health.</p>
        </div>
      </div>
      {view ? (
        <WorkflowEditor
          key={version}
          initial={view.taskSettings}
          usage={view.usage}
          busy={busy}
          onSave={input => {
            setBusy(true)
            setMessage('')
            void request('/api/account/workflow', 'PUT', input)
              .then(async result => {
                await load()
                setMessage(workflowSavedMessage(result))
              })
              .catch(error => setMessage(error instanceof Error ? error.message : 'Workflow could not be saved.'))
              .finally(() => setBusy(false))
          }}
        />
      ) : (
        !message && <p>Loading workflow…</p>
      )}
      {message && (
        <p className="settings-message" role="status">
          {message}
        </p>
      )}
    </section>
  )
}
