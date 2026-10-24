import { useMemo, useState } from 'react'
import type { Tracker, TrackerColumn, TrackerRow } from './trackerModel'
import { shown, type Lookup } from './trackerQuery'
import { Dialog, plural } from './trackerUi'
import ClientSelect, { SearchSelect } from '../../shared/ui/SearchSelect'
import { trackerClients, type TaskDraft, type WorkTools } from './TrackerWork'
import {
  choicesFromOrder,
  choicesFromSheet,
  reviewCounts,
  reviewGroups,
  sameChoice,
  setChoice,
  taskAbove,
  willCreate,
  type Choice,
  type Choices,
} from './trackerReviewPlan'

export type { Choice } from './trackerReviewPlan'
export type ReviewOutcome = {
  rowTasks: { rowId: string; taskId: string }[]
  cellLinks: { rowId: string; columnId: string; taskId: string }[]
  reviewed: string[]
}

type Props = {
  tracker: Tracker
  rows: TrackerRow[]
  /** Every loaded row of the tracker, to find the task row a Sheet row belongs to. */
  allRows?: TrackerRow[]
  lookup: Lookup
  tools: WorkTools
  /** Where the rows came from, for the title. */
  origin: 'sheet' | 'import'
  onClose: () => void
  /** Links rows and cells to what was created, and marks rows reviewed. */
  onApply: (outcome: ReviewOutcome) => Promise<void>
}

type RuleTarget = 'task' | 'above' | 'skip' | 'later'
const NEW_PROJECT = '__new__'
const short = (text: string, max = 32) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/**
 * Reviews new rows (from a connected Sheet or an import) as a list of tasks with their subtasks under them. Rows start
 * grouped the way the Sheet or file groups them; untick what should stay a plain row, or change a row with its menu.
 * Nothing is created until Create is pressed.
 */
