/**
 * GIT Tracker generation rules: how a GitLab or GitHub ticket added to a GIT Tracker becomes rows, Tasks and Subtasks.
 *
 * A GIT template holds:
 * - row blueprints: the rows one ticket adds (e.g. Analysis, Dev, QA, UAT). Each row fills its cells from fixed
 *   values or ticket fields, is added only when its conditions hold, and makes a Task, a Subtask of another row's
 *   Task, or nothing;
 * - column rules: for a column (a QA retest checkbox, say), a Subtask under each Task row whose conditions hold,
 *   linked to that row's cell;
 * - for each Task and Subtask, how its title, description and due date are filled.
 *
 * Work is created under the Client and Project the ticket's repository is mapped to (the caller passes them in), never
 * the tracker's: a GIT Tracker holds tickets of every client.
 *
 * Pure functions, shared by the template editor, the server and the tests. The caller gives stable ids (`idFor`), so
 * planning the same ticket entry twice gives the same rows and work: a retry finds what the first attempt made.
 */
import type { Cell, ColumnType, TrackerColumn } from './trackerModel'

export const GIT_GENERATION_VERSION = 1
export const GIT_LIMITS = {
  rows: 20,
  columnRules: 30,
  conditions: 8,
  /** Tasks and Subtasks one ticket may make. */
  work: 60,
  name: 80,
  value: 500,
  template: 300,
  description: 2000,
  title: 200,
  descriptionOut: 5000,
} as const

export const GIT_TICKET_FIELDS = [
  'title',
  'number',
  'url',
  'repository',
  'labels',
  'assignees',
  'author',
  'milestone',
  'due',
  'state',
  'body',
] as const
export type GitTicketField = (typeof GIT_TICKET_FIELDS)[number]
const LIST_FIELDS: GitTicketField[] = ['labels', 'assignees']

/** What generation reads from a ticket: taken from the provider when the ticket is added. */
export type GitTicketSnapshot = {
  provider: 'github' | 'gitlab'
  repository: string
  number: number
  title: string
  body: string
  url: string
  state: 'open' | 'closed'
  labels: string[]
  assignees: string[]
  author: string
  milestone: string
  /** YYYY-MM-DD, when the ticket has a due date (GitLab). */
  dueDate: string | null
}

export type GitValue = { from: 'fixed'; value: string } | { from: 'ticket'; field: GitTicketField }

export const GIT_CONDITION_OPS = ['equals', 'not_equals', 'contains', 'not_contains', 'is_empty', 'not_empty'] as const
export type GitConditionOp = (typeof GIT_CONDITION_OPS)[number]
export type GitCondition =
  | { on: 'ticket'; field: GitTicketField; op: GitConditionOp; value: string }
  | { on: 'cell'; columnId: string; op: GitConditionOp; value: string }

export type GitDue = { from: 'none' } | { from: 'ticket' } | { from: 'column'; columnId: string }

/**
 * How a Task or Subtask is filled. Title and description are text with placeholders: {ticket.title}, {ticket.number},
 * {ticket.repository}, {ticket.url}, {ticket.labels}, {ticket.assignees}, {ticket.author}, {ticket.milestone},
 * {ticket.state}, {ticket.due}, {row} (the row's name), {column} (a column rule's column) and {col:<column id>}.
 */
export type GitWorkMapping = { title: string; description: string; due: GitDue }

export type GitWorkType = 'task' | 'subtask' | 'none'
export type GitRowBlueprint = {
  key: string
  name: string
  cells: Record<string, GitValue>
  when: GitCondition[]
  work: GitWorkType
  /** Subtask rows: the key of the Task row they belong under. */
  parentKey?: string
  /** Task and Subtask rows. */
  task?: GitWorkMapping
}

export type GitColumnRule = {
  key: string
  columnId: string
  /** The Task rows it applies to: every one, or these row keys. */
  rows: 'all' | string[]
  when: GitCondition[]
  task: GitWorkMapping
}

export type GitGeneration = { version: number; rows: GitRowBlueprint[]; columnRules: GitColumnRule[] }

export const emptyGitGeneration = (): GitGeneration => ({ version: GIT_GENERATION_VERSION, rows: [], columnRules: [] })

