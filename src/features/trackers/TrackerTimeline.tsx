import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { AlertTriangle, CalendarDays, ChevronDown, ChevronRight } from 'lucide-react'
import type { TrackerColumn, TrackerRow } from './trackerModel'
import {
  buildTimeline,
  isoOf,
  monthLabel,
  mondayOf,
  settleTimelineFields,
  shortDate,
  todayNumber,
  weekLabel,
  workingDays,
  type TimelineFields,
  type TimelineItem,
} from './timelineModel'

type Zoom = 'day' | 'week' | 'month'
/** Width of one day, in pixels, for each zoom. */
const DAY_WIDTH: Record<Zoom, number> = { day: 30, week: 12, month: 4 }

type Props = {
  trackerId: string
  columns: TrackerColumn[]
  /** The rows the grid would show: already searched, filtered and sorted. */
  rows: TrackerRow[]
  people: { id: string; name: string }[]
  /** The grid's Group by, when set; it replaces the Phase column. */
  groupBy: string
  onOpenRow: (row: TrackerRow) => void
}

type Saved = { fields?: Partial<TimelineFields>; zoom?: Zoom }
const storageKey = (trackerId: string) => `ba.tracker.timeline.${trackerId}`
function readSaved(trackerId: string): Saved {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey(trackerId)) || '{}')
    return value && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}
function writeSaved(trackerId: string, saved: Saved) {
  try {
    localStorage.setItem(storageKey(trackerId), JSON.stringify(saved))
  } catch {
    /* not remembered */
  }
}

