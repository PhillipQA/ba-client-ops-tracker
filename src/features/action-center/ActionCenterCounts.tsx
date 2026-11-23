/**
 * The count tiles at the top of the Action Center, and the dialog that picks, orders, renames and recolours them, or
 * builds a person's own count of tasks with Reports filters.
 */
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CalendarDays,
  Clock,
  Hash,
  Inbox,
  Pencil,
  Plus,
  Settings2,
  Timer,
  Trash2,
  UserRound,
} from 'lucide-react'
import { type ReactNode, useState } from 'react'
import {
  BUILTIN_COUNTS,
  type BuiltinCount,
  COUNT_LIMITS,
  type CountTile,
  newTileId,
  TILE_COLORS,
  TILE_DETAILS,
  type TileColor,
  type TileDetail,
  builtinLabel,
} from '../../shared/actionCenterSettings'
import { Dialog } from '../../shared/ui'
import type { FilterOp, WidgetFilter } from '../reports/custom/reportModel'
import type { Field } from '../reports/custom/reportData'
import { describeFilter, type TileValue } from './countTiles'

const ICONS: Record<BuiltinCount, ReactNode> = {
  attention: <AlertTriangle size={18} />,
  waitingDev: <Settings2 size={18} />,
  waitingClient: <UserRound size={18} />,
  overdue: <Clock size={18} />,
  dueToday: <CalendarDays size={18} />,
  activities: <CalendarDays size={18} />,
  inquiries: <Inbox size={18} />,
  unsentTime: <Timer size={18} />,
}
const COLOR_NAMES: Record<TileColor, string> = {
  green: 'Green',
  blue: 'Blue',
  amber: 'Amber',
  red: 'Red',
  purple: 'Purple',
  gray: 'Gray',
}
const DETAIL_NAMES: Record<TileDetail, string> = {
  overdue: 'How many are overdue',
  clients: 'How many clients',
  none: 'Nothing',
}

export function CountTiles({
  tiles,
  readValue,
  onOpen,
}: {
  tiles: CountTile[]
  readValue: (tile: CountTile) => TileValue
  /** Clicking a tile opens the list behind its number (DrillPanel). */
  onOpen?: (tile: CountTile, title: string) => void
}) {
  if (!tiles.length) return <p className="ac-widget-note">No count tiles. Add some under Customize.</p>
  return (
    <div className="metric-grid dashboard-metrics ac-tiles">
      {tiles.map(tile => {
        const shown = readValue(tile)
        const title = tile.title || shown.title
        const className = `metric-card${tile.color ? ` ac-tile-${tile.color}` : ''}`
        const body = (
          <>
            <div className="metric-icon">{tile.builtin ? ICONS[tile.builtin] : <Hash size={18} />}</div>
            <div>
              <span>{title}</span>
              <strong>{shown.value}</strong>
              {shown.detail && <small>{shown.detail}</small>}
            </div>
          </>
        )
        return onOpen ? (
          <button
            key={tile.id}
            type="button"
            className={`${className} ac-tile-open`}
            title={`See the ${title.toLowerCase()} list`}
            onClick={() => onOpen(tile, title)}
          >
            {body}
          </button>
        ) : (
          <div key={tile.id} className={className}>
            {body}
          </div>
        )
      })}
    </div>
  )
}

const OPS: { op: FilterOp; label: string; types: Field['type'][] }[] = [
  { op: 'is', label: 'is', types: ['text', 'bool'] },
  { op: 'is_not', label: 'is not', types: ['text'] },
  { op: 'contains', label: 'contains', types: ['text'] },
  { op: 'empty', label: 'is empty', types: ['text', 'date', 'number'] },
  { op: 'not_empty', label: 'is not empty', types: ['text', 'date', 'number'] },
  { op: 'gt', label: 'more than', types: ['number'] },
  { op: 'lt', label: 'less than', types: ['number'] },
  { op: 'before', label: 'before', types: ['date'] },
  { op: 'after', label: 'after', types: ['date'] },
  { op: 'on', label: 'on', types: ['date'] },
  { op: 'true', label: 'is yes', types: ['bool'] },
  { op: 'false', label: 'is no', types: ['bool'] },
]
const needsValue = (op: FilterOp) => !['empty', 'not_empty', 'true', 'false'].includes(op)

