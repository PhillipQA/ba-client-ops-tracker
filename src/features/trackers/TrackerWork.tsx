import { useMemo, useState, type RefObject } from 'react'
import { ExternalLink, Plus, Search, Unlink } from 'lucide-react'
import type { Tracker, TrackerColumn, TrackerRow } from './trackerModel'
import { Dialog, Pill, Popover, plural } from './trackerUi'
import type { WorkItem } from '../../shared/types'
import ClientSelect from '../../shared/ui/SearchSelect'

/** What a tracker needs to create tasks and subtasks. They are saved with the rest of the workspace. */
export type TaskDraft = {
  title: string
  clientId: string
  projectId: string
  parentTaskId?: string
  /** A project to create (by name) for this task; an existing project with the same name is used instead. */
  newProjectName?: string
  /** A subtask of a task created earlier in the same batch: the index of that draft. */
  parentIndex?: number
}
export type WorkTools = {
  items: WorkItem[]
  clients: { id: string; name: string }[]
  projects: { id: string; name: string }[]
  /** True when a status counts as closed or resolved in this account's task settings. */
  isClosed: (status: string) => boolean
  /** Present when this person may create tasks. Resolves once the workspace is saved, with the new items in order. */
  onCreate?: (drafts: TaskDraft[]) => Promise<WorkItem[]>
  onOpenTask?: (taskId: string) => void
}

export const trackerClients = (tracker: Tracker) =>
  tracker.clientIds?.length ? tracker.clientIds : tracker.clientId ? [tracker.clientId] : []
const doneTone = (closed: boolean) => (closed ? ('green' as const) : ('gray' as const))