/** Columns a row blueprint can fill: values stored in the row. Person, calculated, connected and secret are not. */
export const GIT_FILLABLE_TYPES: ColumnType[] = [
  'text',
  'longtext',
  'number',
  'date',
  'checkbox',
  'select',
  'multiselect',
  'link',
]
const KEY = /^[a-z0-9][a-z0-9_-]{0,39}$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const PLACEHOLDER = /\{([^{}]{1,60})\}/g

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const str = (value: unknown, max: number) =>
  typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, max) : ''
const isTicketField = (value: unknown): value is GitTicketField =>
  typeof value === 'string' && (GIT_TICKET_FIELDS as readonly string[]).includes(value)
const isOp = (value: unknown): value is GitConditionOp =>
  typeof value === 'string' && (GIT_CONDITION_OPS as readonly string[]).includes(value)

function validDate(value: string) {
  if (!DATE.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

/** The placeholders a title or description may use, for the template editor. */
export const placeholderNames = (columns: TrackerColumn[]) => [
  ...GIT_TICKET_FIELDS.map(field => `ticket.${field}`),
  'row',
  'column',
  ...columns.map(column => `col:${column.id}`),
]

function placeholderErrors(text: string, columns: TrackerColumn[], where: string, allowColumn: boolean) {
  const errors: string[] = []
  const ids = new Set(columns.map(column => column.id))
  for (const match of text.matchAll(PLACEHOLDER)) {
    const name = match[1]
    if (name.startsWith('ticket.') && isTicketField(name.slice(7))) continue
    if (name === 'row') continue
    if (name === 'column' && allowColumn) continue
    if (name.startsWith('col:') && ids.has(name.slice(4))) continue
    errors.push(`${where}: {${name}} is not a field it can use.`)
  }
  return errors
}

/** Whether a fixed value fits a column. Choice columns take an option's id or label. */
function fixedFits(column: TrackerColumn, value: string) {
  if (!value) return true
  switch (column.type) {
    case 'number':
      return Number.isFinite(Number(value))
    case 'date':
      return validDate(value)
    case 'checkbox':
      return value === 'true' || value === 'false'
    case 'select':
      return Boolean(optionId(column, value))
    case 'multiselect':
      return splitList(value).every(part => Boolean(optionId(column, part)))
    default:
      return true
  }
}

/** Ticket fields each column type can take. Text, long text and link take any. */
function ticketFits(column: TrackerColumn, field: GitTicketField) {
  switch (column.type) {
    case 'number':
      return field === 'number'
    case 'date':
      return field === 'due'
    case 'checkbox':
      return false
    case 'select':
      return field === 'state' || field === 'milestone' || field === 'author'
    case 'multiselect':
      return field === 'labels' || field === 'assignees'
    default:
      return true
  }
}

function optionId(column: TrackerColumn, value: string) {
  const wanted = value.trim().toLowerCase()
  if (!wanted) return ''
  const options = column.options || []
  return (
    options.find(option => option.id === value)?.id ||
    options.find(option => option.label.trim().toLowerCase() === wanted)?.id ||
    ''
  )
}
const splitList = (value: string) =>
  value
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)

function cleanValue(raw: unknown): GitValue | null {
  if (!isObject(raw)) return null
  if (raw.from === 'fixed') return { from: 'fixed', value: str(raw.value, GIT_LIMITS.value).trim() }
  if (raw.from === 'ticket' && isTicketField(raw.field)) return { from: 'ticket', field: raw.field }
  return null
}

function cleanConditions(raw: unknown, columns: TrackerColumn[], where: string, errors: string[]): GitCondition[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) {
    errors.push(`${where}: its conditions are not a list.`)
    return []
  }
  if (raw.length > GIT_LIMITS.conditions) errors.push(`${where}: at most ${GIT_LIMITS.conditions} conditions.`)
  const ids = new Set(columns.map(column => column.id))
  const out: GitCondition[] = []
  for (const item of raw.slice(0, GIT_LIMITS.conditions)) {
    if (!isObject(item) || !isOp(item.op)) {
      errors.push(`${where}: a condition is incomplete.`)
      continue
    }
    const value = str(item.value, 200).trim()
    if (!['is_empty', 'not_empty'].includes(item.op) && !value) {
      errors.push(`${where}: a condition needs a value to compare with.`)
      continue
    }
    if (item.on === 'ticket' && isTicketField(item.field))
      out.push({ on: 'ticket', field: item.field, op: item.op, value })
    else if (item.on === 'cell' && typeof item.columnId === 'string' && ids.has(item.columnId))
      out.push({ on: 'cell', columnId: item.columnId, op: item.op, value })
    else errors.push(`${where}: a condition refers to a ticket field or column that does not exist.`)
  }
  return out
}

