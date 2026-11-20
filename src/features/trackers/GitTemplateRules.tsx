/**
 * The rules part of a GIT template: the rows one ticket adds, what each row makes (a Task, a Subtask of another row's
 * Task, or nothing), how its cells and its Task are filled from the ticket, and Subtasks per column. Every change is
 * checked with normalizeGitGeneration (the same check the server makes), and a sample ticket shows what would be made.
 */
import { useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import {
  GIT_CONDITION_OPS,
  GIT_FILLABLE_TYPES,
  GIT_LIMITS,
  GIT_TICKET_FIELDS,
  type GitColumnRule,
  type GitCondition,
  type GitConditionOp,
  type GitGeneration,
  type GitRowBlueprint,
  type GitTicketField,
  type GitTicketSnapshot,
  type GitValue,
  type GitWorkMapping,
  gitCellText,
  normalizeGitGeneration,
  planGitGeneration,
  ticketFits,
} from './gitGeneration'
import type { TrackerColumn } from './trackerModel'

const FIELD_LABEL: Record<GitTicketField, string> = {
  title: 'Title',
  number: 'Number',
  url: 'Link',
  repository: 'Repository',
  labels: 'Labels',
  assignees: 'Assignees',
  author: 'Author',
  milestone: 'Milestone',
  due: 'Due date',
  state: 'State (open/closed)',
  body: 'Description',
}
const OP_LABEL: Record<GitConditionOp, string> = {
  equals: 'is',
  not_equals: 'is not',
  contains: 'contains',
  not_contains: 'does not contain',
  is_empty: 'is empty',
  not_empty: 'is not empty',
}
const needsValue = (op: GitConditionOp) => op !== 'is_empty' && op !== 'not_empty'
const SAMPLE: GitTicketSnapshot = {
  provider: 'gitlab',
  repository: 'team/app',
  number: 128,
  title: 'Export fails for large reports',
  body: 'Steps to reproduce…',
  url: 'https://gitlab.example.com/team/app/-/issues/128',
  state: 'open',
  labels: ['bug', 'priority::high'],
  assignees: ['dev.one'],
  author: 'qa.lead',
  milestone: 'Sprint 24',
  dueDate: '2026-12-04',
}

/** A key no row or rule uses yet: keys stay the same when names change, so tickets already added keep matching. */
function freshKey(generation: GitGeneration, base: string) {
  const used = new Set([...generation.rows.map(row => row.key), ...generation.columnRules.map(rule => rule.key)])
  const stem =
    base
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 30) || 'row'
  let key = /^[a-z0-9]/.test(stem) ? stem : `r-${stem}`
  for (let n = 2; used.has(key); n++) key = `${stem.slice(0, 30)}-${n}`
  return key
}

