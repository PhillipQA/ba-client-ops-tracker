import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { Copy, ExternalLink, Eye, EyeOff, ListChecks, LockKeyhole, Search, Trash2, X } from 'lucide-react'
import type { Cell, Tracker, TrackerColumn, TrackerRow } from './trackerModel'
import { cleanCell, isBasicType, isConnectedType } from './trackerModel'
import { rowTitle, shown, type Lookup } from './trackerQuery'
import { trackerApi, type TaskLink, type TrackerChange } from './trackerApi'
import { CellView, type Person } from './TrackerCells'
import { ColumnIcon, Pill, Popover, niceTime } from './trackerUi'
import type { WorkItem } from './types'

type Props = {
  tracker: Tracker
  row: TrackerRow
  lookup: Lookup
  people: Person[]
  items: WorkItem[]
  clientName: (clientId: string) => string
  canEdit: boolean
  isAdmin: boolean
  onClose: () => void
  onEdit: (row: TrackerRow, column: TrackerColumn, value: Cell) => void
  onSecret: (row: TrackerRow, column: TrackerColumn, value: string | null) => void
  onLink: (row: TrackerRow, taskId: string | null) => void
  onDelete: (row: TrackerRow) => void
  onOpenTask?: (taskId: string) => void
  /** Tasks and subtasks linked to this row or to one of its cells. */
  links: TaskLink[]
  onAddLink: (row: TrackerRow, taskId: string, columnId: string) => Promise<void>
  onRemoveLink: (link: TaskLink) => Promise<void>
  onReveal: (row: TrackerRow, column: TrackerColumn) => Promise<string>
}

/** What the history says happened, in words. Person cells hold account ids, which are shown as names. */
function describe(change: TrackerChange, columns: TrackerColumn[], people: Person[]) {
  const detail = change.detail || {}
  const name = (id: string) => people.find(person => person.id === id)?.name || id
  switch (change.kind) {
    case 'row_created': return 'added this row'
    case 'cells': return (detail.cells || []).map((cell: any) => {
      const column = columns.find(item => item.id === cell.columnId)
      const from = column?.type === 'person' && cell.from ? name(cell.from) : cell.from, to = column?.type === 'person' && cell.to ? name(cell.to) : cell.to
      return `changed ${cell.name} ${from ? `from “${from}” ` : ''}${to ? `to “${to}”` : 'to empty'}`
    }).join('; ')
    case 'secrets': return (detail.cells || []).map((cell: any) => `${cell.action === 'set' ? 'set' : 'cleared'} ${cell.name}`).join('; ')
    case 'reveal': return `revealed ${detail.name || 'a secret'}`
    case 'task_linked': return `linked the task “${detail.title || 'Untitled'}”`
    case 'task_unlinked': return 'unlinked the task'
    case 'subtask_linked': return `linked “${detail.title || 'a task'}”${detail.columnId ? ` to ${columns.find(item => item.id === detail.columnId)?.name || 'a cell'}` : ''}`
    case 'subtask_unlinked': return 'removed a task link'
    default: return change.kind.replace(/_/g, ' ')
  }
}