function cleanMapping(
  raw: unknown,
  columns: TrackerColumn[],
  where: string,
  errors: string[],
  allowColumn: boolean,
): GitWorkMapping {
  const input = isObject(raw) ? raw : {}
  const title = str(input.title, GIT_LIMITS.template).trim()
  const description = str(input.description, GIT_LIMITS.description)
  if (!title) errors.push(`${where}: enter how its title is made, e.g. "#{ticket.number} {ticket.title}".`)
  errors.push(...placeholderErrors(title, columns, `${where} title`, allowColumn))
  errors.push(...placeholderErrors(description, columns, `${where} description`, allowColumn))
  let due: GitDue = { from: 'none' }
  const dueInput = isObject(input.due) ? input.due : {}
  if (dueInput.from === 'ticket') due = { from: 'ticket' }
  else if (dueInput.from === 'column') {
    const column = columns.find(entry => entry.id === dueInput.columnId)
    if (column?.type === 'date') due = { from: 'column', columnId: column.id }
    else errors.push(`${where}: its due date must come from a Date column.`)
  }
  return { title, description, due }
}

/**
 * Cleans a GIT template's rules against the template's columns. Returns the rules it could keep and, in plain words,
 * everything wrong: a template with errors must not be saved or used for generation.
 */
export function normalizeGitGeneration(
  raw: unknown,
  columns: TrackerColumn[],
): { generation: GitGeneration; errors: string[] } {
  const errors: string[] = []
  const input = isObject(raw) ? raw : {}
  if (input.version !== undefined && input.version !== GIT_GENERATION_VERSION)
    errors.push('These generation rules are from a newer version of the app.')
  const byId = new Map(columns.map(column => [column.id, column]))
  const rowsInput = Array.isArray(input.rows) ? input.rows : []
  if (rowsInput.length > GIT_LIMITS.rows) errors.push(`A template can add at most ${GIT_LIMITS.rows} rows per ticket.`)
  if (!rowsInput.length) errors.push('Add at least one row for each ticket.')

  const keys = new Set<string>()
  const rows: GitRowBlueprint[] = []
  rowsInput.slice(0, GIT_LIMITS.rows).forEach((item: unknown, at: number) => {
    const entry = isObject(item) ? item : {}
    const name = str(entry.name, GIT_LIMITS.name).trim()
    const where = `Row ${at + 1}${name ? ` (${name})` : ''}`
    const key = str(entry.key, 40)
    if (!KEY.test(key)) errors.push(`${where}: its key must be lowercase letters, digits, - or _.`)
    else if (keys.has(key)) errors.push(`${where}: another row already uses the key "${key}".`)
    keys.add(key)
    if (!name) errors.push(`${where}: enter a name.`)
    const cells: Record<string, GitValue> = {}
    for (const [columnId, rawValue] of Object.entries(isObject(entry.cells) ? entry.cells : {})) {
      const column = byId.get(columnId)
      const value = cleanValue(rawValue)
      if (!column) errors.push(`${where}: it fills a column that is not in the template.`)
      else if (!GIT_FILLABLE_TYPES.includes(column.type)) errors.push(`${where}: ${column.name} cannot be filled.`)
      else if (!value) errors.push(`${where}: the value for ${column.name} is incomplete.`)
      else if (value.from === 'fixed' && !fixedFits(column, value.value))
        errors.push(`${where}: "${value.value}" does not fit ${column.name}.`)
      else if (value.from === 'ticket' && !ticketFits(column, value.field))
        errors.push(`${where}: the ticket's ${value.field} cannot go in ${column.name}.`)
      else cells[columnId] = value
    }
    const when = cleanConditions(entry.when, columns, where, errors)
    const work: GitWorkType = entry.work === 'task' || entry.work === 'subtask' ? entry.work : 'none'
    const row: GitRowBlueprint = { key, name, cells, when, work }
    if (work === 'subtask') row.parentKey = str(entry.parentKey, 40)
    if (work !== 'none') row.task = cleanMapping(entry.task, columns, where, errors, false)
    rows.push(row)
  })

  const taskRows = new Set(rows.filter(row => row.work === 'task').map(row => row.key))
  for (const row of rows)
    if (row.work === 'subtask' && (!row.parentKey || !taskRows.has(row.parentKey)))
      errors.push(`Row ${row.name || row.key}: a Subtask row must belong under a row that makes a Task.`)

  const rulesInput = Array.isArray(input.columnRules) ? input.columnRules : []
  if (rulesInput.length > GIT_LIMITS.columnRules) errors.push(`At most ${GIT_LIMITS.columnRules} column rules.`)
  const columnRules: GitColumnRule[] = []
  rulesInput.slice(0, GIT_LIMITS.columnRules).forEach((item: unknown, at: number) => {
    const entry = isObject(item) ? item : {}
    const column = byId.get(String(entry.columnId || ''))
    const where = `Column rule ${at + 1}${column ? ` (${column.name})` : ''}`
    const key = str(entry.key, 40)
    if (!KEY.test(key)) errors.push(`${where}: its key must be lowercase letters, digits, - or _.`)
    else if (keys.has(key)) errors.push(`${where}: the key "${key}" is already used.`)
    keys.add(key)
    if (!column) {
      errors.push(`${where}: choose a column of the template.`)
      return
    }
    let targets: 'all' | string[] = 'all'
    if (Array.isArray(entry.rows)) {
      targets = [...new Set(entry.rows.map(value => String(value)))]
      if (!targets.length || targets.some(target => !taskRows.has(target)))
        errors.push(`${where}: it can only apply to rows that make a Task.`)
    }
    columnRules.push({
      key,
      columnId: column.id,
      rows: targets,
      when: cleanConditions(entry.when, columns, where, errors),
      task: cleanMapping(entry.task, columns, where, errors, true),
    })
  })
  if (columnRules.length && !taskRows.size) errors.push('Column rules need at least one row that makes a Task.')
  if (!rows.some(row => row.work !== 'none'))
    errors.push('The template makes no Tasks: set at least one row to make a Task.')

  return { generation: { version: GIT_GENERATION_VERSION, rows, columnRules }, errors }
}

