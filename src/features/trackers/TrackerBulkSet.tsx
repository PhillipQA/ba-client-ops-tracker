/**
 * Bulk edit: "Set <column> to <value>" for the selected rows. Shows what will change before anything is saved: how many
 * rows, how many already have the value, how many are skipped because their cell comes from the Google Sheet.
 */
import { useMemo, useState } from 'react'
import { bulkColumns, bulkValue, planBulk, type BulkPlan } from './trackerBulk'
import type { Person } from './TrackerCells'
import type { Cell, TrackerColumn, TrackerRow } from './trackerModel'
import { plural } from './trackerUi'

export default function TrackerBulkSet({
  rows,
  columns,
  people,
  isLocked,
  onApply,
  onClose,
}: {
  rows: TrackerRow[]
  columns: TrackerColumn[]
  people: Person[]
  isLocked: (row: TrackerRow, column: TrackerColumn) => boolean
  onApply: (column: TrackerColumn, value: Cell, plan: BulkPlan) => void
  onClose: () => void
}) {
  const choices = useMemo(() => bulkColumns(columns), [columns])
  const [columnId, setColumnId] = useState(choices.find(column => column.type === 'select')?.id || choices[0]?.id || '')
  const [raw, setRaw] = useState('')
  const column = choices.find(item => item.id === columnId)
  const parsed = column ? bulkValue(column, raw) : { error: 'Pick a column.' }
  const plan = column && 'value' in parsed ? planBulk(rows, column, parsed.value, isLocked) : null
  if (!choices.length)
    return <p className="trk-muted-text">This tracker has no column that can be set for several rows at once.</p>

  const valueBox = () => {
    if (!column) return null
    const label = `New ${column.name}`
    if (column.type === 'select')
      return (
        <select aria-label={label} value={raw} onChange={event => setRaw(event.target.value)}>
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
        <select aria-label={label} value={raw} onChange={event => setRaw(event.target.value)}>
          <option value="">(nobody)</option>
          {[...people]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(person => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
        </select>
      )
    if (column.type === 'checkbox')
      return (
        <select aria-label={label} value={raw || 'false'} onChange={event => setRaw(event.target.value)}>
          <option value="true">Ticked</option>
          <option value="false">Not ticked</option>
        </select>
      )
    return (
      <input
        aria-label={label}
        type={column.type === 'date' ? 'date' : 'text'}
        inputMode={column.type === 'number' ? 'decimal' : undefined}
        value={raw}
        placeholder={column.type === 'number' ? 'A number, or empty to clear' : 'Empty clears the cells'}
        onChange={event => setRaw(event.target.value)}
      />
    )
  }

  return (
    <form
      className="trk-bulk-set"
      onSubmit={event => {
        event.preventDefault()
        if (column && plan?.change.length && 'value' in parsed) onApply(column, parsed.value, plan)
      }}
    >
      <strong>Set a value for {plural(rows.length, 'selected row')}</strong>
      <label>
        Column
        <select
          value={columnId}
          onChange={event => {
            setColumnId(event.target.value)
            setRaw('')
          }}
        >
          {choices.map(item => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        New value
        {valueBox()}
      </label>
      {'error' in parsed && raw.trim() !== '' && <p className="trk-field-error">{parsed.error}</p>}
      {plan && (
        <ul className="trk-bulk-plan">
          <li>
            <b>{plural(plan.change.length, 'row')}</b> will change
            {plan.withTask > 0 && `; ${plural(plan.withTask, 'linked task')} may follow`}
          </li>
          {plan.same > 0 && (
            <li>
              {plural(plan.same, 'row')} already {plan.same === 1 ? 'has' : 'have'} this value
            </li>
          )}
          {plan.locked.length > 0 && (
            <li>
              {plural(plan.locked.length, 'row')} skipped: this column comes from the Google Sheet for{' '}
              {plan.locked.length === 1 ? 'it' : 'them'}
            </li>
          )}
        </ul>
      )}
      <div className="trk-bulk-actions">
        <button type="button" className="trk-button" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="trk-button primary" disabled={!plan?.change.length}>
          {plan?.change.length ? `Apply to ${plural(plan.change.length, 'row')}` : 'Nothing to change'}
        </button>
      </div>
    </form>
  )
}
