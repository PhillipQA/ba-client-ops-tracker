import { useRef, type ReactNode, type RefObject } from 'react'
import { ArrowUpDown, Columns3, Layers3, ListFilter, Plus, X } from 'lucide-react'
import {
  FILTER_OPS,
  TRACKER_LIMITS,
  filterNeedsValue,
  filterOpLabel,
  filterOpsFor,
  type TrackerColumn,
  type ViewFilter,
  type TrackerView,
} from './trackerModel'
import { Popover } from './trackerUi'
import type { Person } from './TrackerCells'

/** The working state of the grid: what the toolbar edits. A saved view is a named copy of everything except the search. */
export type Work = {
  search: string
  filters: ViewFilter[]
  sort: TrackerView['sort']
  groupBy: string
  hidden: string[]
}
export const emptyWork: Work = { search: '', filters: [], sort: null, groupBy: '', hidden: [] }

type PanelId = 'filter' | 'sort' | 'group' | 'fields' | null

type Props = {
  columns: TrackerColumn[]
  work: Work
  people: Person[]
  open: PanelId
  onOpen: (panel: PanelId) => void
  onChange: (work: Work) => void
}

function ToolButton({
  icon,
  label,
  count,
  active,
  onClick,
  buttonRef,
}: {
  icon: ReactNode
  label: string
  count?: number
  active: boolean
  onClick: () => void
  buttonRef: RefObject<HTMLButtonElement | null>
}) {
  return (
    <button
      type="button"
      ref={buttonRef}
      className={`trk-tool${count ? ' on' : ''}`}
      aria-haspopup="dialog"
      aria-expanded={active}
      onClick={onClick}
    >
      {icon}
      <span>{label}</span>
      {count ? <b>{count}</b> : null}
    </button>
  )
}