/** The ticket's value for a field, as text (lists joined with ", "). */
export function ticketText(ticket: GitTicketSnapshot, field: GitTicketField): string {
  switch (field) {
    case 'number':
      return String(ticket.number)
    case 'labels':
      return ticket.labels.join(', ')
    case 'assignees':
      return ticket.assignees.join(', ')
    case 'due':
      return ticket.dueDate || ''
    default:
      return String(ticket[field] ?? '')
  }
}

/** A stored cell as text: Choice columns by option label, Checkbox as true/false. */
export function gitCellText(column: TrackerColumn | undefined, value: Cell | undefined): string {
  if (!column || value === undefined || value === null) return ''
  if (column.type === 'select') return column.options?.find(option => option.id === value)?.label || ''
  if (column.type === 'multiselect')
    return (Array.isArray(value) ? value : [])
      .map(id => column.options?.find(option => option.id === id)?.label || '')
      .filter(Boolean)
      .join(', ')
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return typeof value === 'string' ? value.trim() : String(value)
}

/** The value a blueprint puts in a cell, in the column's stored form. Values that do not fit are left empty. */
export function resolveCell(column: TrackerColumn, value: GitValue, ticket: GitTicketSnapshot): Cell {
  const text = value.from === 'fixed' ? value.value : ticketText(ticket, value.field)
  const parts = value.from === 'ticket' && LIST_FIELDS.includes(value.field) ? ticketList(ticket, value.field) : null
  switch (column.type) {
    case 'number': {
      const number = Number(text)
      return text && Number.isFinite(number) ? number : null
    }
    case 'date':
      return validDate(text) ? text : ''
    case 'checkbox':
      return text === 'true'
    case 'select':
      return optionId(column, text)
    case 'multiselect':
      return [...new Set((parts || splitList(text)).map(part => optionId(column, part)).filter(Boolean))]
    case 'longtext':
      return text.slice(0, 10000)
    default:
      return text.replace(/[\r\n]+/g, ' ').slice(0, 1000)
  }
}

const ticketList = (ticket: GitTicketSnapshot, field: GitTicketField) =>
  field === 'labels' ? ticket.labels : field === 'assignees' ? ticket.assignees : []

