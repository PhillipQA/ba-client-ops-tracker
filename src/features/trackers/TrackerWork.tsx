import { useMemo, useState, type RefObject } from 'react'
import { ExternalLink, Plus, Search, Unlink } from 'lucide-react'
import {
  taskFieldColumn,
  trackerClientIds,
  trackerProjectIds,
  type Tracker,
  type TrackerColumn,
  type TrackerRow,
} from './trackerModel'
import { projectForContract } from './trackerProjects'
import { cellText } from './trackerTasks'
import { Dialog, Pill, Popover, plural } from './trackerUi'
import type { WorkItem } from '../../shared/types'
import ClientSelect, { SearchSelect, type SearchChoice } from '../../shared/ui/SearchSelect'
import { seedsTaskNamed } from '../../shared/seeds'

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
  /** Optional: dates, a description and an assignee (subtasks take their task's assignee). */
  startDate?: string
  dueDate?: string
  description?: string
  assignedToUserId?: string
  /** Under a Seeds project: the Seeds task (Go Live, Meetings…) this task counts toward. */
  seedsTaskId?: string
}
export type WorkProject = {
  id: string
  name: string
  clientId?: string
  seedsId?: string
  contractNumber?: string
  beforeSeeds?: boolean
  seedsTasks?: { id: string; name: string; archived?: boolean }[]
  /** Closed in Seeds (resolved, completed…) or archived here: not offered for new work. */
  seedsArchived?: boolean
  archived?: boolean
}
export type WorkTools = {
  items: WorkItem[]
  clients: { id: string; name: string }[]
  projects: WorkProject[]
  /** True when a status counts as closed or resolved in this account's task settings. */
  isClosed: (status: string) => boolean
  /** Present when this person may create tasks. Resolves once the workspace is saved, with the new items in order. */
  onCreate?: (drafts: TaskDraft[]) => Promise<WorkItem[]>
  onOpenTask?: (taskId: string) => void
}

const doneTone = (closed: boolean) => (closed ? ('green' as const) : ('gray' as const))

/** Seeds projects (once Seeds is on, new work goes there by default), and whether there are any. */
export const seedsProjects = (projects: WorkProject[]) =>
  projects.filter(project => project.seedsId && !project.seedsArchived && !project.archived)
/** An open Seeds project: one completed in Seeds takes no new tasks. */
const isSeedsProject = (projects: WorkProject[], id?: string) =>
  Boolean(id) && projects.some(project => project.id === id && project.seedsId && !project.seedsArchived)

/** The project a row's Contract number column names (one of the tracker's projects, or of its clients'), if any. */
const contractProjectOf = (tracker: Tracker, projects: WorkProject[], row?: Pick<TrackerRow, 'cells'>) => {
  const column = row && taskFieldColumn(tracker.columns, 'contract')
  return column ? projectForContract(tracker, cellText(column, row.cells[column.id]), projects) : undefined
}

/**
 * Client and project for a new task. Once Seeds is on, new tasks go to a Seeds project by default (its client is the
 * Seeds parent, filled in), with an optional Seeds task; Before Seeds is still there to choose. Otherwise: the
 * tracker's clients first (picked automatically when there is one), and any project.
 */