function FilterValue({
  column,
  filter,
  people,
  onChange,
}: {
  column: TrackerColumn
  filter: ViewFilter
  people: Person[]
  onChange: (value: string) => void
}) {
  if (!filterNeedsValue(filter.op)) return null
  const label = `Value for ${column.name}`
  if (column.type === 'select' && (filter.op === 'is' || filter.op === 'is_not')) {
    return (
      <select aria-label={label} value={filter.value} onChange={event => onChange(event.target.value)}>
        <option value="">Choose…</option>
        {(column.options || []).map(option => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
    )
  }
  if (column.type === 'person' && (filter.op === 'is' || filter.op === 'is_not')) {
    return (
      <select aria-label={label} value={filter.value} onChange={event => onChange(event.target.value)}>
        <option value="">Choose…</option>
        {[...people]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(person => (
            <option key={person.id} value={person.id}>
              {person.name}
            </option>
          ))}
      </select>
    )
  }
  if (column.type === 'multiselect') {
    return (
      <select aria-label={label} value={filter.value} onChange={event => onChange(event.target.value)}>
        <option value="">Choose…</option>
        {(column.options || []).map(option => (
          <option key={option.id} value={option.label}>
            {option.label}
          </option>
        ))}
      </select>
    )
  }
  const date = column.type === 'date' || column.type === 'task_due'
  return (
    <input
      aria-label={label}
      type={date ? 'date' : 'text'}
      inputMode={column.type === 'number' ? 'decimal' : undefined}
      value={filter.value}
      maxLength={200}
      onChange={event => onChange(event.target.value)}
    />
  )
}

export default function TrackerToolbar({ columns, work, people, open, onOpen, onChange }: Props) {
  const filterButton = useRef<HTMLButtonElement>(null),
    sortButton = useRef<HTMLButtonElement>(null),
    groupButton = useRef<HTMLButtonElement>(null),
    fieldsButton = useRef<HTMLButtonElement>(null)
  const byId = new Map(columns.map(column => [column.id, column]))
  const filterable = columns
  const toggle = (panel: Exclude<PanelId, null>) => onOpen(open === panel ? null : panel)
  const setFilter = (index: number, patch: Partial<ViewFilter>) =>
    onChange({ ...work, filters: work.filters.map((filter, at) => (at === index ? { ...filter, ...patch } : filter)) })
  const addFilter = () => {
    const column = columns[0]
    if (!column || work.filters.length >= TRACKER_LIMITS.filtersPerView) return
    onChange({
      ...work,
      filters: [...work.filters, { columnId: column.id, op: filterOpsFor(column.type)[0], value: '' }],
    })
  }
  const groupable = columns.filter(column => column.type !== 'secret' && column.type !== 'longtext')
  const sortable = columns.filter(column => column.type !== 'secret')

  return (
    <>
      <ToolButton
        buttonRef={filterButton}
        icon={<ListFilter size={15} aria-hidden="true" />}
        label="Filter"
        count={work.filters.length}
        active={open === 'filter'}
        onClick={() => toggle('filter')}
      />
      <ToolButton
        buttonRef={sortButton}
        icon={<ArrowUpDown size={15} aria-hidden="true" />}
        label="Sort"
        count={work.sort ? 1 : 0}
        active={open === 'sort'}
        onClick={() => toggle('sort')}
      />
      <ToolButton
        buttonRef={groupButton}
        icon={<Layers3 size={15} aria-hidden="true" />}
        label="Group by"
        count={work.groupBy ? 1 : 0}
        active={open === 'group'}
        onClick={() => toggle('group')}
      />
      <ToolButton
        buttonRef={fieldsButton}
        icon={<Columns3 size={15} aria-hidden="true" />}
        label="Fields"
        count={work.hidden.length}
        active={open === 'fields'}
        onClick={() => toggle('fields')}
      />

      {open === 'filter' && (
        <Popover
          anchor={filterButton}
          onClose={() => onOpen(null)}
          className="trk-panel-pop"
          label="Filter rows"
          minWidth={420}
        >
          <div className="trk-pop-body">
            {!work.filters.length && (
              <p className="trk-muted-text">No filters. Rows must match every filter you add.</p>
            )}
            {work.filters.map((filter, index) => {
              const column = byId.get(filter.columnId)
              if (!column) return null
              const ops = filterOpsFor(column.type)
              return (
                <div className="trk-filter-row" key={index}>
                  <select
                    aria-label="Column"
                    value={filter.columnId}
                    onChange={event => {
                      const next = byId.get(event.target.value)!
                      setFilter(index, { columnId: next.id, op: filterOpsFor(next.type)[0], value: '' })
                    }}
                  >
                    {filterable.map(item => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label="Condition"
                    value={filter.op}
                    onChange={event => setFilter(index, { op: event.target.value as ViewFilter['op'], value: '' })}
                  >
                    {ops
                      .filter(op => FILTER_OPS.includes(op))
                      .map(op => (
                        <option key={op} value={op}>
                          {filterOpLabel[op]}
                        </option>
                      ))}
                  </select>
                  <FilterValue
                    column={column}
                    filter={filter}
                    people={people}
                    onChange={value => setFilter(index, { value })}
                  />
                  <button
                    type="button"
                    className="trk-icon-button small"
                    aria-label="Remove this filter"
                    onClick={() => onChange({ ...work, filters: work.filters.filter((_, at) => at !== index) })}
                  >
                    <X size={14} />
                  </button>
                </div>
              )
            })}
            <div className="trk-pop-actions">
              <button
                type="button"
                className="trk-text-button strong"
                disabled={work.filters.length >= TRACKER_LIMITS.filtersPerView}
                onClick={addFilter}
              >
                <Plus size={13} aria-hidden="true" /> Add filter
              </button>
              {work.filters.length > 0 && (
                <button type="button" className="trk-text-button" onClick={() => onChange({ ...work, filters: [] })}>
                  Clear all
                </button>
              )}
            </div>
          </div>
        </Popover>
      )}

      {open === 'sort' && (
        <Popover
          anchor={sortButton}
          onClose={() => onOpen(null)}
          className="trk-panel-pop"
          label="Sort rows"
          minWidth={320}
        >
          <div className="trk-pop-body">
            <label className="trk-field-block">
              Sort by
              <select
                value={work.sort?.columnId || ''}
                onChange={event =>
                  onChange({
                    ...work,
                    sort: event.target.value ? { columnId: event.target.value, dir: work.sort?.dir || 'asc' } : null,
                  })
                }
              >
                <option value="">Manual order</option>
                {sortable.map(column => (
                  <option key={column.id} value={column.id}>
                    {column.name}
                  </option>
                ))}
              </select>
            </label>
            {work.sort && (
              <div className="trk-seg" role="radiogroup" aria-label="Direction">
                <button
                  type="button"
                  role="radio"
                  aria-checked={work.sort.dir === 'asc'}
                  className={work.sort.dir === 'asc' ? 'on' : ''}
                  onClick={() => onChange({ ...work, sort: { ...work.sort!, dir: 'asc' } })}
                >
                  Ascending
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={work.sort.dir === 'desc'}
                  className={work.sort.dir === 'desc' ? 'on' : ''}
                  onClick={() => onChange({ ...work, sort: { ...work.sort!, dir: 'desc' } })}
                >
                  Descending
                </button>
              </div>
            )}
            <p className="trk-muted-text">Empty values always sort last.</p>
          </div>
        </Popover>
      )}

      {open === 'group' && (
        <Popover
          anchor={groupButton}
          onClose={() => onOpen(null)}
          className="trk-panel-pop"
          label="Group rows"
          minWidth={300}
        >
          <div className="trk-pop-body">
            <label className="trk-field-block">
              Group by
              <select value={work.groupBy} onChange={event => onChange({ ...work, groupBy: event.target.value })}>
                <option value="">No grouping</option>
                {groupable.map(column => (
                  <option key={column.id} value={column.id}>
                    {column.name}
                  </option>
                ))}
              </select>
            </label>
            <p className="trk-muted-text">Status columns group in the order of their options.</p>
          </div>
        </Popover>
      )}

      {open === 'fields' && (
        <Popover
          anchor={fieldsButton}
          onClose={() => onOpen(null)}
          className="trk-panel-pop"
          label="Choose columns"
          minWidth={280}
        >
          <div className="trk-pop-body">
            <div className="trk-fields-list">
              {columns.map((column, at) => {
                const hidden = work.hidden.includes(column.id)
                const last = !hidden && columns.length - work.hidden.length <= 1
                return (
                  <label key={column.id} className="trk-checkline">
                    <input
                      type="checkbox"
                      checked={!hidden}
                      disabled={last}
                      onChange={event =>
                        onChange({
                          ...work,
                          hidden: event.target.checked
                            ? work.hidden.filter(id => id !== column.id)
                            : [...work.hidden, column.id],
                        })
                      }
                    />{' '}
                    <span>{column.name}</span>
                    {at === 0 && <small>stays frozen</small>}
                  </label>
                )
              })}
            </div>
            {work.hidden.length > 0 && (
              <div className="trk-pop-actions">
                <button type="button" className="trk-text-button" onClick={() => onChange({ ...work, hidden: [] })}>
                  Show all
                </button>
              </div>
            )}
          </div>
        </Popover>
      )}
    </>
  )
}
