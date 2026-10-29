import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { AlertTriangle, CalendarDays, ChevronDown, ChevronRight } from 'lucide-react'
import type { TrackerColumn, TrackerRow } from './trackerModel'
import {
  buildTimeline,
  draggedDates,
  endAfterWorkingDays,
  isoOf,
  monthLabel,
  mondayOf,
  settleTimelineFields,
  shortDate,
  todayNumber,
  weekLabel,
  workingDays,
  type DragMode,
  type TimelineFields,
  type TimelineItem,
  type TimelineSettings,
  type TimelineZoom,
} from './timelineModel'

type Zoom = TimelineZoom
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
  /** The settings saved on the tracker for everyone. Undefined until the database has schema v29. */
  shared?: TimelineSettings
  /** Saves the settings for everyone. Missing for people who cannot edit the tracker: their changes stay in their browser. */
  onShare?: (settings: TimelineSettings) => Promise<void>
  /** Whether a row's dates can be changed by dragging its bar. */
  canDrag: (row: TrackerRow) => boolean
  /** Writes the dragged dates: Start, and End when there is an End column. */
  onDates: (row: TrackerRow, cells: Record<string, string>) => void
  /** Rows tinted with a colour: their highlight, or their state when colouring by status. */
  tones?: ReadonlyMap<string, string>
}

type Saved = TimelineSettings

/** Widths of the Task and Lead columns, set by dragging their edges. Kept per tracker in this browser. */
type Widths = { task: number; lead: number }
const DEFAULT_WIDTHS: Widths = { task: 240, lead: 120 }
const WIDTH_LIMITS: Record<keyof Widths, [number, number]> = { task: [140, 720], lead: [60, 320] }
const clampWidth = (key: keyof Widths, value: number) =>
  Math.round(Math.min(WIDTH_LIMITS[key][1], Math.max(WIDTH_LIMITS[key][0], value)))
const widthsKey = (trackerId: string) => `ba.tracker.timeline.widths.${trackerId}`
function readWidths(trackerId: string): Widths {
  try {
    const value = JSON.parse(localStorage.getItem(widthsKey(trackerId)) || '{}')
    return {
      task: clampWidth('task', Number(value?.task) || DEFAULT_WIDTHS.task),
      lead: clampWidth('lead', Number(value?.lead) || DEFAULT_WIDTHS.lead),
    }
  } catch {
    return DEFAULT_WIDTHS
  }
}
/** The width text takes in the timeline's font, for fitting a column to its longest entry. */
function textWidth(texts: string[], element: HTMLElement | null, bold = false) {
  const canvas = document.createElement('canvas').getContext('2d')
  if (!canvas) return 0
  const style = element ? getComputedStyle(element) : null
  canvas.font = `${bold ? '700 ' : ''}13px ${style?.fontFamily || 'sans-serif'}`
  return Math.max(0, ...texts.map(text => canvas.measureText(text).width))
}
type Drag = { rowId: string; mode: DragMode; x: number; start: number; end: number; delta: number; moved: boolean }
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

const hasSettings = (settings?: TimelineSettings) => Boolean(settings && (settings.zoom || settings.fields))

