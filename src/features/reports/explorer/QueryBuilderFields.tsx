// Data explorer: the builder's fields (a query without SQL). Used by the Data explorer and by SQL widgets on reports
// and the Action Center; each change gives the next builder, whose SQL the caller writes with builderSql.
import { Plus, X } from 'lucide-react'
import type { TableInfo } from './explorerTables'
import {
  builderColumns,
  emptyBuilder,
  joinsFrom,
  type Builder,
  type BuilderFilter,
  type BuilderFilterOp,
  type BuilderSummary,
} from './queryBuilder'

const SUMMARIES: { value: BuilderSummary; label: string; measure: boolean }[] = [
  { value: 'count', label: 'Count of rows', measure: false },
  { value: 'count_distinct', label: 'Number of different…', measure: true },
  { value: 'sum', label: 'Total of…', measure: true },
  { value: 'avg', label: 'Average of…', measure: true },
  { value: 'min', label: 'Lowest…', measure: true },
  { value: 'max', label: 'Highest…', measure: true },
  { value: 'rows', label: 'Just the rows', measure: false },
]
const FILTER_OPS: { value: BuilderFilterOp; label: string; needsValue: boolean }[] = [
  { value: 'is', label: 'is', needsValue: true },
  { value: 'is_not', label: 'is not', needsValue: true },
  { value: 'contains', label: 'contains', needsValue: true },
  { value: 'gte', label: 'is on or after / at least', needsValue: true },
  { value: 'lte', label: 'is on or before / at most', needsValue: true },
  { value: 'empty', label: 'is empty', needsValue: false },
  { value: 'not_empty', label: 'is filled in', needsValue: false },
  { value: 'true', label: 'is yes', needsValue: false },
  { value: 'false', label: 'is no', needsValue: false },
]

