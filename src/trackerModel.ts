/**
 * Trackers: sheets you shape yourself. This file holds the rules shared by the server and the browser:
 * what a column is, what a cell may hold, and how a saved view is cleaned. Both sides call the same
 * functions, so a value the grid accepts is a value the server accepts.
 */

export const TRACKER_LIMITS = {
  columns: 100,
  rows: 5000,
  importBatch: 500,
  trackers: 200,
  views: 30,
  filtersPerView: 10,
  optionsPerColumn: 100,
  nameLength: 120,
  columnName: 60,
  optionLabel: 60,
  viewName: 40,
  text: 2000,
  longText: 20000,
  link: 2000,
  secret: 500,
} as const

export type OptionColor = 'gray' | 'blue' | 'green' | 'amber' | 'red' | 'purple' | 'pink' | 'teal'
export const OPTION_COLORS: OptionColor[] = ['gray', 'blue', 'green', 'amber', 'red', 'purple', 'pink', 'teal']

export type BasicType = 'text' | 'longtext' | 'number' | 'date' | 'checkbox' | 'select' | 'multiselect' | 'person' | 'link'
/** These fill themselves from the task a row is linked to. Nothing is stored in the row for them. */
export type ConnectedType = 'task_status' | 'task_due' | 'task_owner' | 'signoff' | 'drive_files'
export type ColumnType = BasicType | ConnectedType | 'secret'

export type ColumnGroup = 'basic' | 'connected' | 'protected'
export const COLUMN_TYPES: { type: ColumnType; label: string; group: ColumnGroup; about: string }[] = [
  { type: 'text', label: 'Text', group: 'basic', about: 'A short line of text.' },
  { type: 'longtext', label: 'Long text', group: 'basic', about: 'Notes and longer descriptions.' },
  { type: 'number', label: 'Number', group: 'basic', about: 'Quantities, amounts and counts.' },
  { type: 'date', label: 'Date', group: 'basic', about: 'A calendar date.' },
  { type: 'checkbox', label: 'Checkbox', group: 'basic', about: 'Yes or no.' },
  { type: 'select', label: 'Select', group: 'basic', about: 'One choice from a list you define.' },
  { type: 'multiselect', label: 'Multi-select', group: 'basic', about: 'Several choices from a list you define.' },
  { type: 'person', label: 'Person', group: 'basic', about: 'A teammate on this account.' },
  { type: 'link', label: 'Link', group: 'basic', about: 'A web address, such as a Git issue or a Drive folder.' },
  { type: 'task_status', label: 'Task status', group: 'connected', about: 'The status of the task this row is linked to.' },
  { type: 'task_due', label: 'Task due date', group: 'connected', about: 'The due date of the linked task.' },
  { type: 'task_owner', label: 'Task owner', group: 'connected', about: 'Who the linked task is assigned to.' },
  { type: 'signoff', label: 'Sign-off status', group: 'connected', about: 'Where the DocHub sign-offs on the linked task and its subtasks stand.' },
  { type: 'drive_files', label: 'Drive files', group: 'connected', about: 'How many files are saved to Drive on the linked task and its subtasks.' },
  { type: 'secret', label: 'Secret', group: 'protected', about: 'Encrypted, masked on screen. Every reveal is logged.' },
]

export const isConnectedType = (type: string): type is ConnectedType => ['task_status', 'task_due', 'task_owner', 'signoff', 'drive_files'].includes(type)
export const isBasicType = (type: string): type is BasicType => ['text', 'longtext', 'number', 'date', 'checkbox', 'select', 'multiselect', 'person', 'link'].includes(type)
export const isColumnType = (type: unknown): type is ColumnType => typeof type === 'string' && (isBasicType(type) || isConnectedType(type) || type === 'secret')
export const columnTypeLabel = (type: string) => COLUMN_TYPES.find(item => item.type === type)?.label || type

export type SelectOption = { id: string; label: string; color: OptionColor }
export type RevealBy = 'editors' | 'admins'
export type TrackerColumn = {
  id: string
  name: string
  type: ColumnType
  width?: number
  options?: SelectOption[]
  revealBy?: RevealBy
}

export type Cell = string | number | boolean | string[] | null

