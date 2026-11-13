import { useState, type KeyboardEvent } from 'react'
import { Clock3, Trash2 } from 'lucide-react'
import {
  canRemoveTimeEntry,
  EFFORT_CATEGORIES,
  effortSummary,
  defaultSeedsTask,
  formatHours,
  MAX_SEEDS_REMARKS_LENGTH,
  unsentToSeeds,
  subtaskRemarks,
  type SeedsTimeRule,
  validateTimeEntryInput,
  type EffortCategory,
  type TimeEntry,
} from './effort'
import { addTimeEntry, deleteTimeEntry, type TimeEntryMutationResult } from './timeEntries'
import type { WorkItem } from '../../shared/types'
import { SendToSeedsButton } from '../seeds/SendToSeeds'
import './effort.css'

type Props = {
  item: WorkItem
  allItems: WorkItem[]
  currentUser: { id: string; role?: string }
  canLog: boolean
  today: string
  onMutation: (result: TimeEntryMutationResult) => void
  /** Once Seeds is on: the time rule for a task or subtask (see seedsTimeRule); null while Seeds is off. */
  seedsRule?: (target: WorkItem) => SeedsTimeRule | null
}

function niceEntryDate(date: string) {
  const [year, month, day] = date.split('-').map(Number)
  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(new Date(year, month - 1, day))
}

