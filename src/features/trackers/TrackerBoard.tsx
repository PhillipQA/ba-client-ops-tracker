/**
 * Board view: the rows shown (after search and filters) as cards in lanes by one Choice or Person column.
 * Dragging a card to another lane sets that column for the row, through the same save as editing the cell.
 */
import { useState } from 'react'
import { boardField, boardFields, boardLanes, cardFacts, laneCell } from './trackerBoard'
import type { Cell, OptionColor, TrackerColumn, TrackerRow } from './trackerModel'
import { type Lookup, rowTitle, shown } from './trackerQuery'
import { plural } from './trackerUi'

export default function TrackerBoard({
  trackerId,
  columns,
  rows,
  lookup,
  tones,
  canEdit,
  isLocked,
  onEdit,
  onOpenRow,
  commentCounts,
}: {
  trackerId: string
  columns: TrackerColumn[]
  rows: TrackerRow[]
  lookup: Lookup
  tones: ReadonlyMap<string, OptionColor>
  canEdit: boolean
  isLocked: (row: TrackerRow, column: TrackerColumn) => boolean
  onEdit: (row: TrackerRow, column: TrackerColumn, value: Cell) => void
  onOpenRow: (row: TrackerRow) => void
  commentCounts?: Readonly<Record<string, number>>
}) {
  const key = `ba.tracker.board.${trackerId}`
  const [chosen, setChosen] = useState(() => {
    try {
      return localStorage.getItem(key) || ''
    } catch {
      return ''
    }
  })
  const [dragging, setDragging] = useState('')
  const [over, setOver] = useState<string | null>(null)
  const fields = boardFields(columns)
  const field = boardField(columns, chosen)
  if (!field)
    return (
      <p className="trk-view-empty">
        The board needs a Choice or Person column to stand its cards in, such as Status. Add one in the Grid.
      </p>
    )
  const lanes = boardLanes(field, rows, id => lookup.person(id) || '')
  const dragged = dragging ? rows.find(row => row.id === dragging) : undefined
  const drop = (value: string) => {
    setOver(null)
    setDragging('')
    if (!dragged || isLocked(dragged, field)) return
    onEdit(dragged, field, laneCell({ value }))
  }
  return (
    <div className="trk-board-wrap">
      <div className="trk-view-bar">
        <label>
          Columns by{' '}
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
        <span className="trk-muted">
          {plural(rows.length, 'row')}
          {canEdit ? ` · drag a card to change its ${field.name}` : ''}
        </span>
      </div>
      <div className="trk-board" role="list" aria-label={`Rows by ${field.name}`}>
        {lanes.map(lane => (
          <section
            key={lane.value || '(none)'}
            role="listitem"
            className={`trk-lane${over === lane.value && dragged ? ' over' : ''}`}
            aria-label={`${lane.label}: ${plural(lane.rows.length, 'row')}`}
            onDragOver={event => {
              if (!dragged) return
              event.preventDefault()
              event.dataTransfer.dropEffect = 'move'
              if (over !== lane.value) setOver(lane.value)
            }}
            onDragLeave={event => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(null)
            }}
            onDrop={event => {
              event.preventDefault()
              drop(lane.value)
            }}
          >
            <header>
              <span className="trk-lane-name">
                <i className={`trk-lane-dot${lane.color ? ` trk-tone-${lane.color}` : ''}`} aria-hidden="true" />
                {lane.label}
              </span>
              <span className="trk-muted">{lane.rows.length}</span>
            </header>
            <div className="trk-lane-cards">
              {lane.rows.map(row => {
                const locked = isLocked(row, field)
                const tone = tones.get(row.id)
                const comments = commentCounts?.[row.id] || 0
                return (
                  <button
                    type="button"
                    key={row.id}
                    className={`trk-card-row${tone ? ` trk-hl trk-tone-${tone}` : ''}${dragging === row.id ? ' dragging' : ''}`}
                    draggable={canEdit && !locked}
                    title={
                      locked
                        ? `${field.name} comes from the Google Sheet for this row; change it there`
                        : 'Click to open the row'
                    }
                    onDragStart={event => {
                      event.dataTransfer.effectAllowed = 'move'
                      event.dataTransfer.setData('text/plain', rowTitle(columns, row))
                      setDragging(row.id)
                    }}
                    onDragEnd={() => {
                      setDragging('')
                      setOver(null)
                    }}
                    onClick={() => onOpenRow(row)}
                  >
                    <strong>{rowTitle(columns, row)}</strong>
                    {cardFacts(row, columns, field, (column, item) => shown(column, item, lookup).text).map(fact => (
                      <span key={fact.name} className="trk-card-fact">
                        <small>{fact.name}</small> {fact.text}
                      </span>
                    ))}
                    {comments > 0 && <span className="trk-card-fact">{plural(comments, 'comment')}</span>}
                  </button>
                )
              })}
              {!lane.rows.length && <p className="trk-lane-empty">{dragged ? 'Drop here' : 'No rows'}</p>}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}