/** Client and project for a new task: the tracker's clients first (picked automatically when there is one). */
function useTaskContext(tracker: Tracker, tools: WorkTools) {
  const own = trackerClients(tracker).filter(id => tools.clients.some(client => client.id === id))
  const choices = own.length ? tools.clients.filter(client => own.includes(client.id)) : tools.clients
  const [clientId, setClientId] = useState(own.length === 1 ? own[0] : '')
  const [projectId, setProjectId] = useState(
    tracker.projectId && tools.projects.some(project => project.id === tracker.projectId) ? tracker.projectId : '',
  )
  const fields = (
    <>
      <label className="trk-field-block">
        Client
        {own.length === 1 ? (
          <input value={choices[0]?.name || ''} readOnly disabled />
        ) : (
          <ClientSelect
            clients={choices}
            value={clientId}
            onChange={setClientId}
            extra={[{ value: '', label: 'Choose the client' }]}
            required
            aria-label="Client"
          />
        )}
      </label>
      <label className="trk-field-block">
        Project
        <select value={projectId} onChange={event => setProjectId(event.target.value)}>
          <option value="">No project</option>
          {tools.projects.map(project => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </label>
    </>
  )
  return { clientId, projectId, fields, ready: Boolean(clientId) }
}

type PickerProps = {
  anchor: RefObject<HTMLElement | null>
  tracker: Tracker
  row: TrackerRow
  column: TrackerColumn
  /** The first column holds the row's task; every other column can hold one subtask of it. */
  mode: 'task' | 'subtask'
  rowTitle: string
  /** The subtask already in this cell, if any. */
  current?: string
  tools: WorkTools
  onClose: () => void
  onPickTask: (taskId: string | null) => Promise<void>
  onPickSubtask: (taskId: string | null) => Promise<void>
  onSwitchToTask: () => void
}

/** Picks or creates the row's task (first column) or a subtask of it (any other cell). Closed work is never offered. */
export function TrackerWorkPicker(props: PickerProps) {
  const { tracker, row, column, mode, tools } = props
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const [title, setTitle] = useState(
    mode === 'task' ? (props.rowTitle === 'Untitled row' ? '' : props.rowTitle) : column.name,
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const context = useTaskContext(tracker, tools)
  const byId = useMemo(() => new Map(tools.items.map(item => [item.id, item])), [tools.items])
  const task = row.taskId ? byId.get(row.taskId) : undefined
  const current = mode === 'task' ? task : props.current ? byId.get(props.current) : undefined
  const own = trackerClients(tracker)
  const clientName = (id?: string) => tools.clients.find(client => client.id === id)?.name || ''

  const options = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    const pool =
      mode === 'task'
        ? tools.items.filter(item => !item.parentTaskId)
        : tools.items.filter(item => item.parentTaskId && item.parentTaskId === row.taskId)
    const rank = (item: WorkItem) =>
      (own.length && !own.includes(item.clientId || '') ? 2 : 0) +
      (tracker.projectId && item.projectId !== tracker.projectId ? 1 : 0)
    return pool
      .filter(item => item.id !== current?.id && !tools.isClosed(item.status))
      .filter(item =>
        words.every(word => `${item.title} ${item.status} ${clientName(item.clientId)}`.toLowerCase().includes(word)),
      )
      .sort(
        (a, b) => rank(a) - rank(b) || (a.subtaskOrder ?? 0) - (b.subtaskOrder ?? 0) || a.title.localeCompare(b.title),
      )
      .slice(0, 50)
  }, [tools.items, query, mode, row.taskId, current?.id, own.join(','), tracker.projectId])

  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try {
      await action()
      props.onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That could not be saved.')
      setBusy(false)
    }
  }
  const create = () =>
    run(async () => {
      if (!tools.onCreate) throw new Error('Your role cannot create tasks.')
      const name = title.trim()
      if (!name) throw new Error(mode === 'task' ? 'Enter a title for the task.' : 'Enter a title for the subtask.')
      if (mode === 'task') {
        if (!context.ready) throw new Error('Choose the client for this task.')
        const [made] = await tools.onCreate([{ title: name, clientId: context.clientId, projectId: context.projectId }])
        await props.onPickTask(made.id)
      } else {
        if (!task) throw new Error('Pick the row’s task first.')
        const [made] = await tools.onCreate([
          { title: name, clientId: task.clientId || '', projectId: task.projectId || '', parentTaskId: task.id },
        ])
        await props.onPickSubtask(made.id)
      }
    })

  const label = mode === 'task' ? 'Task' : 'Subtask'
  return (
    <Popover
      anchor={props.anchor}
      onClose={props.onClose}
      className="trk-picker wide trk-work-pop"
      label={`${label} for ${column.name}`}
      minWidth={380}
    >
      <div className="trk-work-head">
        <strong>{mode === 'task' ? `Task for “${props.rowTitle}”` : `${column.name} · subtask`}</strong>
        <small>
          {mode === 'task'
            ? 'The row’s task. Its subtasks go in the other columns.'
            : task
              ? `Under ${task.title}`
              : 'This row has no task yet.'}
        </small>
      </div>

      {mode === 'subtask' && !task && (
        <div className="trk-work-empty">
          <p>
            Every cell’s subtask sits under the row’s task, so pick or create the task first, in the row’s first column.
          </p>
          <button type="button" className="trk-button primary" onClick={props.onSwitchToTask}>
            Choose the row’s task
          </button>
        </div>
      )}

      {(mode === 'task' || task) && (
        <>
          {current && (
            <div className="trk-work-current">
              <span className="trk-task-line">
                <strong>{current.title}</strong>
                <small>
                  {[clientName(current.clientId), current.followUpDate ? `Follow-up ${current.followUpDate}` : '']
                    .filter(Boolean)
                    .join(' · ')}
                </small>
              </span>
              <Pill tone={doneTone(tools.isClosed(current.status))}>
                {tools.isClosed(current.status) ? `Done · ${current.status}` : current.status}
              </Pill>
              {tools.onOpenTask && (
                <button
                  type="button"
                  className="trk-icon-button small"
                  title="Open"
                  aria-label={`Open ${current.title}`}
                  onClick={() => {
                    tools.onOpenTask!(current.id)
                    props.onClose()
                  }}
                >
                  <ExternalLink size={13} />
                </button>
              )}
              <button
                type="button"
                className="trk-icon-button small"
                title="Remove from this cell"
                aria-label="Remove from this cell"
                disabled={busy}
                onClick={() => void run(() => (mode === 'task' ? props.onPickTask(null) : props.onPickSubtask(null)))}
              >
                <Unlink size={13} />
              </button>
            </div>
          )}

          {!creating && (
            <>
              <label className="trk-picker-find">
                <Search size={14} aria-hidden="true" />
                <input
                  autoFocus
                  placeholder={mode === 'task' ? 'Search open tasks' : `Search open subtasks of ${task?.title}`}
                  value={query}
                  onChange={event => setQuery(event.target.value)}
                  aria-label={mode === 'task' ? 'Search open tasks' : 'Search open subtasks'}
                />
              </label>
              <div className="trk-picker-list">
                {options.map(item => (
                  <button
                    type="button"
                    key={item.id}
                    data-item
                    disabled={busy}
                    onClick={() =>
                      void run(() => (mode === 'task' ? props.onPickTask(item.id) : props.onPickSubtask(item.id)))
                    }
                  >
                    <span className="trk-task-line">
                      <strong>{item.title}</strong>
                      <small>
                        {[
                          clientName(item.clientId),
                          item.status,
                          item.followUpDate ? `Follow-up ${item.followUpDate}` : '',
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </small>
                    </span>
                  </button>
                ))}
                {!options.length && (
                  <p className="trk-picker-empty">
                    {query
                      ? 'Nothing open matches.'
                      : mode === 'task'
                        ? 'No open tasks to pick.'
                        : 'This task has no other open subtasks.'}
                  </p>
                )}
              </div>
              {tools.onCreate && (
                <button
                  type="button"
                  className="trk-text-button strong trk-work-create"
                  onClick={() => {
                    setCreating(true)
                    setError('')
                  }}
                >
                  <Plus size={13} aria-hidden="true" /> Create a new{' '}
                  {mode === 'task' ? 'task' : `subtask “${column.name}”`}
                </button>
              )}
            </>
          )}

          {creating && (
            <form
              className="trk-work-form"
              onSubmit={event => {
                event.preventDefault()
                void create()
              }}
            >
              <label className="trk-field-block">
                {label} title
                <input
                  autoFocus
                  value={title}
                  maxLength={200}
                  onChange={event => setTitle(event.target.value)}
                  required
                />
              </label>
              {mode === 'task' ? (
                context.fields
              ) : (
                <p className="trk-muted-text">It goes under {task?.title}, with the same client and project.</p>
              )}
              <div className="k-dialog-actions">
                <span className="trk-spacer" />
                <button type="button" className="trk-button" disabled={busy} onClick={() => setCreating(false)}>
                  Back
                </button>
                <button type="submit" className="trk-button primary" disabled={busy}>
                  {busy ? 'Creating…' : `Create ${label.toLowerCase()}`}
                </button>
              </div>
            </form>
          )}
        </>
      )}
      {error && (
        <p className="trk-field-error" role="alert">
          {error}
        </p>
      )}
    </Popover>
  )
}

/** Creates a task for each chosen row that has none, titled from the row, after showing what will be created. */
export function TrackerBulkTasks({
  tracker,
  rows,
  titleOf,
  tools,
  onClose,
  onDone,
}: {
  tracker: Tracker
  rows: TrackerRow[]
  titleOf: (row: TrackerRow) => string
  tools: WorkTools
  onClose: () => void
  onDone: (links: { rowId: string; taskId: string }[]) => Promise<void>
}) {
  const context = useTaskContext(tracker, tools)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const todo = rows.filter(row => !row.taskId)
  const named = todo.filter(row => titleOf(row) !== 'Untitled row')
  const skipped = rows.length - named.length
  const submit = async () => {
    if (!tools.onCreate || !named.length) return
    if (!context.ready) return setError('Choose the client for these tasks.')
    setBusy(true)
    setError('')
    try {
      const made = await tools.onCreate(
        named.map(row => ({ title: titleOf(row), clientId: context.clientId, projectId: context.projectId })),
      )
      await onDone(named.map((row, at) => ({ rowId: row.id, taskId: made[at].id })))
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The tasks could not be created.')
      setBusy(false)
    }
  }
  return (
    <Dialog title="Create tasks for these rows" eyebrow="Tasks" onClose={onClose} busy={busy}>
      <div className="trk-form">
        <p>
          {named.length ? (
            <>
              This creates <strong>{plural(named.length, 'task')}</strong>, one per row, titled from the row’s first
              column, and links each row to its task.
            </>
          ) : (
            'Every chosen row already has a task or has no name in its first column.'
          )}
          {skipped > 0 && (
            <>
              {' '}
              {plural(skipped, 'row')} {skipped === 1 ? 'is' : 'are'} skipped because{' '}
              {skipped === 1 ? 'it has' : 'they have'} a task already or no name.
            </>
          )}
        </p>
        {named.length > 0 && (
          <ul className="trk-bulk-preview" aria-label="Tasks to create">
            {named.slice(0, 50).map(row => (
              <li key={row.id}>{titleOf(row)}</li>
            ))}
            {named.length > 50 && <li className="trk-muted">…and {named.length - 50} more</li>}
          </ul>
        )}
        {named.length > 0 && context.fields}
        {error && (
          <p className="trk-field-error" role="alert">
            {error}
          </p>
        )}
        <div className="k-dialog-actions">
          <span className="trk-spacer" />
          <button type="button" className="trk-button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="trk-button primary"
            disabled={busy || !named.length || !tools.onCreate}
            onClick={() => void submit()}
          >
            {busy ? 'Creating…' : `Create ${plural(named.length, 'task')}`}
          </button>
        </div>
      </div>
    </Dialog>
  )
}