function Field({ column, row, people, canEdit, onEdit }: { column: TrackerColumn; row: TrackerRow; people: Person[]; canEdit: boolean; onEdit: (value: Cell) => void }) {
  const value = row.cells[column.id]
  const text = typeof value === 'string' ? value : typeof value === 'number' ? String(value) : ''
  const [draft, setDraft] = useState(text)
  const [error, setError] = useState('')
  const focused = useRef(false)
  useEffect(() => { if (!focused.current) setDraft(text) }, [text])
  const id = `trk-f-${column.id}`
  const commit = (raw: string) => {
    if (raw === text) { setError(''); return }
    const result = cleanCell(column, raw)
    if (!result.ok) { setError(result.error); return }
    setError(''); onEdit(result.value)
  }
  let control
  switch (column.type) {
    case 'longtext':
      control = <textarea id={id} rows={4} value={draft} disabled={!canEdit} onFocus={() => { focused.current = true }} onChange={event => setDraft(event.target.value)} onBlur={() => { focused.current = false; commit(draft) }} />
      break
    case 'checkbox':
      control = <label className="trk-checkline"><input id={id} type="checkbox" checked={value === true} disabled={!canEdit} onChange={event => onEdit(event.target.checked)} /> <span>{value === true ? 'Yes' : 'No'}</span></label>
      break
    case 'select':
      control = <select id={id} value={typeof value === 'string' ? value : ''} disabled={!canEdit} onChange={event => onEdit(event.target.value)}>
        <option value="">—</option>{(column.options || []).map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select>
      break
    case 'multiselect': {
      const chosen = new Set(Array.isArray(value) ? value : [])
      control = <div className="trk-checks" role="group" aria-labelledby={`${id}-label`}>
        {(column.options || []).map(option => <label key={option.id} className="trk-checkline"><input type="checkbox" checked={chosen.has(option.id)} disabled={!canEdit}
          onChange={event => { const next = new Set(chosen); if (event.target.checked) next.add(option.id); else next.delete(option.id); onEdit([...next]) }} /> <Pill tone={option.color}>{option.label}</Pill></label>)}
        {!column.options?.length && <span className="trk-muted">No options yet.</span>}
      </div>
      break
    }
    case 'person': {
      const id2 = typeof value === 'string' ? value : ''
      control = <select id={id} value={id2} disabled={!canEdit} onChange={event => onEdit(event.target.value)}>
        <option value="">—</option>
        {id2 && !people.some(person => person.id === id2) && <option value={id2}>Unknown user</option>}
        {[...people].sort((a, b) => a.name.localeCompare(b.name)).map(person => <option key={person.id} value={person.id}>{person.name}</option>)}
      </select>
      break
    }
    default:
      control = <input id={id} type={column.type === 'date' ? 'date' : 'text'} inputMode={column.type === 'number' ? 'decimal' : undefined} value={draft} disabled={!canEdit}
        onFocus={() => { focused.current = true }} onChange={event => { setDraft(event.target.value); if (column.type === 'date') commit(event.target.value) }}
        onBlur={() => { focused.current = false; if (column.type !== 'date') commit(draft) }}
        onKeyDown={event => { if (event.key === 'Enter') (event.target as HTMLInputElement).blur() }} />
  }
  return <div className={`trk-field${column.type === 'longtext' || column.type === 'multiselect' ? ' wide' : ''}`}>
    <label id={`${id}-label`} htmlFor={id}><ColumnIcon type={column.type} size={13} /> {column.name}</label>
    {control}
    {error && <p className="trk-field-error" role="alert">{error}</p>}
  </div>
}

function TaskPicker({ anchor, items, tracker, clientName, onPick, onClose, subtasks = false, taken }: { anchor: RefObject<HTMLElement | null>; items: WorkItem[]; tracker: Tracker; clientName: (id: string) => string; onPick: (id: string) => void; onClose: () => void; subtasks?: boolean; taken?: ReadonlySet<string> }) {
  const [query, setQuery] = useState('')
  const matches = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    const rank = (item: WorkItem) => (tracker.projectId && item.projectId === tracker.projectId ? 0 : 2) + (tracker.clientId && item.clientId === tracker.clientId ? 0 : 1)
    return items
      .filter(item => (subtasks || !item.parentTaskId) && !taken?.has(item.id) && words.every(word => `${item.title} ${item.status} ${clientName(item.clientId || '')}`.toLowerCase().includes(word)))
      .sort((a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title)).slice(0, 40)
  }, [items, query, tracker.clientId, tracker.projectId, clientName])
  return <Popover anchor={anchor} onClose={onClose} className="trk-picker wide" label="Choose a task" minWidth={360}>
    <label className="trk-picker-find"><Search size={14} aria-hidden="true" /><input autoFocus placeholder="Search tasks" value={query} onChange={event => setQuery(event.target.value)} aria-label="Search tasks" /></label>
    <div className="trk-picker-list">
      {matches.map(item => <button type="button" key={item.id} data-item onClick={() => onPick(item.id)}>
        <span className="trk-task-line"><strong>{item.title}</strong><small>{[item.parentTaskId ? `Subtask of ${items.find(other => other.id === item.parentTaskId)?.title || 'a task'}` : '', clientName(item.clientId || ''), item.status, item.followUpDate].filter(Boolean).join(' · ')}</small></span>
      </button>)}
      {!matches.length && <p className="trk-picker-empty">{items.length ? 'No task matches.' : 'There are no tasks yet.'}</p>}
    </div>
  </Popover>
}

