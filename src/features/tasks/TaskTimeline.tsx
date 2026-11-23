/**
 * The Tasks page's Timeline: each filtered task as a bar from its start date to its due date (a diamond when it has
 * only one of them), subtasks under their task, today marked, and an arrow from each blocking task to the task it
 * blocks. A task that starts before an open blocker is due is outlined, so clashes stand out. Click to open a task.
 */
import { AlertTriangle, Lock } from 'lucide-react'
import { useMemo, useState } from 'react'
import { isTaskClosed } from '../../app/store'
import type { TaskSettings, WorkItem } from '../../shared/types'
import { blockedText, dependencyLinks, openBlockersOf } from './dependencies'
import { addDay, DAY_WIDTH, daysBetween, type TimelineZoom, timelineRange, timelineRows, weekday } from './taskViews'

const ROW = 34
const MAX_ROWS = 400

type Props = {
  items: WorkItem[]
  allItems: WorkItem[]
  taskSettings: TaskSettings
  today: string
  onOpen?: (id: string) => void
}

const shortDay = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString('en', { month: 'short', day: 'numeric', timeZone: 'UTC' })

export default function TaskTimeline({ items, allItems, taskSettings, today, onOpen }: Props) {
  const [zoom, setZoom] = useState<TimelineZoom>('week')
  const allRows = useMemo(() => timelineRows(items), [items])
  const rows = allRows.slice(0, MAX_ROWS)
  const byId = useMemo(() => new Map(allItems.map(item => [item.id, item])), [allItems])
  const range = useMemo(
    () =>
      timelineRange(
        rows.map(row => row.span),
        today,
      ),
    [rows, today],
  )
  const width = DAY_WIDTH[zoom]
  const x = (day: string) => daysBetween(range.start, day) * width
  const rowOf = new Map(rows.map((row, at) => [row.item.id, at]))
  const links = dependencyLinks(rows.map(row => row.item)).filter(link => rowOf.has(link.from) && rowOf.has(link.to))
  const undated = items.length - allRows.length

  // Header: months, and days (Week) or week starts (Month).
  const days = Array.from({ length: range.days }, (_, at) => addDay(range.start, at))
  const months = days.filter((day, at) => at === 0 || day.endsWith('-01'))
  const ticks = zoom === 'week' ? days : days.filter(day => weekday(day) === 0)

  /** An open blocker due after this task starts: the task can't really start on time. */
  const clash = (item: WorkItem, start: string) =>
    openBlockersOf(item, allItems, taskSettings, byId).some(blocker => {
      const at = rowOf.get(blocker.id)
      const end = at === undefined ? blocker.dueDate : rows[at].span.end
      return Boolean(end && end >= start)
    })

  return (
    <div className="task-timeline">
      <div className="task-tl-bar">
        <div className="client-layout-switch" role="group" aria-label="Timeline zoom">
          {(['week', 'month'] as const).map(level => (
            <button key={level} type="button" aria-pressed={zoom === level} onClick={() => setZoom(level)}>
              <span>{level === 'week' ? 'Days' : 'Weeks'}</span>
            </button>
          ))}
        </div>
        <span className="muted">
          Bars run from start to due date; ◆ marks a task with only one of them. Arrows go from a blocking task to the
          task it blocks.
        </span>
        {undated > 0 && <span className="muted">{undated} without a start or due date aren’t shown.</span>}
        {allRows.length > MAX_ROWS && (
          <span className="muted">Showing the first {MAX_ROWS}; narrow the filters to see the rest.</span>
        )}
      </div>
      {!rows.length ? (
        <p className="muted task-tl-empty">No tasks here have a start or due date yet.</p>
      ) : (
        <div className="task-tl-scroll">
          <div className="task-tl-grid" style={{ width: 260 + range.days * width }}>
            <div className="task-tl-head">
              <div className="task-tl-label task-tl-corner">Task</div>
              <div className="task-tl-track" style={{ width: range.days * width }}>
                {months.map(day => (
                  <span key={`m${day}`} className="task-tl-month" style={{ left: x(day) }}>
                    {new Date(`${day}T00:00:00Z`).toLocaleDateString('en', {
                      month: 'short',
                      year: 'numeric',
                      timeZone: 'UTC',
                    })}
                  </span>
                ))}
                {ticks.map(day => (
                  <span
                    key={`d${day}`}
                    className="task-tl-tick"
                    style={{ left: x(day), width: zoom === 'week' ? width : 7 * width }}
                  >
                    {Number(day.slice(8))}
                  </span>
                ))}
              </div>
            </div>
            <div className="task-tl-body" style={{ height: rows.length * ROW }}>
              <div
                className="task-tl-today"
                style={{ left: 260 + x(today) + width / 2 }}
                title={`Today, ${shortDay(today)}`}
              />
              <svg
                className="task-tl-links"
                width={range.days * width}
                height={rows.length * ROW}
                style={{ left: 260 }}
                aria-hidden="true"
              >
                <defs>
                  <marker
                    id="task-tl-arrow"
                    viewBox="0 0 8 8"
                    refX="7"
                    refY="4"
                    markerWidth="7"
                    markerHeight="7"
                    orient="auto"
                  >
                    <path d="M0,0 L8,4 L0,8 z" />
                  </marker>
                </defs>
                {links.map(link => {
                  const from = rows[rowOf.get(link.from) as number]
                  const to = rows[rowOf.get(link.to) as number]
                  const x1 = x(from.span.end) + width
                  const y1 = (rowOf.get(link.from) as number) * ROW + ROW / 2
                  const x2 = x(to.span.start)
                  const y2 = (rowOf.get(link.to) as number) * ROW + ROW / 2
                  const bend = Math.max(x1 + 8, Math.min(x2 - 8, x1 + 16))
                  return (
                    <path
                      key={`${link.from}>${link.to}`}
                      d={`M${x1},${y1} H${bend} V${y2} H${x2}`}
                      markerEnd="url(#task-tl-arrow)"
                    />
                  )
                })}
              </svg>
              {rows.map(({ item, span, depth }, at) => {
                const closed = isTaskClosed(item.status, taskSettings)
                const blocked = closed ? '' : blockedText(openBlockersOf(item, allItems, taskSettings, byId))
                const late = !closed && clash(item, span.start)
                const dates = span.milestone ? shortDay(span.start) : `${shortDay(span.start)} – ${shortDay(span.end)}`
                const tip = [
                  item.title,
                  dates,
                  item.status,
                  blocked,
                  late ? 'Starts before a blocking task is due' : '',
                ]
                  .filter(Boolean)
                  .join(' · ')
                return (
                  <div className="task-tl-row" key={item.id} style={{ top: at * ROW, height: ROW }}>
                    <button
                      type="button"
                      className={`task-tl-label${depth ? ' is-subtask' : ''}`}
                      title={tip}
                      disabled={!onOpen}
                      onClick={() => onOpen?.(item.id)}
                    >
                      {blocked && <Lock size={12} aria-label="Blocked" />}
                      <span>{item.title}</span>
                    </button>
                    <button
                      type="button"
                      className={`task-tl-bar-item${span.milestone ? ' is-milestone' : ''}${closed ? ' is-closed' : ''}${late ? ' is-clash' : ''}`}
                      style={{
                        left: 260 + x(span.start),
                        width: span.milestone
                          ? undefined
                          : Math.max(width, (daysBetween(span.start, span.end) + 1) * width),
                      }}
                      title={tip}
                      aria-label={tip}
                      disabled={!onOpen}
                      onClick={() => onOpen?.(item.id)}
                    >
                      {late && <AlertTriangle size={11} aria-hidden="true" />}
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
