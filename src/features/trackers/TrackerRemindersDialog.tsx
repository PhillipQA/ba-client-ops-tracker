/**
 * The Reminders dialog: "N days before / on / after <date column>, if <condition>, remind <who>". Checked every
 * morning at 8:00 AM; saved for everyone on the tracker.
 */
import { Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { type RuleOp, ruleColumns, ruleNeedsValue, ruleOpLabel, ruleOpsFor } from './highlightRules'
import type { Person } from './TrackerCells'
import type { TrackerColumn } from './trackerModel'
import {
  cleanReminders,
  describeReminder,
  newReminder,
  REMINDER_LIMITS,
  reminderDateColumns,
  reminderPersonColumns,
  type TrackerReminder,
} from './trackerReminders'
import { Dialog } from './trackerUi'

export default function TrackerRemindersDialog({
  columns,
  people,
  reminders: saved,
  onSave,
  onClose,
}: {
  columns: TrackerColumn[]
  people: Person[]
  reminders: TrackerReminder[]
  onSave: (reminders: TrackerReminder[]) => Promise<void>
  onClose: () => void
}) {
  const [list, setList] = useState<TrackerReminder[]>(saved)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const dates = reminderDateColumns(columns)
  const personColumns = reminderPersonColumns(columns)
  const conditionColumns = ruleColumns(columns)
  const sortedPeople = [...people].sort((a, b) => a.name.localeCompare(b.name))
  const personName = (id: string) => people.find(person => person.id === id)?.name || ''
  const patch = (id: string, change: Partial<TrackerReminder>) =>
    setList(current => current.map(item => (item.id === id ? { ...item, ...change } : item)))

  const save = async () => {
    const cleaned = cleanReminders(list, columns)
    if (cleaned.length < list.length)
      return setError('Each reminder needs someone to remind, and a value for its condition if it has one.')
    setBusy(true)
    setError('')
    try {
      await onSave(cleaned)
      onClose()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The reminders could not be saved.')
      setBusy(false)
    }
  }

  return (
    <Dialog
      title="Date reminders"
      eyebrow="Checked every morning at 8:00 AM"
      onClose={onClose}
      busy={busy}
      size="medium"
    >
      <div className="trk-form trk-rules">
        <p className="trk-muted-text">
          Reminders arrive in the bell of the people chosen, at most once a day for each row. They stop by themselves
          once the condition no longer holds; anyone reminded can snooze a row for themselves.
        </p>
        {!dates.length && <p className="trk-muted-text">This tracker has no Date column to remind about.</p>}
        {list.map((reminder, at) => {
          const condition = reminder.condition
          const conditionColumn = condition ? columns.find(column => column.id === condition.columnId) : undefined
          return (
            <fieldset key={reminder.id} className={`trk-rule${reminder.off ? ' off' : ''}`}>
              <legend>
                Reminder {at + 1}
                {reminder.off ? ' (off)' : ''}
              </legend>
              <div className="trk-rule-line">
                {reminder.when === 'before' && (
                  <input
                    aria-label="Days before"
                    type="number"
                    min={1}
                    max={REMINDER_LIMITS.days}
                    className="trk-rule-num"
                    value={reminder.days}
                    onChange={event => patch(reminder.id, { days: Number(event.target.value) })}
                  />
                )}
                <select
                  aria-label="When"
                  value={reminder.when}
                  onChange={event =>
                    patch(reminder.id, {
                      when: event.target.value as TrackerReminder['when'],
                      days: reminder.days || 3,
                    })
                  }
                >
                  <option value="before">days before</option>
                  <option value="on">on the day of</option>
                  <option value="after">every working day after</option>
                </select>
                <select
                  aria-label="Date column"
                  value={reminder.dateId}
                  onChange={event => patch(reminder.id, { dateId: event.target.value })}
                >
                  {dates.map(column => (
                    <option key={column.id} value={column.id}>
                      {column.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="trk-rule-line">
                <span className="trk-rule-word">if</span>
                <select
                  aria-label="Condition column"
                  value={condition?.columnId || ''}
                  onChange={event => {
                    const column = conditionColumns.find(item => item.id === event.target.value)
                    if (!column) {
                      const { condition: _old, ...rest } = reminder
                      return setList(current => current.map(item => (item.id === reminder.id ? rest : item)))
                    }
                    const op = ruleOpsFor(column)[0]
                    patch(reminder.id, { condition: { columnId: column.id, op, value: op === 'within' ? '7' : '' } })
                  }}
                >
                  <option value="">(always)</option>
                  {conditionColumns.map(column => (
                    <option key={column.id} value={column.id}>
                      {column.name}
                    </option>
                  ))}
                </select>
                {condition && conditionColumn && (
                  <>
                    <select
                      aria-label="Comparison"
                      value={condition.op}
                      onChange={event => {
                        const op = event.target.value as RuleOp
                        patch(reminder.id, { condition: { ...condition, op, value: op === 'within' ? '7' : '' } })
                      }}
                    >
                      {ruleOpsFor(conditionColumn).map(op => (
                        <option key={op} value={op}>
                          {ruleOpLabel(op)}
                        </option>
                      ))}
                    </select>
                    {ruleNeedsValue(condition.op) &&
                      (conditionColumn.type === 'select' && (condition.op === 'is' || condition.op === 'is_not') ? (
                        <select
                          aria-label="Value"
                          value={condition.value}
                          onChange={event =>
                            patch(reminder.id, { condition: { ...condition, value: event.target.value } })
                          }
                        >
                          <option value="">Choose…</option>
                          {(conditionColumn.options || []).map(option => (
                            <option key={option.id} value={option.id}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          aria-label="Value"
                          type={
                            condition.op === 'within' ? 'number' : conditionColumn.type === 'date' ? 'date' : 'text'
                          }
                          value={condition.value}
                          onChange={event =>
                            patch(reminder.id, { condition: { ...condition, value: event.target.value } })
                          }
                        />
                      ))}
                  </>
                )}
              </div>
              <div className="trk-rule-line">
                <span className="trk-rule-word">remind</span>
                {personColumns.length > 0 && (
                  <select
                    aria-label="Person column"
                    value={reminder.to.columnId || ''}
                    onChange={event =>
                      patch(reminder.id, {
                        to: { ...reminder.to, columnId: event.target.value || undefined },
                      })
                    }
                  >
                    <option value="">(no column)</option>
                    {personColumns.map(column => (
                      <option key={column.id} value={column.id}>
                        the row’s {column.name}
                      </option>
                    ))}
                  </select>
                )}
                <label className="trk-checkline">
                  <input
                    type="checkbox"
                    checked={Boolean(reminder.to.creator)}
                    onChange={event => patch(reminder.id, { to: { ...reminder.to, creator: event.target.checked } })}
                  />{' '}
                  the tracker’s creator
                </label>
                <select
                  aria-label="Add a person"
                  value=""
                  onChange={event => {
                    const id = event.target.value
                    if (!id || reminder.to.people?.includes(id)) return
                    patch(reminder.id, { to: { ...reminder.to, people: [...(reminder.to.people || []), id] } })
                  }}
                >
                  <option value="">+ a person…</option>
                  {sortedPeople.map(person => (
                    <option key={person.id} value={person.id}>
                      {person.name}
                    </option>
                  ))}
                </select>
              </div>
              {(reminder.to.people || []).length > 0 && (
                <div className="trk-rule-line">
                  {(reminder.to.people || []).map(id => (
                    <button
                      type="button"
                      key={id}
                      className="trk-chip-button"
                      title="Remove"
                      onClick={() =>
                        patch(reminder.id, {
                          to: { ...reminder.to, people: (reminder.to.people || []).filter(item => item !== id) },
                        })
                      }
                    >
                      {personName(id) || 'Unknown user'} ×
                    </button>
                  ))}
                </div>
              )}
              <div className="trk-rule-foot">
                <small className="trk-muted">{describeReminder(reminder, columns, personName)}</small>
                <span className="trk-rule-tools">
                  <label className="trk-checkline">
                    <input
                      type="checkbox"
                      checked={!reminder.off}
                      onChange={event => patch(reminder.id, { off: event.target.checked ? undefined : true })}
                    />{' '}
                    On
                  </label>
                  <button
                    type="button"
                    className="trk-icon-button"
                    aria-label="Delete reminder"
                    onClick={() => setList(current => current.filter(item => item.id !== reminder.id))}
                  >
                    <Trash2 size={13} />
                  </button>
                </span>
              </div>
            </fieldset>
          )
        })}
        {list.length < REMINDER_LIMITS.reminders && dates.length > 0 && (
          <button
            type="button"
            className="trk-button"
            onClick={() => {
              const reminder = newReminder(columns)
              if (reminder) setList(current => [...current, reminder])
            }}
          >
            <Plus size={14} aria-hidden="true" /> Add a reminder
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
            Save reminders
          </button>
        </div>
      </div>
    </Dialog>
  )
}