/** Tasks and subtasks linked to this row, or to one cell of it. The Action Center shows them on their follow-up date. */
function TaskLinksCard({ props }: { props: Props }) {
  const { tracker, row, lookup, canEdit, links } = props
  const button = useRef<HTMLButtonElement>(null)
  const [picking, setPicking] = useState(false)
  const [columnId, setColumnId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const mine = links.filter(link => link.rowId === row.id)
  useEffect(() => { setPicking(false); setError('') }, [row.id])
  useEffect(() => { if (columnId && !tracker.columns.some(column => column.id === columnId)) setColumnId('') }, [columnId, tracker.columns])
  const taken = useMemo(() => new Set(mine.filter(link => link.columnId === columnId).map(link => link.taskId)), [mine, columnId])
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError('')
    try { await action() } catch (e) { setError(e instanceof Error ? e.message : 'That could not be saved.') } finally { setBusy(false) }
  }
  return <section className="trk-card" aria-label="Tasks and subtasks">
    <h3><ListChecks size={14} aria-hidden="true" /> Tasks and subtasks</h3>
    <p className="trk-muted-text">Link as many as you need to this row or to one cell. They show in the Action Center on their follow-up date.</p>
    {mine.length > 0 && <ul className="trk-link-list">
      {mine.map(link => {
        const task = lookup.task(link.taskId)
        const owner = task?.assignedToUserId ? lookup.person(task.assignedToUserId) : ''
        const when = task?.followUpDate || task?.dueDate || ''
        return <li key={link.id}>
          <span className="trk-task-line">
            <strong>{task ? task.title : 'A deleted task'}</strong>
            <small>{[task?.parentTaskId ? 'Subtask' : task ? 'Task' : '', task?.status, when ? `${task?.followUpDate ? 'Follow-up' : 'Due'} ${when}` : '', owner].filter(Boolean).join(' · ')}</small>
          </span>
          <span className="trk-link-where">{link.columnName ? link.columnName : 'Whole row'}</span>
          {task && <Pill tone={/^(done|complete|completed|closed|resolved)/i.test(task.status) ? 'green' : 'gray'}>{task.status}</Pill>}
          {task && props.onOpenTask && <button type="button" className="trk-icon-button small" aria-label={`Open ${task.title}`} title="Open task" onClick={() => props.onOpenTask!(task.id)}><ExternalLink size={13} /></button>}
          {canEdit && <button type="button" className="trk-icon-button small" aria-label={`Remove link to ${task ? task.title : 'deleted task'}`} title="Remove link" disabled={busy} onClick={() => void run(() => props.onRemoveLink(link))}><X size={13} /></button>}
        </li>
      })}
    </ul>}
    {!mine.length && <p className="trk-muted-text">Nothing linked yet.</p>}
    {canEdit && <div className="trk-link-add">
      <label><span>Applies to</span>
        <select value={columnId} onChange={event => setColumnId(event.target.value)} aria-label="Link applies to">
          <option value="">Whole row</option>
          {tracker.columns.map(column => <option key={column.id} value={column.id}>{column.name}</option>)}
        </select></label>
      <button type="button" className="trk-text-button strong" ref={button} disabled={busy} onClick={() => setPicking(true)}>Link a task or subtask</button>
    </div>}
    {error && <p className="trk-field-error" role="alert">{error}</p>}
    {picking && <TaskPicker anchor={button} items={props.items} tracker={tracker} clientName={props.clientName} subtasks taken={taken} onClose={() => setPicking(false)}
      onPick={id => { setPicking(false); void run(() => props.onAddLink(row, id, columnId)) }} />}
  </section>
}