export type FilterOp = 'contains' | 'is' | 'is_not' | 'is_empty' | 'not_empty' | 'gt' | 'lt' | 'before' | 'after' | 'checked' | 'unchecked'
export const FILTER_OPS: FilterOp[] = ['contains', 'is', 'is_not', 'is_empty', 'not_empty', 'gt', 'lt', 'before', 'after', 'checked', 'unchecked']
export type ViewFilter = { columnId: string; op: FilterOp; value: string }
export type TrackerView = {
  id: string
  name: string
  filters: ViewFilter[]
  sort: { columnId: string; dir: 'asc' | 'desc' } | null
  groupBy: string
  hidden: string[]
}

export type TrackerRow = {
  id: string
  position: number
  cells: Record<string, Cell>
  /** Which Secret columns hold a value. The values themselves never leave the server except through a logged reveal. */
  secretSet: Record<string, true>
  taskId: string
  version: number
  updatedAt: string
}

export type Tracker = {
  id: string
  name: string
  clientId: string
  projectId: string
  private: boolean
  template: string
  columns: TrackerColumn[]
  views: TrackerView[]
  revision: number
  rowCount: number
  createdBy: string
  createdByName: string
  createdAt: string
  updatedAt: string
  archived: boolean
  canEdit: boolean
  canManage: boolean
}

export class TrackerError extends Error {
  constructor(message: string, public status = 400, public extra?: Record<string, unknown>) { super(message) }
}

const ID = /^[a-z0-9_]{3,40}$/i
const DATE = /^\d{4}-\d{2}-\d{2}$/

export function randomId(prefix = '') {
  const bytes = new Uint8Array(6)
  globalThis.crypto.getRandomValues(bytes)
  return prefix + Array.from(bytes, byte => byte.toString(36).padStart(2, '0')).join('').slice(0, 10)
}

/** Collapses whitespace and strips control characters from a one-line name. */
export function cleanName(value: unknown, label: string, max: number) {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!text) throw new TrackerError(`Enter a ${label}.`)
  if (text.length > max) throw new TrackerError(`The ${label} can be at most ${max} characters.`)
  return text
}

function normalizeOptions(input: unknown, previous?: SelectOption[]): SelectOption[] {
  if (input === undefined || input === null) return previous ? previous.map(option => ({ ...option })) : []
  if (!Array.isArray(input)) throw new TrackerError('Options must be a list.')
  if (input.length > TRACKER_LIMITS.optionsPerColumn) throw new TrackerError(`A column can have at most ${TRACKER_LIMITS.optionsPerColumn} options.`)
  const seenId = new Set<string>(), seenLabel = new Set<string>()
  return input.map((raw: any, index) => {
    const label = cleanName(raw?.label, 'option name', TRACKER_LIMITS.optionLabel)
    const key = label.toLowerCase()
    if (seenLabel.has(key)) throw new TrackerError(`Two options are named "${label}".`)
    seenLabel.add(key)
    let id = typeof raw?.id === 'string' && ID.test(raw.id) && !seenId.has(raw.id) ? raw.id : ''
    while (!id || seenId.has(id)) id = randomId('o_')
    seenId.add(id)
    const color: OptionColor = OPTION_COLORS.includes(raw?.color) ? raw.color : OPTION_COLORS[(index % (OPTION_COLORS.length - 1)) + 1]
    return { id, label, color }
  })
}

/**
 * Checks a column list and fills in what is missing (ids, option colours). A column that already existed keeps its type:
 * changing one could expose or lose values, so a different type means adding a new column.
 */
export function normalizeColumns(input: unknown, previous: TrackerColumn[] = []): TrackerColumn[] {
  if (!Array.isArray(input) || !input.length) throw new TrackerError('A tracker needs at least one column.')
  if (input.length > TRACKER_LIMITS.columns) throw new TrackerError(`A tracker can have at most ${TRACKER_LIMITS.columns} columns.`)
  const before = new Map(previous.map(column => [column.id, column]))
  const seenId = new Set<string>(), seenName = new Set<string>()
  return input.map((raw: any) => {
    const name = cleanName(raw?.name, 'column name', TRACKER_LIMITS.columnName)
    if (seenName.has(name.toLowerCase())) throw new TrackerError(`Two columns are named "${name}".`)
    seenName.add(name.toLowerCase())
    if (!isColumnType(raw?.type)) throw new TrackerError(`Choose a type for "${name}".`)
    const known = typeof raw?.id === 'string' ? before.get(raw.id) : undefined
    if (known && known.type !== raw.type) throw new TrackerError(`"${name}" cannot change type. Add a new column of the type you want and delete this one.`)
    let id = known ? known.id : typeof raw?.id === 'string' && ID.test(raw.id) && !before.has(raw.id) ? raw.id : ''
    if (seenId.has(id)) throw new TrackerError('Two columns share an id.')
    while (!id || seenId.has(id) || (!known && before.has(id))) id = randomId('c_')
    seenId.add(id)
    const column: TrackerColumn = { id, name, type: raw.type }
    if (raw.width !== undefined && raw.width !== null) {
      const width = Number(raw.width)
      if (Number.isFinite(width)) column.width = Math.max(60, Math.min(800, Math.round(width)))
    }
    if (raw.type === 'select' || raw.type === 'multiselect') column.options = normalizeOptions(raw.options, known?.options)
    if (raw.type === 'secret') column.revealBy = raw.revealBy === 'admins' ? 'admins' : 'editors'
    return column
  })
}