/** The tile editor: the tiles in order on the left, the chosen tile's settings on the right. */
export function CountTilesDialog({
  tiles: initial,
  fields,
  valuesFor,
  onSave,
  onClose,
}: {
  tiles: CountTile[]
  /** The Tasks fields, for custom counts. */
  fields: Field[]
  /** Values a field has, for the filter value list. */
  valuesFor: (field: string) => string[]
  onSave: (tiles: CountTile[]) => void
  onClose: () => void
}) {
  const [tiles, setTiles] = useState(initial)
  const [selected, setSelected] = useState(initial[0]?.id || '')
  const tile = tiles.find(item => item.id === selected)
  const full = tiles.length >= COUNT_LIMITS.tiles
  const update = (patch: Partial<CountTile>) =>
    setTiles(current => current.map(item => (item.id === selected ? { ...item, ...patch } : item)))
  const move = (index: number, to: number) =>
    setTiles(current => {
      if (to < 0 || to >= current.length) return current
      const next = [...current]
      const [moved] = next.splice(index, 1)
      next.splice(to, 0, moved)
      return next
    })
  const toggleBuiltin = (id: BuiltinCount) => {
    if (tiles.some(item => item.builtin === id)) {
      setTiles(current => current.filter(item => item.builtin !== id))
      if (selected === id) setSelected('')
    } else if (!full) {
      setTiles(current => [...current, { id, builtin: id }])
      setSelected(id)
    }
  }
  const addCustom = () => {
    if (full) return
    const id = newTileId()
    setTiles(current => [
      ...current,
      { id, title: 'My count', filters: [], mine: true, detail: 'overdue', color: 'purple' },
    ])
    setSelected(id)
  }
  const setFilter = (index: number, patch: Partial<WidgetFilter>) =>
    update({ filters: (tile?.filters || []).map((item, at) => (at === index ? { ...item, ...patch } : item)) })
  const invalid = tiles.some(item => !item.builtin && !item.title?.trim())

  return (
    <Dialog title="Count tiles" eyebrow="Action Center" size="wide" onClose={onClose}>
      <div className="ac-tiles-editor">
        <div className="ac-tiles-list">
          <h3>On the page</h3>
          {!tiles.length && <p className="ac-widget-note">No tiles. Tick a built-in count or add your own.</p>}
          <ol>
            {tiles.map((item, index) => (
              <li key={item.id} className={item.id === selected ? 'selected' : ''}>
                <button type="button" className="ac-tiles-pick" onClick={() => setSelected(item.id)}>
                  <span className={`ac-swatch ac-tile-${item.color || 'none'}`} aria-hidden="true" />
                  <span>{item.title || (item.builtin ? builtinLabel(item.builtin) : 'My count')}</span>
                  {!item.builtin && <em>Custom</em>}
                </button>
                <button
                  type="button"
                  aria-label="Move up"
                  disabled={index === 0}
                  onClick={() => move(index, index - 1)}
                >
                  <ArrowUp size={14} />
                </button>
                <button
                  type="button"
                  aria-label="Move down"
                  disabled={index === tiles.length - 1}
                  onClick={() => move(index, index + 1)}
                >
                  <ArrowDown size={14} />
                </button>
              </li>
            ))}
          </ol>
          <h3>Built-in counts</h3>
          <div className="ac-tiles-builtins">
            {BUILTIN_COUNTS.map(item => {
              const on = tiles.some(entry => entry.builtin === item.id)
              return (
                <label key={item.id} title={item.about}>
                  <input type="checkbox" checked={on} disabled={!on && full} onChange={() => toggleBuiltin(item.id)} />
                  {item.label}
                </label>
              )
            })}
          </div>
          <button type="button" className="secondary" disabled={full} onClick={addCustom}>
            <Plus size={14} /> Add your own count
          </button>
          {full && <p className="ac-widget-note">At most {COUNT_LIMITS.tiles} tiles.</p>}
        </div>

        <div className="ac-tiles-detail">
          {!tile ? (
            <p className="ac-widget-note">Choose a tile to rename it, recolour it or change what it counts.</p>
          ) : (
            <>
              <h3>
                <Pencil size={15} /> {tile.builtin ? builtinLabel(tile.builtin) : 'Your own count'}
              </h3>
              <label className="ac-field">
                <span>Title</span>
                <input
                  value={tile.title || ''}
                  maxLength={COUNT_LIMITS.title}
                  placeholder={tile.builtin ? builtinLabel(tile.builtin) : 'Name this count'}
                  onChange={event => update({ title: event.target.value })}
                />
              </label>
              <fieldset className="ac-field">
                <legend>Colour</legend>
                <div className="ac-swatches">
                  <button
                    type="button"
                    className="ac-swatch ac-tile-none"
                    aria-label="No colour"
                    aria-pressed={!tile.color}
                    onClick={() => update({ color: undefined })}
                  />
                  {TILE_COLORS.map(color => (
                    <button
                      type="button"
                      key={color}
                      className={`ac-swatch ac-tile-${color}`}
                      aria-label={COLOR_NAMES[color]}
                      aria-pressed={tile.color === color}
                      onClick={() => update({ color })}
                    />
                  ))}
                </div>
              </fieldset>
              {!tile.builtin && (
                <>
                  <fieldset className="ac-field">
                    <legend>Count tasks where</legend>
                    {(tile.filters || []).map((filter, index) => {
                      const field = fields.find(item => item.key === filter.field) || fields[0]
                      const ops = OPS.filter(item => item.types.includes(field?.type || 'text'))
                      const values = field?.type === 'text' ? valuesFor(field.key) : []
                      return (
                        <div key={`${index}:${filter.field}`} className="ac-filter-row">
                          <select
                            aria-label="Field"
                            value={filter.field}
                            onChange={event => {
                              const next = fields.find(item => item.key === event.target.value)
                              const op = OPS.find(item => item.types.includes(next?.type || 'text'))?.op || 'is'
                              setFilter(index, { field: event.target.value, op, value: '' })
                            }}
                          >
                            {fields.map(item => (
                              <option key={item.key} value={item.key}>
                                {item.label}
                              </option>
                            ))}
                          </select>
                          <select
                            aria-label="Comparison"
                            value={filter.op}
                            onChange={event => setFilter(index, { op: event.target.value as FilterOp })}
                          >
                            {ops.map(item => (
                              <option key={item.op} value={item.op}>
                                {item.label}
                              </option>
                            ))}
                          </select>
                          {needsValue(filter.op) &&
                            (values.length && (filter.op === 'is' || filter.op === 'is_not') ? (
                              <select
                                aria-label="Value"
                                value={filter.value || ''}
                                onChange={event => setFilter(index, { value: event.target.value })}
                              >
                                <option value="">Choose…</option>
                                {values.map(value => (
                                  <option key={value} value={value}>
                                    {value}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <input
                                aria-label="Value"
                                type={field?.type === 'date' ? 'date' : field?.type === 'number' ? 'number' : 'text'}
                                value={filter.value || ''}
                                onChange={event => setFilter(index, { value: event.target.value })}
                              />
                            ))}
                          <button
                            type="button"
                            className="icon-only secondary"
                            aria-label={`Remove filter ${describeFilter(filter, fields)}`}
                            onClick={() =>
                              update({ filters: (tile.filters || []).filter((_item, at) => at !== index) })
                            }
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      )
                    })}
                    {(tile.filters || []).length < COUNT_LIMITS.filters && fields.length > 0 && (
                      <button
                        type="button"
                        className="link-button"
                        onClick={() =>
                          update({ filters: [...(tile.filters || []), { field: 'waitingOn', op: 'is', value: '' }] })
                        }
                      >
                        <Plus size={13} /> Add a filter
                      </button>
                    )}
                  </fieldset>
                  <label className="ac-check">
                    <input
                      type="checkbox"
                      checked={Boolean(tile.mine)}
                      onChange={event => update({ mine: event.target.checked })}
                    />
                    Only tasks assigned to me
                  </label>
                  <label className="ac-check">
                    <input
                      type="checkbox"
                      checked={Boolean(tile.all)}
                      onChange={event => update({ all: event.target.checked })}
                    />
                    Include done tasks
                  </label>
                  <label className="ac-field">
                    <span>Small line under the number</span>
                    <select
                      value={tile.detail || 'overdue'}
                      onChange={event => update({ detail: event.target.value as TileDetail })}
                    >
                      {TILE_DETAILS.map(detail => (
                        <option key={detail} value={detail}>
                          {DETAIL_NAMES[detail]}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              )}
              <button
                type="button"
                className="link-button danger"
                onClick={() => {
                  setTiles(current => current.filter(item => item.id !== tile.id))
                  setSelected('')
                }}
              >
                <Trash2 size={13} /> Remove this tile
              </button>
            </>
          )}
        </div>
      </div>
      <div className="k-dialog-actions">
        {invalid && <span className="ac-widget-note">Give each of your own counts a title.</span>}
        <span style={{ flex: 1 }} />
        <button type="button" className="secondary" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="primary"
          disabled={invalid}
          onClick={() =>
            onSave(
              tiles.map(item =>
                item.title?.trim() ? { ...item, title: item.title.trim() } : { ...item, title: undefined },
              ),
            )
          }
        >
          Use these tiles
        </button>
      </div>
    </Dialog>
  )
}
