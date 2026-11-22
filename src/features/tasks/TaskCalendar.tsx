/**
 * The Tasks page's Calendar: the filtered tasks on a month grid by their due date (or follow-up date). Overdue open
 * work is marked, closed work is muted, and tasks still blocked by open work show a lock. Clicking a task opens it.
 */
import { ChevronLeft, ChevronRight, Lock } from 'lucide-react'
import { useMemo, useState } from 'react'
import { isTaskClosed } from '../../app/store'
import type { TaskSettings, WorkItem } from '../../shared/types'
import { blockedText, openBlockersOf } from './dependencies'
import { type CalendarDate, itemsByDay, monthGrid, monthOf, shiftMonth } from './taskViews'

const SHOWN_PER_DAY = 3
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

type Props = {
  items: WorkItem[]
  allItems: WorkItem[]
  taskSettings: TaskSettings
  today: string
  dateField: CalendarDate
  onOpen?: (id: string) => void
}

export default function TaskCalendar({ items, allItems, taskSettings, today, dateField, onOpen }: Props) {
  const [month, setMonth] = useState(() => monthOf(today))
  const [openDay, setOpenDay] = useState('')
  const byDay = useMemo(() => itemsByDay(items, dateField), [items, dateField])
  const byId = useMemo(() => new Map(allItems.map(item => [item.id, item])), [allItems])
  const weeks = monthGrid(month)
  const undated = items.filter(item => !(dateField === 'due' ? item.dueDate : item.followUpDate)).length
  const title = new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })
  const field = dateField === 'due' ? 'due date' : 'follow-up date'

  const chip = (item: WorkItem) => {
    const closed = isTaskClosed(item.status, taskSettings)
    const day = dateField === 'due' ? item.dueDate : item.followUpDate
    const late = !closed && Boolean(day && day < today)
    const blocked = closed ? '' : blockedText(openBlockersOf(item, allItems, taskSettings, byId))
    const tip = [item.title, item.status, blocked].filter(Boolean).join(' · ')
    return (
      <li key={item.id}>
        <button
          type="button"
          className={`task-cal-chip${closed ? ' is-closed' : ''}${late ? ' is-late' : ''}`}
          title={tip}
          disabled={!onOpen}
          onClick={() => onOpen?.(item.id)}
        >
          {blocked && <Lock size={11} aria-label="Blocked" />}
          {item.parentTaskId && <span aria-hidden="true">↳ </span>}
          <span>{item.title}</span>
        </button>
      </li>
    )
  }

  return (
    <div className="task-calendar">
      <div className="task-cal-bar">
        <button type="button" className="icon-button" aria-label="Previous month" onClick={() => setMonth(shiftMonth(month, -1))}>
          <ChevronLeft size={16} />
        </button>
        <h3 aria-live="polite">{title}</h3>
        <button type="button" className="icon-button" aria-label="Next month" onClick={() => setMonth(shiftMonth(month, 1))}>
          <ChevronRight size={16} />
        </button>
        <button type="button" className="secondary" onClick={() => setMonth(monthOf(today))}>
          Today
        </button>
        {undated > 0 && (
          <span className="muted task-cal-undated">
            {undated} without a {field}
          </span>
        )}
      </div>
      <div className="task-cal-grid" role="table" aria-label={`Tasks by ${field}, ${title}`}>
        <div className="task-cal-row task-cal-head" role="row">
          {WEEKDAYS.map(name => (
            <div key={name} role="columnheader">
              {name}
            </div>
          ))}
        </div>
        {weeks.map(week => (
          <div className="task-cal-row" role="row" key={week[0]}>
            {week.map(day => {
              const list = byDay.get(day) || []
              const expanded = openDay === day
              const shown = expanded ? list : list.slice(0, SHOWN_PER_DAY)
              return (
                <div
                  key={day}
                  role="cell"
                  className={`task-cal-day${monthOf(day) !== month ? ' is-other' : ''}${day === today ? ' is-today' : ''}`}
                >
                  <span className="task-cal-date">{Number(day.slice(8))}</span>
                  {list.length > 0 && <ul>{shown.map(chip)}</ul>}
                  {list.length > SHOWN_PER_DAY && (
                    <button type="button" className="link-button task-cal-more" onClick={() => setOpenDay(expanded ? '' : day)}>
                      {expanded ? 'Show less' : `+${list.length - SHOWN_PER_DAY} more`}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}