export default function TrackerTimeline(props: Props) {
  const { trackerId, columns, rows, people, groupBy, onOpenRow, shared, onShare, canDrag, onDates } = props
  // The tracker's shared settings win; this browser's copy is the fallback before schema v29, and for viewers.
  const [saved, setSaved] = useState<Saved>(() => (hasSettings(shared) ? shared! : readSaved(trackerId)))
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [drag, setDrag] = useState<Drag | null>(null)
  const [widths, setWidths] = useState<Widths>(() => readWidths(trackerId))
  useEffect(() => setWidths(readWidths(trackerId)), [trackerId])
  const resizing = useRef<{ key: keyof Widths; x: number; start: number } | null>(null)
  const [resizingKey, setResizingKey] = useState<keyof Widths | ''>('')
  const saveWidths = (next: Widths) => {
    setWidths(next)
    try {
      localStorage.setItem(widthsKey(trackerId), JSON.stringify(next))
    } catch {
      /* not remembered */
    }
  }
  const dragRef = useRef<Drag | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  // The visible width, so the list never crowds the chart out (see `shown` below).
  const [scrollNode, setScrollNode] = useState<HTMLDivElement | null>(null)
  const [viewWidth, setViewWidth] = useState(0)
  useEffect(() => {
    if (!scrollNode || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(entries => setViewWidth(Math.round(entries[0]?.contentRect.width || 0)))
    observer.observe(scrollNode)
    return () => observer.disconnect()
  }, [scrollNode])
  // The list (Task, Lead, Days, Done) takes at most two-thirds of the visible width, so the chart always shows: on a
  // narrow window Task, then Lead, give way. The widths people chose are kept and come back when there is room.
  const listCap = viewWidth ? Math.round(viewWidth * 0.66) : Number.POSITIVE_INFINITY
  const fitted: Widths = (() => {
    const others = 137 // Days, Done, the gaps, the padding and the border
    const lead = Math.max(WIDTH_LIMITS.lead[0], Math.min(widths.lead, listCap - others - WIDTH_LIMITS.task[0]))
    const task = Math.max(WIDTH_LIMITS.task[0], Math.min(widths.task, listCap - others - lead))
    return { task, lead }
  })()
  const sharedKey = JSON.stringify(shared ?? null)
  // sharedKey stands for `shared`, compared by value, so a new object with the same settings does not reset.
  useEffect(() => setSaved(hasSettings(shared) ? shared! : readSaved(trackerId)), [trackerId, sharedKey])
  const update = (next: Saved) => {
    setSaved(next)
    writeSaved(trackerId, next)
    // Kept in this browser either way; shared when the tracker can hold it.
    if (onShare) void onShare(next).catch(() => undefined)
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
  // Months (with the year) head every zoom, so dates always read as a calendar.
  if (from !== null)
    for (let day = from; day < from + days; day++) {
      const first = new Date(day * 86_400_000).getUTCDate() === 1 || day === from
      if (first) months.push({ start: day, length: 0 })
      months[months.length - 1].length += 1
    }
  const chartStyle = { '--tl-day': `${width}px`, width: `${days * width}px` } as CSSProperties
  const todayInRange = from !== null && today >= from && today < from + days

  const setDragBoth = (next: Drag | null) => {
    dragRef.current = next
    setDrag(next)
  }
  const commit = (item: TimelineItem, start: number, end: number) => {
    if (start === item.start && end === item.end) return
    const cells: Record<string, string> = { [fields.startId]: isoOf(start) }
    if (fields.endId) cells[fields.endId] = isoOf(end)
    onDates(item.row, cells)
  }
  const startDrag = (event: ReactPointerEvent<HTMLElement>, item: TimelineItem, mode: DragMode) => {
    if (event.button !== 0 || item.start === null || item.end === null || !canDrag(item.row)) return
    event.stopPropagation()
    ;(event.currentTarget.closest('.trk-tl-bar') as HTMLElement | null)?.setPointerCapture(event.pointerId)
    setDragBoth({
      rowId: item.row.id,
      mode,
      x: event.clientX,
      start: item.start,
      end: item.end,
      delta: 0,
      moved: false,
    })
  }
  const moveDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const current = dragRef.current
    if (!current) return
    const moved = current.moved || Math.abs(event.clientX - current.x) > 3
    const delta = Math.round((event.clientX - current.x) / width)
    if (delta !== current.delta || moved !== current.moved) setDragBoth({ ...current, delta, moved })
  }
  const endDrag = (item: TimelineItem) => {
    const current = dragRef.current
    if (!current) return
    setDragBoth(null)
    if (current.moved) {
      const next = draggedDates(current.start, current.end, current.mode, current.delta)
      commit(item, next.start, next.end)
    } else onOpenRow(item.row)
  }
  // Keyboard: arrows move the bar a day; Shift with arrows changes the end; Enter opens the row.
  const keyDrag = (event: ReactKeyboardEvent<HTMLElement>, item: TimelineItem) => {
    if (item.start === null || item.end === null || !canDrag(item.row)) return
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (!step) return
    event.preventDefault()
    const next = draggedDates(item.start, item.end, event.shiftKey ? 'end' : 'move', step)
    commit(item, next.start, next.end)
  }

  /** Fits a column to its longest entry: task names (with WBS numbers) and phase names, or leads. */
  const fit = (key: keyof Widths) => {
    const items = timeline.groups.flatMap(group => group.items)
    if (key === 'lead')
      return saveWidths({
        ...widths,
        lead: clampWidth(
          'lead',
          textWidth(
            items.map(item => item.lead),
            scrollRef.current,
          ) + 12,
        ),
      })
    const wbsWidth = wbs
      ? Math.max(
          30,
          textWidth(
            items.map(item => String(item.row.cells[wbs.id] || '')),
            scrollRef.current,
          ),
        ) + 6
      : 0
    const names = textWidth(
      items.map(item => (title && String(item.row.cells[title.id] || '')) || 'Untitled row'),
      scrollRef.current,
    )
    const phases = textWidth(
      timeline.groups.map(group => group.label),
      scrollRef.current,
      true,
    )
    saveWidths({ ...widths, task: clampWidth('task', Math.max(names + wbsWidth, phases + 18) + 14) })
  }
  /**
   * A handle on a border: between Task and Lead, between Lead and Days, or on the list's right edge (which widens
   * Task). Drag it on any row, or double-click to fit the column. The header's handles also take the arrow keys.
   */
  const resizer = (key: keyof Widths, name: string, edge: 'task' | 'lead' | 'panel', header: boolean) => (
    <span
      key={edge}
      className={`trk-tl-resize edge-${edge}`}
      {...(header && edge !== 'panel'
        ? {
            role: 'separator',
            'aria-orientation': 'vertical' as const,
            'aria-label': `Resize the ${name} column`,
            'aria-valuenow': widths[key],
            'aria-valuemin': WIDTH_LIMITS[key][0],
            'aria-valuemax': WIDTH_LIMITS[key][1],
            tabIndex: 0,
          }
        : { 'aria-hidden': true })}
      title={`Drag to resize the ${name} column; double-click to fit it`}
      onPointerDown={event => {
        if (event.button !== 0) return
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        resizing.current = { key, x: event.clientX, start: fitted[key] }
        setResizingKey(key)
      }}
      onPointerMove={event => {
        const current = resizing.current
        if (!current) return
        const value = clampWidth(current.key, current.start + event.clientX - current.x)
        setWidths(previous => ({ ...previous, [current.key]: value }))
      }}
      onPointerUp={() => {
        if (!resizing.current) return
        resizing.current = null
        setResizingKey('')
        saveWidths({ ...widths })
      }}
      onPointerCancel={() => {
        resizing.current = null
        setResizingKey('')
      }}
      onDoubleClick={() => fit(key)}
      onKeyDown={event => {
        if (!header) return
        const step = event.key === 'ArrowRight' ? 16 : event.key === 'ArrowLeft' ? -16 : 0
        if (step) {
          event.preventDefault()
          saveWidths({ ...widths, [key]: clampWidth(key, widths[key] + step) })
        } else if (event.key === 'Enter') {
          event.preventDefault()
          fit(key)
        }
      }}
    />
  )

  /** Every row of the list carries the borders, so they can be dragged anywhere, not only in the header. */
  const edges = (header = false) => [
    resizer('task', 'Task', 'task', header),
    resizer('lead', 'Lead', 'lead', header),
    resizer('task', 'Task', 'panel', header),
  ]

  const bar = (item: TimelineItem) => {
    if (item.start === null || item.end === null) return <span className="trk-tl-nodate">No dates</span>
    const dragging = drag && drag.rowId === item.row.id ? drag : null
    const draggable = canDrag(item.row)
    const shown = dragging ? draggedDates(dragging.start, dragging.end, dragging.mode, dragging.delta) : item
    const span = shown.end! - shown.start! + 1
    const tone = item.status?.color || 'blue'
    const range = `${shortDate(shown.start!, true)}${span > 1 ? ` – ${shortDate(shown.end!, true)}` : ''}`
    const tip = [
      title ? String(item.row.cells[title.id] || '') : '',
      range,
      `${workingDays(shown.start!, shown.end!)} working day${workingDays(shown.start!, shown.end!) === 1 ? '' : 's'}`,
      `${item.progress}% done`,
      item.status?.label || '',
      item.lead ? `Lead: ${item.lead}` : '',
      item.late ? 'Past its end date' : '',
      draggable ? 'Drag to move, drag an edge to change a date, or use the arrow keys (Shift for the end)' : '',
    ]
      .filter(Boolean)
      .join(' · ')
    const pixels = Math.max(span * width, 6)
    return (
      <>
        <button
          type="button"
          className={`trk-tl-bar trk-tone-${tone}${item.late ? ' late' : ''}${item.progress >= 100 ? ' done' : ''}${draggable ? ' draggable' : ''}${dragging?.moved ? ' dragging' : ''}`}
          style={{ left: x(shown.start!), width: pixels }}
          title={dragging ? undefined : tip}
          aria-label={tip}
          onPointerDown={event => startDrag(event, item, 'move')}
          onPointerMove={moveDrag}
          onPointerUp={() => endDrag(item)}
          onPointerCancel={() => setDragBoth(null)}
          onKeyDown={event => keyDrag(event, item)}
          // Mouse clicks on a draggable bar are handled on pointer up; Enter and Space still open the row.
          onClick={event => {
            if (!draggable || event.detail === 0) onOpenRow(item.row)
          }}
        >
          <span className="trk-tl-fill" style={{ width: `${item.progress}%` }} />
          {pixels >= 44 && <span className="trk-tl-pct">{item.progress}%</span>}
          {draggable && pixels >= 18 && (
            <>
              <span
                className="trk-tl-handle start"
                aria-hidden="true"
                onPointerDown={event => startDrag(event, item, 'start')}
              />
              <span
                className="trk-tl-handle end"
                aria-hidden="true"
                onPointerDown={event => startDrag(event, item, 'end')}
              />
            </>
          )}
        </button>
        {dragging?.moved && (
          <span className="trk-tl-dragtip" style={{ left: x(shown.start!) }} role="status">
            {range}
          </span>
        )}
      </>
    )
  }

  return (
    <div
      className={`trk-tl${resizingKey ? ' trk-tl-resizing' : ''}`}
      data-resizing={resizingKey || undefined}
      style={{ '--tl-task': `${fitted.task}px`, '--tl-lead': `${fitted.lead}px` } as CSSProperties}
    >
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
      <div
        className="trk-tl-scroll"
        ref={node => {
          scrollRef.current = node
          if (node !== scrollNode) setScrollNode(node)
        }}
      >
        <div className="trk-tl-table" style={{ width: `calc(var(--tl-left) + ${days * width}px)` }}>
          <div className="trk-tl-row trk-tl-head">
            <div className="trk-tl-left trk-tl-lefthead">
              <span className="trk-tl-hcell">Task</span>
              <span className="trk-tl-hcell">Lead</span>
              <span className="trk-tl-num">Days</span>
              <span className="trk-tl-num">Done</span>
              {edges(true)}
            </div>
            <div className="trk-tl-chart trk-tl-scale" style={chartStyle}>
              <div className="trk-tl-weeks trk-tl-months">
                {months.map(month => (
                  <span key={month.start} style={{ width: month.length * width }} title={monthLabel(month.start)}>
                    <b>{month.length * width >= 60 ? monthLabel(month.start) : ''}</b>
                  </span>
                ))}
              </div>
              {zoom !== 'month' && (
                <div className="trk-tl-weeks">
                  {weeks.map(week => (
                    <span key={week} style={{ width: 7 * width }} title={`Week of ${shortDate(week, true)}`}>
                      {timeline.weekOne !== null && <b>{weekLabel(week, timeline.weekOne)}</b>}
                      <small>{shortDate(week, true)}</small>
                    </span>
                  ))}
                </div>
              )}
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
                          <span className="trk-tl-name" title={group.label}>
                            {group.label}
                          </span>
                        </button>
                        <span className="trk-tl-meta">{group.items.length}</span>
                        <span className="trk-tl-num" title="From the first start to the last end of its tasks">
                          {group.start !== null && group.end !== null ? workingDays(group.start, group.end) : ''}
                        </span>
                        <span className="trk-tl-num">{group.progress}%</span>
                        {edges()}
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
                      <div
                        key={item.row.id}
                        className={`trk-tl-row${props.tones?.get(item.row.id) ? ` trk-hl trk-tone-${props.tones.get(item.row.id)}` : ''}`}
                      >
                        <div className="trk-tl-left">
                          <button
                            type="button"
                            className="trk-tl-name trk-tl-open"
                            title={`${wbs && item.row.cells[wbs.id] ? `${String(item.row.cells[wbs.id])} ` : ''}${(title && String(item.row.cells[title.id] || '')) || 'Untitled row'}`}
                            onClick={() => onOpenRow(item.row)}
                          >
                            {wbs && item.row.cells[wbs.id] ? (
                              <span className="trk-tl-wbs">{String(item.row.cells[wbs.id])}</span>
                            ) : null}
                            {(title && String(item.row.cells[title.id] || '')) || 'Untitled row'}
                          </button>
                          <span className="trk-tl-meta" title={item.lead}>
                            {item.lead}
                          </span>
                          {item.start !== null && item.end !== null && fields.endId && canDrag(item.row) ? (
                            <DaysInput
                              key={`${item.row.id}:${item.start}:${item.end}`}
                              days={workingDays(item.start, item.end)}
                              label={`Working days for ${(title && String(item.row.cells[title.id] || '')) || 'this row'}`}
                              onChange={days => commit(item, item.start!, endAfterWorkingDays(item.start!, days))}
                            />
                          ) : (
                            <span
                              className="trk-tl-num"
                              title={
                                item.start === null
                                  ? 'Set a Start date to give this task a length'
                                  : !fields.endId
                                    ? 'Choose an End column in the timeline settings to change the length'
                                    : undefined
                              }
                            >
                              {item.start !== null && item.end !== null ? workingDays(item.start, item.end) : ''}
                            </span>
                          )}
                          <span className={`trk-tl-num${item.late ? ' late' : ''}`}>{item.progress}%</span>
                          {edges()}
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
        <span className="trk-tl-key today" /> today. Click a bar or task to open the row
        {rows.some(canDrag) ? '; drag a bar to change its dates.' : '.'}{' '}
        {shared && onShare
          ? 'These settings are shared with everyone who opens this tracker.'
          : 'These settings are kept in this browser only.'}
      </p>
    </div>
  )
}

/**
 * A task's length in working days, typed in. Enter or leaving the field saves it (the End date moves; the Start stays);
 * Escape puts the old number back.
 */
function DaysInput({ days, label, onChange }: { days: number; label: string; onChange: (days: number) => void }) {
  const [text, setText] = useState(String(days))
  const save = () => {
    const value = Math.floor(Number(text))
    if (!Number.isFinite(value) || value < 1 || value > 999) {
      setText(String(days))
      return
    }
    if (value !== days) onChange(value)
  }
  return (
    <input
      className="trk-tl-days-input"
      type="number"
      inputMode="numeric"
      min={1}
      max={999}
      step={1}
      value={text}
      aria-label={label}
      title="Working days: type a number to move the End date"
      onChange={event => setText(event.target.value)}
      onBlur={save}
      onKeyDown={event => {
        if (event.key === 'Enter') event.currentTarget.blur()
        if (event.key === 'Escape') {
          setText(String(days))
          event.currentTarget.blur()
        }
      }}
    />
  )
}