export default function TrackerReview({ tracker, rows, allRows, lookup, tools, origin, onClose, onApply }: Props) {
  const columns = tracker.columns
  const textColumns = columns.filter(column =>
    ['text', 'longtext', 'number', 'date', 'select', 'link', 'person'].includes(column.type),
  )
  const open = rows.filter(row => !row.taskId)
  const firstText = (row: TrackerRow) => (columns[0] ? shown(columns[0], row, lookup).text.trim() : '')

  const [initialChoices] = useState<Choices>(() => {
    if (!tools.onCreate) return {}
    return origin === 'sheet'
      ? choicesFromSheet(open, allRows ?? rows)
      : choicesFromOrder(open.map(row => ({ id: row.id, name: firstText(row) })))
  })
  const [choices, setChoices] = useState(initialChoices)
  const [skipped, setSkipped] = useState<Set<string>>(new Set())
  const [titleColumn, setTitleColumn] = useState(textColumns[0]?.id || '')
  // Rows under a task usually leave the name column blank, so their subtask title comes from another column.
  const [subTitleColumn, setSubTitleColumn] = useState(() =>
    bestTitleColumn(
      textColumns.filter(column => column.id !== titleColumn),
      open.filter(row => initialChoices[row.id] && initialChoices[row.id].kind !== 'task'),
      lookup,
    ),
  )
  const [titles, setTitles] = useState<Record<string, string>>({})
  const own = trackerClients(tracker).filter(id => tools.clients.some(client => client.id === id))
  const [clientId, setClientId] = useState(own.length === 1 ? own[0] : '')
  const [projectId, setProjectId] = useState(tracker.projectId || '')
  const [projectName, setProjectName] = useState('')
  const [subColumns, setSubColumns] = useState<Set<string>>(new Set())
  const [ruleColumn, setRuleColumn] = useState(textColumns[0]?.id || '')
  const [ruleOp, setRuleOp] = useState<'is' | 'contains' | 'empty' | 'filled'>('is')
  const [ruleValue, setRuleValue] = useState('')
  const [ruleTarget, setRuleTarget] = useState<RuleTarget>('task')
  const [ruleNote, setRuleNote] = useState('')
  const [picking, setPicking] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const isSubtask = (row: TrackerRow) => Boolean(choices[row.id] && choices[row.id].kind !== 'task')
  // The chosen title column, or when that cell is blank, the row's first filled text cell.
  const titleFrom = (row: TrackerRow) => {
    const column = columns.find(item => item.id === (isSubtask(row) && subTitleColumn ? subTitleColumn : titleColumn))
    const value = column ? shown(column, row, lookup).text.trim() : ''
    if (value) return value
    for (const other of textColumns) {
      const text = shown(other, row, lookup).text.trim()
      if (text) return text
    }
    return ''
  }
  const titleOf = (row: TrackerRow) => (titles[row.id] ?? titleFrom(row)) || 'Untitled row'
  const rowById = useMemo(() => new Map(rows.map(row => [row.id, row])), [rows])
  const itemNames = useMemo(() => new Map(tools.items.map(item => [item.id, item.title])), [tools.items])
  const parentName = (choice: Choice) =>
    choice.kind === 'subtask'
      ? itemNames.get(choice.parentTaskId) || 'a task'
      : choice.kind === 'subtask_new'
        ? titleOf(rowById.get(choice.parentRowId)!)
        : ''

  const groups = useMemo(() => reviewGroups(rows, choices), [rows, choices])
  const counts = reviewCounts(open, choices, skipped, subColumns.size)
  const anySubtask = open.some(isSubtask)
  const newProject = counts.tasks > 0 && projectId === NEW_PROJECT && projectName.trim() ? 1 : 0

  const otherTasks = useMemo(
    () => [
      { value: '', label: 'Choose the task it belongs to' },
      ...open
        .filter(row => choices[row.id]?.kind === 'task')
        .map(row => ({ value: `row:${row.id}`, label: titleOf(row), hint: 'New, from this list' })),
      ...tools.items
        .filter(item => !item.parentTaskId && !tools.isClosed(item.status))
        .map(item => ({
          value: `task:${item.id}`,
          label: item.title,
          hint: tools.clients.find(client => client.id === item.clientId)?.name,
        })),
    ],
    [open, choices, titles, titleColumn, tools.items, tools.clients, tools.isClosed],
  )

  const unskip = (ids: string[]) =>
    setSkipped(current => {
      const next = new Set(current)
      for (const id of ids) next.delete(id)
      return next
    })
  const skip = (ids: string[]) => setSkipped(current => new Set([...current, ...ids]))

  /** The row menu. */
  const choose = (row: TrackerRow, value: string) => {
    setError('')
    setPicking('')
    if (value === 'other') return setPicking(row.id)
    if (value === 'skip') return skip([row.id])
    unskip([row.id])
    if (value === 'current') return
    if (value === 'later') return setChoices(current => setChoice(rows, current, row.id, null))
    if (value === 'task') return setChoices(current => setChoice(rows, current, row.id, { kind: 'task' }))
    if (value === 'above') {
      const above = taskAbove(rows, row.id, choices, skipped)
      if (above) setChoices(current => setChoice(rows, current, row.id, above))
    }
  }
  const pickOther = (row: TrackerRow, value: string) => {
    if (!value) return
    const [kind, id] = [value.slice(0, value.indexOf(':')), value.slice(value.indexOf(':') + 1)]
    const choice: Choice =
      kind === 'row' ? { kind: 'subtask_new', parentRowId: id } : { kind: 'subtask', parentTaskId: id }
    setChoices(current => setChoice(rows, current, row.id, choice))
    unskip([row.id])
    setPicking('')
  }

  /** Ticking a task ticks its subtasks too; ticking a subtask ticks its task. */
  const toggleGroup = (head: string, children: string[], on: boolean) =>
    on ? unskip([head, ...children]) : skip([head, ...children])
  const toggleChild = (id: string, on: boolean) => {
    if (!on) return skip([id])
    const choice = choices[id]
    unskip(choice?.kind === 'subtask_new' ? [id, choice.parentRowId] : [id])
  }

  const matches = (row: TrackerRow) => {
    const column = columns.find(item => item.id === ruleColumn)
    if (!column) return false
    const text = shown(column, row, lookup).text.trim().toLowerCase(),
      wanted = ruleValue.trim().toLowerCase()
    return ruleOp === 'empty'
      ? !text
      : ruleOp === 'filled'
        ? Boolean(text)
        : ruleOp === 'is'
          ? text === wanted
          : Boolean(wanted) && text.includes(wanted)
  }
  const applyRule = () => {
    const hits = open.filter(matches)
    setRuleNote(hits.length ? `${plural(hits.length, 'row')} changed.` : 'No row matches.')
    if (!hits.length) return
    const ids = hits.map(row => row.id)
    if (ruleTarget === 'skip') return skip(ids)
    unskip(ids)
    setChoices(current => {
      let next = current
      for (const row of hits) {
        const choice: Choice | null =
          ruleTarget === 'task'
            ? { kind: 'task' }
            : ruleTarget === 'above'
              ? taskAbove(rows, row.id, next, skipped)
              : null
        if (ruleTarget === 'above' && !choice) continue
        next = setChoice(rows, next, row.id, choice)
      }
      return next
    })
  }

  const create = async () => {
    if (busy) return
    if (counts.tasks && !clientId) return setError('Choose the client for the new tasks.')
    if (counts.tasks && projectId === NEW_PROJECT && !projectName.trim())
      return setError('Name the new project, or choose an existing one.')
    if (counts.tasks + counts.subtasks + counts.plain === 0) return setError('Nothing to create or save yet.')
    setBusy(true)
    setError('')
    try {
      const drafts: TaskDraft[] = [],
        draftOfRow = new Map<string, number>(),
        rowOfDraft: ({ rowId: string; columnId?: string } | null)[] = []
      const push = (draft: TaskDraft, link: { rowId: string; columnId?: string } | null) => {
        drafts.push(draft)
        rowOfDraft.push(link)
        return drafts.length - 1
      }
      const making = open.filter(row => willCreate(row.id, choices, skipped))
      const taskRows = making.filter(row => choices[row.id].kind === 'task')
      for (const row of taskRows)
        draftOfRow.set(
          row.id,
          push(
            {
              title: titleOf(row),
              clientId,
              projectId: projectId === NEW_PROJECT ? '' : projectId,
              newProjectName: projectId === NEW_PROJECT ? projectName.trim() : undefined,
            },
            { rowId: row.id },
          ),
        )
      for (const row of taskRows)
        for (const columnId of subColumns)
          push(
            {
              title: columns.find(column => column.id === columnId)?.name || 'Subtask',
              clientId: '',
              projectId: '',
              parentIndex: draftOfRow.get(row.id),
            },
            { rowId: row.id, columnId },
          )
      for (const row of making) {
        const choice = choices[row.id]
        if (choice.kind === 'subtask_new')
          push(
            { title: titleOf(row), clientId: '', projectId: '', parentIndex: draftOfRow.get(choice.parentRowId) },
            { rowId: row.id },
          )
        if (choice.kind === 'subtask')
          push(
            { title: titleOf(row), clientId: '', projectId: '', parentTaskId: choice.parentTaskId },
            { rowId: row.id },
          )
      }
      const made = drafts.length ? await tools.onCreate!(drafts) : []
      const outcome: ReviewOutcome = {
        rowTasks: [],
        cellLinks: [],
        reviewed: open.filter(row => choices[row.id] || skipped.has(row.id)).map(row => row.id),
      }
      made.forEach((item, at) => {
        const link = rowOfDraft[at]
        if (!link) return
        if (link.columnId) outcome.cellLinks.push({ rowId: link.rowId, columnId: link.columnId, taskId: item.id })
        else outcome.rowTasks.push({ rowId: link.rowId, taskId: item.id })
      })
      await onApply(outcome)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The tasks could not be created.')
      setBusy(false)
    }
  }
  const leaveAllPlain = async () => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await onApply({ rowTasks: [], cellLinks: [], reviewed: open.map(row => row.id) })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That could not be saved.')
      setBusy(false)
    }
  }

  const summary = [
    counts.tasks && plural(counts.tasks, 'task'),
    counts.subtasks && plural(counts.subtasks, 'subtask'),
    newProject && '1 new project',
  ]
    .filter(Boolean)
    .join(', ')

  /** One line of the list: tick, title, where it came from, and what it becomes. */
  const line = (row: TrackerRow, role: 'head' | 'child' | 'loose', children: string[] = []) => {
    if (row.taskId)
      return (
        <div className="trk-rv-line done" key={row.id}>
          <span />
          <span className="trk-rv-title">{titleOf(row)}</span>
          <span className="trk-muted">Already linked to {lookup.task(row.taskId)?.title || 'a task'}</span>
        </div>
      )
    const choice = choices[row.id]
    const off = skipped.has(row.id)
    const above = taskAbove(rows, row.id, choices, skipped)
    const value = off
      ? 'skip'
      : !choice
        ? 'later'
        : choice.kind === 'task'
          ? 'task'
          : sameChoice(choice, above)
            ? 'above'
            : 'current'
    const source = firstText(row)
    return (
      <div
        className={`trk-rv-line ${role}${off ? ' off' : ''}${!choice && !off ? ' later' : ''}`}
        key={row.id}
        data-row={row.id}
      >
        <span>
          {choice && tools.onCreate ? (
            <input
              type="checkbox"
              className="trk-review-tick"
              checked={!off}
              aria-label={`Create ${titleOf(row)}`}
              onChange={event =>
                role === 'head'
                  ? toggleGroup(row.id, children, event.target.checked)
                  : toggleChild(row.id, event.target.checked)
              }
            />
          ) : null}
        </span>
        <span className="trk-rv-title">
          {role === 'child' && (
            <span className="trk-rv-branch" aria-hidden="true">
              ↳
            </span>
          )}
          {choice && !off ? (
            <input
              aria-label={`Title for ${titleOf(row)}`}
              value={titleOf(row)}
              onChange={event => setTitles(current => ({ ...current, [row.id]: event.target.value }))}
            />
          ) : (
            <span className="trk-rv-plain">{titleOf(row)}</span>
          )}
          {source && source !== titleOf(row) && role !== 'head' && (
            <small className="trk-muted">{short(source, 24)}</small>
          )}
        </span>
        <span className="trk-rv-becomes">
          <select
            aria-label={`What ${titleOf(row)} becomes`}
            value={value}
            disabled={!tools.onCreate && value !== 'skip' && value !== 'later'}
            onChange={event => choose(row, event.target.value)}
          >
            {tools.onCreate && <option value="task">Task</option>}
            {tools.onCreate && above && <option value="above">Subtask of “{short(parentName(above))}”</option>}
            {choice && value === 'current' && <option value="current">Subtask of “{short(parentName(choice))}”</option>}
            {tools.onCreate && <option value="other">Subtask of another task…</option>}
            <option value="skip">Keep as a row</option>
            <option value="later">Decide later</option>
          </select>
          {picking === row.id && (
            <span className="trk-rv-pick">
              <SearchSelect
                choices={otherTasks}
                value=""
                onChange={next => pickOther(row, next)}
                placeholder="Type a task name"
                empty="No open task matches"
                aria-label={`Task for ${titleOf(row)}`}
              />
              <button type="button" className="trk-button" onClick={() => setPicking('')}>
                Cancel
              </button>
            </span>
          )}
        </span>
      </div>
    )
  }

  return (
    <Dialog
      title={origin === 'sheet' ? 'New rows from the Sheet' : 'Create tasks from the imported rows'}
      eyebrow="Review"
      onClose={onClose}
      wide
      busy={busy}
    >
      <div className="trk-review">
        <p className="trk-strip">
          Rows with a name become <strong>tasks</strong>, and the rows under them become their <strong>subtasks</strong>
          . Untick anything that should stay a plain row, or change a row with its menu.
          {origin === 'sheet' ? ' Every row stays in the tracker either way.' : ''}
        </p>
        {!tools.onCreate && (
          <p className="trk-field-error">Your role cannot create tasks. You can still keep rows as plain rows.</p>
        )}

        {tools.onCreate && (
          <div className="trk-rv-setup" role="group" aria-label="For the new tasks">
            <label className="trk-field-block">
              Client
              <ClientSelect
                clients={own.length ? tools.clients.filter(client => own.includes(client.id)) : tools.clients}
                value={clientId}
                onChange={setClientId}
                extra={[{ value: '', label: 'Choose the client' }]}
                required
              />
            </label>
            <label className="trk-field-block">
              Project
              <select value={projectId} onChange={event => setProjectId(event.target.value)}>
                <option value="">No project</option>
                {[...tools.projects]
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map(project => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                <option value={NEW_PROJECT}>+ New project…</option>
              </select>
              {projectId === NEW_PROJECT && (
                <input
                  aria-label="New project name"
                  value={projectName}
                  maxLength={120}
                  placeholder="For example: Sta. Rosa roll-out"
                  onChange={event => setProjectName(event.target.value)}
                />
              )}
            </label>
            <label className="trk-field-block">
              Task name from
              <select
                value={titleColumn}
                onChange={event => {
                  setTitleColumn(event.target.value)
                  setTitles({})
                }}
              >
                {textColumns.map(column => (
                  <option key={column.id} value={column.id}>
                    {column.name}
                  </option>
                ))}
              </select>
            </label>
            {anySubtask && (
              <label className="trk-field-block">
                Subtask name from
                <select
                  value={subTitleColumn}
                  onChange={event => {
                    setSubTitleColumn(event.target.value)
                    setTitles(current =>
                      Object.fromEntries(Object.entries(current).filter(([id]) => !isSubtask(rowById.get(id)!))),
                    )
                  }}
                >
                  {textColumns.map(column => (
                    <option key={column.id} value={column.id}>
                      {column.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        )}

        <div className="trk-rv-listbar">
          <strong>{plural(open.length, 'new row')}</strong>
          {tools.onCreate && (
            <>
              <button type="button" className="trk-link-button" onClick={() => unskip(open.map(row => row.id))}>
                Tick all
              </button>
              <button
                type="button"
                className="trk-link-button"
                onClick={() => skip(open.filter(row => choices[row.id]).map(row => row.id))}
              >
                Untick all
              </button>
            </>
          )}
        </div>
        <ul className="trk-rv-list" aria-label="Rows to review">
          {groups.map(group =>
            group.kind === 'loose' ? (
              <li className="trk-rv-group" key={group.rowId}>
                {line(rowById.get(group.rowId)!, 'loose')}
              </li>
            ) : group.kind === 'new' ? (
              <li className="trk-rv-group" key={group.rowId}>
                {line(rowById.get(group.rowId)!, 'head', group.children)}
                {group.children.map(id => line(rowById.get(id)!, 'child'))}
              </li>
            ) : (
              <li className="trk-rv-group" key={`task:${group.taskId}`}>
                <div className="trk-rv-existing">
                  Under the existing task <strong>{itemNames.get(group.taskId) || 'a task'}</strong>
                </div>
                {group.children.map(id => line(rowById.get(id)!, 'child'))}
              </li>
            ),
          )}
        </ul>

        {tools.onCreate && (
          <details className="trk-rv-more">
            <summary>More options</summary>
            <div className="trk-field-block">
              <span>Change several rows at once</span>
              <span className="trk-review-rule">
                <span>Rows where</span>
                <select
                  aria-label="Rule column"
                  value={ruleColumn}
                  onChange={event => setRuleColumn(event.target.value)}
                >
                  {columns
                    .filter(column => !['secret', 'formula'].includes(column.type))
                    .map(column => (
                      <option key={column.id} value={column.id}>
                        {column.name}
                      </option>
                    ))}
                </select>
                <select
                  aria-label="Rule"
                  value={ruleOp}
                  onChange={event => setRuleOp(event.target.value as typeof ruleOp)}
                >
                  <option value="is">is</option>
                  <option value="contains">contains</option>
                  <option value="filled">is not empty</option>
                  <option value="empty">is empty</option>
                </select>
                {(ruleOp === 'is' || ruleOp === 'contains') && (
                  <input
                    aria-label="Rule value"
                    value={ruleValue}
                    onChange={event => setRuleValue(event.target.value)}
                    placeholder="Value"
                  />
                )}
                <span>become</span>
                <select
                  aria-label="Rows become"
                  value={ruleTarget}
                  onChange={event => setRuleTarget(event.target.value as RuleTarget)}
                >
                  <option value="task">Tasks</option>
                  <option value="above">Subtasks of the task above</option>
                  <option value="skip">Plain rows</option>
                  <option value="later">Decide later</option>
                </select>
                <button type="button" className="trk-button" onClick={applyRule}>
                  Apply
                </button>
                {ruleNote && (
                  <span className="trk-muted" role="status">
                    {ruleNote}
                  </span>
                )}
              </span>
            </div>
            <div className="trk-field-block">
              <span>Also give every new task a subtask for each of these columns</span>
              <span className="trk-review-cols">
                {columns
                  .filter(
                    (column: TrackerColumn) =>
                      column.id !== columns[0]?.id && column.type !== 'secret' && column.type !== 'formula',
                  )
                  .map(column => (
                    <label key={column.id} className="trk-checkline">
                      <input
                        type="checkbox"
                        checked={subColumns.has(column.id)}
                        onChange={event =>
                          setSubColumns(current => {
                            const next = new Set(current)
                            if (event.target.checked) next.add(column.id)
                            else next.delete(column.id)
                            return next
                          })
                        }
                      />{' '}
                      {column.name}
                    </label>
                  ))}
              </span>
              <small className="trk-muted-text">
                Each subtask is named after its column, and its status shows in that cell.
              </small>
            </div>
          </details>
        )}

        {error && (
          <p className="trk-field-error" role="alert">
            {error}
          </p>
        )}
        <div className="k-dialog-actions">
          {origin === 'sheet' && (
            <button
              type="button"
              className="trk-button"
              disabled={busy || !open.length}
              onClick={() => void leaveAllPlain()}
              title="Keep every row as a plain row and clear this list"
            >
              Leave all as plain rows
            </button>
          )}
          <span className="trk-spacer" />
          <span className="trk-muted-text" role="status">
            {summary ? `Creates ${summary}.` : 'Nothing to create yet.'}
            {counts.plain ? ` ${plural(counts.plain, 'row')} stay plain.` : ''}
            {counts.later ? ` ${plural(counts.later, 'row')} left for later.` : ''}
          </span>
          <button type="button" className="trk-button" disabled={busy} onClick={onClose}>
            Later
          </button>
          <button
            type="button"
            className="trk-button primary"
            disabled={busy || counts.tasks + counts.subtasks + counts.plain === 0}
            onClick={() => void create()}
          >
            {busy ? 'Creating…' : summary ? `Create ${summary}` : 'Save'}
          </button>
        </div>
      </div>
    </Dialog>
  )
}

/** The column most often filled on these rows, with the longest text as the tie-break: usually a ticket title. */
function bestTitleColumn(columns: TrackerColumn[], rows: TrackerRow[], lookup: Lookup) {
  let best = columns[0]?.id || '',
    bestScore = -1
  for (const column of columns) {
    const texts = rows.map(row => shown(column, row, lookup).text.trim()).filter(Boolean)
    const average = texts.length ? texts.reduce((sum, text) => sum + text.length, 0) / texts.length : 0
    const score = texts.length * 1000 + Math.min(average, 999)
    if (score > bestScore) {
      best = column.id
      bestScore = score
    }
  }
  return best
}
