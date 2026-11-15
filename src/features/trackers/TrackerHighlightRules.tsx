/**
 * The Highlight rules dialog: a list of rules, each "when <column> <comparison> <value> (and …) → colour". Checked top
 * to bottom; the first match colours the row. Saved for everyone on the tracker.
 */
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import {
  cleanRules,
  describeRule,
  type HighlightRule,
  newRule,
  RULE_LIMITS,
  type RuleCondition,
  type RuleOp,
  ruleColumns,
  ruleNeedsValue,
  ruleOpLabel,
  ruleOpsFor,
} from './highlightRules'
import type { Person } from './TrackerCells'
import type { TrackerColumn } from './trackerModel'
import { Dialog, HIGHLIGHTS } from './trackerUi'

export default function TrackerHighlightRules({
  columns,
  people,
  rules: saved,
  onSave,
  onClose,
}: {
  columns: TrackerColumn[]
  people: Person[]
  rules: HighlightRule[]
  onSave: (rules: HighlightRule[]) => Promise<void>
  onClose: () => void
}) {
  const [rules, setRules] = useState<HighlightRule[]>(saved)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const usable = ruleColumns(columns)
  const patch = (id: string, change: (rule: HighlightRule) => HighlightRule) =>
    setRules(current => current.map(rule => (rule.id === id ? change(rule) : rule)))
  const patchCondition = (id: string, at: number, change: Partial<RuleCondition>) =>
    patch(id, rule => ({
      ...rule,
      conditions: rule.conditions.map((condition, index) => (index === at ? { ...condition, ...change } : condition)),
    }))
  const move = (at: number, by: number) =>
    setRules(current => {
      const to = at + by
      if (to < 0 || to >= current.length) return current
      const next = [...current]
      ;[next[at], next[to]] = [next[to], next[at]]
      return next
    })
  const personName = (id: string) => people.find(person => person.id === id)?.name || ''

  const valueBox = (rule: HighlightRule, condition: RuleCondition, at: number) => {
    const column = columns.find(item => item.id === condition.columnId)
    if (!column || !ruleNeedsValue(condition.op)) return null
    const set = (value: string) => patchCondition(rule.id, at, { value })
    const label = `Value for ${column.name}`
    if (condition.op === 'within')
      return (
        <span className="trk-rule-days">
          <input
            aria-label="Days"
            type="number"
            min={0}
            max={RULE_LIMITS.days}
            value={condition.value}
            onChange={event => set(event.target.value)}
          />{' '}
          days
        </span>
      )
    if (column.type === 'select' && (condition.op === 'is' || condition.op === 'is_not'))
      return (
        <select aria-label={label} value={condition.value} onChange={event => set(event.target.value)}>
          <option value="">Choose…</option>
          {(column.options || []).map(option => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      )
    if (column.type === 'person' && (condition.op === 'is' || condition.op === 'is_not'))
      return (
        <select aria-label={label} value={condition.value} onChange={event => set(event.target.value)}>
          <option value="">Choose…</option>
          {[...people]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(person => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
        </select>
      )
    return (
      <input
        aria-label={label}
        type={column.type === 'date' || column.type === 'task_due' ? 'date' : 'text'}
        value={condition.value}
        onChange={event => set(event.target.value)}
      />
    )
  }

  const save = async () => {
    // Half-filled conditions are dropped by the same cleaning the server does; say so rather than lose them quietly.
    const cleaned = cleanRules(rules, columns)
    const kept = cleaned.reduce((total, rule) => total + rule.conditions.length, 0)
    const typed = rules.reduce((total, rule) => total + rule.conditions.length, 0)
    if (kept < typed) return setError('Fill in the value of every condition, or remove the ones you don’t need.')
    setBusy(true)
    setError('')
    try {
      await onSave(cleaned)
      onClose()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The rules could not be saved.')
      setBusy(false)
    }
  }

  return (
    <Dialog title="Highlight rules" eyebrow="Rows colour themselves" onClose={onClose} busy={busy} size="medium">
      <div className="trk-form trk-rules">
        <p className="trk-muted-text">
          Checked top to bottom: the first rule that matches colours the row. A colour you set by hand on a row still
          wins, and a rule wins over Colour by status.
        </p>
        {!usable.length && <p className="trk-muted-text">This tracker has no column a rule can look at.</p>}
        {rules.map((rule, at) => (
          <fieldset key={rule.id} className={`trk-rule${rule.off ? ' off' : ''}`}>
            <legend>
              <i className={`trk-swatch trk-tone-${rule.color}`} aria-hidden="true" /> Rule {at + 1}
              {rule.off ? ' (off)' : ''}
            </legend>
            {rule.conditions.map((condition, index) => {
              const column = columns.find(item => item.id === condition.columnId)
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: a rule's conditions are edited in place, never reordered
                <div className="trk-rule-line" key={index}>
                  <span className="trk-rule-word">{index === 0 ? 'When' : 'and'}</span>
                  <select
                    aria-label="Column"
                    value={condition.columnId}
                    onChange={event => {
                      const next = usable.find(item => item.id === event.target.value)
                      if (!next) return
                      const op = ruleOpsFor(next)[0]
                      patchCondition(rule.id, index, { columnId: next.id, op, value: op === 'within' ? '7' : '' })
                    }}
                  >
                    {usable.map(item => (
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
                      patchCondition(rule.id, index, { op, value: op === 'within' ? '7' : '' })
                    }}
                  >
                    {(column ? ruleOpsFor(column) : []).map(op => (
                      <option key={op} value={op}>
                        {ruleOpLabel(op)}
                      </option>
                    ))}
                  </select>
                  {valueBox(rule, condition, index)}
                  {rule.conditions.length > 1 && (
                    <button
                      type="button"
                      className="trk-icon-button"
                      aria-label="Remove this condition"
                      onClick={() =>
                        patch(rule.id, current => ({
                          ...current,
                          conditions: current.conditions.filter((_item, position) => position !== index),
                        }))
                      }
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              )
            })}
            <div className="trk-rule-foot">
              <span className="trk-rule-colors" role="group" aria-label="Colour">
                {HIGHLIGHTS.map(item => (
                  <button
                    type="button"
                    key={item.color}
                    className={`trk-swatch trk-tone-${item.color}${rule.color === item.color ? ' on' : ''}`}
                    aria-label={item.label}
                    aria-pressed={rule.color === item.color}
                    title={item.label}
                    onClick={() => patch(rule.id, current => ({ ...current, color: item.color }))}
                  />
                ))}
              </span>
              <span className="trk-rule-tools">
                {rule.conditions.length < RULE_LIMITS.conditions && usable.length > 0 && (
                  <button
                    type="button"
                    className="trk-text-button"
                    onClick={() =>
                      patch(rule.id, current => {
                        const column = usable[0],
                          op = ruleOpsFor(column)[0]
                        return {
                          ...current,
                          conditions: [
                            ...current.conditions,
                            { columnId: column.id, op, value: op === 'within' ? '7' : '' },
                          ],
                        }
                      })
                    }
                  >
                    + And
                  </button>
                )}
                <label className="trk-checkline">
                  <input
                    type="checkbox"
                    checked={!rule.off}
                    onChange={event =>
                      patch(rule.id, current => {
                        const { off: _off, ...rest } = current
                        return event.target.checked ? rest : { ...rest, off: true }
                      })
                    }
                  />{' '}
                  On
                </label>
                <button
                  type="button"
                  className="trk-icon-button"
                  aria-label="Move rule up"
                  disabled={at === 0}
                  onClick={() => move(at, -1)}
                >
                  <ArrowUp size={13} />
                </button>
                <button
                  type="button"
                  className="trk-icon-button"
                  aria-label="Move rule down"
                  disabled={at === rules.length - 1}
                  onClick={() => move(at, 1)}
                >
                  <ArrowDown size={13} />
                </button>
                <button
                  type="button"
                  className="trk-icon-button"
                  aria-label="Delete rule"
                  onClick={() => setRules(current => current.filter(item => item.id !== rule.id))}
                >
                  <Trash2 size={13} />
                </button>
              </span>
            </div>
            <small className="trk-muted">{describeRule(rule, columns, personName)}</small>
          </fieldset>
        ))}
        {rules.length < RULE_LIMITS.rules && usable.length > 0 && (
          <button
            type="button"
            className="trk-button"
            onClick={() => {
              const rule = newRule(columns)
              if (rule) setRules(current => [...current, rule])
            }}
          >
            <Plus size={14} aria-hidden="true" /> Add a rule
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
            Save rules
          </button>
        </div>
      </div>
    </Dialog>
  )
}