export default function TrackerTimeline({ trackerId, columns, rows, people, groupBy, onOpenRow }: Props) {
  const [saved, setSaved] = useState<Saved>(() => readSaved(trackerId))
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => setSaved(readSaved(trackerId)), [trackerId])
  const update = (next: Saved) => {
    setSaved(next)
    writeSaved(trackerId, next)
  }
  const zoom: Zoom = saved.zoom === 'day' || saved.zoom === 'month' ? saved.zoom : 'week'
  const fields = useMemo(() => {
    const settled = settleTimelineFields(columns, saved.fields || null)
    return groupBy && columns.some(column => column.id === groupBy) ? { ...settled, groupId: groupBy } : settled
  }, [columns, saved.fields, groupBy])
  const today = todayNumber()
  const names = useMemo(() => new Map(people.map(person => [person.id, person.name])), [people])
  const timeline = useMemo(
    () => buildTimeline(rows, columns, fields, { today, personName: id => names.get(id) || '' }),
    [rows, columns, fields, today, names],
  )
  const wbs = columns.find(column => column.type === 'text' && /^wbs$|^#$|^no\.?$/i.test(column.name.trim()))
  const title = columns.find(column => column.type === 'text' && column.id !== wbs?.id)

  const width = DAY_WIDTH[zoom]
  const from = timeline.from
  const days = from === null || timeline.to === null ? 0 : timeline.to - from + 1
  const x = (day: number) => (day - (from ?? 0)) * width

  // Opens on today (or the project start) the first time, and whenever the zoom changes.
  const scrollToDay = (day: number) => {
    const element = scrollRef.current
    if (!element || from === null) return
    element.scrollLeft = Math.max(0, x(day) - 120)
  }
  // Only when the zoom or the range changes, not on every render.
  useEffect(() => {
    if (from === null) return
    const inRange = timeline.to !== null && today >= from && today <= timeline.to
    scrollToDay(inRange ? mondayOf(today) : (timeline.weekOne ?? from))
  }, [zoom, from, timeline.to])

  const dateColumns = columns.filter(column => column.type === 'date')
  if (!dateColumns.length)
    return (
      <div className="trk-empty trk-tl-empty">
        <CalendarDays size={22} aria-hidden="true" />
        <p>
          <strong>No dates to put on a timeline.</strong>
        </p>
        <p className="trk-muted-text">
          Add a Start and an End date column (or start from the Project timeline template), then fill in the dates.
        </p>
      </div>
    )

  if (!rows.length)
    return (
      <div className="trk-empty trk-tl-empty">
        <CalendarDays size={22} aria-hidden="true" />
        <p>
          <strong>No rows to show.</strong>
        </p>
        <p className="trk-muted-text">Add rows in the Grid, or clear the search and filters.</p>
      </div>
    )

  const pick = (key: keyof TimelineFields, label: string, types: string[], allowNone: boolean) => (
    <label className="trk-tl-field">
      {label}
      <select
        value={fields[key]}
        disabled={key === 'groupId' && Boolean(groupBy)}
        title={key === 'groupId' && groupBy ? 'Uses the grid’s Group by. Clear it there to choose here.' : undefined}
        onChange={event => update({ ...saved, fields: { ...fields, [key]: event.target.value } })}
      >
        {allowNone && <option value="">None</option>}
        {columns
          .filter(column => types.includes(column.type))
          .map(column => (
            <option key={column.id} value={column.id}>
              {column.name}
            </option>
          ))}
      </select>
    </label>
  )

  // Header: weeks (or months) on top, then days.
  const weeks: number[] = []
  if (from !== null) for (let day = from; day < from + days; day += 7) weeks.push(day)
  const months: { start: number; length: number }[] = []
  if (from !== null && zoom === 'month')
    for (let day = from; day < from + days; day++) {
      const first = new Date(day * 86_400_000).getUTCDate() === 1 || day === from
      if (first) months.push({ start: day, length: 0 })
      months[months.length - 1].length += 1
    }
  const chartStyle = { '--tl-day': `${width}px`, width: `${days * width}px` } as CSSProperties
  const todayInRange = from !== null && today >= from && today < from + days

  const bar = (item: TimelineItem) => {
    if (item.start === null || item.end === null) return <span className="trk-tl-nodate">No dates</span>
    const span = item.end - item.start + 1
    const tone = item.status?.color || 'blue'
    const range = `${shortDate(item.start, true)}${span > 1 ? ` – ${shortDate(item.end, true)}` : ''}`
    const tip = [
      title ? String(item.row.cells[title.id] || '') : '',
      range,
      `${workingDays(item.start, item.end)} working day${workingDays(item.start, item.end) === 1 ? '' : 's'}`,
      `${item.progress}% done`,
      item.status?.label || '',
      item.lead ? `Lead: ${item.lead}` : '',
      item.late ? 'Past its end date' : '',
    ]
      .filter(Boolean)
      .join(' · ')
    return (
      <button
        type="button"
        className={`trk-tl-bar trk-tone-${tone}${item.late ? ' late' : ''}${item.progress >= 100 ? ' done' : ''}`}
        style={{ left: x(item.start), width: Math.max(span * width, 6) }}
        title={tip}
        aria-label={tip}
        onClick={() => onOpenRow(item.row)}
      >
        <span className="trk-tl-fill" style={{ width: `${item.progress}%` }} />
        {span * width >= 44 && <span className="trk-tl-pct">{item.progress}%</span>}
      </button>
    )
  }

  return (
    <div className="trk-tl">
      <div className="trk-tl-toolbar">
        {pick('startId', 'Start', ['date'], false)}
        {pick('endId', 'End', ['date'], true)}
        {pick('progressId', '% done', ['number', 'formula'], true)}
        {pick('groupId', 'Group by', ['select', 'text', 'person'], true)}
        {pick('statusId', 'Colour by', ['select'], true)}
        {pick('leadId', 'Lead', ['text', 'person'], true)}
        <span className="trk-spacer" />
        <div className="trk-segmented" role="group" aria-label="Zoom">
          {(['day', 'week', 'month'] as Zoom[]).map(level => (
            <button
              key={level}
              type="button"
              className={level === zoom ? 'on' : ''}
              aria-pressed={level === zoom}
              onClick={() => update({ ...saved, zoom: level })}
            >
              {level === 'day' ? 'Days' : level === 'week' ? 'Weeks' : 'Months'}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="trk-button"
          disabled={!todayInRange}
          onClick={() => scrollToDay(mondayOf(today))}
        >
          Today
        </button>
      </div>
      {timeline.unscheduled > 0 && (
        <p className="trk-tl-note" role="status">
          <AlertTriangle size={13} aria-hidden="true" /> {timeline.unscheduled} row
          {timeline.unscheduled === 1 ? ' has' : 's have'} no dates yet. They are listed without a bar.
        </p>
      )}
      <div className="trk-tl-scroll" ref={scrollRef}>
        <div className="trk-tl-table" style={{ width: `calc(var(--tl-left) + ${days * width}px)` }}>
          <div className="trk-tl-row trk-tl-head">
            <div className="trk-tl-left trk-tl-lefthead">
              <span className="trk-tl-name">Task</span>
              <span className="trk-tl-meta">Lead</span>
              <span className="trk-tl-num">Days</span>
              <span className="trk-tl-num">Done</span>
            </div>
            <div className="trk-tl-chart trk-tl-scale" style={chartStyle}>
              <div className="trk-tl-weeks">
                {zoom === 'month'
                  ? months.map(month => (
                      <span key={month.start} style={{ width: month.length * width }}>
                        {monthLabel(month.start)}
                      </span>
                    ))
                  : weeks.map(week => (
                      <span key={week} style={{ width: 7 * width }} title={`Week of ${isoOf(week)}`}>
                        {timeline.weekOne !== null && <b>{weekLabel(week, timeline.weekOne)}</b>}
                        <small>{shortDate(week, zoom === 'day')}</small>
                      </span>
                    ))}
              </div>
              {zoom === 'day' && from !== null && (
                <div className="trk-tl-days">
                  {Array.from({ length: days }, (_, at) => {
                    const day = from + at
                    const date = new Date(day * 86_400_000)
                    return (
                      <span key={day} className={day === today ? 'today' : ''}>
                        <b>{'SMTWTFS'[date.getUTCDay()]}</b>
                        {date.getUTCDate()}
                      </span>
                    )
                  })}
                </div>
              )}
            </div>
          </div>

          <div className="trk-tl-body">
            {todayInRange && (
              <span
                className="trk-tl-today"
                style={{ left: `calc(var(--tl-left) + ${x(today) + width / 2}px)` }}
                title={`Today, ${shortDate(today, true)}`}
              />
            )}
            {timeline.groups.map(group => {
              const closed = collapsed.has(group.key)
              return (
                <div key={group.key || 'all'} className="trk-tl-group">
                  {group.label && (
                    <div className="trk-tl-row trk-tl-grouprow">
                      <div className="trk-tl-left">
                        <button
                          type="button"
                          className="trk-tl-toggle"
                          aria-expanded={!closed}
                          onClick={() =>
                            setCollapsed(current => {
                              const next = new Set(current)
                              if (next.has(group.key)) next.delete(group.key)
                              else next.add(group.key)
                              return next
                            })
                          }
                        >
                          {closed ? (
                            <ChevronRight size={14} aria-hidden="true" />
                          ) : (
                            <ChevronDown size={14} aria-hidden="true" />
                          )}
                          <span className="trk-tl-name">{group.label}</span>
                        </button>
                        <span className="trk-tl-meta">{group.items.length}</span>
                        <span className="trk-tl-num">
                          {group.start !== null && group.end !== null ? workingDays(group.start, group.end) : ''}
                        </span>
                        <span className="trk-tl-num">{group.progress}%</span>
                      </div>
                      <div className="trk-tl-chart" style={chartStyle}>
                        {group.start !== null && group.end !== null && (
                          <span
                            className="trk-tl-summary"
                            style={{ left: x(group.start), width: (group.end - group.start + 1) * width }}
                            title={`${group.label}: ${shortDate(group.start, true)} – ${shortDate(group.end, true)} · ${group.progress}% done`}
                          >
                            <span className="trk-tl-fill" style={{ width: `${group.progress}%` }} />
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                  {!closed &&
                    group.items.map(item => (
                      <div key={item.row.id} className="trk-tl-row">
                        <div className="trk-tl-left">
                          <button type="button" className="trk-tl-name trk-tl-open" onClick={() => onOpenRow(item.row)}>
                            {wbs && item.row.cells[wbs.id] ? (
                              <span className="trk-tl-wbs">{String(item.row.cells[wbs.id])}</span>
                            ) : null}
                            {(title && String(item.row.cells[title.id] || '')) || 'Untitled row'}
                          </button>
                          <span className="trk-tl-meta" title={item.lead}>
                            {item.lead}
                          </span>
                          <span className="trk-tl-num">
                            {item.start !== null && item.end !== null ? workingDays(item.start, item.end) : ''}
                          </span>
                          <span className={`trk-tl-num${item.late ? ' late' : ''}`}>{item.progress}%</span>
                        </div>
                        <div className="trk-tl-chart" style={chartStyle}>
                          {bar(item)}
                        </div>
                      </div>
                    ))}
                </div>
              )
            })}
          </div>
        </div>
      </div>
      <p className="trk-tl-legend">
        Bars fill in by % done. <span className="trk-tl-key late" /> past the end date and not finished.{' '}
        <span className="trk-tl-key today" /> today. Click a bar or task to open the row.
      </p>
    </div>
  )
}