export function GitTemplateRules({
  columns,
  value,
  onChange,
}: {
  /** The template's columns as they are now (ids stay the same while they are edited). */
  columns: TrackerColumn[]
  value: GitGeneration
  onChange: (next: GitGeneration) => void
}) {
  const [preview, setPreview] = useState(false)
  const { errors } = useMemo(() => normalizeGitGeneration(value, columns), [value, columns])
  const taskRows = value.rows.filter(row => row.work === 'task')
  const dateColumns = columns.filter(column => column.type === 'date')
  const setRow = (key: string, patch: Partial<GitRowBlueprint>) =>
    onChange({ ...value, rows: value.rows.map(row => (row.key === key ? { ...row, ...patch } : row)) })
  const setRule = (key: string, patch: Partial<GitColumnRule>) =>
    onChange({ ...value, columnRules: value.columnRules.map(rule => (rule.key === key ? { ...rule, ...patch } : rule)) })
  const moveRow = (at: number, by: number) => {
    const rows = [...value.rows]
    const [row] = rows.splice(at, 1)
    rows.splice(at + by, 0, row)
    onChange({ ...value, rows })
  }
  const removeRow = (key: string) =>
    onChange({
      ...value,
      // Its Subtask rows and the column rules aimed at it go with it.
      rows: value.rows
        .filter(row => row.key !== key)
        .map(row => (row.parentKey === key ? { ...row, work: 'none' as const, parentKey: undefined } : row)),
      columnRules: value.columnRules.map(rule =>
        Array.isArray(rule.rows) ? { ...rule, rows: rule.rows.filter(target => target !== key) } : rule,
      ),
    })
  const addRow = () => {
    const name = `Row ${value.rows.length + 1}`
    const parent = taskRows[0]?.key
    onChange({
      ...value,
      rows: [
        ...value.rows,
        {
          key: freshKey(value, name),
          name,
          cells: {},
          when: [],
          work: parent ? 'subtask' : 'task',
          ...(parent ? { parentKey: parent } : {}),
          task: { title: `${name}: #{ticket.number} {ticket.title}`, description: '', due: { from: 'none' } },
        },
      ],
    })
  }
  const addRule = () => {
    const column = columns.find(item => item.type === 'checkbox') || columns[0]
    if (!column) return
    onChange({
      ...value,
      columnRules: [
        ...value.columnRules,
        {
          key: freshKey(value, `col-${column.name}`),
          columnId: column.id,
          rows: 'all',
          when: [],
          task: { title: '{column}: #{ticket.number} {ticket.title}', description: '', due: { from: 'none' } },
        },
      ],
    })
  }

  return (
    <section className="git-rules" aria-label="What each ticket makes">
      <h3>What each ticket makes</h3>
      <p className="trk-muted-text">
        When a ticket is added to a GIT Tracker, it adds these rows and makes their Tasks and Subtasks under the Client
        and Project its repository is mapped to. In titles and descriptions you can use {'{ticket.title}'},{' '}
        {'{ticket.number}'}, {'{ticket.url}'}, {'{ticket.labels}'}, {'{ticket.assignees}'}, {'{ticket.milestone}'},{' '}
        {'{ticket.due}'}, {'{row}'} (the row’s name) and, in column rules, {'{column}'}.
      </p>

      {value.rows.map((row, at) => (
        <fieldset key={row.key} className="git-rule">
          <legend>
            Row {at + 1}: {row.name || 'Unnamed'}
          </legend>
          <div className="git-rule-tools">
            <button
              type="button"
              className="trk-icon-button small"
              aria-label={`Move ${row.name || 'row'} up`}
              disabled={at === 0}
              onClick={() => moveRow(at, -1)}
            >
              <ArrowUp size={13} />
            </button>
            <button
              type="button"
              className="trk-icon-button small"
              aria-label={`Move ${row.name || 'row'} down`}
              disabled={at === value.rows.length - 1}
              onClick={() => moveRow(at, 1)}
            >
              <ArrowDown size={13} />
            </button>
            <button
              type="button"
              className="trk-icon-button small"
              aria-label={`Remove ${row.name || 'row'}`}
              disabled={value.rows.length === 1}
              onClick={() => removeRow(row.key)}
            >
              <Trash2 size={13} />
            </button>
          </div>
          <div className="git-rule-grid">
            <label className="trk-field-block">
              Row name
              <input
                value={row.name}
                maxLength={GIT_LIMITS.name}
                onChange={event => setRow(row.key, { name: event.target.value })}
              />
            </label>
            <label className="trk-field-block">
              Makes
              <select
                value={row.work === 'subtask' ? `sub:${row.parentKey || ''}` : row.work}
                onChange={event => {
                  const next = event.target.value
                  const task = row.task || { title: '#{ticket.number} {ticket.title}', description: '', due: { from: 'none' } }
                  if (next === 'none') setRow(row.key, { work: 'none', parentKey: undefined })
                  else if (next === 'task') setRow(row.key, { work: 'task', parentKey: undefined, task })
                  else setRow(row.key, { work: 'subtask', parentKey: next.slice(4), task })
                }}
              >
                <option value="task">A Task</option>
                {taskRows
                  .filter(other => other.key !== row.key)
                  .map(other => (
                    <option key={other.key} value={`sub:${other.key}`}>
                      A Subtask of “{other.name || other.key}”
                    </option>
                  ))}
                {row.work === 'subtask' && !taskRows.some(other => other.key === row.parentKey) && (
                  <option value={`sub:${row.parentKey || ''}`}>A Subtask (choose its Task row)</option>
                )}
                <option value="none">Nothing (a row only)</option>
              </select>
            </label>
          </div>
          {row.work !== 'none' && row.task && (
            <WorkFields
              mapping={row.task}
              dateColumns={dateColumns}
              onChange={task => setRow(row.key, { task })}
              titleHint={row.work === 'task' ? '#{ticket.number} {ticket.title}' : '{row}: #{ticket.number} {ticket.title}'}
            />
          )}
          <CellFills columns={columns} cells={row.cells} onChange={cells => setRow(row.key, { cells })} />
          <Conditions
            label="Only add this row when"
            columns={columns}
            value={row.when}
            onChange={when => setRow(row.key, { when })}
          />
        </fieldset>
      ))}
      <div className="git-rules-add">
        <button
          type="button"
          className="trk-button"
          disabled={value.rows.length >= GIT_LIMITS.rows}
          onClick={addRow}
        >
          <Plus size={14} aria-hidden="true" /> Add a row
        </button>
      </div>

      <h3>Subtasks per column</h3>
      <p className="trk-muted-text">
        Optional: a Subtask under each Task row for a column, such as a “QA retest” checkbox. The Subtask is linked to
        that row’s cell.
      </p>
      {value.columnRules.map((rule, at) => (
        <fieldset key={rule.key} className="git-rule">
          <legend>Column rule {at + 1}</legend>
          <div className="git-rule-tools">
            <button
              type="button"
              className="trk-icon-button small"
              aria-label={`Remove column rule ${at + 1}`}
              onClick={() => onChange({ ...value, columnRules: value.columnRules.filter(item => item.key !== rule.key) })}
            >
              <Trash2 size={13} />
            </button>
          </div>
          <div className="git-rule-grid">
            <label className="trk-field-block">
              Column
              <select value={rule.columnId} onChange={event => setRule(rule.key, { columnId: event.target.value })}>
                {columns.map(column => (
                  <option key={column.id} value={column.id}>
                    {column.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="trk-field-block">
              For
              <select
                value={rule.rows === 'all' ? 'all' : 'some'}
                onChange={event =>
                  setRule(rule.key, { rows: event.target.value === 'all' ? 'all' : taskRows.slice(0, 1).map(row => row.key) })
                }
              >
                <option value="all">Every Task row</option>
                <option value="some">Only some Task rows</option>
              </select>
            </label>
          </div>
          {rule.rows !== 'all' && (
            <div className="git-rule-rows" role="group" aria-label="Task rows it applies to">
              {taskRows.map(row => {
                const chosen = rule.rows as string[]
                return (
                  <label key={row.key} className="trk-checkline">
                    <input
                      type="checkbox"
                      checked={chosen.includes(row.key)}
                      onChange={event =>
                        setRule(rule.key, {
                          rows: event.target.checked
                            ? [...chosen, row.key]
                            : chosen.filter(target => target !== row.key),
                        })
                      }
                    />{' '}
                    {row.name || row.key}
                  </label>
                )
              })}
            </div>
          )}
          <WorkFields
            mapping={rule.task}
            dateColumns={dateColumns}
            onChange={task => setRule(rule.key, { task })}
            titleHint="{column}: #{ticket.number} {ticket.title}"
          />
          <Conditions
            label="Only when"
            columns={columns}
            value={rule.when}
            onChange={when => setRule(rule.key, { when })}
          />
        </fieldset>
      ))}
      <div className="git-rules-add">
        <button
          type="button"
          className="trk-button"
          disabled={!columns.length || value.columnRules.length >= GIT_LIMITS.columnRules}
          onClick={addRule}
        >
          <Plus size={14} aria-hidden="true" /> Add a column rule
        </button>
      </div>

      {errors.length > 0 ? (
        <div className="git-rules-errors" role="alert">
          <strong>Fix these before saving:</strong>
          <ul>
            {errors.map(error => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="git-rules-preview">
          <button type="button" className="trk-button" aria-expanded={preview} onClick={() => setPreview(on => !on)}>
            {preview ? 'Hide the example' : 'Try it with an example ticket'}
          </button>
          {preview && <Preview generation={value} columns={columns} />}
        </div>
      )}
    </section>
  )
}

function WorkFields({
  mapping,
  dateColumns,
  titleHint,
  onChange,
}: {
  mapping: GitWorkMapping
  dateColumns: TrackerColumn[]
  titleHint: string
  onChange: (next: GitWorkMapping) => void
}) {
  const due = mapping.due.from === 'column' ? `col:${mapping.due.columnId}` : mapping.due.from
  return (
    <div className="git-rule-grid">
      <label className="trk-field-block">
        Task title
        <input
          value={mapping.title}
          maxLength={GIT_LIMITS.template}
          placeholder={titleHint}
          onChange={event => onChange({ ...mapping, title: event.target.value })}
        />
      </label>
      <label className="trk-field-block">
        Due date
        <select
          value={due}
          onChange={event => {
            const next = event.target.value
            onChange({
              ...mapping,
              due: next.startsWith('col:')
                ? { from: 'column', columnId: next.slice(4) }
                : next === 'ticket'
                  ? { from: 'ticket' }
                  : { from: 'none' },
            })
          }}
        >
          <option value="none">None</option>
          <option value="ticket">The ticket’s due date</option>
          {dateColumns.map(column => (
            <option key={column.id} value={`col:${column.id}`}>
              From the row’s {column.name}
            </option>
          ))}
        </select>
      </label>
      <label className="trk-field-block git-span">
        Task description
        <textarea
          rows={2}
          value={mapping.description}
          maxLength={GIT_LIMITS.description}
          onChange={event => onChange({ ...mapping, description: event.target.value })}
        />
      </label>
    </div>
  )
}

/** How each of the row's cells is filled: left empty, a fixed value, or a field of the ticket. */
function CellFills({
  columns,
  cells,
  onChange,
}: {
  columns: TrackerColumn[]
  cells: Record<string, GitValue>
  onChange: (next: Record<string, GitValue>) => void
}) {
  const fillable = columns.filter(column => GIT_FILLABLE_TYPES.includes(column.type))
  if (!fillable.length) return null
  const set = (columnId: string, next: GitValue | null) => {
    const copy = { ...cells }
    if (next) copy[columnId] = next
    else delete copy[columnId]
    onChange(copy)
  }
  return (
    <div className="git-cells" role="group" aria-label="The row's cells">
      <span className="git-cells-title">The row’s cells</span>
      {fillable.map(column => {
        const value = cells[column.id]
        const how = !value ? '' : value.from === 'fixed' ? 'fixed' : `ticket:${value.field}`
        return (
          <div key={column.id} className="git-cell">
            <span className="git-cell-name">{column.name}</span>
            <select
              aria-label={`How ${column.name} is filled`}
              value={how}
              onChange={event => {
                const next = event.target.value
                if (!next) set(column.id, null)
                else if (next === 'fixed') set(column.id, { from: 'fixed', value: '' })
                else set(column.id, { from: 'ticket', field: next.slice(7) as GitTicketField })
              }}
            >
              <option value="">Left empty</option>
              <option value="fixed">A fixed value</option>
              {GIT_TICKET_FIELDS.filter(field => ticketFits(column, field)).map(field => (
                <option key={field} value={`ticket:${field}`}>
                  Ticket: {FIELD_LABEL[field]}
                </option>
              ))}
            </select>
            {value?.from === 'fixed' && (
              <FixedValue column={column} value={value.value} onChange={next => set(column.id, { from: 'fixed', value: next })} />
            )}
          </div>
        )
      })}
    </div>
  )
}

function FixedValue({
  column,
  value,
  onChange,
}: {
  column: TrackerColumn
  value: string
  onChange: (next: string) => void
}) {
  const label = `${column.name} value`
  if (column.type === 'checkbox')
    return (
      <select aria-label={label} value={value} onChange={event => onChange(event.target.value)}>
        <option value="">Choose…</option>
        <option value="true">Ticked</option>
        <option value="false">Not ticked</option>
      </select>
    )
  if (column.type === 'select')
    return (
      <select aria-label={label} value={value} onChange={event => onChange(event.target.value)}>
        <option value="">Choose…</option>
        {(column.options || []).map(option => (
          <option key={option.id} value={option.label}>
            {option.label}
          </option>
        ))}
      </select>
    )
  return (
    <input
      aria-label={label}
      type={column.type === 'date' ? 'date' : column.type === 'number' ? 'number' : 'text'}
      value={value}
      maxLength={GIT_LIMITS.value}
      placeholder={column.type === 'multiselect' ? 'Choice one, Choice two' : ''}
      onChange={event => onChange(event.target.value)}
    />
  )
}

function Conditions({
  label,
  columns,
  value,
  onChange,
}: {
  label: string
  columns: TrackerColumn[]
  value: GitCondition[]
  onChange: (next: GitCondition[]) => void
}) {
  const set = (at: number, next: GitCondition) => onChange(value.map((item, index) => (index === at ? next : item)))
  return (
    <div className="git-conditions" role="group" aria-label={label}>
      <span className="git-cells-title">
        {label}
        {value.length ? ' (all of these)' : ': always'}
      </span>
      {value.map((condition, at) => {
        const what = condition.on === 'ticket' ? `ticket:${condition.field}` : `cell:${condition.columnId}`
        return (
          <div key={at} className="git-condition">
            <select
              aria-label="Compare"
              value={what}
              onChange={event => {
                const next = event.target.value
                set(
                  at,
                  next.startsWith('ticket:')
                    ? { on: 'ticket', field: next.slice(7) as GitTicketField, op: condition.op, value: condition.value }
                    : { on: 'cell', columnId: next.slice(5), op: condition.op, value: condition.value },
                )
              }}
            >
              {GIT_TICKET_FIELDS.map(field => (
                <option key={field} value={`ticket:${field}`}>
                  Ticket: {FIELD_LABEL[field]}
                </option>
              ))}
              {columns.map(column => (
                <option key={column.id} value={`cell:${column.id}`}>
                  Cell: {column.name}
                </option>
              ))}
            </select>
            <select
              aria-label="How"
              value={condition.op}
              onChange={event => set(at, { ...condition, op: event.target.value as GitConditionOp })}
            >
              {GIT_CONDITION_OPS.map(op => (
                <option key={op} value={op}>
                  {OP_LABEL[op]}
                </option>
              ))}
            </select>
            {needsValue(condition.op) && (
              <input
                aria-label="Value"
                value={condition.value}
                maxLength={200}
                onChange={event => set(at, { ...condition, value: event.target.value })}
              />
            )}
            <button
              type="button"
              className="trk-icon-button small"
              aria-label="Remove condition"
              onClick={() => onChange(value.filter((_, index) => index !== at))}
            >
              <Trash2 size={13} />
            </button>
          </div>
        )
      })}
      <button
        type="button"
        className="trk-text-button"
        disabled={value.length >= GIT_LIMITS.conditions}
        onClick={() => onChange([...value, { on: 'ticket', field: 'labels', op: 'contains', value: '' }])}
      >
        <Plus size={13} aria-hidden="true" /> Add a condition
      </button>
    </div>
  )
}

/** What the rules make for an example ticket, before any real ticket is added. */
function Preview({ generation, columns }: { generation: GitGeneration; columns: TrackerColumn[] }) {
  const plan = planGitGeneration({
    generation,
    columns,
    ticket: SAMPLE,
    clientId: 'client',
    projectId: 'project',
    assigneeId: '',
    idFor: (kind, key) => `${kind}:${key}`,
  })
  const byColumn = new Map(columns.map(column => [column.id, column]))
  return (
    <div className="git-preview">
      <p className="trk-muted-text">
        Example: GitLab ticket #{SAMPLE.number} “{SAMPLE.title}”, labels {SAMPLE.labels.join(', ')}, due {SAMPLE.dueDate}
        .
      </p>
      {plan.errors.length > 0 && <p className="trk-field-error">{plan.errors[0]}</p>}
      <strong>Rows</strong>
      <ul>
        {plan.rows.map(row => (
          <li key={row.id}>
            {row.name}
            {Object.keys(row.cells).length > 0 && (
              <small>
                {' '}
                ·{' '}
                {Object.entries(row.cells)
                  .map(([id, cell]) => `${byColumn.get(id)?.name || id}: ${gitCellText(byColumn.get(id), cell)}`)
                  .join(' · ')}
              </small>
            )}
          </li>
        ))}
      </ul>
      <strong>Tasks and Subtasks</strong>
      <ul>
        {plan.work.map(work => (
          <li key={work.id} className={work.type === 'Subtask' ? 'git-preview-sub' : undefined}>
            {work.type === 'Subtask' ? '↳ ' : ''}
            {work.title}
            {work.dueDate && <small> · due {work.dueDate}</small>}
          </li>
        ))}
      </ul>
      {plan.skipped.length > 0 && (
        <p className="trk-muted-text">Not made for this ticket: {plan.skipped.map(skip => skip.reason).join(' ')}</p>
      )}
    </div>
  )
}