function useTaskContext(
  tracker: Tracker,
  tools: WorkTools,
  row?: Pick<TrackerRow, 'cells'>,
  /** A project picked for the row (its Project chip): the task starts there. */
  startProjectId?: string,
) {
  const fromSeeds = seedsProjects(tools.projects)
  // A project picked on the row's chip wins; then a row whose contract number names a project starts on that project;
  // else the tracker's default project.
  const picked = startProjectId ? tools.projects.find(project => project.id === startProjectId) : undefined
  const byContract = picked || contractProjectOf(tracker, tools.projects, row)
  const startProject = byContract?.id || tracker.projectId
  const [target, setTarget] = useState<'seeds' | 'before'>(
    fromSeeds.length && !(byContract && !byContract.seedsId) ? 'seeds' : 'before',
  )
  const own = trackerClientIds(tracker).filter(id => tools.clients.some(client => client.id === id))
  const choices = own.length ? tools.clients.filter(client => own.includes(client.id)) : tools.clients
  const [clientId, setClientId] = useState(
    byContract && !byContract.seedsId && byContract.clientId && own.includes(byContract.clientId)
      ? byContract.clientId
      : own.length === 1
        ? own[0]
        : '',
  )
  const [projectId, setProjectId] = useState(
    startProject && tools.projects.some(project => project.id === startProject && !project.seedsId && !project.archived)
      ? startProject
      : '',
  )
  // The tracker's own Seeds project when it has one.
  const [seedsProjectId, setSeedsProjectId] = useState(
    isSeedsProject(tools.projects, startProject)
      ? startProject
      : isSeedsProject(tools.projects, tracker.projectId)
        ? tracker.projectId
        : '',
  )
  const [seedsTaskId, setSeedsTaskId] = useState('')
  const seedsProject = fromSeeds.find(project => project.id === seedsProjectId)
  const seedsClient = tools.clients.find(client => client.id === seedsProject?.clientId)
  const seedsTasks = (seedsProject?.seedsTasks || []).filter(task => !task.archived)
  const oldProjects = tools.projects.filter(project => !project.seedsId && !project.archived)

  // Projects to type into: the tracker's own first, each with its contract number and client.
  const mine = new Set(trackerProjectIds(tracker))
  const projectChoices = (list: WorkProject[]): SearchChoice[] => {
    const sorted = [...list].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }),
    )
    const choice = (project: WorkProject, group?: string): SearchChoice => ({
      value: project.id,
      label: project.name,
      hint: [project.contractNumber, tools.clients.find(client => client.id === project.clientId)?.name]
        .filter(Boolean)
        .join(' · '),
      group,
    })
    const own = sorted.filter(project => mine.has(project.id))
    if (!own.length) return sorted.map(project => choice(project))
    return [
      ...own.map(project => choice(project, "This tracker's projects")),
      ...sorted.filter(project => !mine.has(project.id)).map(project => choice(project, 'Other projects')),
    ]
  }
  const seedsFields = (
    <>
      <label className="trk-field-block">
        Seeds project
        <SearchSelect
          value={seedsProjectId}
          onChange={value => {
            setSeedsProjectId(value)
            setSeedsTaskId('')
          }}
          required
          aria-label="Seeds project"
          placeholder="Type a project, contract number or client"
          empty="No open Seeds project matches"
          choices={[{ value: '', label: 'Choose the Seeds project' }, ...projectChoices(fromSeeds)]}
        />
      </label>
      <label className="trk-field-block">
        Client
        <input value={seedsProject ? seedsClient?.name || 'No client in Seeds' : ''} readOnly disabled />
      </label>
      {seedsTasks.length > 0 && (
        <label className="trk-field-block">
          Seeds task
          <SearchSelect
            value={seedsTaskId}
            onChange={setSeedsTaskId}
            aria-label="Seeds task"
            placeholder="Type a Seeds task"
            empty="No Seeds task matches"
            choices={[
              { value: '', label: 'No Seeds task' },
              ...seedsTasks.map(task => ({ value: task.id, label: task.name })),
            ]}
          />
        </label>
      )}
    </>
  )
  const beforeFields = (
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
        <SearchSelect
          value={projectId}
          onChange={setProjectId}
          aria-label="Project"
          placeholder="Type a project"
          empty="No project matches"
          choices={[
            { value: '', label: 'No project' },
            ...projectChoices(fromSeeds.length ? oldProjects.filter(project => !project.archived) : tools.projects),
          ]}
        />
      </label>
    </>
  )
  const fields = fromSeeds.length ? (
    <>
      <div className="trk-field-block">
        Where
        <span className="trk-segmented" role="group" aria-label="Where the task goes">
          <button
            type="button"
            className={target === 'seeds' ? 'on' : undefined}
            aria-pressed={target === 'seeds'}
            onClick={() => setTarget('seeds')}
          >
            Seeds
          </button>
          <button
            type="button"
            className={target === 'before' ? 'on' : undefined}
            aria-pressed={target === 'before'}
            onClick={() => setTarget('before')}
          >
            Before Seeds
          </button>
        </span>
      </div>
      {target === 'seeds' ? seedsFields : beforeFields}
    </>
  ) : (
    beforeFields
  )
  if (target === 'seeds' && fromSeeds.length)
    return {
      target,
      clientId: seedsProject?.clientId || '',
      projectId: seedsProjectId,
      seedsTaskId: seedsTaskId || undefined,
      fields,
      ready: Boolean(seedsProject?.clientId),
      problem: seedsProject ? 'This Seeds project has no client in Seeds.' : 'Choose the Seeds project.',
    }
  return {
    target,
    clientId,
    projectId,
    seedsTaskId: undefined,
    fields,
    ready: Boolean(clientId),
    problem: 'Choose the client for this task.',
  }
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
  /** Task mode: a project picked on the row's Project chip. The picker opens on creating a task there. */
  startProjectId?: string
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
  const [creating, setCreating] = useState(mode === 'task' && Boolean(props.startProjectId) && Boolean(tools.onCreate))
  const [title, setTitle] = useState(
    mode === 'task' ? (props.rowTitle === 'Untitled row' ? '' : props.rowTitle) : column.name,
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const context = useTaskContext(tracker, tools, row, mode === 'task' ? props.startProjectId : undefined)
  const byId = useMemo(() => new Map(tools.items.map(item => [item.id, item])), [tools.items])
  const task = row.taskId ? byId.get(row.taskId) : undefined
  // A new subtask under a Seeds project: its Seeds task, matched from its name unless one is chosen.
  const subtaskSeedsTasks = (tools.projects.find(project => project.id === task?.projectId)?.seedsTasks || []).filter(
    option => !option.archived,
  )
  const [pickedSeedsTask, setPickedSeedsTask] = useState<string | null>(null)
  const subtaskSeedsTask = pickedSeedsTask ?? (seedsTaskNamed(subtaskSeedsTasks, title) || '')
  const current = mode === 'task' ? task : props.current ? byId.get(props.current) : undefined
  const own = trackerClientIds(tracker)
  const clientName = (id?: string) => tools.clients.find(client => client.id === id)?.name || ''

  const options = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    // A tracker with clients only offers their tasks; one without a client offers every task.
    const pool =
      mode === 'task'
        ? tools.items.filter(
            item =>
              !item.parentTaskId &&
              (!own.length || own.includes(item.clientId || '') || isSeedsProject(tools.projects, item.projectId)),
          )
        : tools.items.filter(item => item.parentTaskId && item.parentTaskId === row.taskId)
    const rank = (item: WorkItem) => (tracker.projectId && item.projectId !== tracker.projectId ? 1 : 0)
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
        if (!context.ready) throw new Error(context.problem)
        const [made] = await tools.onCreate([
          { title: name, clientId: context.clientId, projectId: context.projectId, seedsTaskId: context.seedsTaskId },
        ])
        await props.onPickTask(made.id)
      } else {
        if (!task) throw new Error('Pick the row’s task first.')
        const [made] = await tools.onCreate([
          {
            title: name,
            clientId: task.clientId || '',
            projectId: task.projectId || '',
            parentTaskId: task.id,
            ...(subtaskSeedsTask ? { seedsTaskId: subtaskSeedsTask } : {}),
          },
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
                        ? own.length
                          ? `No open tasks for ${own.map(clientName).filter(Boolean).join(', ') || 'this tracker’s client'}.`
                          : 'No open tasks to pick.'
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
                <>
                  <p className="trk-muted-text">It goes under {task?.title}, with the same client and project.</p>
                  {subtaskSeedsTasks.length > 0 && (
                    <label className="trk-field-block">
                      Seeds task
                      <SearchSelect
                        value={subtaskSeedsTask}
                        onChange={setPickedSeedsTask}
                        aria-label="Seeds task"
                        placeholder="Type a Seeds task"
                        empty="No Seeds task matches"
                        choices={[
                          { value: '', label: 'Same as the task' },
                          ...subtaskSeedsTasks.map(option => ({ value: option.id, label: option.name })),
                        ]}
                      />
                    </label>
                  )}
                </>
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
  // Into Seeds: rows on a Before Seeds task switch to the new Seeds task (the old one stays in Before Seeds).
  const taskOf = (row: TrackerRow) => tools.items.find(item => item.id === row.taskId)
  const switching = (row: TrackerRow) =>
    context.target === 'seeds' && Boolean(row.taskId) && !isSeedsProject(tools.projects, taskOf(row)?.projectId)
  const todo = rows.filter(row => !row.taskId || switching(row))
  const switches = todo.filter(switching).length
  const named = todo.filter(row => titleOf(row) !== 'Untitled row')
  const skipped = rows.length - named.length
  // A row whose contract number names a project (of the same kind, Seeds or Before Seeds) goes to that project.
  const placeOf = (row: TrackerRow) => {
    const project = contractProjectOf(tracker, tools.projects, row)
    if (!project || Boolean(project.seedsId) !== (context.target === 'seeds')) return undefined
    const clientId = project.clientId || (context.target === 'before' ? context.clientId : '')
    return clientId ? { project, clientId } : undefined
  }
  const byContract = named.filter(row => placeOf(row)).length
  const submit = async () => {
    if (!tools.onCreate || !named.length) return
    if (!context.ready && named.some(row => !placeOf(row))) return setError(context.problem)
    setBusy(true)
    setError('')
    try {
      const made = await tools.onCreate(
        named.map(row => {
          const place = placeOf(row)
          if (!place)
            return {
              title: titleOf(row),
              clientId: context.clientId,
              projectId: context.projectId,
              seedsTaskId: context.seedsTaskId,
            }
          return {
            title: titleOf(row),
            clientId: place.clientId,
            projectId: place.project.id,
            seedsTaskId: place.project.id === context.projectId ? context.seedsTaskId : undefined,
          }
        }),
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
              {switches > 0 && (
                <>
                  {' '}
                  {plural(switches, 'row')} {switches === 1 ? 'is' : 'are'} on a Before Seeds task and will switch to
                  the new Seeds task; the old task stays in Before Seeds.
                </>
              )}
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
            {named.slice(0, 50).map(row => {
              const place = placeOf(row)
              return (
                <li key={row.id}>
                  {titleOf(row)}
                  {place && <span className="trk-muted"> · {place.project.name}</span>}
                </li>
              )
            })}
            {named.length > 50 && <li className="trk-muted">…and {named.length - 50} more</li>}
          </ul>
        )}
        {byContract > 0 && (
          <p className="trk-muted-text">
            {plural(byContract, 'row')} {byContract === 1 ? 'goes' : 'go'} to the project whose contract number{' '}
            {byContract === 1 ? 'is' : 'are'} in the row (shown next to its name)
            {byContract < named.length ? '; the rest go to the project below.' : '.'}
          </p>
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
