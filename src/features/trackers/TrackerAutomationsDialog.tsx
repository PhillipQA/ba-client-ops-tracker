/**
 * The Automations dialog: when → then rules, and the run log. Saved for everyone on the tracker; run on the server
 * when a row is saved from the app.
 */
import { Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { type RuleOp, ruleColumns, ruleNeedsValue, ruleOpLabel, ruleOpsFor } from './highlightRules'
import { type AutomationRun, trackerApi } from './trackerApi'
import {
  AUTOMATION_LIMITS,
  type Automation,
  type AutomationAction,
  cleanAutomations,
  describeAutomation,
  newAutomation,
  settableColumns,
  TODAY,
  triggerColumns,
} from './trackerAutomations'
import type { Person } from './TrackerCells'
import type { TrackerColumn } from './trackerModel'
import { Dialog, niceTime } from './trackerUi'

/** A box for a value of a column: its options, people, ticked/not, a date (or today), a number or text. */
function ValueBox({
  column,
  value,
  people,
  allowToday,
  label,
  onChange,
}: {
  column: TrackerColumn
  value: string
  people: Person[]
  allowToday?: boolean
  label: string
  onChange: (value: string) => void
}) {
  if (column.type === 'select')
    return (
      <select aria-label={label} value={value} onChange={event => onChange(event.target.value)}>
        <option value="">(empty)</option>
        {(column.options || []).map(option => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
    )
  if (column.type === 'person')
    return (
      <select aria-label={label} value={value} onChange={event => onChange(event.target.value)}>
        <option value="">(nobody)</option>
        {people.map(person => (
          <option key={person.id} value={person.id}>
            {person.name}
          </option>
        ))}
      </select>
    )
  if (column.type === 'checkbox')
    return (
      <select aria-label={label} value={value || 'true'} onChange={event => onChange(event.target.value)}>
        <option value="true">ticked</option>
        <option value="false">not ticked</option>
      </select>
    )
  if (column.type === 'date')
    return (
      <span className="trk-rule-days">
        {allowToday && (
          <select
            aria-label={`${label}: today or a date`}
            value={value === TODAY ? TODAY : 'date'}
            onChange={event => onChange(event.target.value === TODAY ? TODAY : '')}
          >
            <option value={TODAY}>today</option>
            <option value="date">a date…</option>
          </select>
        )}
        {value !== TODAY && (
          <input aria-label={label} type="date" value={value} onChange={event => onChange(event.target.value)} />
        )}
      </span>
    )
  return (
    <input
      aria-label={label}
      type="text"
      inputMode={column.type === 'number' ? 'decimal' : undefined}
      value={value}
      placeholder="Empty clears it"
      onChange={event => onChange(event.target.value)}
    />
  )
}

export default function TrackerAutomationsDialog({
  trackerId,
  columns,
  people,
  automations: saved,
  tasksByTemplate,
  onSave,
  onClose,
}: {
  trackerId: string
  columns: TrackerColumn[]
  people: Person[]
  automations: Automation[]
  /** The tracker makes its tasks by itself (Site rollout, Project timeline): no "create its task" action. */
  tasksByTemplate: boolean
  onSave: (automations: Automation[]) => Promise<void>
  onClose: () => void
}) {
  const [list, setList] = useState<Automation[]>(saved)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [runs, setRuns] = useState<AutomationRun[] | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    trackerApi
      .automationRuns(trackerId, controller.signal)
      .then(result => setRuns(result.runs))
      .catch(() => setRuns([]))
    return () => controller.abort()
  }, [trackerId])
  const watch = triggerColumns(columns)
  const settable = settableColumns(columns)
  const conditionColumns = ruleColumns(columns)
  const personColumns = columns.filter(column => column.type === 'person')
  const sortedPeople = [...people].sort((a, b) => a.name.localeCompare(b.name))
  const personName = (id: string) => people.find(person => person.id === id)?.name || ''
  const patch = (id: string, change: Partial<Automation>) =>
    setList(current => current.map(item => (item.id === id ? { ...item, ...change } : item)))
  const patchAction = (automation: Automation, at: number, action: AutomationAction | null) =>
    patch(automation.id, {
      then: action
        ? automation.then.map((item, index) => (index === at ? action : item))
        : automation.then.filter((_item, index) => index !== at),
    })

  const save = async () => {
    const cleaned = cleanAutomations(list, columns)
    const actions = (items: Automation[]) => items.reduce((total, item) => total + item.then.length, 0)
    if (cleaned.length < list.length || actions(cleaned) < actions(list))
      return setError(
        'Each automation needs at least one complete action: a value to set, someone to notify or a comment.',
      )
    setBusy(true)
    setError('')
    try {
      await onSave(cleaned)
      onClose()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The automations could not be saved.')
      setBusy(false)
    }
  }

  const actionBox = (automation: Automation, action: AutomationAction, at: number) => {
    const kind = (
      <select
        aria-label="Action"
        value={action.kind}
        onChange={event => {
          const next = event.target.value
          const first = settable[0]
          patchAction(
            automation,
            at,
            next === 'set' && first
              ? { kind: 'set', columnId: first.id, value: first.type === 'date' ? TODAY : '' }
              : next === 'task'
                ? { kind: 'task' }
                : next === 'notify'
                  ? { kind: 'notify', ...(personColumns[0] ? { columnId: personColumns[0].id } : {}) }
                  : { kind: 'comment', text: '' },
          )
        }}
      >
        {settable.length > 0 && <option value="set">Set</option>}
        {!tasksByTemplate && <option value="task">Create its task</option>}
        <option value="notify">Notify</option>
        <option value="comment">Add a comment</option>
      </select>
    )
    const remove = (
      <button
        type="button"
        className="trk-icon-button"
        aria-label="Remove this action"
        onClick={() => patchAction(automation, at, null)}
      >
        <Trash2 size={13} />
      </button>
    )
    if (action.kind === 'set') {
      const column = settable.find(item => item.id === action.columnId) || settable[0]
      return (
        <div className="trk-rule-line" key={at}>
          <span className="trk-rule-word">then</span>
          {kind}
          <select
            aria-label="Column to set"
            value={column?.id || ''}
            onChange={event => {
              const next = settable.find(item => item.id === event.target.value)
              if (next)
                patchAction(automation, at, {
                  kind: 'set',
                  columnId: next.id,
                  value: next.type === 'date' ? TODAY : '',
                })
            }}
          >
            {settable.map(item => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          <span>to</span>
          {column && (
            <ValueBox
              column={column}
              value={action.value}
              people={sortedPeople}
              allowToday
              label={`New ${column.name}`}
              onChange={value => patchAction(automation, at, { ...action, value })}
            />
          )}
          {remove}
        </div>
      )
    }
    if (action.kind === 'task')
      return (
        <div className="trk-rule-line" key={at}>
          <span className="trk-rule-word">then</span>
          {kind}
          {personColumns.length > 0 && (
            <select
              aria-label="Assign to"
              value={action.assigneeColumnId || ''}
              onChange={event =>
                patchAction(automation, at, {
                  kind: 'task',
                  ...(event.target.value ? { assigneeColumnId: event.target.value } : {}),
                })
              }
            >
              <option value="">for the person saving</option>
              {personColumns.map(item => (
                <option key={item.id} value={item.id}>
                  for the row’s {item.name}
                </option>
              ))}
            </select>
          )}
          {remove}
        </div>
      )
    if (action.kind === 'notify')
      return (
        <div className="trk-rule-line" key={at}>
          <span className="trk-rule-word">then</span>
          {kind}
          {personColumns.length > 0 && (
            <select
              aria-label="Person column to notify"
              value={action.columnId || ''}
              onChange={event => patchAction(automation, at, { ...action, columnId: event.target.value || undefined })}
            >
              <option value="">(no column)</option>
              {personColumns.map(item => (
                <option key={item.id} value={item.id}>
                  the row’s {item.name}
                </option>
              ))}
            </select>
          )}
          <select
            aria-label="Add a person to notify"
            value=""
            onChange={event => {
              const id = event.target.value
              if (id && !action.people?.includes(id))
                patchAction(automation, at, { ...action, people: [...(action.people || []), id] })
            }}
          >
            <option value="">+ a person…</option>
            {sortedPeople.map(person => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </select>
          {(action.people || []).map(id => (
            <button
              type="button"
              key={id}
              className="trk-chip-button"
              title="Remove"
              onClick={() =>
                patchAction(automation, at, { ...action, people: (action.people || []).filter(item => item !== id) })
              }
            >
              {personName(id) || 'Unknown user'} ×
            </button>
          ))}
          {remove}
        </div>
      )
    return (
      <div className="trk-rule-line" key={at}>
        <span className="trk-rule-word">then</span>
        {kind}
        <input
          aria-label="Comment"
          type="text"
          maxLength={AUTOMATION_LIMITS.text}
          value={action.text}
          placeholder="Blocked, please check"
          onChange={event => patchAction(automation, at, { kind: 'comment', text: event.target.value })}
        />
        {remove}
      </div>
    )
  }

  return (
    <Dialog title="Automations" eyebrow="When → then, on every save" onClose={onClose} busy={busy} size="medium">
      <div className="trk-form trk-rules">
        <p className="trk-muted-text">
          Run on the server right after a row is saved from the app, and shown in the row’s history. A change an
          automation makes never starts another automation. Automations never delete anything and never set a cell that
          comes from the Google Sheet. New rows from an import of more than {AUTOMATION_LIMITS.rowsAdded} rows are left
          alone.
        </p>
        {list.map((automation, number) => {
          const when = automation.when
          const watched = when.kind === 'changed' ? watch.find(item => item.id === when.columnId) : undefined
          return (
            <fieldset key={automation.id} className={`trk-rule${automation.off ? ' off' : ''}`}>
              <legend>
                Automation {number + 1}
                {automation.off ? ' (off)' : ''}
              </legend>
              <div className="trk-rule-line">
                <span className="trk-rule-word">When</span>
                <select
                  aria-label="Trigger"
                  value={when.kind === 'added' ? '(added)' : when.columnId}
                  onChange={event =>
                    patch(automation.id, {
                      when:
                        event.target.value === '(added)'
                          ? { kind: 'added' }
                          : { kind: 'changed', columnId: event.target.value },
                    })
                  }
                >
                  <option value="(added)">a row is added</option>
                  {watch.map(column => (
                    <option key={column.id} value={column.id}>
                      {column.name} changes
                    </option>
                  ))}
                </select>
                {when.kind === 'changed' && watched && ['select', 'person', 'checkbox'].includes(watched.type) && (
                  <>
                    <span>to</span>
                    <select
                      aria-label="To"
                      value={when.to === undefined ? '(any)' : 'value'}
                      onChange={event =>
                        patch(automation.id, {
                          when:
                            event.target.value === '(any)'
                              ? { kind: 'changed', columnId: when.columnId }
                              : {
                                  kind: 'changed',
                                  columnId: when.columnId,
                                  to: watched.type === 'checkbox' ? 'true' : watched.options?.[0]?.id || '',
                                },
                        })
                      }
                    >
                      <option value="(any)">anything</option>
                      <option value="value">a value…</option>
                    </select>
                    {when.to !== undefined && (
                      <ValueBox
                        column={watched}
                        value={when.to}
                        people={sortedPeople}
                        label={`${watched.name} becomes`}
                        onChange={value => patch(automation.id, { when: { ...when, to: value } })}
                      />
                    )}
                  </>
                )}
              </div>
              {automation.conditions.map((condition, at) => {
                const column = columns.find(item => item.id === condition.columnId)
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: conditions are edited in place, never reordered
                  <div className="trk-rule-line" key={at}>
                    <span className="trk-rule-word">and if</span>
                    <select
                      aria-label="Condition column"
                      value={condition.columnId}
                      onChange={event => {
                        const next = conditionColumns.find(item => item.id === event.target.value)
                        if (!next) return
                        const op = ruleOpsFor(next)[0]
                        patch(automation.id, {
                          conditions: automation.conditions.map((item, index) =>
                            index === at ? { columnId: next.id, op, value: op === 'within' ? '7' : '' } : item,
                          ),
                        })
                      }}
                    >
                      {conditionColumns.map(item => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                    <select
                      aria-label="Comparison"
                      value={condition.op}
                      onChange={event => {
                        const op = event.target.value as RuleOp
                        patch(automation.id, {
                          conditions: automation.conditions.map((item, index) =>
                            index === at ? { ...item, op, value: op === 'within' ? '7' : '' } : item,
                          ),
                        })
                      }}
                    >
                      {(column ? ruleOpsFor(column) : []).map(op => (
                        <option key={op} value={op}>
                          {ruleOpLabel(op)}
                        </option>
                      ))}
                    </select>
                    {column && ruleNeedsValue(condition.op) && (
                      <ValueBox
                        column={
                          column.type === 'person' || column.type === 'select' || column.type === 'date'
                            ? column
                            : { ...column, type: 'text' }
                        }
                        value={condition.value}
                        people={sortedPeople}
                        label="Value"
                        onChange={value =>
                          patch(automation.id, {
                            conditions: automation.conditions.map((item, index) =>
                              index === at ? { ...item, value } : item,
                            ),
                          })
                        }
                      />
                    )}
                    <button
                      type="button"
                      className="trk-icon-button"
                      aria-label="Remove this condition"
                      onClick={() =>
                        patch(automation.id, {
                          conditions: automation.conditions.filter((_item, index) => index !== at),
                        })
                      }
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                )
              })}
              {automation.then.map((action, at) => actionBox(automation, action, at))}
              <div className="trk-rule-foot">
                <span className="trk-rule-tools">
                  {automation.conditions.length < AUTOMATION_LIMITS.conditions && conditionColumns.length > 0 && (
                    <button
                      type="button"
                      className="trk-text-button"
                      onClick={() => {
                        const column = conditionColumns[0],
                          op = ruleOpsFor(column)[0]
                        patch(automation.id, {
                          conditions: [
                            ...automation.conditions,
                            { columnId: column.id, op, value: op === 'within' ? '7' : '' },
                          ],
                        })
                      }}
                    >
                      + Condition
                    </button>
                  )}
                  {automation.then.length < AUTOMATION_LIMITS.actions && (
                    <button
                      type="button"
                      className="trk-text-button"
                      onClick={() =>
                        patch(automation.id, { then: [...automation.then, { kind: 'comment', text: '' }] })
                      }
                    >
                      + Action
                    </button>
                  )}
                </span>
                <span className="trk-rule-tools">
                  <label className="trk-checkline">
                    <input
                      type="checkbox"
                      checked={!automation.off}
                      onChange={event => patch(automation.id, { off: event.target.checked ? undefined : true })}
                    />{' '}
                    On
                  </label>
                  <button
                    type="button"
                    className="trk-icon-button"
                    aria-label="Delete automation"
                    onClick={() => setList(current => current.filter(item => item.id !== automation.id))}
                  >
                    <Trash2 size={13} />
                  </button>
                </span>
              </div>
              <small className="trk-muted">{describeAutomation(automation, columns, personName)}</small>
            </fieldset>
          )
        })}
        {list.length < AUTOMATION_LIMITS.automations && (
          <button
            type="button"
            className="trk-button"
            onClick={() => {
              const automation = newAutomation(columns)
              if (automation) setList(current => [...current, automation])
            }}
            disabled={!newAutomation(columns)}
          >
            <Plus size={14} aria-hidden="true" /> New automation
          </button>
        )}
        {error && (
          <p className="trk-field-error" role="alert">
            {error}
          </p>
        )}
        <div className="k-dialog-actions">
          <button type="button" className="trk-button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="trk-button primary" onClick={() => void save()} disabled={busy}>
            Save automations
          </button>
        </div>
        <section className="trk-runs" aria-label="Recent runs">
          <h3>Recent runs</h3>
          {!runs && <p className="trk-muted-text">Loading…</p>}
          {runs && !runs.length && <p className="trk-muted-text">Nothing has run yet.</p>}
          {runs && runs.length > 0 && (
            <ol>
              {runs.map(run => (
                <li key={run.id}>
                  <span>
                    <strong>{run.row || 'A row'}</strong>: {run.trigger}
                    <br />
                    <small className="trk-muted">
                      {run.done.length ? run.done.join(', ') : 'did nothing'}
                      {run.skipped.length ? ` · skipped: ${run.skipped.join('; ')}` : ''}
                    </small>
                  </span>
                  <time dateTime={run.at} className="trk-muted">
                    {niceTime(run.at)}
                  </time>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </Dialog>
  )
}
