import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { ChevronDown, ChevronRight, Plus } from 'lucide-react'
import { emptyCell, type Cell, type TrackerColumn, type TrackerRow, type TrackerView } from './trackerModel'
import { type Lookup } from './trackerQuery'
import { CellEditor, CellView, LinkedIcon, editable, type Person } from './TrackerCells'
import { ColumnIcon } from './trackerUi'

export const ROW_HEIGHT = 44
const NUMBER_WIDTH = 56
const OVERSCAN = 8

export type Entry = { kind: 'row'; row: TrackerRow; n: number } | { kind: 'group'; key: string; label: string; count: number }

const WIDTHS: Record<string, number> = {
  text: 200, longtext: 260, number: 120, date: 140, checkbox: 96, select: 160, multiselect: 220, person: 180, link: 220,
  task_status: 160, task_due: 140, task_owner: 170, signoff: 170, drive_files: 140, secret: 150,
}
export const widthOf = (column: TrackerColumn, first: boolean) => column.width || (first ? 260 : WIDTHS[column.type] || 160)

export type GridFocus = { rowId: string; columnId: string; edit: boolean; nonce: number }

type Props = {
  columns: TrackerColumn[]
  entries: Entry[]
  lookup: Lookup
  people: Person[]
  canEdit: boolean
  sort: TrackerView['sort']
  selected: ReadonlySet<string>
  focus: GridFocus | null
  taskTitle: (row: TrackerRow) => string
  rowName: (row: TrackerRow) => string
  onEdit: (row: TrackerRow, column: TrackerColumn, value: Cell) => void
  onOpenRow: (row: TrackerRow) => void
  onHeader: (column: TrackerColumn, button: HTMLElement) => void
  onAddColumn?: () => void
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

  const rowEntries = useMemo(() => entries.map((entry, index) => ({ entry, index })).filter(item => item.entry.kind === 'row') as { entry: Extract<Entry, { kind: 'row' }>; index: number }[], [entries])
  const rowPlace = useMemo(() => new Map(rowEntries.map((item, at) => [item.entry.row.id, at])), [rowEntries])
  const columnPlace = useMemo(() => new Map(columns.map((column, at) => [column.id, at])), [columns])

  // The selection must point at something that still exists.
  useEffect(() => {
    if (active && (!rowPlace.has(active.rowId) || !columnPlace.has(active.columnId))) { setActive(null); setEditing(null) }
  }, [active, rowPlace, columnPlace])

  const scrollTo = useCallback((index: number) => {
    const element = scroller.current
    if (!element) return
    const top = index * ROW_HEIGHT, view = element.clientHeight - ROW_HEIGHT - 2
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

  const first = columns[0]?.id
  const template = useMemo(() => `${NUMBER_WIDTH}px ${columns.map((column, at) => `${widthOf(column, at === 0)}px`).join(' ')} ${props.onAddColumn ? '56px' : '0px'}`, [columns, props.onAddColumn])
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  const end = Math.min(entries.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN)
  const allSelected = rowEntries.length > 0 && rowEntries.every(item => selected.has(item.entry.row.id))

  const move = (rowAt: number, columnAt: number) => {
    if (!rowEntries.length || !columns.length) return
    const r = Math.max(0, Math.min(rowEntries.length - 1, rowAt)), c = Math.max(0, Math.min(columns.length - 1, columnAt))
    setActive({ rowId: rowEntries[r].entry.row.id, columnId: columns[c].id })
    scrollTo(rowEntries[r].index)
  }
  const stopEditing = (direction?: 'down' | 'right') => {
    setEditing(null)
    scroller.current?.focus({ preventScroll: true })
    if (!active) return
    const r = rowPlace.get(active.rowId)!, c = columnPlace.get(active.columnId)!
    if (direction === 'down') move(r + 1, c)
    else if (direction === 'right') move(r, c + 1)
  }
  const beginEdit = (row: TrackerRow, column: TrackerColumn, initial?: string) => {
    if (editable(column) && canEdit) setEditing({ initial })
    else props.onOpenRow(row)
  }

  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (editing || event.target !== event.currentTarget) return
    if (!rowEntries.length || !columns.length) return
    const r = active ? rowPlace.get(active.rowId) ?? 0 : 0, c = active ? columnPlace.get(active.columnId) ?? 0 : 0
    const row = rowEntries[r].entry.row, column = columns[c]
    const arrow: Record<string, [number, number]> = { ArrowDown: [1, 0], ArrowUp: [-1, 0], ArrowRight: [0, 1], ArrowLeft: [0, -1] }
    if (arrow[event.key]) { event.preventDefault(); if (!active) move(0, 0); else move(r + arrow[event.key][0], c + arrow[event.key][1]); return }
    if (event.key === 'PageDown' || event.key === 'PageUp') { event.preventDefault(); const page = Math.max(1, Math.floor(height / ROW_HEIGHT) - 1); move(r + (event.key === 'PageDown' ? page : -page), c); return }
    if (event.key === 'Home') { event.preventDefault(); move(event.ctrlKey ? 0 : r, 0); return }
    if (event.key === 'End') { event.preventDefault(); move(event.ctrlKey ? rowEntries.length - 1 : r, columns.length - 1); return }
    if (event.key === 'Tab') {
      const next = c + (event.shiftKey ? -1 : 1)
      if (next >= 0 && next < columns.length) { event.preventDefault(); move(r, next) }
      return
    }
    if (!active) return
    if (event.key === 'Enter' || event.key === 'F2') { event.preventDefault(); beginEdit(row, column); return }
    if (event.key === ' ' && column.type === 'checkbox') { event.preventDefault(); if (canEdit) props.onEdit(row, column, row.cells[column.id] !== true); return }
    if ((event.key === 'Delete' || event.key === 'Backspace') && canEdit && (editable(column) || column.type === 'checkbox')) { event.preventDefault(); props.onEdit(row, column, emptyCell(column.type)); return }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && canEdit && ['text', 'number', 'link'].includes(column.type)) { event.preventDefault(); setEditing({ initial: event.key }) }
  }

  const rendered = []
  for (let index = start; index < end; index++) {
    const entry = entries[index]
    if (entry.kind === 'group') {
      rendered.push(<div key={`g:${entry.key}`} role="row" aria-rowindex={index + 2} className="trk-row trk-group-row" style={{ height: ROW_HEIGHT }}>
        <div role="gridcell" className="trk-group-cell"><ChevronDown size={14} aria-hidden="true" /><strong>{entry.label}</strong><span>{entry.count.toLocaleString('en')}</span></div>
      </div>)
      continue
    }
    const { row, n } = entry
    const isSelected = selected.has(row.id), rowActive = active?.rowId === row.id
    rendered.push(<div key={row.id} role="row" aria-rowindex={index + 2} aria-selected={isSelected} className={`trk-row${isSelected ? ' selected' : ''}${rowActive ? ' current' : ''}`} style={{ gridTemplateColumns: template, height: ROW_HEIGHT }}>
      <div role="gridcell" className="trk-cell trk-num trk-s1">
        <span className="trk-n">{n}</span>
        <input type="checkbox" className="trk-pick" checked={isSelected} aria-label={`Select row ${n}`} onChange={event => props.onToggleRow(row.id, event.target.checked)} />
      </div>
      {columns.map((column, at) => {
        const on = rowActive && active?.columnId === column.id
        const isEditing = on && editing !== null
        const classes = ['trk-cell', `trk-t-${column.type}`]
        if (column.id === first) classes.push('trk-s2', 'trk-first')
        if (on) classes.push('active')
        if (isEditing) classes.push('editing')
        return <div key={column.id} role="gridcell" aria-colindex={at + 2} className={classes.join(' ')} data-column={column.id}
          onClick={() => { if (on && !isEditing && canEdit && editable(column)) beginEdit(row, column); else if (!on) { setActive({ rowId: row.id, columnId: column.id }); setEditing(null); scroller.current?.focus({ preventScroll: true }) } }}
          onDoubleClick={() => { if (!isEditing) beginEdit(row, column) }}>
          {isEditing
            ? <CellEditor column={column} row={row} people={people} initial={editing?.initial} onDone={stopEditing} onCommit={value => props.onEdit(row, column, value)} onInvalid={props.onInvalid} />
            : <CellView column={column} row={row} lookup={lookup} canEdit={canEdit} onToggle={value => props.onEdit(row, column, value)} />}
          {column.id === first && !isEditing && <>
            {row.taskId && <LinkedIcon title={`Linked to ${props.taskTitle(row)}`} />}
            <button type="button" className="trk-open" aria-label={`Open ${props.rowName(row)}`} title="Open row" onClick={event => { event.stopPropagation(); props.onOpenRow(row) }}><ChevronRight size={14} aria-hidden="true" /></button>
          </>}
        </div>
      })}
      <div className="trk-cell trk-end" aria-hidden="true" />
    </div>)
  }

  return <div ref={scroller} className="trk-scroll" tabIndex={0} role="application" aria-label="Tracker rows. Use the arrow keys to move between cells, Enter to edit, and Escape to stop editing." onScroll={event => setScrollTop(event.currentTarget.scrollTop)} onKeyDown={keys}>
    <div role="grid" aria-rowcount={entries.length + 1} aria-colcount={columns.length + 1} className="trk-table">
      <div role="row" aria-rowindex={1} className="trk-row trk-head" style={{ gridTemplateColumns: template }}>
        <div role="columnheader" className="trk-hcell trk-num trk-s1">
          <input type="checkbox" className="trk-pick always" checked={allSelected} disabled={!rowEntries.length} aria-label="Select all rows shown" onChange={event => props.onToggleAll(event.target.checked)} />
          <span className="trk-n">#</span>
        </div>
        {columns.map((column, at) => {
          const connected = !['text', 'longtext', 'number', 'date', 'checkbox', 'select', 'multiselect', 'person', 'link', 'secret'].includes(column.type)
          const sorted = sort?.columnId === column.id ? sort.dir : null
          return <div key={column.id} role="columnheader" aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : 'none'}
            className={`trk-hcell${at === 0 ? ' trk-s2' : ''}${connected ? ' connected' : ''}${column.type === 'secret' ? ' secret' : ''}`}>
            <button type="button" className="trk-hbutton" aria-haspopup="dialog" title={connected ? `${column.name}. Fills itself from the linked task.` : column.type === 'secret' ? `${column.name}. Protected.` : column.name} onClick={event => props.onHeader(column, event.currentTarget)}>
              <ColumnIcon type={column.type} />
              <span className="trk-hname">{column.name}</span>
              {sorted && <span className="trk-sorted" aria-hidden="true">{sorted === 'asc' ? '↑' : '↓'}</span>}
              <ChevronDown size={13} className="trk-hchev" aria-hidden="true" />
            </button>
          </div>
        })}
        <div role="columnheader" className="trk-hcell trk-add">
          {props.onAddColumn && <button type="button" className="trk-add-column" aria-label="Add a column" title="Add a column" onClick={props.onAddColumn}><Plus size={16} aria-hidden="true" /></button>}
        </div>
      </div>
      <div style={{ height: start * ROW_HEIGHT }} aria-hidden="true" />
      {rendered}
      <div style={{ height: Math.max(0, entries.length - end) * ROW_HEIGHT }} aria-hidden="true" />
    </div>
  </div>
}
