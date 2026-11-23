/**
 * The task form's Repeat: every N days / weeks / months / years, the weekdays for weekly, workdays only for daily, and
 * an optional end date. Shows when the next copy would be due if the task were closed today.
 */
import { Repeat } from 'lucide-react'
import './taskViews.css'
import { cleanRecurrence, nextDueDay, type Recurrence, recurrenceText, type RepeatUnit } from './recurrence'

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const UNITS: { value: RepeatUnit; one: string; many: string }[] = [
  { value: 'day', one: 'day', many: 'days' },
  { value: 'week', one: 'week', many: 'weeks' },
  { value: 'month', one: 'month', many: 'months' },
  { value: 'year', one: 'year', many: 'years' },
]

type Props = {
  value: Recurrence | undefined
  onChange: (rule: Recurrence | undefined) => void
  /** The task's dates as typed now, for the defaults and the preview. */
  dates: { dueDate?: string; startDate?: string; followUpDate?: string }
  today: string
  disabled?: boolean
}

const weekdayOf = (day: string | undefined) =>
  day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? new Date(`${day}T00:00:00Z`).getUTCDay() : undefined

export function RepeatField({ value, onChange, dates, today, disabled }: Props) {
  const anchor = dates.dueDate || dates.startDate || dates.followUpDate || today
  const set = (change: Partial<Recurrence>) => {
    const rule = cleanRecurrence({ ...(value || { every: 1, unit: 'week' }), ...change })
    onChange(rule)
  }
  const start = (unit: RepeatUnit) =>
    onChange(
      cleanRecurrence({
        every: 1,
        unit,
        weekdays: unit === 'week' ? [weekdayOf(anchor) ?? 1] : undefined,
        monthDay: unit === 'month' ? Number(anchor.slice(8)) : undefined,
      }),
    )
  const next = value ? nextDueDay(dates, value, today) : null
  const unit = UNITS.find(candidate => candidate.value === value?.unit)

  return (
    <div className="span-2 repeat-field">
      <label>
        Repeat
        <select
          value={value?.unit || ''}
          disabled={disabled}
          onChange={event => (event.target.value ? start(event.target.value as RepeatUnit) : onChange(undefined))}
        >
          <option value="">Doesn’t repeat</option>
          <option value="day">Daily</option>
          <option value="week">Weekly</option>
          <option value="month">Monthly</option>
          <option value="year">Yearly</option>
        </select>
      </label>
      {value && unit && (
        <>
          <label className="repeat-every">
            Every
            <input
              type="number"
              min={1}
              max={99}
              value={value.every}
              disabled={disabled}
              onChange={event => set({ every: Number(event.target.value) || 1 })}
            />
            <span>{value.every === 1 ? unit.one : unit.many}</span>
          </label>
          {value.unit === 'week' && (
            <fieldset className="repeat-weekdays" disabled={disabled}>
              <legend>On</legend>
              {WEEKDAYS.map((name, day) => {
                const on = value.weekdays?.includes(day) ?? false
                return (
                  <button
                    key={name}
                    type="button"
                    aria-pressed={on}
                    onClick={() => {
                      const days = on ? (value.weekdays || []).filter(d => d !== day) : [...(value.weekdays || []), day]
                      if (days.length) set({ weekdays: days })
                    }}
                  >
                    {name}
                  </button>
                )
              })}
            </fieldset>
          )}
          {value.unit === 'day' && (
            <label className="repeat-check">
              <input
                type="checkbox"
                checked={Boolean(value.workdaysOnly)}
                disabled={disabled}
                onChange={event => set({ workdaysOnly: event.target.checked })}
              />
              Workdays only (skip Saturday and Sunday)
            </label>
          )}
          <label>
            Until (optional)
            <input
              type="date"
              value={value.until || ''}
              disabled={disabled}
              onChange={event => set({ until: event.target.value || undefined })}
            />
          </label>
          <p className="muted repeat-preview">
            <Repeat size={13} aria-hidden="true" /> {recurrenceText(value)}.{' '}
            {next
              ? `When this task is closed, the next one is made, due ${next}, with its subtasks.`
              : 'The end date has passed: closing this task makes no new one.'}
          </p>
        </>
      )}
    </div>
  )
}
