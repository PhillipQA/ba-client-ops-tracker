import { useMemo, useState } from 'react'
import type { Tracker, TrackerColumn, TrackerRow } from './trackerModel'
import { shown, type Lookup } from './trackerQuery'
import { Dialog, plural } from './trackerUi'
import ClientSelect, { SearchSelect } from './shared/ui/SearchSelect'
import { trackerClients, type TaskDraft, type WorkTools } from './TrackerWork'

/** What a reviewed row becomes. */
export type Choice = { kind: 'task' } | { kind: 'subtask'; parentTaskId: string } | { kind: 'subtask_new'; parentRowId: string } | { kind: 'plain' }
export type ReviewOutcome = { rowTasks: { rowId: string; taskId: string }[]; cellLinks: { rowId: string; columnId: string; taskId: string }[]; reviewed: string[] }

type Props = {
  tracker: Tracker
  rows: TrackerRow[]
  lookup: Lookup
  tools: WorkTools
  /** Where the rows came from, for the title. */
  origin: 'sheet' | 'import'
  onClose: () => void
  /** Links rows and cells to what was created, and marks rows reviewed. */
  onApply: (outcome: ReviewOutcome) => Promise<void>
}

const describe = (choice: Choice | undefined, rows: Map<string, string>, items: Map<string, string>) => {
  if (!choice) return 'Not decided'
  if (choice.kind === 'task') return 'New task'
  if (choice.kind === 'plain') return 'Plain row'
  if (choice.kind === 'subtask') return `Subtask of ${items.get(choice.parentTaskId) || 'a task'}`
  return `Subtask of “${rows.get(choice.parentRowId) || 'a new task'}”`
}

/**
 * Reviews new rows (from a connected Sheet or an import): each ticked row becomes a new task, a subtask of an existing
 * task, a subtask of a new task from the same list, or stays a plain row. Nothing is created until Create is pressed.
 */
