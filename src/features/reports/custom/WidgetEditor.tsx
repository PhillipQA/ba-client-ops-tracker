// Custom reports: the settings of one widget, with a live preview beside them.
import { useMemo, useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react'
import { Dialog } from '../../../shared/ui'
import type { Tracker } from '../../trackers/trackerModel'
import { fieldValues, SOURCES, type Field, type FieldType, type Rec } from './reportData'
import {
  BUCKETS,
  WIDGET_LABELS,
  type Bucket,
  type FilterOp,
  type Measure,
  type MeasureOp,
  type SourceId,
  type Widget,
  type WidgetFilter,
  type WidgetKind,
} from './reportModel'

const OPS: Record<FieldType, { op: FilterOp; label: string }[]> = {
  text: [
    { op: 'is', label: 'is any of' },
    { op: 'is_not', label: 'is none of' },
    { op: 'contains', label: 'contains' },
    { op: 'not_empty', label: 'is filled in' },
    { op: 'empty', label: 'is empty' },
  ],
  number: [
    { op: 'eq', label: '=' },
    { op: 'gt', label: 'more than' },
    { op: 'lt', label: 'less than' },
    { op: 'not_empty', label: 'is filled in' },
    { op: 'empty', label: 'is empty' },
  ],
  date: [
    { op: 'before', label: 'before' },
    { op: 'after', label: 'after' },
    { op: 'on', label: 'on' },
    { op: 'not_empty', label: 'is filled in' },
    { op: 'empty', label: 'is empty' },
  ],
  bool: [
    { op: 'true', label: 'is Yes' },
    { op: 'false', label: 'is No' },
  ],
}
const MEASURES: { op: MeasureOp; label: string; needs: 'none' | 'number' | 'any' | 'where' }[] = [
  { op: 'count', label: 'Count of rows', needs: 'none' },
  { op: 'sum', label: 'Total of…', needs: 'number' },
  { op: 'avg', label: 'Average of…', needs: 'number' },
  { op: 'min', label: 'Lowest…', needs: 'number' },
  { op: 'max', label: 'Highest…', needs: 'number' },
  { op: 'distinct', label: 'Number of different…', needs: 'any' },
  { op: 'percent', label: '% of rows where…', needs: 'where' },
]
const BUCKET_LABELS: Record<Bucket, string> = {
  day: 'By day',
  week: 'By week',
  month: 'By month',
  quarter: 'By quarter',
  year: 'By year',
}
const DATA_KINDS: WidgetKind[] = ['metric', 'bar', 'column', 'line', 'pie', 'table', 'gantt']

function FieldSelect({
  fields,
  value,
  onChange,
  none,
  types,
}: {
  fields: Field[]
  value: string | undefined
  onChange: (value: string) => void
  /** The label of the "nothing chosen" option. Without it, a field must be chosen. */
  none?: string
  types?: FieldType[]
}) {
  const list = types ? fields.filter(field => types.includes(field.type)) : fields
  return (
    <select value={value || ''} onChange={event => onChange(event.target.value)}>
      {(none !== undefined || !value) && <option value="">{none ?? 'Choose…'}</option>}
      {list.map(field => (
        <option key={field.key} value={field.key}>
          {field.label}
        </option>
      ))}
    </select>
  )
}

function Row({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="crp-form-row">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  )
}

/** One condition: a field, how it compares, and to what. */
function Condition({
  filter,
  fields,
  records,
  onChange,
  onRemove,
}: {
  filter: WidgetFilter
  fields: Field[]
  records: Rec[]
  onChange: (filter: WidgetFilter) => void
  onRemove?: () => void
}) {
  const field = fields.find(item => item.key === filter.field)
  const type = field?.type || 'text'
  const ops = OPS[type]
  const op = ops.some(item => item.op === filter.op) ? filter.op : ops[0].op
  const choices = useMemo(
    () => (field && type === 'text' ? fieldValues(records, field, 40) : []),
    [records, field, type],
  )
  const picked = filter.values || []
  return (
    <div className="crp-condition">
      <div className="crp-condition-line">
        <FieldSelect
          fields={fields}
          value={filter.field}
          onChange={key => {
            const next = fields.find(item => item.key === key)
            onChange({ field: key, op: OPS[next?.type || 'text'][0].op })
          }}
        />
        <select value={op} onChange={event => onChange({ ...filter, op: event.target.value as FilterOp })}>
          {ops.map(item => (
            <option key={item.op} value={item.op}>
              {item.label}
            </option>
          ))}
        </select>
        {onRemove && (
          <button type="button" className="crp-icon" aria-label="Remove this condition" onClick={onRemove}>
            <X size={14} />
          </button>
        )}
      </div>
      {(op === 'is' || op === 'is_not') && (
        <div className="crp-choices">
          {choices.length === 0 && <small>No values yet.</small>}
          {choices.map(choice => (
            <button
              type="button"
              key={choice}
              className={picked.includes(choice) ? 'on' : ''}
              aria-pressed={picked.includes(choice)}
              onClick={() =>
                onChange({
                  ...filter,
                  op,
                  values: picked.includes(choice) ? picked.filter(item => item !== choice) : [...picked, choice],
                })
              }
            >
              {choice}
            </button>
          ))}
        </div>
      )}
      {op === 'contains' && (
        <input
          value={filter.value || ''}
          placeholder="Text to look for"
          onChange={event => onChange({ ...filter, op, value: event.target.value })}
        />
      )}
      {(op === 'eq' || op === 'gt' || op === 'lt') && (
        <input
          type="number"
          value={filter.value || ''}
          onChange={event => onChange({ ...filter, op, value: event.target.value })}
        />
      )}
      {(op === 'before' || op === 'after' || op === 'on') && (
        <div className="crp-condition-line">
          <input
            type="date"
            value={filter.value === 'today' ? '' : filter.value || ''}
            disabled={filter.value === 'today'}
            onChange={event => onChange({ ...filter, op, value: event.target.value })}
          />
          <label className="crp-check">
            <input
              type="checkbox"
              checked={filter.value === 'today'}
              onChange={event => onChange({ ...filter, op, value: event.target.checked ? 'today' : '' })}
            />
            Today (moves with the day)
          </label>
        </div>
      )}
    </div>
  )
}

export function WidgetEditor({
  widget: initial,
  trackers,
  canUseTrackers,
  fieldsFor,
  recordsFor,
  preview,
  onSave,
  onClose,
}: {
  widget: Widget
  trackers: Tracker[] | null
  canUseTrackers: boolean
  fieldsFor: (source: SourceId, trackerId?: string) => Field[]
  recordsFor: (source: SourceId, trackerId?: string) => Rec[]
  preview: (widget: Widget) => ReactNode
  onSave: (widget: Widget) => void
  onClose: () => void
}) {
  const [widget, setWidget] = useState<Widget>(initial)
  const set = (patch: Partial<Widget>) => setWidget(current => ({ ...current, ...patch }))
  const fields = fieldsFor(widget.source, widget.trackerId)
  const records = recordsFor(widget.source, widget.trackerId)
  const isText = widget.kind === 'heading' || widget.kind === 'note'
  const groupField = fields.find(field => field.key === widget.groupBy)
  const summary = widget.kind === 'table' && Boolean(widget.groupBy)
  const charted = ['bar', 'column', 'line', 'pie'].includes(widget.kind) || summary
  const measureInfo = MEASURES.find(item => item.op === widget.measure.op) || MEASURES[0]
  const dates = fields.filter(field => field.type === 'date')

  const setMeasure = (measure: Measure) => set({ measure })
  const changeSource = (source: SourceId, trackerId?: string) => {
    const next = fieldsFor(source, trackerId)
    const has = (key?: string) => Boolean(key && next.some(field => field.key === key))
    const firstDate = next.find(field => field.type === 'date')?.key
    setWidget(current => ({
      ...current,
      source,
      trackerId: source === 'tracker' ? trackerId : undefined,
      dateField: source === 'tasks' ? undefined : source === 'tracker' ? firstDate : has('date') ? 'date' : undefined,
      filters: current.filters.filter(filter => has(filter.field)),
      measure: has(current.measure.field) ? current.measure : { op: 'count' },
      groupBy: has(current.groupBy) ? current.groupBy : next.find(field => field.type === 'text')?.key,
      splitBy: has(current.splitBy) ? current.splitBy : undefined,
      columns: (current.columns || []).filter(has).length
        ? (current.columns || []).filter(has)
        : next.slice(0, 4).map(field => field.key),
      orderBy: has(current.orderBy) ? current.orderBy : undefined,
      label: has(current.label) ? current.label : next.find(field => field.type === 'text')?.key,
      start: has(current.start) ? current.start : firstDate,
      end: has(current.end) ? current.end : next.filter(field => field.type === 'date')[1]?.key || firstDate,
    }))
  }

  const columns = widget.columns || []
  const moveColumn = (index: number, by: number) => {
    const next = [...columns]
    const [item] = next.splice(index, 1)
    next.splice(index + by, 0, item)
    set({ columns: next })
  }

  return (
    <Dialog title={widget.title || WIDGET_LABELS[widget.kind]} eyebrow="Widget settings" onClose={onClose} size="wide">
      <div className="crp-editor">
        <div className="crp-editor-preview">
          <div className={`crp-cell crp-kind-${widget.kind} crp-preview-cell`}>{preview(widget)}</div>
          {!isText && (
            <p className="crp-muted">
              {records.length} {records.length === 1 ? 'row' : 'rows'} in{' '}
              {SOURCES.find(s => s.id === widget.source)?.label} before filters.
            </p>
          )}
        </div>
        <form
          className="crp-editor-form"
          onSubmit={event => {
            event.preventDefault()
            onSave(widget)
          }}
        >
          {!isText && (
            <div className="crp-kinds" role="group" aria-label="Kind of widget">
              {DATA_KINDS.map(kind => (
                <button
                  type="button"
                  key={kind}
                  className={widget.kind === kind ? 'on' : ''}
                  aria-pressed={widget.kind === kind}
                  onClick={() => {
                    const patch: Partial<Widget> = { kind }
                    if (kind === 'gantt' && !widget.start) {
                      patch.start = dates[0]?.key
                      patch.end = dates[1]?.key || dates[0]?.key
                      patch.label = fields.find(field => field.type === 'text')?.key
                    }
                    if (['bar', 'column', 'line', 'pie'].includes(kind) && !widget.groupBy)
                      patch.groupBy = fields.find(field => field.type === 'text')?.key
                    set(patch)
                  }}
                >
                  {WIDGET_LABELS[kind]}
                </button>
              ))}
            </div>
          )}

          {widget.kind !== 'heading' && (
            <Row label="Title">
              <input value={widget.title} maxLength={120} onChange={event => set({ title: event.target.value })} />
            </Row>
          )}
          {isText && (
            <Row label={widget.kind === 'heading' ? 'Heading' : 'Note'}>
              {widget.kind === 'heading' ? (
                <input
                  value={widget.text || ''}
                  maxLength={120}
                  onChange={event => set({ text: event.target.value })}
                />
              ) : (
                <textarea
                  rows={6}
                  value={widget.text || ''}
                  maxLength={4000}
                  onChange={event => set({ text: event.target.value })}
                />
              )}
            </Row>
          )}

          {!isText && (
            <fieldset>
              <legend>Data</legend>
              <Row label="Comes from">
                <select
                  value={widget.source}
                  onChange={event =>
                    changeSource(event.target.value as SourceId, widget.trackerId || trackers?.[0]?.id)
                  }
                >
                  {SOURCES.filter(source => source.id !== 'tracker' || canUseTrackers).map(source => (
                    <option key={source.id} value={source.id}>
                      {source.label}
                    </option>
                  ))}
                </select>
              </Row>
              {widget.source === 'tracker' && (
                <Row
                  label="Tracker"
                  hint="Client, Project and Person filters use matching tracker columns. Choose a date field below to apply the report date range."
                >
                  <select
                    value={widget.trackerId || ''}
                    onChange={event => changeSource('tracker', event.target.value)}
                  >
                    {!widget.trackerId && (
                      <option value="">{trackers ? 'Choose a tracker…' : 'Loading trackers…'}</option>
                    )}
                    {(trackers || []).map(tracker => (
                      <option key={tracker.id} value={tracker.id}>
                        {tracker.name}
                      </option>
                    ))}
                  </select>
                </Row>
              )}
              {dates.length > 0 && (
                <Row label="Report dates apply to" hint="Choose the date column this widget should use for the report's date range.">
                  <FieldSelect
                    fields={dates}
                    value={widget.dateField}
                    none="Nothing (all dates)"
                    onChange={value => set({ dateField: value || undefined })}
                  />
                </Row>
              )}
            </fieldset>
          )}

          {(widget.kind === 'metric' || charted) && (
            <fieldset>
              <legend>{widget.kind === 'metric' ? 'Number' : 'Value'}</legend>
              <Row label="Show">
                <select
                  value={widget.measure.op}
                  onChange={event => {
                    const op = event.target.value as MeasureOp
                    const info = MEASURES.find(item => item.op === op)
                    const numeric = fields.find(field => field.type === 'number')?.key
                    setMeasure({
                      op,
                      field:
                        info?.needs === 'number'
                          ? fields.some(f => f.key === widget.measure.field && f.type === 'number')
                            ? widget.measure.field
                            : numeric
                          : info?.needs === 'any'
                            ? widget.measure.field || fields[0]?.key
                            : undefined,
                      where:
                        op === 'percent'
                          ? widget.measure.where || {
                              field: fields.find(f => f.type === 'bool')?.key || fields[0]?.key || '',
                              op: fields.some(f => f.type === 'bool') ? 'true' : 'not_empty',
                            }
                          : undefined,
                    })
                  }}
                >
                  {MEASURES.map(item => (
                    <option key={item.op} value={item.op}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </Row>
              {(measureInfo.needs === 'number' || measureInfo.needs === 'any') && (
                <Row label="Of">
                  <FieldSelect
                    fields={fields}
                    types={measureInfo.needs === 'number' ? ['number'] : undefined}
                    value={widget.measure.field}
                    onChange={value => setMeasure({ ...widget.measure, field: value })}
                  />
                </Row>
              )}
              {measureInfo.needs === 'where' && widget.measure.where && (
                <Condition
                  filter={widget.measure.where}
                  fields={fields}
                  records={records}
                  onChange={where => setMeasure({ ...widget.measure, where })}
                />
              )}
            </fieldset>
          )}

          {widget.kind === 'table' && (
            <fieldset>
              <legend>Table</legend>
              <div className="crp-segment" role="group" aria-label="Table shows">
                <button
                  type="button"
                  className={!summary ? 'on' : ''}
                  aria-pressed={!summary}
                  onClick={() => set({ groupBy: undefined })}
                >
                  List rows
                </button>
                <button
                  type="button"
                  className={summary ? 'on' : ''}
                  aria-pressed={summary}
                  onClick={() => set({ groupBy: fields.find(field => field.type === 'text')?.key })}
                >
                  Totals by group
                </button>
              </div>
              {!summary && (
                <>
                  <div className="crp-columns">
                    {columns.map((key, index) => (
                      <div key={key} className="crp-column-item">
                        <span>{fields.find(field => field.key === key)?.label || key}</span>
                        <button
                          type="button"
                          className="crp-icon"
                          aria-label="Move left"
                          disabled={index === 0}
                          onClick={() => moveColumn(index, -1)}
                        >
                          <ArrowUp size={13} />
                        </button>
                        <button
                          type="button"
                          className="crp-icon"
                          aria-label="Move right"
                          disabled={index === columns.length - 1}
                          onClick={() => moveColumn(index, 1)}
                        >
                          <ArrowDown size={13} />
                        </button>
                        <button
                          type="button"
                          className="crp-icon"
                          aria-label="Remove column"
                          onClick={() => set({ columns: columns.filter(item => item !== key) })}
                        >
                          <X size={13} />
                        </button>
                      </div>
                    ))}
                  </div>
                  <Row label="Add a column">
                    <select
                      value=""
                      onChange={event => event.target.value && set({ columns: [...columns, event.target.value] })}
                    >
                      <option value="">Choose…</option>
                      {fields
                        .filter(field => !columns.includes(field.key))
                        .map(field => (
                          <option key={field.key} value={field.key}>
                            {field.label}
                          </option>
                        ))}
                    </select>
                  </Row>
                  <div className="crp-pair">
                    <Row label="Sort by">
                      <FieldSelect
                        fields={fields}
                        value={widget.orderBy}
                        none="As they come"
                        onChange={value => set({ orderBy: value || undefined })}
                      />
                    </Row>
                    <Row label="Order">
                      <select
                        value={widget.orderDir || 'asc'}
                        onChange={event => set({ orderDir: event.target.value as 'asc' | 'desc' })}
                      >
                        <option value="asc">A to Z, low to high, oldest first</option>
                        <option value="desc">Z to A, high to low, newest first</option>
                      </select>
                    </Row>
                  </div>
                  <Row label="Show at most">
                    <input
                      type="number"
                      min={1}
                      max={500}
                      value={widget.limit || 50}
                      onChange={event => set({ limit: Number(event.target.value) || 50 })}
                    />
                  </Row>
                </>
              )}
            </fieldset>
          )}

          {charted && (
            <fieldset>
              <legend>Groups</legend>
              <Row
                label={
                  widget.kind === 'pie' ? 'One slice per' : widget.kind === 'table' ? 'One row per' : 'One bar per'
                }
              >
                <FieldSelect fields={fields} value={widget.groupBy} onChange={value => set({ groupBy: value })} />
              </Row>
              {groupField?.type === 'date' && (
                <Row label="Dates">
                  <select
                    value={widget.bucket || 'month'}
                    onChange={event => set({ bucket: event.target.value as Bucket })}
                  >
                    {BUCKETS.map(bucket => (
                      <option key={bucket} value={bucket}>
                        {BUCKET_LABELS[bucket]}
                      </option>
                    ))}
                  </select>
                </Row>
              )}
              {(widget.kind === 'column' || widget.kind === 'line' || summary) && (
                <Row label="Split into series by" hint="One colour per value, up to 7; the rest are added up as Other.">
                  <FieldSelect
                    fields={fields.filter(field => field.key !== widget.groupBy)}
                    value={widget.splitBy}
                    none="Nothing"
                    onChange={value => set({ splitBy: value || undefined })}
                  />
                </Row>
              )}
              <div className="crp-pair">
                <Row label="Order">
                  <select
                    value={widget.sort || (groupField?.type === 'date' ? 'label' : 'value_desc')}
                    onChange={event => set({ sort: event.target.value as Widget['sort'] })}
                  >
                    <option value="value_desc">Largest first</option>
                    <option value="value_asc">Smallest first</option>
                    <option value="label">{groupField?.type === 'date' ? 'By date' : 'By name'}</option>
                  </select>
                </Row>
                <Row label="Show at most">
                  <input
                    type="number"
                    min={1}
                    max={60}
                    value={widget.limit || (widget.kind === 'pie' ? 6 : groupField?.type === 'date' ? 60 : 12)}
                    onChange={event => set({ limit: Number(event.target.value) || undefined })}
                  />
                </Row>
              </div>
            </fieldset>
          )}

          {widget.kind === 'gantt' && (
            <fieldset>
              <legend>Timeline</legend>
              <Row label="Name">
                <FieldSelect fields={fields} value={widget.label} onChange={value => set({ label: value })} />
              </Row>
              <div className="crp-pair">
                <Row label="Starts">
                  <FieldSelect fields={dates} value={widget.start} onChange={value => set({ start: value })} />
                </Row>
                <Row label="Ends">
                  <FieldSelect fields={dates} value={widget.end} onChange={value => set({ end: value })} />
                </Row>
              </div>
              <div className="crp-pair">
                <Row label="Colour by">
                  <FieldSelect
                    fields={fields.filter(field => field.type === 'text' || field.type === 'bool')}
                    value={widget.splitBy}
                    none="One colour"
                    onChange={value => set({ splitBy: value || undefined })}
                  />
                </Row>
                <Row label="Show at most">
                  <input
                    type="number"
                    min={1}
                    max={200}
                    value={widget.limit || 60}
                    onChange={event => set({ limit: Number(event.target.value) || 60 })}
                  />
                </Row>
              </div>
            </fieldset>
          )}

          {!isText && (
            <fieldset>
              <legend>Only rows where</legend>
              {widget.filters.length === 0 && <p className="crp-muted">Every row is counted.</p>}
              {widget.filters.map((filter, index) => (
                <Condition
                  key={index}
                  filter={filter}
                  fields={fields}
                  records={records}
                  onChange={next => set({ filters: widget.filters.map((item, at) => (at === index ? next : item)) })}
                  onRemove={() => set({ filters: widget.filters.filter((_, at) => at !== index) })}
                />
              ))}
              {widget.filters.length < 10 && fields.length > 0 && (
                <button
                  type="button"
                  className="crp-btn subtle"
                  onClick={() =>
                    set({
                      filters: [
                        ...widget.filters,
                        { field: fields[0].key, op: OPS[fields[0].type][0].op } as WidgetFilter,
                      ],
                    })
                  }
                >
                  <Plus size={14} /> Add a condition
                </button>
              )}
            </fieldset>
          )}

          <div className="k-dialog-actions crp-editor-actions">
            <span className="crp-spacer" />
            <button type="button" className="crp-btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="crp-btn primary">
              Apply
            </button>
          </div>
        </form>
      </div>
    </Dialog>
  )
}