export function QueryBuilderFields({
  builder,
  catalog,
  onChange: applyBuilder,
}: {
  builder: Builder
  catalog: TableInfo[]
  onChange: (next: Builder) => void
}) {
  const columns = builderColumns(builder, catalog)
  const setFilter = (index: number, patch: Partial<BuilderFilter>) =>
    applyBuilder({
      ...builder,
      filters: builder.filters.map((item, at) => (at === index ? { ...item, ...patch } : item)),
    })
  return (
    <div className="dx-builder">
      <label>
        <span>From</span>
        <select value={builder.table} onChange={event => applyBuilder(emptyBuilder(event.target.value))}>
          {catalog.map(table => (
            <option key={table.name} value={table.name}>
              {table.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>With</span>
        <select value={builder.join} onChange={event => applyBuilder({ ...builder, join: event.target.value })}>
          <option value="">Nothing else</option>
          {joinsFrom(builder.table).map(join => (
            <option key={join.key} value={join.key}>
              {join.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Show</span>
        <select
          value={builder.summary}
          onChange={event => {
            const summary = event.target.value as BuilderSummary
            const needs = SUMMARIES.find(item => item.value === summary)?.measure
            const numeric = columns.find(column => column.type === 'number')?.key || ''
            applyBuilder({
              ...builder,
              summary,
              measure: needs ? (summary === 'count_distinct' ? columns[0]?.key || '' : numeric) : '',
            })
          }}
        >
          {SUMMARIES.map(item => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
      {SUMMARIES.find(item => item.value === builder.summary)?.measure && (
        <label>
          <span>Of</span>
          <select
            value={builder.measure}
            onChange={event => applyBuilder({ ...builder, measure: event.target.value })}
          >
            {columns
              .filter(
                column => builder.summary === 'count_distinct' || ['number', 'date'].includes(column.type),
              )
              .map(column => (
                <option key={column.key} value={column.key}>
                  {column.key}
                </option>
              ))}
          </select>
        </label>
      )}
      {builder.summary === 'rows' ? (
        <label className="dx-wide">
          <span>Columns</span>
          <select
            value=""
            onChange={event =>
              event.target.value &&
              applyBuilder({ ...builder, columns: [...builder.columns, event.target.value] })
            }
          >
            <option value="">
              {builder.columns.length ? 'Add a column…' : 'All columns (add to choose)…'}
            </option>
            {columns
              .filter(column => !builder.columns.includes(column.key))
              .map(column => (
                <option key={column.key} value={column.key}>
                  {column.key}
                </option>
              ))}
          </select>
          <div className="crp-choices">
            {builder.columns.map(key => (
              <button
                type="button"
                key={key}
                className="on"
                onClick={() =>
                  applyBuilder({ ...builder, columns: builder.columns.filter(item => item !== key) })
                }
              >
                {key} <X size={11} />
              </button>
            ))}
          </div>
        </label>
      ) : (
        <label>
          <span>Grouped by</span>
          <select
            value={builder.groupBy[0] || ''}
            onChange={event =>
              applyBuilder({
                ...builder,
                groupBy: event.target.value ? [event.target.value, ...builder.groupBy.slice(1)] : [],
              })
            }
          >
            <option value="">Nothing (one total)</option>
            {columns.map(column => (
              <option key={column.key} value={column.key}>
                {column.key}
              </option>
            ))}
          </select>
        </label>
      )}
      {builder.summary !== 'rows' && builder.groupBy[0] && (
        <label>
          <span>Then by</span>
          <select
            value={builder.groupBy[1] || ''}
            onChange={event =>
              applyBuilder({
                ...builder,
                groupBy: [builder.groupBy[0], ...(event.target.value ? [event.target.value] : [])],
              })
            }
          >
            <option value="">Nothing</option>
            {columns
              .filter(column => column.key !== builder.groupBy[0])
              .map(column => (
                <option key={column.key} value={column.key}>
                  {column.key}
                </option>
              ))}
          </select>
        </label>
      )}
      {builder.summary !== 'rows' &&
        builder.groupBy.some(key => columns.find(column => column.key === key)?.type === 'date') && (
          <label>
            <span>Dates</span>
            <select
              value={builder.bucket}
              onChange={event => applyBuilder({ ...builder, bucket: event.target.value as Builder['bucket'] })}
            >
              <option value="day">As they are</option>
              <option value="week">By week</option>
              <option value="month">By month</option>
            </select>
          </label>
        )}
      {builder.summary !== 'rows' && (
        <label>
          <span>Order</span>
          <select
            value={builder.sort}
            onChange={event => applyBuilder({ ...builder, sort: event.target.value as Builder['sort'] })}
          >
            <option value="value_desc">Largest first</option>
            <option value="value_asc">Smallest first</option>
            <option value="group">By group</option>
            <option value="none">As they come</option>
          </select>
        </label>
      )}
      <label>
        <span>At most</span>
        <input
          type="number"
          min={1}
          max={5000}
          value={builder.limit}
          onChange={event => applyBuilder({ ...builder, limit: Number(event.target.value) || 100 })}
        />
      </label>
      <div className="dx-filters">
        {builder.filters.map((filter, index) => {
          const needsValue = FILTER_OPS.find(item => item.value === filter.op)?.needsValue
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: filters have no id of their own
            <div key={index} className="dx-filter">
              <span>{index ? 'and' : 'Only where'}</span>
              <select
                value={filter.column}
                onChange={event => setFilter(index, { column: event.target.value })}
              >
                {columns.map(column => (
                  <option key={column.key} value={column.key}>
                    {column.key}
                  </option>
                ))}
              </select>
              <select
                value={filter.op}
                onChange={event => setFilter(index, { op: event.target.value as BuilderFilterOp })}
              >
                {FILTER_OPS.map(item => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
              {needsValue && !filter.ask && (
                <input
                  value={filter.value}
                  placeholder="Value"
                  onChange={event => setFilter(index, { value: event.target.value })}
                />
              )}
              {needsValue && (
                <label className="crp-check">
                  <input
                    type="checkbox"
                    checked={filter.ask}
                    onChange={event => setFilter(index, { ask: event.target.checked })}
                  />
                  Ask each time
                </label>
              )}
              <button
                type="button"
                className="crp-icon small"
                aria-label="Remove this condition"
                onClick={() =>
                  applyBuilder({ ...builder, filters: builder.filters.filter((_, at) => at !== index) })
                }
              >
                <X size={12} />
              </button>
            </div>
          )
        })}
        <button
          type="button"
          className="crp-btn subtle"
          onClick={() =>
            applyBuilder({
              ...builder,
              filters: [
                ...builder.filters,
                {
                  column: (columns.find(column => !/(^|_)id$/.test(column.name)) || columns[0])?.key || '',
                  op: 'is',
                  value: '',
                  ask: false,
                },
              ],
            })
          }
        >
          <Plus size={13} /> Add a condition
        </button>
      </div>
    </div>
  )
}
