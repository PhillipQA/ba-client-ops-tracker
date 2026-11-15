import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { ChevronDown, ChevronRight, Plus } from 'lucide-react'
import {
  COLUMN_WIDTH,
  emptyCell,
  formulaToText,
  type Cell,
  type TrackerColumn,
  type TrackerRow,
  type TrackerView,
} from './trackerModel'
import type { Lookup } from './trackerQuery'
import { CellEditor, CellView, editable, type Person } from './TrackerCells'
import { type TotalShown, totalKindsFor } from './trackerTotals'
import { ColumnIcon } from './trackerUi'

export const ROW_HEIGHT = 44
const NUMBER_WIDTH = 56
const OVERSCAN = 8

export type Entry =
  | { kind: 'row'; row: TrackerRow; n: number }
  | { kind: 'group'; key: string; label: string; count: number }

const WIDTHS: Record<string, number> = {
  text: 200,
  longtext: 260,
  number: 120,
  date: 140,
  checkbox: 96,
  select: 160,
  multiselect: 220,
  person: 180,
  link: 220,
  task_status: 160,
  task_due: 140,
  task_owner: 170,
  signoff: 170,
  drive_files: 140,
  secret: 150,
}
export const widthOf = (column: TrackerColumn, first: boolean) =>
  column.width || (first ? 260 : WIDTHS[column.type] || 160)
export const NUMBER_COLUMN_WIDTH = NUMBER_WIDTH

export type GridFocus = { rowId: string; columnId: string; edit: boolean; nonce: number }

type Props = {
  columns: TrackerColumn[]
  /** Ids of the columns kept in view while scrolling sideways. They come first in `columns`. */
  frozen: ReadonlySet<string>
  /** The tracker's first column (it carries the open-row button), whether or not it is shown. */
  primaryId: string
  entries: Entry[]
  lookup: Lookup
  people: Person[]
  /** Rows tinted with a colour: their highlight, or their state when colouring by status. */
  tones?: ReadonlyMap<string, string>
  canEdit: boolean
  /** Two-way sync: Sheet columns are edited here too, and the edit goes to the Sheet. */
  twoWay?: boolean
  sort: TrackerView['sort']
  selected: ReadonlySet<string>
  focus: GridFocus | null
  taskTitle: (row: TrackerRow) => string
  /** The task (first column) or subtask (other cells) shown in a cell, if any. */
  cellWork?: (
    row: TrackerRow,
    column: TrackerColumn,
  ) => { label: string; title: string; done: boolean; task: boolean } | null
  /** Present when tasks and subtasks can be picked from cells. */
  onWork?: (row: TrackerRow, column: TrackerColumn, element: HTMLElement) => void
  /** What each column shows in the totals row, by column id. Absent: no totals row. */
  totals?: ReadonlyMap<string, TotalShown>
  /** Opens the list of totals for a column (people who can change the columns). */
  onPickTotal?: (column: TrackerColumn, anchor: HTMLElement) => void
  /** Every column of the tracker, shown or not, for reading formulas. */
  allColumns?: TrackerColumn[]
  /** Per row: how many tasks are linked, and which cells have their own. */
  links?: ReadonlyMap<string, { count: number; cells: ReadonlySet<string> }>
  rowName: (row: TrackerRow) => string
  onEdit: (row: TrackerRow, column: TrackerColumn, value: Cell) => void
  onOpenRow: (row: TrackerRow) => void
  onHeader: (column: TrackerColumn, button: HTMLElement) => void
  onAddColumn?: () => void
  /** Present while rows can be reordered; called with the rows to move and the row they go just before (null for the end). */
  onMove?: (ids: string[], before: string | null) => void
  /** Present only for people who can change columns; dragging a header edge calls it with the new width (or null to reset). */
  onResize?: (column: TrackerColumn, width: number | null) => void
  onToggleRow: (rowId: string, on: boolean) => void
  onToggleAll: (on: boolean) => void
  onInvalid: (message: string) => void
}

type Active = { rowId: string; columnId: string } | null