export default function TrackerReview({ tracker, rows, lookup, tools, origin, onClose, onApply }: Props) {
  const columns = tracker.columns
  const textColumns = columns.filter(column => ['text', 'longtext', 'number', 'date', 'select', 'link', 'person'].includes(column.type))
  const [titleColumn, setTitleColumn] = useState(textColumns[0]?.id || '')
  const titleFrom = (row: TrackerRow) => { const column = columns.find(item => item.id === titleColumn); return column ? shown(column, row, lookup).text.trim() : '' }
  const open = rows.filter(row => !row.taskId)
  const [ticked, setTicked] = useState<Set<string>>(new Set())
  const [choices, setChoices] = useState<Record<string, Choice>>({})
  const [titles, setTitles] = useState<Record<string, string>>({})
  const [ruleColumn, setRuleColumn] = useState(textColumns[0]?.id || '')
  const [ruleOp, setRuleOp] = useState<'is' | 'contains' | 'empty' | 'filled'>('is')
  const [ruleValue, setRuleValue] = useState('')
  const own = trackerClients(tracker).filter(id => tools.clients.some(client => client.id === id))
  const [clientId, setClientId] = useState(own.length === 1 ? own[0] : '')
  const [projectMode, setProjectMode] = useState<'existing' | 'new'>('existing')
  const [projectId, setProjectId] = useState(tracker.projectId || '')
  const [projectName, setProjectName] = useState('')
  const [subColumns, setSubColumns] = useState<Set<string>>(new Set())
  const [parentPick, setParentPick] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const titleOf = (row: TrackerRow) => (titles[row.id] ?? titleFrom(row)) || 'Untitled row'
  const rowNames = useMemo(() => new Map(rows.map(row => [row.id, titleOf(row)])), [rows, titles, titleColumn])
  const itemNames = useMemo(() => new Map(tools.items.map(item => [item.id, item.title])), [tools.items])
  const taskRows = open.filter(row => choices[row.id]?.kind === 'task')
  const openTasks = useMemo(() => [{ value: '', label: 'Choose the task they belong to' }, ...tools.items.filter(item => !item.parentTaskId && !tools.isClosed(item.status)).map(item => ({ value: item.id, label: item.title, hint: tools.clients.find(client => client.id === item.clientId)?.name }))], [tools.items, tools.clients, tools.isClosed])

  const matches = (row: TrackerRow) => {
    const column = columns.find(item => item.id === ruleColumn)
    if (!column) return false
    const text = shown(column, row, lookup).text.trim().toLowerCase(), wanted = ruleValue.trim().toLowerCase()
    return ruleOp === 'empty' ? !text : ruleOp === 'filled' ? Boolean(text) : ruleOp === 'is' ? text === wanted : Boolean(wanted) && text.includes(wanted)
  }
  const tickRule = () => setTicked(new Set(open.filter(matches).map(row => row.id)))
  const toggle = (id: string) => setTicked(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next })
  const apply = (choice: Choice) => {
    if (!ticked.size) return setError('Tick the rows first.')
    setError('')
    setChoices(current => {
      const next = { ...current }
      for (const id of ticked) {
        if (choice.kind === 'subtask_new' && choice.parentRowId === id) continue
        next[id] = choice
      }
      // A row that stops being a task takes its subtasks back to "not decided".
      for (const [id, value] of Object.entries(next)) if (value.kind === 'subtask_new' && next[value.parentRowId]?.kind !== 'task') delete next[id]
      return next
    })
    setTicked(new Set())
  }

  const counts = useMemo(() => {
    const decided = Object.entries(choices).filter(([id]) => open.some(row => row.id === id))
    const tasks = decided.filter(([, c]) => c.kind === 'task').length
    const subtasks = decided.filter(([, c]) => c.kind === 'subtask' || c.kind === 'subtask_new').length + tasks * subColumns.size
    const plain = decided.filter(([, c]) => c.kind === 'plain').length
    const newProject = tasks > 0 && projectMode === 'new' && projectName.trim() ? 1 : 0
    return { tasks, subtasks, plain, newProject, undecided: open.length - decided.length }
  }, [choices, subColumns, projectMode, projectName, open])

  const create = async () => {
    if (busy) return
    if (counts.tasks && !clientId) return setError('Choose the client for the new tasks.')
    if (counts.tasks && projectMode === 'new' && !projectName.trim()) return setError('Name the new project, or choose an existing one.')
    if (counts.tasks + counts.subtasks + counts.plain === 0) return setError('Decide what at least one row becomes.')
    setBusy(true); setError('')
    try {
      const drafts: TaskDraft[] = [], draftOfRow = new Map<string, number>(), rowOfDraft: ({ rowId: string; columnId?: string } | null)[] = []
      const push = (draft: TaskDraft, link: { rowId: string; columnId?: string } | null) => { drafts.push(draft); rowOfDraft.push(link); return drafts.length - 1 }
      for (const row of taskRows) draftOfRow.set(row.id, push({ title: titleOf(row), clientId, projectId: projectMode === 'existing' ? projectId : '', newProjectName: projectMode === 'new' ? projectName.trim() : undefined }, { rowId: row.id }))
      for (const row of taskRows) for (const columnId of subColumns) push({ title: columns.find(column => column.id === columnId)?.name || 'Subtask', clientId: '', projectId: '', parentIndex: draftOfRow.get(row.id) }, { rowId: row.id, columnId })
      for (const row of open) {
        const choice = choices[row.id]
        if (choice?.kind === 'subtask_new' && draftOfRow.has(choice.parentRowId)) push({ title: titleOf(row), clientId: '', projectId: '', parentIndex: draftOfRow.get(choice.parentRowId) }, { rowId: row.id })
        if (choice?.kind === 'subtask') push({ title: titleOf(row), clientId: '', projectId: '', parentTaskId: choice.parentTaskId }, { rowId: row.id })
      }
      const made = drafts.length ? await tools.onCreate!(drafts) : []
      const outcome: ReviewOutcome = { rowTasks: [], cellLinks: [], reviewed: open.filter(row => choices[row.id]).map(row => row.id) }
      made.forEach((item, at) => {
        const link = rowOfDraft[at]
        if (!link) return
        if (link.columnId) outcome.cellLinks.push({ rowId: link.rowId, columnId: link.columnId, taskId: item.id })
        else outcome.rowTasks.push({ rowId: link.rowId, taskId: item.id })
      })
      await onApply(outcome)
      onClose()
    } catch (e) { setError(e instanceof Error ? e.message : 'The tasks could not be created.'); setBusy(false) }
  }
  const leaveAllPlain = async () => {
    if (busy) return
    setBusy(true); setError('')
    try { await onApply({ rowTasks: [], cellLinks: [], reviewed: open.map(row => row.id) }); onClose() }
    catch (e) { setError(e instanceof Error ? e.message : 'That could not be saved.'); setBusy(false) }
  }

  const summary = [counts.tasks && plural(counts.tasks, 'task'), counts.subtasks && plural(counts.subtasks, 'subtask'), counts.newProject && '1 new project'].filter(Boolean).join(', ')
  return <Dialog title={origin === 'sheet' ? 'New rows from the Sheet' : 'Create tasks from the imported rows'} eyebrow="Review" onClose={onClose} wide busy={busy}>
    <div className="trk-review">
      <p className="trk-muted-text">Tick rows, then choose what they become. Rows you do not decide on stay in this list for later{origin === 'sheet' ? ', and every row stays in the tracker either way' : ''}.</p>
      {!tools.onCreate && <p className="trk-field-error">Your role cannot create tasks. You can still mark rows as plain rows.</p>}

      <div className="trk-review-bar" role="group" aria-label="Tick rows">
        <button type="button" className="trk-button" onClick={() => setTicked(new Set(open.map(row => row.id)))}>Tick all</button>
        <button type="button" className="trk-button" onClick={() => setTicked(new Set())}>Untick all</button>
        <span className="trk-review-rule">
          <span>or tick rows where</span>
          <select aria-label="Rule column" value={ruleColumn} onChange={event => setRuleColumn(event.target.value)}>{columns.filter(column => !['secret', 'formula'].includes(column.type)).map(column => <option key={column.id} value={column.id}>{column.name}</option>)}</select>
          <select aria-label="Rule" value={ruleOp} onChange={event => setRuleOp(event.target.value as typeof ruleOp)}><option value="is">is</option><option value="contains">contains</option><option value="filled">is not empty</option><option value="empty">is empty</option></select>
          {(ruleOp === 'is' || ruleOp === 'contains') && <input aria-label="Rule value" value={ruleValue} onChange={event => setRuleValue(event.target.value)} placeholder="Value" />}
          <button type="button" className="trk-button" onClick={tickRule}>Tick matching</button>
        </span>
      </div>

      <div className="trk-review-actions" role="group" aria-label="Make the ticked rows">
        <strong>{ticked.size ? `Make the ${plural(ticked.size, 'ticked row')}:` : 'Make the ticked rows:'}</strong>
        <button type="button" className="trk-button primary" disabled={!ticked.size || !tools.onCreate} onClick={() => apply({ kind: 'task' })}>New tasks</button>
        <span className="trk-review-parent">
          <SearchSelect choices={openTasks} value={parentPick} onChange={setParentPick} placeholder="Type an existing task" empty="No open task matches" aria-label="Existing task for subtasks" />
          <button type="button" className="trk-button" disabled={!ticked.size || !parentPick || !tools.onCreate} onClick={() => apply({ kind: 'subtask', parentTaskId: parentPick })}>Subtasks of this task</button>
        </span>
        {taskRows.length > 0 && <select aria-label="Subtasks of a new task in this list" value="" disabled={!ticked.size} onChange={event => { if (event.target.value) apply({ kind: 'subtask_new', parentRowId: event.target.value }) }}>
          <option value="">Subtasks of a new task here…</option>{taskRows.map(row => <option key={row.id} value={row.id}>{titleOf(row)}</option>)}</select>}
        <button type="button" className="trk-button" disabled={!ticked.size} onClick={() => apply({ kind: 'plain' })}>Plain rows</button>
      </div>

      <div className="trk-review-table" role="table" aria-label="Rows to review">
        <div role="row" className="trk-review-head"><span role="columnheader" /><span role="columnheader">Row</span><span role="columnheader">Title for its task or subtask</span><span role="columnheader">Becomes</span></div>
        {rows.map(row => {
          const done = Boolean(row.taskId), choice = choices[row.id]
          return <div role="row" key={row.id} className={`trk-review-row${ticked.has(row.id) ? ' ticked' : ''}${done ? ' done' : ''}`}>
            <span role="cell">{done ? null : <input type="checkbox" className="trk-review-tick" checked={ticked.has(row.id)} aria-label={`Tick ${rowNames.get(row.id)}`} onChange={() => toggle(row.id)} />}</span>
            <span role="cell" className="trk-review-name">{shown(columns[0], row, lookup).text || '—'}</span>
            <span role="cell">{done ? <span className="trk-muted">Already linked to {lookup.task(row.taskId)?.title || 'a task'}</span>
              : <input aria-label={`Title for ${rowNames.get(row.id)}`} value={titleOf(row)} disabled={!choice || choice.kind === 'plain'} onChange={event => setTitles(current => ({ ...current, [row.id]: event.target.value }))} />}</span>
            <span role="cell" className={`trk-review-becomes ${choice?.kind || 'none'}`}>{done ? 'Linked' : describe(choice, rowNames, itemNames)}</span>
          </div>
        })}
      </div>

      {counts.tasks > 0 && <fieldset className="trk-review-settings"><legend>For the new tasks</legend>
        <label className="trk-field-block">Client<ClientSelect clients={own.length ? tools.clients.filter(client => own.includes(client.id)) : tools.clients} value={clientId} onChange={setClientId} extra={[{ value: '', label: 'Choose the client' }]} required /></label>
        <div className="trk-field-block"><span>Project</span>
          <span className="trk-review-project">
            <label className="trk-radio"><input type="radio" name="review-project" checked={projectMode === 'existing'} onChange={() => setProjectMode('existing')} /> Existing</label>
            <label className="trk-radio"><input type="radio" name="review-project" checked={projectMode === 'new'} onChange={() => setProjectMode('new')} /> New project</label>
          </span>
          {projectMode === 'existing'
            ? <select aria-label="Project" value={projectId} onChange={event => setProjectId(event.target.value)}><option value="">No project</option>{[...tools.projects].sort((a, b) => a.name.localeCompare(b.name)).map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select>
            : <input aria-label="New project name" value={projectName} maxLength={120} placeholder="For example: Sta. Rosa roll-out" onChange={event => setProjectName(event.target.value)} />}
        </div>
        <label className="trk-field-block">Title comes from<select value={titleColumn} onChange={event => { setTitleColumn(event.target.value); setTitles({}) }}>{textColumns.map(column => <option key={column.id} value={column.id}>{column.name}</option>)}</select></label>
        <div className="trk-field-block"><span>Also give every new task a subtask for each of these columns</span>
          <span className="trk-review-cols">{columns.filter((column: TrackerColumn) => column.id !== columns[0]?.id && column.type !== 'secret' && column.type !== 'formula').map(column => <label key={column.id} className="trk-checkline">
            <input type="checkbox" checked={subColumns.has(column.id)} onChange={event => setSubColumns(current => { const next = new Set(current); if (event.target.checked) next.add(column.id); else next.delete(column.id); return next })} /> {column.name}</label>)}</span>
          <small className="trk-muted-text">Each subtask is named after its column, and its status shows in that cell.</small>
        </div>
      </fieldset>}

      {error && <p className="trk-field-error" role="alert">{error}</p>}
      <div className="k-dialog-actions">
        {origin === 'sheet' && <button type="button" className="trk-button" disabled={busy || !open.length} onClick={() => void leaveAllPlain()} title="Keep every row as a plain row and clear this list">Leave all as plain rows</button>}
        <span className="trk-spacer" />
        <span className="trk-muted-text" role="status">{summary ? `Creates ${summary}.` : 'Nothing to create yet.'}{counts.plain ? ` ${plural(counts.plain, 'row')} stay plain.` : ''}{counts.undecided ? ` ${plural(counts.undecided, 'row')} left for later.` : ''}</span>
        <button type="button" className="trk-button" disabled={busy} onClick={onClose}>Later</button>
        <button type="button" className="trk-button primary" disabled={busy || counts.tasks + counts.subtasks + counts.plain === 0} onClick={() => void create()}>{busy ? 'Creating…' : summary ? `Create ${summary}` : 'Save'}</button>
      </div>
    </div>
  </Dialog>
}