/** Effort section of the task editor. It sits inside the task form, so its controls never submit that form. */
export default function TaskEffort({ item, allItems, currentUser, canLog, today, onMutation, seedsRule }: Props) {
  const subtasks = item.parentTaskId ? [] : allItems.filter(candidate => candidate.parentTaskId === item.id)
  const summary = effortSummary(item, allItems)
  const [date, setDate] = useState(today)
  const [hours, setHours] = useState('')
  const [category, setCategory] = useState<EffortCategory>('Analysis')
  const [targetId, setTargetId] = useState(item.id)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)
  // Once Seeds is on: time is logged on the task as Seeds time entries (duration in hrs + mins, Seeds task, remarks).
  // An entry can be for one of the task's subtasks; the remarks are then filled in as "subtask – task", and stay
  // editable.
  const rule = seedsRule ? seedsRule(item) : null
  const [durationHours, setDurationHours] = useState('0')
  const [durationMinutes, setDurationMinutes] = useState('0')
  const [subtaskId, setSubtaskId] = useState('')
  const [chosenSeedsTask, setChosenSeedsTask] = useState('')
  const seedsTaskId = chosenSeedsTask || (rule ? defaultSeedsTask(rule, subtaskId) : '')
  const forSubtask = rule?.subtasks.find(subtask => subtask.id === subtaskId)
  // Seeds requires a product for this Seeds task (or its project) and none is picked on the task yet.
  const productMissing = Boolean(seedsTaskId && rule?.needsProduct?.includes(seedsTaskId))
  const remarks = note
  // Picking a subtask fills in "subtask – task", unless the person has typed their own remarks.
  const chooseSubtask = (id: string) => {
    const suggestion = (subtask?: { title: string }) => (subtask ? subtaskRemarks(subtask.title, item.title) : '')
    const previous = suggestion(forSubtask),
      next = suggestion(rule?.subtasks.find(subtask => subtask.id === id))
    if (!note.trim() || note === previous) setNote(next)
    setSubtaskId(id)
    setChosenSeedsTask('')
  }
  const parentTask = item.parentTaskId ? allItems.find(candidate => candidate.id === item.parentTaskId) : undefined
  const seedsTasks = rule?.tasks || []
  const seedsTaskLabel = (id: string) => `Seeds: ${seedsTasks.find(task => task.id === id)?.name || 'task'}`
  const duration = Number(durationHours) + Number(durationMinutes) / 60

  // A subtask also lists the time logged on its task for it (once Seeds is on, time is logged on the task).
  const parentOf = item.parentTaskId ? allItems.find(candidate => candidate.id === item.parentTaskId) : undefined
  const forThisSubtask = (parentOf?.timeEntries || [])
    .filter(entry => entry.subtaskId === item.id)
    .map(entry => ({ entry, owner: parentOf as WorkItem }))
  const entries: { entry: TimeEntry; owner: WorkItem }[] = [item, ...subtasks]
    .flatMap(owner => (owner.timeEntries || []).map(entry => ({ entry, owner })))
    .concat(forThisSubtask)
    .sort((a, b) => b.entry.date.localeCompare(a.entry.date) || b.entry.createdAt.localeCompare(a.entry.createdAt))

  const addQuick = (amount: number) => setHours(current => String(Math.min(24, (Number(current) || 0) + amount)))
  const blockEnter = (event: KeyboardEvent) => {
    if (event.key === 'Enter') event.preventDefault()
  }

  const save = async () => {
    if (busy) return
    const checked = rule
      ? validateTimeEntryInput({ date, hours: duration, note, seedsTaskId, subtaskId }, rule)
      : validateTimeEntryInput({ date, hours: Number(hours), category, note })
    if (!checked.ok) {
      setMessage({ text: checked.error, ok: false })
      return
    }
    setBusy(true)
    setMessage(null)
    try {
      onMutation(await addTimeEntry(rule ? item.id : targetId, checked.value))
      setHours('')
      setDurationHours('0')
      setDurationMinutes('0')
      // The subtask stays chosen, so its suggestion is ready for the next entry.
      setNote(rule && forSubtask ? subtaskRemarks(forSubtask.title, item.title) : '')
      setMessage({ text: `${formatHours(checked.value.hours)} logged.`, ok: true })
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : 'The time entry could not be saved.', ok: false })
    } finally {
      setBusy(false)
    }
  }

  const remove = async (owner: WorkItem, entry: TimeEntry) => {
    if (busy || !window.confirm(`Remove ${formatHours(entry.hours)} logged on ${niceEntryDate(entry.date)}?`)) return
    setBusy(true)
    setMessage(null)
    try {
      onMutation(await deleteTimeEntry(owner.id, entry.id))
      setMessage({ text: 'Time entry removed.', ok: true })
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : 'The time entry could not be removed.', ok: false })
    } finally {
      setBusy(false)
    }
  }

  // This person's entries on this task that can go to Seeds and have not.
  const myUnsent = (item.timeEntries || [])
    .filter(entry => entry.userId === currentUser.id && unsentToSeeds(entry))
    .map(entry => entry.id)

  const logAgainstField = subtasks.length > 0 && (
    <label>
      Log against
      <select
        value={targetId}
        onChange={event => {
          setTargetId(event.target.value)
          setChosenSeedsTask('')
        }}
      >
        <option value={item.id}>This task</option>
        {subtasks.map(subtask => (
          <option key={subtask.id} value={subtask.id}>
            Subtask: {subtask.title}
          </option>
        ))}
      </select>
    </label>
  )

  const within = summary.estimate ? Math.min(summary.logged, summary.estimate) : summary.logged
  const scale = Math.max(summary.logged, summary.estimate || 0) || 1
  return (
    <section className="effort-panel span-2" aria-labelledby={`effort-${item.id}`}>
      <div className="effort-heading">
        <div>
          <strong id={`effort-${item.id}`}>
            <Clock3 size={15} /> Effort
          </strong>
          <span>{subtasks.length ? 'Includes time logged on subtasks.' : 'Time logged against this work item.'}</span>
        </div>
        <span className="count-pill">
          {entries.length} {entries.length === 1 ? 'entry' : 'entries'}
        </span>
      </div>

      <div className="effort-tiles">
        <div>
          <span>Estimate</span>
          <strong>{summary.estimate ? formatHours(summary.estimate) : '—'}</strong>
          <small>
            {summary.estimateFromSubtasks
              ? 'Sum of subtask estimates'
              : summary.estimate
                ? 'Set in the field above'
                : 'No estimate set'}
          </small>
        </div>
        <div>
          <span>Logged</span>
          <strong>{formatHours(summary.logged)}</strong>
          <small>
            {summary.subtaskLogged ? `${formatHours(summary.subtaskLogged)} from subtasks` : 'On this item'}
          </small>
        </div>
        {summary.overBy > 0 ? (
          <div className="effort-over">
            <span>Over estimate</span>
            <strong>+{formatHours(summary.overBy)}</strong>
            <small>{(summary.percent || 0) - 100}% over</small>
          </div>
        ) : (
          <div>
            <span>Remaining</span>
            <strong>{summary.estimate ? formatHours(summary.estimate - summary.logged) : '—'}</strong>
            <small>{summary.percent !== undefined ? `${summary.percent}% used` : 'Add an estimate to track'}</small>
          </div>
        )}
      </div>

      {summary.logged > 0 && (
        <div
          className="effort-progress"
          role="img"
          aria-label={`${formatHours(summary.logged)} logged${summary.estimate ? ` of ${formatHours(summary.estimate)} estimated` : ''}`}
        >
          <div className="effort-progress-track">
            <div className="effort-progress-within" style={{ width: `${(within / scale) * 100}%` }} />
            {summary.overBy > 0 && (
              <div className="effort-progress-over" style={{ width: `${(summary.overBy / scale) * 100}%` }} />
            )}
          </div>
          <div className="effort-category-line">
            {summary.byCategory.map(row => (
              <span key={row.category}>
                {row.category} {formatHours(row.hours)}
              </span>
            ))}
          </div>
        </div>
      )}

      {canLog && rule?.logOnTaskId && (
        <p className="effort-message" role="status">
          Time is logged on the task{parentTask ? ` “${parentTask.title}”` : ''}: open it, log time and choose this
          subtask. The remarks are filled in as “subtask – task”, and you can edit them.
        </p>
      )}
      {canLog && rule && !rule.logOnTaskId && (
        <div className="effort-log" onKeyDown={blockEnter}>
          <div className="effort-log-head">
            <strong>Log time</strong>
          </div>
          {!rule.tasks.length ? (
            <p className="effort-message" role="status">
              Time is logged only on tasks under a Seeds project, tagged with a Seeds task.
            </p>
          ) : (
            <>
              <div className="effort-log-grid">
                <label>
                  Task date
                  <input type="date" value={date} max={today} onChange={event => setDate(event.target.value)} />
                </label>
                <label>
                  Duration
                  <span className="effort-duration">
                    <select
                      value={durationHours}
                      onChange={event => setDurationHours(event.target.value)}
                      aria-label="Hours"
                    >
                      {Array.from({ length: 25 }, (_, hour) => (
                        <option key={hour} value={hour}>
                          {hour} hrs
                        </option>
                      ))}
                    </select>
                    <select
                      value={durationMinutes}
                      onChange={event => setDurationMinutes(event.target.value)}
                      aria-label="Minutes"
                    >
                      {[0, 15, 30, 45].map(minutes => (
                        <option key={minutes} value={minutes}>
                          {String(minutes).padStart(2, '0')} mins
                        </option>
                      ))}
                    </select>
                  </span>
                </label>
                {rule.subtasks.length > 0 && (
                  <label>
                    Subtask
                    <select value={subtaskId} onChange={event => chooseSubtask(event.target.value)}>
                      <option value="">None</option>
                      {rule.subtasks.map(subtask => (
                        <option key={subtask.id} value={subtask.id}>
                          {subtask.title}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label>
                  Seeds task
                  <select value={seedsTaskId} onChange={event => setChosenSeedsTask(event.target.value)}>
                    {!seedsTaskId && <option value="">Choose the Seeds task</option>}
                    {rule.tasks.map(task => (
                      <option key={task.id} value={task.id}>
                        {task.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {productMissing && (
                <p className="effort-message" role="status">
                  Seeds requires a product for this time. Pick a Seeds product on the task before sending it to Seeds.
                </p>
              )}
              <label className="effort-note">
                Remarks (required, max {MAX_SEEDS_REMARKS_LENGTH} characters)
                <textarea
                  value={remarks}
                  maxLength={MAX_SEEDS_REMARKS_LENGTH}
                  rows={2}
                  placeholder={forSubtask ? '' : 'What you worked on'}
                  onChange={event => setNote(event.target.value)}
                />
                <small className="effort-count">
                  {remarks.length}/{MAX_SEEDS_REMARKS_LENGTH}
                </small>
              </label>
              <div className="effort-log-actions">
                {message && (
                  <span
                    className={`effort-message${message.ok ? ' success' : ''}`}
                    role={message.ok ? 'status' : 'alert'}
                  >
                    {message.text}
                  </span>
                )}
                <button
                  type="button"
                  className="primary"
                  disabled={busy || duration <= 0 || !remarks.trim() || !seedsTaskId}
                  onClick={() => void save()}
                >
                  {busy ? 'Saving…' : 'Save entry'}
                </button>
              </div>
            </>
          )}
        </div>
      )}
      {canLog && !rule && (
        <div className="effort-log" onKeyDown={blockEnter}>
          <div className="effort-log-head">
            <strong>Log time</strong>
            <div className="effort-quick">
              {[0.25, 0.5, 1].map(amount => (
                <button key={amount} type="button" className="secondary compact" onClick={() => addQuick(amount)}>
                  +{amount < 1 ? `${amount * 60}m` : '1h'}
                </button>
              ))}
            </div>
          </div>
          <div className="effort-log-grid">
            <label>
              Date
              <input type="date" value={date} max={today} onChange={event => setDate(event.target.value)} />
            </label>
            <label>
              Hours
              <input
                type="number"
                inputMode="decimal"
                min="0.25"
                max="24"
                step="0.25"
                value={hours}
                placeholder="1.5"
                onChange={event => setHours(event.target.value)}
              />
            </label>
            <label>
              Category
              <select value={category} onChange={event => setCategory(event.target.value as EffortCategory)}>
                {EFFORT_CATEGORIES.map(option => (
                  <option key={option}>{option}</option>
                ))}
              </select>
            </label>
            {logAgainstField}
          </div>
          <label className="effort-note">
            Note (optional)
            <input
              value={note}
              maxLength={500}
              placeholder="What was this time spent on?"
              onChange={event => setNote(event.target.value)}
            />
          </label>
          <div className="effort-log-actions">
            {message && (
              <span className={`effort-message${message.ok ? ' success' : ''}`} role={message.ok ? 'status' : 'alert'}>
                {message.text}
              </span>
            )}
            <button type="button" className="primary" disabled={busy || !hours} onClick={() => void save()}>
              {busy ? 'Saving…' : 'Save entry'}
            </button>
          </div>
        </div>
      )}
      {!canLog && message && <span className={`effort-message${message.ok ? ' success' : ''}`}>{message.text}</span>}

      {rule && myUnsent.length > 0 && (
        <div className="effort-log-actions">
          {entries.some(
            ({ entry }) =>
              myUnsent.includes(entry.id) && entry.seedsTaskId && rule.needsProduct?.includes(entry.seedsTaskId),
          ) && (
            <span className="effort-message" role="status">
              Some entries need a Seeds product: pick one on the task first.
            </span>
          )}
          <SendToSeedsButton
            entryIds={myUnsent}
            onSent={result => {
              for (const updated of result.items) onMutation({ item: updated } as TimeEntryMutationResult)
            }}
          />
        </div>
      )}
      {entries.length > 0 && (
        <ul className="effort-entries">
          {entries.map(({ entry, owner }) => (
            <li key={entry.id}>
              <time dateTime={entry.date}>{niceEntryDate(entry.date)}</time>
              <div>
                <strong>
                  {entry.note || (entry.seedsTaskId ? seedsTaskLabel(entry.seedsTaskId) : entry.category)}
                </strong>
                <small>
                  {entry.seedsTaskId && (
                    <span
                      className={`effort-seeds ${entry.seedsEntryId ? 'sent' : entry.seedsError ? 'failed' : ''}`}
                      title={entry.seedsError || undefined}
                    >
                      {entry.seedsEntryId ? 'In Seeds' : entry.seedsError ? 'Not sent: retry' : 'Not sent'}
                    </span>
                  )}{' '}
                  {entry.userName} · {entry.seedsTaskId ? seedsTaskLabel(entry.seedsTaskId) : entry.category}
                  {entry.subtaskId && owner.id === item.id
                    ? ` · Subtask: ${subtasks.find(subtask => subtask.id === entry.subtaskId)?.title || 'removed'}`
                    : ''}
                  {owner.id !== item.id ? ` · Subtask: ${owner.title}` : ''}
                </small>
              </div>
              <b>{formatHours(entry.hours)}</b>
              {canLog && canRemoveTimeEntry(entry, currentUser) && !entry.seedsEntryId ? (
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Remove ${formatHours(entry.hours)} logged on ${niceEntryDate(entry.date)}`}
                  disabled={busy}
                  onClick={() => void remove(owner, entry)}
                >
                  <Trash2 size={15} />
                </button>
              ) : (
                <span />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