export const emptyCell = (type: ColumnType): Cell => type === 'number' ? null : type === 'checkbox' ? false : type === 'multiselect' ? [] : ''

export function isEmptyCell(value: Cell | undefined) {
  return value === undefined || value === null || value === '' || value === false || (Array.isArray(value) && !value.length)
}

export function validDate(value: string) {
  if (!DATE.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

const noControls = (text: string, multiline: boolean) => text.replace(multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g : /[\u0000-\u001f\u007f]/g, multiline ? '' : ' ')

/** Cleans one cell value for a column. Returns the value to store (empty values come back as the type's empty value). */
export function cleanCell(column: TrackerColumn, raw: unknown): { ok: true; value: Cell } | { ok: false; error: string } {
  const bad = (error: string) => ({ ok: false as const, error })
  switch (column.type) {
    case 'text': {
      if (raw === null || raw === undefined) return { ok: true, value: '' }
      const text = noControls(String(raw), false).trim()
      return text.length > TRACKER_LIMITS.text ? bad(`${column.name} can hold at most ${TRACKER_LIMITS.text} characters.`) : { ok: true, value: text }
    }
    case 'longtext': {
      if (raw === null || raw === undefined) return { ok: true, value: '' }
      const text = noControls(String(raw).replace(/\r\n?/g, '\n'), true).trim()
      return text.length > TRACKER_LIMITS.longText ? bad(`${column.name} can hold at most ${TRACKER_LIMITS.longText} characters.`) : { ok: true, value: text }
    }
    case 'number': {
      if (raw === null || raw === undefined || raw === '') return { ok: true, value: null }
      const value = typeof raw === 'number' ? raw : Number(String(raw).replace(/[,\s]/g, ''))
      return Number.isFinite(value) && Math.abs(value) <= 1e15 ? { ok: true, value } : bad(`${column.name} needs a number.`)
    }
    case 'date': {
      if (raw === null || raw === undefined || raw === '') return { ok: true, value: '' }
      const text = String(raw).trim()
      return validDate(text) ? { ok: true, value: text } : bad(`${column.name} needs a date.`)
    }
    case 'checkbox': {
      if (typeof raw === 'boolean') return { ok: true, value: raw }
      if (raw === null || raw === undefined || raw === '') return { ok: true, value: false }
      const text = String(raw).trim().toLowerCase()
      if (['yes', 'y', 'true', '1', 'x', '✓', '✔', 'done', 'checked'].includes(text)) return { ok: true, value: true }
      if (['no', 'n', 'false', '0', 'unchecked'].includes(text)) return { ok: true, value: false }
      return bad(`${column.name} needs yes or no.`)
    }
    case 'select': {
      if (raw === null || raw === undefined || raw === '') return { ok: true, value: '' }
      return column.options?.some(option => option.id === raw) ? { ok: true, value: String(raw) } : bad(`${column.name} has no such option.`)
    }
    case 'multiselect': {
      if (raw === null || raw === undefined || raw === '') return { ok: true, value: [] }
      if (!Array.isArray(raw)) return bad(`${column.name} needs a list of options.`)
      const unique = [...new Set(raw.map(String))]
      return unique.every(id => column.options?.some(option => option.id === id)) ? { ok: true, value: unique } : bad(`${column.name} has no such option.`)
    }
    case 'person': {
      if (raw === null || raw === undefined || raw === '') return { ok: true, value: '' }
      const id = String(raw).trim()
      return id.length <= 100 && !/[\u0000-\u001f]/.test(id) ? { ok: true, value: id } : bad(`${column.name} needs a teammate.`)
    }
    case 'link': {
      if (raw === null || raw === undefined || raw === '') return { ok: true, value: '' }
      const text = String(raw).trim()
      if (text.length > TRACKER_LIMITS.link) return bad(`${column.name} is too long.`)
      try {
        // Keep the address as typed; only add https:// when no scheme was given.
        const href = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`
        const url = new URL(href)
        if (!['http:', 'https:'].includes(url.protocol) || !url.hostname.includes('.')) throw new Error()
        return { ok: true, value: href }
      } catch { return bad(`${column.name} needs a web address.`) }
    }
    case 'secret': return bad(`${column.name} is a Secret column. Its value is set separately.`)
    default: return bad(`${column.name} fills itself from the linked task.`)
  }
}

export function cleanSecret(column: TrackerColumn, raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (column.type !== 'secret') return { ok: false, error: `${column.name} is not a Secret column.` }
  if (typeof raw !== 'string') return { ok: false, error: `${column.name} needs text.` }
  const text = raw.replace(/[\u0000-\u001f\u007f]/g, '')
  if (text.length > TRACKER_LIMITS.secret) return { ok: false, error: `${column.name} can hold at most ${TRACKER_LIMITS.secret} characters.` }
  return { ok: true, value: text }
}

const newView = (): TrackerView => ({ id: '', name: '', filters: [], sort: null, groupBy: '', hidden: [] })

/** Cleans saved views. References to columns that no longer exist are dropped rather than rejected. */
export function normalizeViews(input: unknown, columns: TrackerColumn[]): TrackerView[] {
  if (input === undefined || input === null) return []
  if (!Array.isArray(input)) throw new TrackerError('Views must be a list.')
  if (input.length > TRACKER_LIMITS.views) throw new TrackerError(`A tracker can have at most ${TRACKER_LIMITS.views} saved views.`)
  const known = new Set(columns.map(column => column.id))
  const seenId = new Set<string>(), seenName = new Set<string>()
  return input.map((raw: any) => {
    const view = newView()
    view.name = cleanName(raw?.name, 'view name', TRACKER_LIMITS.viewName)
    if (seenName.has(view.name.toLowerCase())) throw new TrackerError(`Two views are named "${view.name}".`)
    seenName.add(view.name.toLowerCase())
    let id = typeof raw?.id === 'string' && ID.test(raw.id) && !seenId.has(raw.id) ? raw.id : ''
    while (!id || seenId.has(id)) id = randomId('v_')
    seenId.add(id); view.id = id
    const filters = Array.isArray(raw?.filters) ? raw.filters : []
    view.filters = filters.filter((filter: any) => known.has(filter?.columnId) && FILTER_OPS.includes(filter?.op)).slice(0, TRACKER_LIMITS.filtersPerView)
      .map((filter: any) => ({ columnId: String(filter.columnId), op: filter.op as FilterOp, value: String(filter.value ?? '').slice(0, 200) }))
    view.sort = raw?.sort && known.has(raw.sort.columnId) ? { columnId: String(raw.sort.columnId), dir: raw.sort.dir === 'desc' ? 'desc' : 'asc' } : null
    view.groupBy = known.has(raw?.groupBy) ? String(raw.groupBy) : ''
    view.hidden = Array.isArray(raw?.hidden) ? [...new Set<string>(raw.hidden.map(String).filter((columnId: string) => known.has(columnId)))] : []
    return view
  })
}

export function filterOpsFor(type: ColumnType): FilterOp[] {
  switch (type) {
    case 'number': return ['is', 'gt', 'lt', 'is_empty', 'not_empty']
    case 'date': case 'task_due': return ['is', 'before', 'after', 'is_empty', 'not_empty']
    case 'checkbox': return ['checked', 'unchecked']
    case 'select': case 'person': return ['is', 'is_not', 'is_empty', 'not_empty']
    case 'multiselect': return ['contains', 'is_empty', 'not_empty']
    case 'secret': return ['is_empty', 'not_empty']
    default: return ['contains', 'is', 'is_not', 'is_empty', 'not_empty']
  }
}

export const filterOpLabel: Record<FilterOp, string> = {
  contains: 'contains', is: 'is', is_not: 'is not', is_empty: 'is empty', not_empty: 'is not empty',
  gt: 'is greater than', lt: 'is less than', before: 'is before', after: 'is after', checked: 'is checked', unchecked: 'is not checked',
}
export const filterNeedsValue = (op: FilterOp) => !['is_empty', 'not_empty', 'checked', 'unchecked'].includes(op)
