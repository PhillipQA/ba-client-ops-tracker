/**
 * Calendar view: the rows shown (after search and filters) on a month or a week, by one Date column.
 * Dragging a row to another day changes its date; rows with no date wait below, to be dragged on.
 * Clicking a day's + adds a row on that day.
 */
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react'
import { useState } from 'react'
import {
  calendarField,
  calendarFields,
  calendarTitle,
  monthDays,
  rowsByDay,
  stepAnchor,
  weekDays,
} from './trackerBoard'
import type { Cell, OptionColor, TrackerColumn, TrackerRow } from './trackerModel'
import { rowTitle } from './trackerQuery'
import { plural } from './trackerUi'

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const MONTH_CHIPS = 3

export default function TrackerCalendar({
  trackerId,
  columns,
  rows,
  tones,
  today,
  canEdit,
  isLocked,
  onEdit,
  onOpenRow,
  onAdd,
}: {
  trackerId: string
  columns: TrackerColumn[]
  rows: TrackerRow[]
  tones: ReadonlyMap<string, OptionColor>
  /** Today as YYYY-MM-DD, in the business time zone. */
  today: string
  canEdit: boolean
  isLocked: (row: TrackerRow, column: TrackerColumn) => boolean
  onEdit: (row: TrackerRow, column: TrackerColumn, value: Cell) => void
  onOpenRow: (row: TrackerRow) => void
  /** Adds a row with this date. */
  onAdd?: (column: TrackerColumn, day: string) => void
}) {
  const key = `ba.tracker.calendar.${trackerId}`
  const [chosen, setChosen] = useState(() => {
    try {
      return localStorage.getItem(key) || ''
    } catch {
      return ''
    }
  })
  const [mode, setMode] = useState<'month' | 'week'>('month')
  const [anchor, setAnchor] = useState(today)
  const [dragging, setDragging] = useState('')
  const [over, setOver] = useState('')
  const [expanded, setExpanded] = useState('')
  const fields = calendarFields(columns)
  const field = calendarField(columns, chosen)
  if (!field)
    return (
      <p className="trk-view-empty">
        The calendar needs a Date column to place rows by, such as Go-live. Add one in the Grid.
      </p>
    )
  const days = mode === 'month' ? monthDays(anchor) : weekDays(anchor)
  const { byDay, undated } = rowsByDay(rows, field)
  const dragged = dragging ? rows.find(row => row.id === dragging) : undefined
  const drop = (day: string) => {
    setOver('')
    setDragging('')
    if (!dragged || isLocked(dragged, field)) return
    onEdit(dragged, field, day)
  }
  const chip = (row: TrackerRow) => {
    const tone = tones.get(row.id)
    const locked = isLocked(row, field)
    return (
      <button
        type="button"
        key={row.id}
        className={`trk-cal-chip${tone ? ` trk-hl trk-tone-${tone}` : ''}${dragging === row.id ? ' dragging' : ''}`}
        draggable={canEdit && !locked}
        title={
          locked ? `${rowTitle(columns, row)}: its ${field.name} comes from the Google Sheet` : rowTitle(columns, row)
        }
        onDragStart={event => {
          event.dataTransfer.effectAllowed = 'move'
          event.dataTransfer.setData('text/plain', rowTitle(columns, row))
          setDragging(row.id)
        }}
        onDragEnd={() => {
          setDragging('')
          setOver('')
        }}
        onClick={() => onOpenRow(row)}
      >
        {rowTitle(columns, row)}
      </button>
    )
  }
  const month = anchor.slice(0, 7)
  return (
    <div className="trk-cal-wrap">
      <div className="trk-view-bar">
        <span className="trk-cal-nav">
          <button
            type="button"
            className="trk-icon-button"
            aria-label={mode === 'month' ? 'Previous month' : 'Previous week'}
            onClick={() => setAnchor(stepAnchor(anchor, mode, -1))}
          >
            <ChevronLeft size={16} />
          </button>
          <strong>{calendarTitle(anchor, mode)}</strong>
          <button
            type="button"
            className="trk-icon-button"
            aria-label={mode === 'month' ? 'Next month' : 'Next week'}
            onClick={() => setAnchor(stepAnchor(anchor, mode, 1))}
          >
            <ChevronRight size={16} />
          </button>
          <button type="button" className="trk-button" onClick={() => setAnchor(today)}>
            Today
          </button>
        </span>
        <span className="trk-cal-tools">
          <label>
            Dates from{' '}
            <select
              value={field.id}
              onChange={event => {
                setChosen(event.target.value)
                try {
                  localStorage.setItem(key, event.target.value)
                } catch {
                  /* not remembered */
                }
              }}
            >
              {fields.map(column => (
                <option key={column.id} value={column.id}>
                  {column.name}
                </option>
              ))}
            </select>
          </label>
          <span className="trk-segmented" role="group" aria-label="Calendar range">
            <button
              type="button"
              className={mode === 'month' ? 'on' : ''}
              aria-pressed={mode === 'month'}
              onClick={() => setMode('month')}
            >
              Month
            </button>
            <button
              type="button"
              className={mode === 'week' ? 'on' : ''}
              aria-pressed={mode === 'week'}
              onClick={() => setMode('week')}
            >
              Week
            </button>
          </span>
        </span>
      </div>
      <div className={`trk-cal ${mode}`} role="grid" aria-label={`${field.name}, ${calendarTitle(anchor, mode)}`}>
        <div role="row" className="trk-cal-head">
          {WEEKDAYS.map(name => (
            <span role="columnheader" key={name}>
              {name}
            </span>
          ))}
        </div>
        {Array.from({ length: days.length / 7 }, (_week, week) => (
          <div role="row" className="trk-cal-week" key={days[week * 7]}>
            {days.slice(week * 7, week * 7 + 7).map(day => {
              const here = byDay.get(day) || []
              const all = mode === 'week' || expanded === day || here.length <= MONTH_CHIPS
              return (
                <div
                  role="gridcell"
                  key={day}
                  className={`trk-cal-day${day.slice(0, 7) !== month && mode === 'month' ? ' other' : ''}${day === today ? ' today' : ''}${over === day && dragged ? ' over' : ''}`}
                  onDragOver={event => {
                    if (!dragged) return
                    event.preventDefault()
                    event.dataTransfer.dropEffect = 'move'
                    if (over !== day) setOver(day)
                  }}
                  onDrop={event => {
                    event.preventDefault()
                    drop(day)
                  }}
                >
                  <span className="trk-cal-date">
                    <b>{Number(day.slice(8))}</b>
                    {canEdit && onAdd && (
                      <button
                        type="button"
                        className="trk-cal-add"
                        aria-label={`Add a row on ${day}`}
                        title="Add a row on this day"
                        onClick={() => onAdd(field, day)}
                      >
                        <Plus size={12} />
                      </button>
                    )}
                  </span>
                  {(all ? here : here.slice(0, MONTH_CHIPS - 1)).map(chip)}
                  {!all && (
                    <button type="button" className="trk-cal-more" onClick={() => setExpanded(day)}>
                      +{here.length - (MONTH_CHIPS - 1)} more
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        ))}
      </div>
      {undated.length > 0 && (
        <section
          className={`trk-cal-undated${over === 'none' && dragged ? ' over' : ''}`}
          aria-label={`Rows with no ${field.name}`}
          onDragOver={event => {
            if (!dragged) return
            event.preventDefault()
            if (over !== 'none') setOver('none')
          }}
          onDrop={event => {
            event.preventDefault()
            drop('')
          }}
        >
          <strong>
            No {field.name} · {plural(undated.length, 'row')}
          </strong>
          {canEdit && <small className="trk-muted"> Drag one onto a day to give it a date.</small>}
          <div className="trk-cal-undated-list">{undated.slice(0, 60).map(chip)}</div>
          {undated.length > 60 && (
            <small className="trk-muted">And {undated.length - 60} more: filter to see them.</small>
          )}
        </section>
      )}
      <p className="trk-muted trk-cal-foot">
        {days[0] <= today && today <= days[days.length - 1] ? '' : 'Today is not on this page. '}
        {canEdit ? 'Drag a row to another day to change its date.' : ''}
      </p>
    </div>
  )
}