export default function TrackerRowPanel(props: Props) {
  const { tracker, row, lookup, people, canEdit } = props
  const panel = useRef<HTMLElement>(null)
  const linkButton = useRef<HTMLButtonElement>(null)
  const [picking, setPicking] = useState(false)
  const [history, setHistory] = useState<TrackerChange[] | null>(null)
  const [historyError, setHistoryError] = useState('')
  const [revealed, setRevealed] = useState<Record<string, string>>({})
  const [secretDrafts, setSecretDrafts] = useState<Record<string, string>>({})
  const [secretNote, setSecretNote] = useState('')
  const [busyReveal, setBusyReveal] = useState('')
  const [bump, setBump] = useState(0)
  const timers = useRef(new Map<string, number>())

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    panel.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus()
    return () => { timers.current.forEach(timer => window.clearTimeout(timer)); timers.current.clear(); if (previous?.isConnected) previous.focus() }
  }, [])
  // Switching rows hides anything revealed.
  useEffect(() => { setRevealed({}); setSecretDrafts({}); setSecretNote(''); timers.current.forEach(timer => window.clearTimeout(timer)); timers.current.clear() }, [row.id])

  useEffect(() => {
    const controller = new AbortController()
    trackerApi.history(tracker.id, row.id, controller.signal)
      .then(result => { setHistory(result.changes); setHistoryError('') })
      .catch(error => { if (error?.name !== 'AbortError') setHistoryError('The history could not be loaded.') })
    return () => controller.abort()
  }, [tracker.id, row.id, row.version, bump])

  const task = row.taskId ? lookup.task(row.taskId) : undefined
  const basic = tracker.columns.filter(column => isBasicType(column.type))
  const connected = tracker.columns.filter(column => isConnectedType(column.type))
  const secrets = tracker.columns.filter(column => column.type === 'secret')
  const title = rowTitle(tracker.columns, row)

  const hide = (columnId: string) => {
    window.clearTimeout(timers.current.get(columnId)); timers.current.delete(columnId)
    setRevealed(current => { const next = { ...current }; delete next[columnId]; return next })
  }
  const reveal = async (column: TrackerColumn) => {
    setBusyReveal(column.id); setSecretNote('')
    try {
      const value = await props.onReveal(row, column)
      setRevealed(current => ({ ...current, [column.id]: value }))
      timers.current.set(column.id, window.setTimeout(() => hide(column.id), 30_000))
      setBump(count => count + 1)
    } catch (error) { setSecretNote(error instanceof Error ? error.message : 'Could not reveal this value.') }
    finally { setBusyReveal('') }
  }
  const copy = async (column: TrackerColumn) => {
    try { await navigator.clipboard.writeText(revealed[column.id]); setSecretNote(`${column.name} copied. It stays on your clipboard until you copy something else.`) }
    catch { setSecretNote('Copying is blocked in this browser. Select the value and copy it.') }
  }

  return <aside ref={panel} className="trk-panel" role="dialog" aria-modal="false" aria-label={`Row details: ${title}`}>
    <header className="trk-panel-head">
      <div><p>Row</p><h2>{title}</h2></div>
      <div className="trk-panel-actions">
        {canEdit && <button type="button" className="trk-icon-button" aria-label="Delete this row" title="Delete this row" onClick={() => props.onDelete(row)}><Trash2 size={17} /></button>}
        <button type="button" className="trk-icon-button" aria-label="Close" data-autofocus onClick={props.onClose}><X size={18} /></button>
      </div>
    </header>
    <div className="trk-panel-body">
      <section className="trk-card" aria-label="Linked task">
        <h3>Linked task</h3>
        {row.taskId && task && <>
          <div className="trk-task-line"><strong>{task.title}</strong><small>{[props.clientName(task.clientId || ''), task.type].filter(Boolean).join(' · ')}</small></div>
          <div className="trk-card-actions"><Pill tone={/^(done|complete|completed|closed|resolved)/i.test(task.status) ? 'green' : 'gray'}>{task.status}</Pill>
            {props.onOpenTask && <button type="button" className="trk-text-button" onClick={() => props.onOpenTask!(task.id)}><ExternalLink size={13} aria-hidden="true" /> Open task</button>}
            {canEdit && <button type="button" className="trk-text-button" onClick={() => props.onLink(row, null)}>Unlink</button>}
            {canEdit && <button type="button" className="trk-text-button" ref={linkButton} onClick={() => setPicking(true)}>Change</button>}</div>
        </>}
        {row.taskId && !task && <>
          <p className="trk-warn-text">The linked task was deleted, so the columns that fill themselves are empty.</p>
          {canEdit && <div className="trk-card-actions"><button type="button" className="trk-text-button" onClick={() => props.onLink(row, null)}>Unlink</button><button type="button" className="trk-text-button" ref={linkButton} onClick={() => setPicking(true)}>Link another task</button></div>}
        </>}
        {!row.taskId && <>
          <p className="trk-muted-text">Not linked. Link a task to fill in its status, due date, owner, sign-off and Drive files here.</p>
          {canEdit && <div className="trk-card-actions"><button type="button" className="trk-text-button strong" ref={linkButton} onClick={() => setPicking(true)}>Link a task</button></div>}
        </>}
        {picking && <TaskPicker anchor={linkButton} items={props.items} tracker={tracker} clientName={props.clientName} onClose={() => setPicking(false)} onPick={id => { setPicking(false); props.onLink(row, id) }} />}
      </section>

      <TaskLinksCard props={props} />

      <section className="trk-fields" aria-label="Fields">
        {basic.map(column => <Field key={column.id} column={column} row={row} people={people} canEdit={canEdit} onEdit={value => props.onEdit(row, column, value)} />)}
      </section>

      {connected.length > 0 && <section className="trk-card" aria-label="Fills itself">
        <h3>Fills itself</h3>
        <p className="trk-muted-text">These come from the linked task and its subtasks. Change them there.</p>
        <dl className="trk-dl">
          {connected.map(column => <div key={column.id}><dt><ColumnIcon type={column.type} size={13} /> {column.name}</dt><dd><CellView column={column} row={row} lookup={lookup} canEdit={false} onToggle={() => undefined} />
            {shown(column, row, lookup).note === 'unlinked' && <span className="trk-visually-hidden">Not linked to a task</span>}</dd></div>)}
        </dl>
      </section>}

      {secrets.map(column => {
        const set = Boolean(row.secretSet[column.id]), adminOnly = column.revealBy === 'admins' && !props.isAdmin, mayReveal = tracker.canEdit
        const value = revealed[column.id]
        return <section key={column.id} className="trk-card trk-secret-card" aria-label={column.name}>
          <h3><LockKeyhole size={14} aria-hidden="true" /> {column.name}</h3>
          <p className="trk-muted-text">{set ? (mayReveal ? 'A value is stored, encrypted. It is hidden until you reveal it.' : 'A value is stored, encrypted. Your role cannot reveal it.') : 'Nothing is stored yet.'} Every reveal is recorded in this row’s history{column.revealBy === 'admins' ? '. Only Administrators can reveal this column' : ''}.</p>
          {value !== undefined && <div className="trk-revealed"><code aria-live="polite">{value}</code>
            <button type="button" className="trk-text-button" onClick={() => void copy(column)}><Copy size={13} aria-hidden="true" /> Copy</button>
            <button type="button" className="trk-text-button" onClick={() => hide(column.id)}><EyeOff size={13} aria-hidden="true" /> Hide</button>
            <small>Hides itself after 30 seconds.</small></div>}
          <div className="trk-card-actions">
            {set && mayReveal && value === undefined && <button type="button" className="trk-text-button strong" disabled={adminOnly || busyReveal === column.id} title={adminOnly ? 'Only an Administrator can reveal this column' : undefined} onClick={() => void reveal(column)}><Eye size={13} aria-hidden="true" /> {busyReveal === column.id ? 'Revealing…' : 'Reveal'}</button>}
            {canEdit && set && <button type="button" className="trk-text-button" onClick={() => { hide(column.id); props.onSecret(row, column, null) }}>Clear</button>}
          </div>
          {canEdit && <form className="trk-secret-form" onSubmit={event => { event.preventDefault(); const draft = secretDrafts[column.id] || ''; if (!draft) return; hide(column.id); props.onSecret(row, column, draft); setSecretDrafts(current => ({ ...current, [column.id]: '' })) }}>
            <input type="password" autoComplete="new-password" spellCheck={false} placeholder={set ? 'Type a new value to replace it' : 'Type the value'} aria-label={`${set ? 'New' : ''} ${column.name}`.trim()} value={secretDrafts[column.id] || ''} maxLength={500}
              onChange={event => setSecretDrafts(current => ({ ...current, [column.id]: event.target.value }))} />
            <button type="submit" className="trk-button" disabled={!secretDrafts[column.id]}>{set ? 'Replace' : 'Save'}</button>
          </form>}
        </section>
      })}
      {secretNote && <p className="trk-field-error" role="status">{secretNote}</p>}

      <section className="trk-card" aria-label="History">
        <h3>History</h3>
        {historyError && <p className="trk-field-error">{historyError}</p>}
        {!history && !historyError && <p className="trk-muted-text">Loading…</p>}
        {history && !history.length && <p className="trk-muted-text">No changes recorded yet.</p>}
        {history && history.length > 0 && <ol className="trk-history">
          {history.map(change => <li key={change.id}><span><strong>{change.actorName || 'Someone'}</strong> {describe(change, tracker.columns, people)}</span><time dateTime={change.at}>{niceTime(change.at)}</time></li>)}
        </ol>}
      </section>
    </div>
  </aside>
}