export default function TrackerGrid(props: Props) {
  const { columns, entries, lookup, people, canEdit, sort, selected } = props
  const scroller = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [height, setHeight] = useState(600)
  const [active, setActive] = useState<Active>(null)
  const [editing, setEditing] = useState<{ initial?: string } | null>(null)

  useLayoutEffect(() => {
    const element = scroller.current
    if (!element) return
    const measure = () => setHeight(element.clientHeight || 600)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const rowEntries = useMemo(
    () =>
      entries.map((entry, index) => ({ entry, index })).filter(item => item.entry.kind === 'row') as {
        entry: Extract<Entry, { kind: 'row' }>
        index: number
      }[],
    [entries],
  )
  const rowPlace = useMemo(() => new Map(rowEntries.map((item, at) => [item.entry.row.id, at])), [rowEntries])
  const columnPlace = useMemo(() => new Map(columns.map((column, at) => [column.id, at])), [columns])

  // The selection must point at something that still exists.
  useEffect(() => {
    if (active && (!rowPlace.has(active.rowId) || !columnPlace.has(active.columnId))) {
      setActive(null)
      setEditing(null)
    }
  }, [active, rowPlace, columnPlace])

  const scrollTo = useCallback((index: number) => {
    const element = scroller.current
    if (!element) return
    const top = index * ROW_HEIGHT,
      view = element.clientHeight - ROW_HEIGHT - 2
    if (top < element.scrollTop) element.scrollTop = top
    else if (top + ROW_HEIGHT > element.scrollTop + view) element.scrollTop = top + ROW_HEIGHT - view
  }, [])

  // A row that was just added is selected and, if asked, opened for typing.
  const lastFocus = useRef(0)
  useEffect(() => {
    const request = props.focus
    if (!request || request.nonce === lastFocus.current) return
    const place = rowPlace.get(request.rowId)
    if (place === undefined || !columnPlace.has(request.columnId)) return
    lastFocus.current = request.nonce
    setActive({ rowId: request.rowId, columnId: request.columnId })
    scrollTo(rowEntries[place].index)
    const column = columns[columnPlace.get(request.columnId)!]
    setEditing(request.edit && canEdit && editable(column) ? {} : null)
    if (!request.edit || !editable(column)) scroller.current?.focus({ preventScroll: true })
  }, [props.focus, rowPlace, columnPlace, rowEntries, columns, canEdit, scrollTo])

  const first = props.primaryId
  const [dragIds, setDragIds] = useState<ReadonlySet<string> | null>(null)
  const [dropAt, setDropAt] = useState<{ rowId: string; after: boolean } | null>(null)
  const endDrag = () => {
    setDragIds(null)
    setDropAt(null)
  }
  const dropTarget = () => {
    if (!dropAt || !dragIds || dragIds.has(dropAt.rowId)) return undefined
    const place = rowPlace.get(dropAt.rowId)
    if (place === undefined) return undefined
    return { before: dropAt.after ? (rowEntries[place + 1]?.entry.row.id ?? null) : dropAt.rowId }
  }
  const [drag, setDrag] = useState<{ id: string; width: number } | null>(null)
  const widthFor = useCallback(
    (column: TrackerColumn) => (drag?.id === column.id ? drag.width : widthOf(column, column.id === first)),
    [drag, first],
  )
  const template = useMemo(
    () =>
      `${NUMBER_WIDTH}px ${columns.map(column => `${widthFor(column)}px`).join(' ')} ${props.onAddColumn ? '56px' : '0px'}`,
    [columns, widthFor, props.onAddColumn],
  )
  // Frozen columns stick to the left, one after another, starting after the row-number column.
  const stick = useMemo(() => {
    const places = new Map<string, { left: number; edge: boolean }>()
    let left = NUMBER_WIDTH,
      last = ''
    for (const column of columns) {
      if (!props.frozen.has(column.id)) break
      places.set(column.id, { left, edge: false })
      left += widthFor(column)
      last = column.id
    }
    if (last) places.get(last)!.edge = true
    return places
  }, [columns, props.frozen, widthFor])
  const startResize = (column: TrackerColumn, event: ReactPointerEvent<HTMLSpanElement>) => {
    if (!props.onResize || event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    const handle = event.currentTarget,
      x0 = event.clientX,
      w0 = widthFor(column)
    handle.setPointerCapture(event.pointerId)
    const clamp = (value: number) => Math.max(COLUMN_WIDTH.min, Math.min(COLUMN_WIDTH.max, Math.round(value)))
    const move = (e: PointerEvent) => setDrag({ id: column.id, width: clamp(w0 + e.clientX - x0) })
    const finish = (e: PointerEvent) => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', finish)
      handle.removeEventListener('pointercancel', finish)
      const width = clamp(w0 + e.clientX - x0)
      setDrag(null)
      if (e.type === 'pointerup' && width !== w0) props.onResize?.(column, width)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', finish)
    handle.addEventListener('pointercancel', finish)
  }
  const placeClasses = (column: TrackerColumn) => {
    const place = stick.get(column.id)
    return `${place ? ' trk-frozen' : ''}${place?.edge ? ' trk-edge' : ''}${column.align ? ` trk-al-${column.align}` : ''}`
  }
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  const end = Math.min(entries.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN)
  const allSelected = rowEntries.length > 0 && rowEntries.every(item => selected.has(item.entry.row.id))

  const move = (rowAt: number, columnAt: number) => {
    if (!rowEntries.length || !columns.length) return
    const r = Math.max(0, Math.min(rowEntries.length - 1, rowAt)),
      c = Math.max(0, Math.min(columns.length - 1, columnAt))
    setActive({ rowId: rowEntries[r].entry.row.id, columnId: columns[c].id })
    scrollTo(rowEntries[r].index)
  }
  const stopEditing = (direction?: 'down' | 'right') => {
    setEditing(null)
    scroller.current?.focus({ preventScroll: true })
    if (!active) return
    const r = rowPlace.get(active.rowId)!,
      c = columnPlace.get(active.columnId)!
    if (direction === 'down') move(r + 1, c)
    else if (direction === 'right') move(r, c + 1)
  }
  const beginEdit = (row: TrackerRow, column: TrackerColumn, initial?: string) => {
    // Cells that come from a connected Google Sheet are changed in the Sheet, not here (unless it syncs both ways).
    if (editable(column) && canEdit && !(column.synced && row.sourceKey && !props.twoWay)) setEditing({ initial })
    else props.onOpenRow(row)
  }

  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (editing || event.target !== event.currentTarget) return
    if (!rowEntries.length || !columns.length) return
    const r = active ? (rowPlace.get(active.rowId) ?? 0) : 0,
      c = active ? (columnPlace.get(active.columnId) ?? 0) : 0
    const row = rowEntries[r].entry.row,
      column = columns[c]
    const arrow: Record<string, [number, number]> = {
      ArrowDown: [1, 0],
      ArrowUp: [-1, 0],
      ArrowRight: [0, 1],
      ArrowLeft: [0, -1],
    }
    if (arrow[event.key]) {
      event.preventDefault()
      if (!active) move(0, 0)
      else move(r + arrow[event.key][0], c + arrow[event.key][1])
      return
    }
    if (event.key === 'PageDown' || event.key === 'PageUp') {
      event.preventDefault()
      const page = Math.max(1, Math.floor(height / ROW_HEIGHT) - 1)
      move(r + (event.key === 'PageDown' ? page : -page), c)
      return
    }
    if (event.key === 'Home') {
      event.preventDefault()
      move(event.ctrlKey ? 0 : r, 0)
      return
    }
    if (event.key === 'End') {
      event.preventDefault()
      move(event.ctrlKey ? rowEntries.length - 1 : r, columns.length - 1)
      return
    }
    if (event.key === 'Tab') {
      const next = c + (event.shiftKey ? -1 : 1)
      if (next >= 0 && next < columns.length) {
        event.preventDefault()
        move(r, next)
      }
      return
    }
    if (!active) return
    if (event.key === 'Enter' || event.key === 'F2') {
      event.preventDefault()
      beginEdit(row, column)
      return
    }
    if (event.key === ' ' && column.type === 'checkbox') {
      event.preventDefault()
      if (canEdit) props.onEdit(row, column, row.cells[column.id] !== true)
      return
    }
    if (
      (event.key === 'Delete' || event.key === 'Backspace') &&
      canEdit &&
      (editable(column) || column.type === 'checkbox')
    ) {
      event.preventDefault()
      props.onEdit(row, column, emptyCell(column.type))
      return
    }
    if (
      event.key.length === 1 &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      canEdit &&
      ['text', 'number', 'link'].includes(column.type)
    ) {
      event.preventDefault()
      setEditing({ initial: event.key })
    }
  }

  const rendered = []
  for (let index = start; index < end; index++) {
    const entry = entries[index]
    if (entry.kind === 'group') {
      rendered.push(
        <div
          key={`g:${entry.key}`}
          role="row"
          aria-rowindex={index + 2}
          className="trk-row trk-group-row"
          style={{ height: ROW_HEIGHT }}
        >
          <div role="gridcell" className="trk-group-cell">
            <ChevronDown size={14} aria-hidden="true" />
            <strong>{entry.label}</strong>
            <span>{entry.count.toLocaleString('en')}</span>
          </div>
        </div>,
      )
      continue
    }
    const { row, n } = entry
    const isSelected = selected.has(row.id),
      rowActive = active?.rowId === row.id,
      tone = props.tones?.get(row.id)
    rendered.push(
      <div
        key={row.id}
        role="row"
        aria-rowindex={index + 2}
        aria-selected={isSelected}
        className={`trk-row${tone ? ` trk-hl trk-tone-${tone}` : ''}${isSelected ? ' selected' : ''}${rowActive ? ' current' : ''}${dragIds?.has(row.id) ? ' dragging' : ''}${row.sourceMissing ? ' trk-missing' : ''}${row.review ? ' trk-to-review' : ''}${dropAt?.rowId === row.id && dragIds && !dragIds.has(row.id) ? (dropAt.after ? ' drop-after' : ' drop-before') : ''}`}
        style={{ gridTemplateColumns: template, height: ROW_HEIGHT }}
        onDragOver={
          dragIds
            ? event => {
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
                const box = event.currentTarget.getBoundingClientRect()
                const after = event.clientY > box.top + box.height / 2
                if (dropAt?.rowId !== row.id || dropAt.after !== after) setDropAt({ rowId: row.id, after })
              }
            : undefined
        }
        onDrop={
          dragIds
            ? event => {
                event.preventDefault()
                const target = dropTarget()
                if (target) props.onMove?.([...dragIds], target.before)
                endDrag()
              }
            : undefined
        }
      >
        <div
          role="gridcell"
          className={`trk-cell trk-num trk-s1${props.onMove ? ' movable' : ''}`}
          draggable={Boolean(props.onMove)}
          title={props.onMove ? 'Drag to move this row' : undefined}
          onDragStart={
            props.onMove
              ? event => {
                  const ids = selected.has(row.id) ? new Set(selected) : new Set([row.id])
                  setDragIds(ids)
                  event.dataTransfer.effectAllowed = 'move'
                  event.dataTransfer.setData('text/plain', `${ids.size} row${ids.size === 1 ? '' : 's'}`)
                }
              : undefined
          }
          onDragEnd={props.onMove ? endDrag : undefined}
        >
          <span
            className="trk-n"
            title={
              row.sourceMissing
                ? 'No longer in the Google Sheet. Kept here; delete it if it is not needed.'
                : row.review
                  ? 'New: waiting for review'
                  : undefined
            }
          >
            {n}
          </span>
          {props.links?.get(row.id) && (
            <span
              className="trk-linkcount"
              title={`${props.links.get(row.id)!.count} linked task${props.links.get(row.id)!.count === 1 ? '' : 's'} or subtask${props.links.get(row.id)!.count === 1 ? '' : 's'}`}
              aria-label={`${props.links.get(row.id)!.count} linked tasks`}
            >
              {props.links.get(row.id)!.count}
            </span>
          )}
          <input
            type="checkbox"
            className="trk-pick"
            checked={isSelected}
            aria-label={`Select row ${n}`}
            onChange={event => props.onToggleRow(row.id, event.target.checked)}
          />
        </div>
        {columns.map((column, at) => {
          const on = rowActive && active?.columnId === column.id
          const isEditing = on && editing !== null
          const classes = ['trk-cell', `trk-t-${column.type}`]
          if (column.id === first) classes.push('trk-first')
          const place = stick.get(column.id)
          if (place) classes.push('trk-frozen')
          if (place?.edge) classes.push('trk-edge')
          if (column.align) classes.push(`trk-al-${column.align}`)
          if (on) classes.push('active')
          if (isEditing) classes.push('editing')
          return (
            <div
              key={column.id}
              role="gridcell"
              aria-colindex={at + 2}
              className={classes.join(' ')}
              data-column={column.id}
              style={place ? { left: place.left } : undefined}
              onClick={() => {
                if (
                  on &&
                  !isEditing &&
                  canEdit &&
                  editable(column) &&
                  !(column.synced && row.sourceKey && !props.twoWay)
                )
                  beginEdit(row, column)
                else if (!on) {
                  setActive({ rowId: row.id, columnId: column.id })
                  setEditing(null)
                  scroller.current?.focus({ preventScroll: true })
                }
              }}
              onDoubleClick={() => {
                if (!isEditing) beginEdit(row, column)
              }}
            >
              {isEditing ? (
                <CellEditor
                  column={column}
                  row={row}
                  people={people}
                  initial={editing?.initial}
                  onDone={stopEditing}
                  onCommit={value => props.onEdit(row, column, value)}
                  onInvalid={props.onInvalid}
                />
              ) : (
                <CellView
                  column={column}
                  row={row}
                  lookup={lookup}
                  canEdit={canEdit}
                  onToggle={value => props.onEdit(row, column, value)}
                />
              )}
              {!isEditing &&
                (() => {
                  const work = props.cellWork?.(row, column)
                  const allowed =
                    column.id === first ||
                    [
                      'text',
                      'longtext',
                      'number',
                      'date',
                      'checkbox',
                      'select',
                      'multiselect',
                      'person',
                      'link',
                    ].includes(column.type)
                  if (work)
                    return (
                      <button
                        type="button"
                        className={`trk-work-chip${work.done ? ' done' : ''}${work.task ? ' task' : ''}`}
                        title={work.title}
                        aria-label={work.title}
                        onClick={event => {
                          event.stopPropagation()
                          if (props.onWork) props.onWork(row, column, event.currentTarget)
                        }}
                      >
                        {work.label}
                      </button>
                    )
                  if (props.onWork && canEdit && allowed)
                    return (
                      <button
                        type="button"
                        className="trk-work-add"
                        title={
                          column.id === first
                            ? 'Pick or create this row’s task'
                            : `Pick or create a “${column.name}” subtask`
                        }
                        aria-label={
                          column.id === first
                            ? `Task for ${props.rowName(row)}`
                            : `${column.name} subtask for ${props.rowName(row)}`
                        }
                        onClick={event => {
                          event.stopPropagation()
                          props.onWork!(row, column, event.currentTarget)
                        }}
                      >
                        {column.id === first ? '+ Task' : '+'}
                      </button>
                    )
                  return null
                })()}
              {column.id === first && !isEditing && (
                <>
                  <button
                    type="button"
                    className="trk-open"
                    aria-label={`Open ${props.rowName(row)}`}
                    title="Open row"
                    onClick={event => {
                      event.stopPropagation()
                      props.onOpenRow(row)
                    }}
                  >
                    <ChevronRight size={14} aria-hidden="true" />
                  </button>
                </>
              )}
            </div>
          )
        })}
        <div className="trk-cell trk-end" aria-hidden="true" />
      </div>,
    )
  }

  return (
    <div
      ref={scroller}
      className="trk-scroll"
      tabIndex={0}
      role="application"
      aria-label="Tracker rows. Use the arrow keys to move between cells, Enter to edit, and Escape to stop editing."
      onScroll={event => setScrollTop(event.currentTarget.scrollTop)}
      onKeyDown={keys}
    >
      <div role="grid" aria-rowcount={entries.length + 1} aria-colcount={columns.length + 1} className="trk-table">
        <div role="row" aria-rowindex={1} className="trk-row trk-head" style={{ gridTemplateColumns: template }}>
          <div role="columnheader" className="trk-hcell trk-num trk-s1">
            <input
              type="checkbox"
              className="trk-pick always"
              checked={allSelected}
              disabled={!rowEntries.length}
              aria-label="Select all rows shown"
              onChange={event => props.onToggleAll(event.target.checked)}
            />
            <span className="trk-n">#</span>
          </div>
          {columns.map((column, at) => {
            const computed = column.type === 'formula'
            const connected =
              !computed &&
              ![
                'text',
                'longtext',
                'number',
                'date',
                'checkbox',
                'select',
                'multiselect',
                'person',
                'link',
                'secret',
              ].includes(column.type)
            const sorted = sort?.columnId === column.id ? sort.dir : null
            return (
              <div
                key={column.id}
                role="columnheader"
                aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : 'none'}
                className={`trk-hcell${placeClasses(column)}${connected ? ' connected' : ''}${computed ? ' computed' : ''}${column.synced ? ' synced' : ''}${column.type === 'secret' ? ' secret' : ''}`}
                style={stick.has(column.id) ? { left: stick.get(column.id)!.left } : undefined}
              >
                <button
                  type="button"
                  className="trk-hbutton"
                  aria-haspopup="dialog"
                  title={
                    column.synced
                      ? props.twoWay
                        ? `${column.name}. Synced with the Google Sheet both ways; an edit here is written to the Sheet.`
                        : `${column.name}. Comes from the Google Sheet; change it there.`
                      : computed
                        ? `${column.name} = ${formulaToText(column.formula || '', props.allColumns || columns)}`
                        : connected
                          ? `${column.name}. Fills itself from the linked task.`
                          : column.type === 'secret'
                            ? `${column.name}. Protected.`
                            : column.name
                  }
                  onClick={event => props.onHeader(column, event.currentTarget)}
                >
                  <ColumnIcon type={column.type} />
                  <span className="trk-hname">{column.name}</span>
                  {sorted && (
                    <span className="trk-sorted" aria-hidden="true">
                      {sorted === 'asc' ? '↑' : '↓'}
                    </span>
                  )}
                  <ChevronDown size={13} className="trk-hchev" aria-hidden="true" />
                </button>
                {props.onResize && (
                  <span
                    className="trk-resize"
                    role="separator"
                    aria-orientation="vertical"
                    aria-label={`Resize ${column.name}. Double-click to reset.`}
                    title="Drag to resize. Double-click to reset."
                    onPointerDown={event => startResize(column, event)}
                    onDoubleClick={event => {
                      event.stopPropagation()
                      props.onResize?.(column, null)
                    }}
                  />
                )}
              </div>
            )
          })}
          <div role="columnheader" className="trk-hcell trk-add">
            {props.onAddColumn && (
              <button
                type="button"
                className="trk-add-column"
                aria-label="Add a column"
                title="Add a column"
                onClick={props.onAddColumn}
              >
                <Plus size={16} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
        <div style={{ height: start * ROW_HEIGHT }} aria-hidden="true" />
        {rendered}
        <div style={{ height: Math.max(0, entries.length - end) * ROW_HEIGHT }} aria-hidden="true" />
        {props.totals && (
          <div
            role="row"
            aria-rowindex={entries.length + 2}
            className="trk-row trk-totals"
            style={{ gridTemplateColumns: template }}
          >
            <div role="rowheader" className="trk-cell trk-num trk-s1" title="Totals for the rows shown">
              Σ
            </div>
            {columns.map((column, at) => {
              const place = stick.get(column.id),
                total = props.totals!.get(column.id),
                canPick = Boolean(props.onPickTotal) && totalKindsFor(column).length > 0
              const inner = total ? (
                <>
                  {total.label && <small>{total.label.toUpperCase()}</small>}
                  <span className="trk-number">{total.text}</span>
                </>
              ) : at === 0 && !canPick ? (
                <span className="trk-muted">Total</span>
              ) : null
              return (
                <div
                  key={column.id}
                  role="gridcell"
                  aria-colindex={at + 2}
                  className={`trk-cell${place ? ' trk-frozen' : ''}${place?.edge ? ' trk-edge' : ''}${total ? ' trk-sum' : ''}${column.align ? ` trk-al-${column.align}` : ''}`}
                  style={place ? { left: place.left } : undefined}
                  title={canPick ? undefined : total?.title}
                >
                  {canPick ? (
                    <button
                      type="button"
                      className={`trk-total-pick${total ? '' : ' empty'}`}
                      title={total ? `${total.title}. Click to change.` : `Add a total for ${column.name}`}
                      aria-label={
                        total ? `${column.name} total: ${total.text}. Change` : `Add a total for ${column.name}`
                      }
                      onClick={event => props.onPickTotal?.(column, event.currentTarget)}
                    >
                      {inner || <span className="trk-total-add">+ Total</span>}
                    </button>
                  ) : (
                    inner
                  )}
                </div>
              )
            })}
            <div className="trk-cell trk-end" aria-hidden="true" />
          </div>
        )}
      </div>
    </div>
  )
}