/** Whether every condition holds. Text compares without case; list fields match when any item does. */
export function conditionsHold(
  conditions: GitCondition[],
  ticket: GitTicketSnapshot,
  cells: Record<string, Cell>,
  columns: TrackerColumn[],
): boolean {
  return conditions.every(condition => {
    let items: string[]
    // A Checkbox is "true" when ticked and empty when not, so `equals false` and `is_empty` both mean unticked.
    let checkbox = false
    if (condition.on === 'ticket')
      items = LIST_FIELDS.includes(condition.field)
        ? ticketList(ticket, condition.field)
        : [ticketText(ticket, condition.field)]
    else {
      const column = columns.find(entry => entry.id === condition.columnId)
      const value = cells[condition.columnId]
      checkbox = column?.type === 'checkbox'
      if (checkbox) items = value === true ? ['true'] : []
      else if (column?.type === 'multiselect' && Array.isArray(value))
        items = value.map(id => column.options?.find(option => option.id === id)?.label || '')
      else items = [gitCellText(column, value)]
    }
    const values = items.map(item => item.trim().toLowerCase()).filter(Boolean)
    const wanted = condition.value.trim().toLowerCase()
    const unticked = checkbox && wanted === 'false'
    switch (condition.op) {
      case 'is_empty':
        return !values.length
      case 'not_empty':
        return values.length > 0
      case 'equals':
        return unticked ? !values.length : values.includes(wanted)
      case 'not_equals':
        return unticked ? values.length > 0 : !values.includes(wanted)
      case 'contains':
        return values.some(item => item.includes(wanted))
      case 'not_contains':
        return !values.some(item => item.includes(wanted))
    }
  })
}

/** Fills a title or description. Unknown placeholders are left as written (the template check reports them). */
export function renderTemplate(
  template: string,
  ticket: GitTicketSnapshot,
  context: { rowName: string; columnName?: string; cells: Record<string, Cell>; columns: TrackerColumn[] },
): string {
  return template.replace(PLACEHOLDER, (whole, name: string) => {
    if (name.startsWith('ticket.') && isTicketField(name.slice(7)))
      return ticketText(ticket, name.slice(7) as GitTicketField)
    if (name === 'row') return context.rowName
    if (name === 'column' && context.columnName !== undefined) return context.columnName
    if (name.startsWith('col:')) {
      const column = context.columns.find(entry => entry.id === name.slice(4))
      if (column) return gitCellText(column, context.cells[column.id])
    }
    return whole
  })
}

export type PlannedGitRow = { key: string; id: string; name: string; cells: Record<string, Cell> }
export type PlannedGitWork = {
  /** row:<row key> or col:<rule key>:<row key>; unique per ticket entry. */
  ruleKey: string
  id: string
  type: 'Task' | 'Subtask'
  parentId: string | null
  rowKey: string
  rowId: string
  /** Column rules: the cell the Subtask is linked to. */
  columnId: string | null
  title: string
  description: string
  dueDate: string
  clientId: string
  projectId: string
  assignedToUserId: string
}
export type GitPlan = {
  rows: PlannedGitRow[]
  /** Tasks first, then Subtasks, so every parent comes before its children. */
  work: PlannedGitWork[]
  /** Rules that did not apply, and why, for the generation report. */
  skipped: { ruleKey: string; reason: string }[]
  /** Anything that stops generation: nothing should be made when there is one. */
  errors: string[]
}

export type GitPlanInput = {
  generation: GitGeneration
  columns: TrackerColumn[]
  ticket: GitTicketSnapshot
  /** From the ticket's repository mapping, as stored on the ticket entry when it was added. */
  clientId: string
  projectId: string
  assigneeId: string
  /** Stable ids: the same kind and key give the same id for this ticket entry. */
  idFor: (kind: 'row' | 'work', key: string) => string
}

/** Plans the rows, Tasks and Subtasks for one ticket. Makes nothing itself. */
export function planGitGeneration(input: GitPlanInput): GitPlan {
  const { generation, columns, ticket, clientId, projectId, assigneeId, idFor } = input
  const plan: GitPlan = { rows: [], work: [], skipped: [], errors: [] }
  const checked = normalizeGitGeneration(generation, columns)
  if (checked.errors.length) {
    plan.errors.push(...checked.errors.map(error => `Template: ${error}`))
    return plan
  }
  if (!clientId || !projectId) {
    plan.errors.push('The ticket has no Client and Project: its repository must be mapped first.')
    return plan
  }
  const byId = new Map(columns.map(column => [column.id, column]))
  const rules = checked.generation

  for (const blueprint of rules.rows) {
    const cells: Record<string, Cell> = {}
    for (const [columnId, value] of Object.entries(blueprint.cells)) {
      const column = byId.get(columnId)
      if (column) cells[columnId] = resolveCell(column, value, ticket)
    }
    if (!conditionsHold(blueprint.when, ticket, cells, columns)) {
      plan.skipped.push({
        ruleKey: `row:${blueprint.key}`,
        reason: `Row ${blueprint.name}: its conditions do not hold.`,
      })
      continue
    }
    plan.rows.push({ key: blueprint.key, id: idFor('row', blueprint.key), name: blueprint.name, cells })
  }

  const rowOf = new Map(plan.rows.map(row => [row.key, row]))
  const work = (
    ruleKey: string,
    type: PlannedGitWork['type'],
    parentId: string | null,
    row: PlannedGitRow,
    mapping: GitWorkMapping,
    column?: TrackerColumn,
  ): PlannedGitWork => {
    const context = { rowName: row.name, columnName: column?.name, cells: row.cells, columns }
    const title =
      renderTemplate(mapping.title, ticket, context).replace(/\s+/g, ' ').trim().slice(0, GIT_LIMITS.title) ||
      `#${ticket.number} ${ticket.title}`.trim().slice(0, GIT_LIMITS.title)
    const due =
      mapping.due.from === 'ticket'
        ? ticket.dueDate || ''
        : mapping.due.from === 'column'
          ? String(row.cells[mapping.due.columnId] || '')
          : ''
    return {
      ruleKey,
      id: idFor('work', ruleKey),
      type,
      parentId,
      rowKey: row.key,
      rowId: row.id,
      columnId: column?.id || null,
      title,
      description: renderTemplate(mapping.description, ticket, context).slice(0, GIT_LIMITS.descriptionOut),
      dueDate: validDate(due) ? due : '',
      clientId,
      projectId,
      assignedToUserId: assigneeId,
    }
  }

  // Tasks first.
  const taskOf = new Map<string, PlannedGitWork>()
  for (const blueprint of rules.rows) {
    const row = rowOf.get(blueprint.key)
    if (!row || blueprint.work !== 'task' || !blueprint.task) continue
    const task = work(`row:${blueprint.key}`, 'Task', null, row, blueprint.task)
    taskOf.set(blueprint.key, task)
    plan.work.push(task)
  }
  // Subtask rows, under their Task row's Task.
  for (const blueprint of rules.rows) {
    const row = rowOf.get(blueprint.key)
    if (!row || blueprint.work !== 'subtask' || !blueprint.task) continue
    const parent = taskOf.get(blueprint.parentKey || '')
    if (!parent) {
      plan.skipped.push({
        ruleKey: `row:${blueprint.key}`,
        reason: `Row ${blueprint.name}: its Task row was not added, so it has no parent Task.`,
      })
      continue
    }
    plan.work.push(work(`row:${blueprint.key}`, 'Subtask', parent.id, row, blueprint.task))
  }
  // Column rules: a Subtask for each Task row they apply to, linked to that row's cell.
  for (const rule of rules.columnRules) {
    const column = byId.get(rule.columnId)
    if (!column) continue
    for (const blueprint of rules.rows) {
      const parent = taskOf.get(blueprint.key)
      const row = rowOf.get(blueprint.key)
      if (!parent || !row || (rule.rows !== 'all' && !rule.rows.includes(blueprint.key))) continue
      const ruleKey = `col:${rule.key}:${blueprint.key}`
      if (!conditionsHold(rule.when, ticket, row.cells, columns)) {
        plan.skipped.push({ ruleKey, reason: `${column.name} on ${row.name}: its conditions do not hold.` })
        continue
      }
      plan.work.push(work(ruleKey, 'Subtask', parent.id, row, rule.task, column))
    }
  }

  if (plan.work.length > GIT_LIMITS.work)
    plan.errors.push(`This ticket would make ${plan.work.length} Tasks and Subtasks; the most is ${GIT_LIMITS.work}.`)
  if (!plan.work.length && !plan.errors.length)
    plan.skipped.push({ ruleKey: '', reason: 'No rule applied to this ticket, so no Tasks were made.' })
  return plan
}
