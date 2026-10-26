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

export type BasicType =
  | 'text'
  | 'longtext'
  | 'number'
  | 'date'
  | 'checkbox'
  | 'select'
  | 'multiselect'
  | 'person'
  | 'link'
/** These fill themselves from the task a row is linked to. Nothing is stored in the row for them. */
export type ConnectedType = 'task_status' | 'task_due' | 'task_owner' | 'signoff' | 'drive_files'
export type ColumnType = BasicType | ConnectedType | 'secret' | 'formula'

export type ColumnGroup = 'basic' | 'computed' | 'connected' | 'protected'
export const COLUMN_TYPES: { type: ColumnType; label: string; group: ColumnGroup; about: string }[] = [
  { type: 'text', label: 'Text', group: 'basic', about: 'A short line of text.' },
  { type: 'longtext', label: 'Long text', group: 'basic', about: 'Notes and longer descriptions.' },
  { type: 'number', label: 'Number', group: 'basic', about: 'Quantities, amounts and counts.' },
  { type: 'date', label: 'Date', group: 'basic', about: 'A calendar date.' },
  { type: 'checkbox', label: 'Checkbox', group: 'basic', about: 'Yes or no.' },
  { type: 'select', label: 'Select', group: 'basic', about: 'One choice from a list you define.' },
  { type: 'multiselect', label: 'Multi-select', group: 'basic', about: 'Several choices from a list you define.' },
  { type: 'person', label: 'Person', group: 'basic', about: 'A teammate on this account.' },
  {
    type: 'link',
    label: 'Link',
    group: 'basic',
    about:
      'A web address, such as a Git issue or a Drive folder. Type a short label first to show it instead of the address, like #1234 https://…',
  },
  {
    type: 'formula',
    label: 'Calculated',
    group: 'computed',
    about:
      'Works out a number from other columns in the same row: add +, subtract -, multiply * and divide /, like [Qty] * [Price].',
  },
  {
    type: 'task_status',
    label: 'Task status',
    group: 'connected',
    about: 'The status of the task this row is linked to.',
  },
  { type: 'task_due', label: 'Task due date', group: 'connected', about: 'The due date of the linked task.' },
  { type: 'task_owner', label: 'Task owner', group: 'connected', about: 'Who the linked task is assigned to.' },
  {
    type: 'signoff',
    label: 'Sign-off status',
    group: 'connected',
    about: 'Where the DocHub sign-offs on the linked task and its subtasks stand.',
  },
  {
    type: 'drive_files',
    label: 'Drive files',
    group: 'connected',
    about: 'How many files are saved to Drive on the linked task and its subtasks.',
  },
  {
    type: 'secret',
    label: 'Secret',
    group: 'protected',
    about: 'Encrypted, masked on screen. Every reveal is logged.',
  },
]

export const isConnectedType = (type: string): type is ConnectedType =>
  ['task_status', 'task_due', 'task_owner', 'signoff', 'drive_files'].includes(type)
export const isBasicType = (type: string): type is BasicType =>
  ['text', 'longtext', 'number', 'date', 'checkbox', 'select', 'multiselect', 'person', 'link'].includes(type)
export const isColumnType = (type: unknown): type is ColumnType =>
  typeof type === 'string' && (isBasicType(type) || isConnectedType(type) || type === 'secret' || type === 'formula')
export const columnTypeLabel = (type: string) => COLUMN_TYPES.find(item => item.type === type)?.label || type

export type SelectOption = { id: string; label: string; color: OptionColor }
/**
 * A Link cell holds a web address, optionally with a short label that is shown instead of the address: `[#1234](https://…)`.
 * People can type `#1234 https://…` or `[#1234](https://…)`; both are stored in the bracket form.
 */
const LINK_MARKDOWN = /^\[([^\]\n]{1,120})\]\((\S+)\)$/
const LINK_LABELLED = /^(.{1,120}?)\s+(https?:\/\/\S+)$/i
const cleanLabel = (label: string) =>
  label
    .replace(/[\u0000-\u001f\u007f[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
export function splitLink(text: string): { label: string; address: string } {
  const markdown = LINK_MARKDOWN.exec(text)
  if (markdown) return { label: cleanLabel(markdown[1]), address: markdown[2] }
  const labelled = LINK_LABELLED.exec(text)
  if (labelled && !/^https?:\/\//i.test(labelled[1])) return { label: cleanLabel(labelled[1]), address: labelled[2] }
  return { label: '', address: text }
}
/** Splits a stored Link value into what to show and where it goes. */
export const parseLink = (value: string) => {
  const { label, address } = splitLink(value)
  return { label, href: address }
}
/** A stored Link value as people type and read it: `label address`. */
export const linkToInput = (value: string) => {
  const { label, href } = parseLink(value)
  return label ? `${label} ${href}` : href
}

export type RevealBy = 'editors' | 'admins'
export type ColumnAlign = 'left' | 'center' | 'right'
export const COLUMN_WIDTH = { min: 60, max: 800 }
/** The first column stays in view unless it was explicitly unfrozen; any other column only when it was frozen. */
export const isFrozenColumn = (column: TrackerColumn, all: TrackerColumn[]) => column.frozen ?? all[0]?.id === column.id
export type TrackerColumn = {
  id: string
  name: string
  type: ColumnType
  width?: number
  /** Kept in view while scrolling sideways. Unset means "the first column only". */
  frozen?: boolean
  align?: ColumnAlign
  options?: SelectOption[]
  revealBy?: RevealBy
  /** Calculated columns: the formula, with other columns referenced as {columnId}. */
  formula?: string
  /** Number and Calculated columns: show a SUM in the totals row. */
  total?: 'sum'
  /** Filled from the connected Google Sheet. In one-way sync it is read-only for rows that came from the Sheet. */
  synced?: boolean
  /**
   * Checkbox and Choice columns: fills itself from the tasks linked to the row. Ticked (or set to `done`) when every
   * linked task is completed, unticked (or set to `undone`) when one is reopened. At most one column per tracker.
   */
  autoDone?: AutoDone
}

/** The "done when its tasks are done" setting. Checkbox columns need no values: done is ticked, not done is unticked. */
export type AutoDone = {
  /** Choice columns: the option set when every linked task is completed. */
  done?: string
  /** Choice columns: the option set when a linked task is reopened. Empty means the cell is cleared. */
  undone?: string
}

export const canAutoDone = (column: Pick<TrackerColumn, 'type'>) => column.type === 'checkbox' || column.type === 'select'

/**
 * Cleans the setting for a column, or returns undefined when it does not apply. A Choice column needs a done option
 * that exists; a not-done option that no longer exists is dropped (the cell is cleared instead).
 */
export function normalizeAutoDone(raw: unknown, column: TrackerColumn): AutoDone | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !canAutoDone(column)) return undefined
  if (column.type === 'checkbox') return {}
  const options = new Set((column.options || []).map(option => option.id))
  const input = raw as Record<string, unknown>
  const done = typeof input.done === 'string' && options.has(input.done) ? input.done : ''
  if (!done) return undefined
  const undone =
    typeof input.undone === 'string' && options.has(input.undone) && input.undone !== done ? input.undone : ''
  return undone ? { done, undone } : { done }
}

export type Cell = string | number | boolean | string[] | null

export type FilterOp =
  | 'contains'
  | 'is'
  | 'is_not'
  | 'is_empty'
  | 'not_empty'
  | 'gt'
  | 'lt'
  | 'before'
  | 'after'
  | 'checked'
  | 'unchecked'
export const FILTER_OPS: FilterOp[] = [
  'contains',
  'is',
  'is_not',
  'is_empty',
  'not_empty',
  'gt',
  'lt',
  'before',
  'after',
  'checked',
  'unchecked',
]
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
  /** Rows from a connected Google Sheet: the row's task name and order (sheetRowKeys). Empty otherwise. */
  sourceKey?: string
  /** The row is no longer in the Sheet. It is kept, and flagged, rather than deleted. */
  sourceMissing?: boolean
  /** A new row waiting to be reviewed: made into a task, a subtask, or left as it is. */
  review?: boolean
  /** Its done mark could not be written to the connected Sheet, and why. Cleared by a later success or a dismiss. */
  sheetIssue?: { code: string; message: string; value: Cell; at: string }
}

/** A tracker that follows a Google Sheet. One-way today; two-way is prepared for but not switched on. */
export type SyncMode = 'one_way' | 'two_way'
export type TrackerSource = {
  spreadsheetId: string
  spreadsheetName: string
  tab: string
  keyHeader: string
  /** Sheet header → tracker column id. */
  headerMap: Record<string, string>
  mode: SyncMode
  connectedBy: string
  connectedByName: string
  connectedEmail: string
  lastSyncedAt: string
  lastStatus: 'ok' | 'error' | 'never'
  lastError: string
  lastReport: SyncReport | null
  /** Sent only when a column marks done in the Sheet: whether the person who connected it allowed editing Sheets. */
  canWrite?: boolean
}
export type SyncReport = {
  added: number
  updated: number
  missing: number
  returned: number
  unchanged: number
  skippedNoKey: number
  duplicateKeys: string[]
  capped: number
  missingHeaders: string[]
  newHeaders: string[]
  problems: number
}

export type Tracker = {
  id: string
  name: string
  /** The first of clientIds, kept for older callers. */
  clientId: string
  /** Every client this tracker follows. */
  clientIds: string[]
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
  /** Set when the tracker follows a Google Sheet (loaded with the tracker, not in the list). */
  source?: TrackerSource | null
  /** In the list: whether the tracker follows a Google Sheet. */
  synced?: boolean
}

export class TrackerError extends Error {
  constructor(
    message: string,
    public status = 400,
    public extra?: Record<string, unknown>,
  ) {
    super(message)
  }
}

const ID = /^[a-z0-9_]{3,40}$/i
const DATE = /^\d{4}-\d{2}-\d{2}$/

export function randomId(prefix = '') {
  const bytes = new Uint8Array(6)
  globalThis.crypto.getRandomValues(bytes)
  return (
    prefix +
    Array.from(bytes, byte => byte.toString(36).padStart(2, '0'))
      .join('')
      .slice(0, 10)
  )
}

/** Collapses whitespace and strips control characters from a one-line name. */
export function cleanName(value: unknown, label: string, max: number) {
  const text = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) throw new TrackerError(`Enter a ${label}.`)
  if (text.length > max) throw new TrackerError(`The ${label} can be at most ${max} characters.`)
  return text
}

function normalizeOptions(input: unknown, previous?: SelectOption[]): SelectOption[] {
  if (input === undefined || input === null) return previous ? previous.map(option => ({ ...option })) : []
  if (!Array.isArray(input)) throw new TrackerError('Options must be a list.')
  if (input.length > TRACKER_LIMITS.optionsPerColumn)
    throw new TrackerError(`A column can have at most ${TRACKER_LIMITS.optionsPerColumn} options.`)
  const seenId = new Set<string>(),
    seenLabel = new Set<string>()
  return input.map((raw: any, index) => {
    const label = cleanName(raw?.label, 'option name', TRACKER_LIMITS.optionLabel)
    const key = label.toLowerCase()
    if (seenLabel.has(key)) throw new TrackerError(`Two options are named "${label}".`)
    seenLabel.add(key)
    let id = typeof raw?.id === 'string' && ID.test(raw.id) && !seenId.has(raw.id) ? raw.id : ''
    while (!id || seenId.has(id)) id = randomId('o_')
    seenId.add(id)
    const color: OptionColor = OPTION_COLORS.includes(raw?.color)
      ? raw.color
      : OPTION_COLORS[(index % (OPTION_COLORS.length - 1)) + 1]
    return { id, label, color }
  })
}

/**
 * Checks a column list and fills in what is missing (ids, option colours). A column that already existed keeps its type:
 * changing one could expose or lose values, so a different type means adding a new column.
 */
export function normalizeColumns(input: unknown, previous: TrackerColumn[] = []): TrackerColumn[] {
  if (!Array.isArray(input) || !input.length) throw new TrackerError('A tracker needs at least one column.')
  if (input.length > TRACKER_LIMITS.columns)
    throw new TrackerError(`A tracker can have at most ${TRACKER_LIMITS.columns} columns.`)
  const before = new Map(previous.map(column => [column.id, column]))
  const seenId = new Set<string>(),
    seenName = new Set<string>()
  const columns = input.map((raw: any) => {
    const name = cleanName(raw?.name, 'column name', TRACKER_LIMITS.columnName)
    if (seenName.has(name.toLowerCase())) throw new TrackerError(`Two columns are named "${name}".`)
    seenName.add(name.toLowerCase())
    if (!isColumnType(raw?.type)) throw new TrackerError(`Choose a type for "${name}".`)
    const known = typeof raw?.id === 'string' ? before.get(raw.id) : undefined
    if (known && known.type !== raw.type)
      throw new TrackerError(`"${name}" cannot change type. Add a new column of the type you want and delete this one.`)
    let id = known ? known.id : typeof raw?.id === 'string' && ID.test(raw.id) && !before.has(raw.id) ? raw.id : ''
    if (seenId.has(id)) throw new TrackerError('Two columns share an id.')
    while (!id || seenId.has(id) || (!known && before.has(id))) id = randomId('c_')
    seenId.add(id)
    const column: TrackerColumn = { id, name, type: raw.type }
    if (raw.width !== undefined && raw.width !== null) {
      const width = Number(raw.width)
      if (Number.isFinite(width))
        column.width = Math.max(COLUMN_WIDTH.min, Math.min(COLUMN_WIDTH.max, Math.round(width)))
    }
    if (typeof raw.frozen === 'boolean') column.frozen = raw.frozen
    if (raw.align === 'left' || raw.align === 'center' || raw.align === 'right') column.align = raw.align
    if (raw.type === 'select' || raw.type === 'multiselect')
      column.options = normalizeOptions(raw.options, known?.options)
    if (raw.type === 'secret') column.revealBy = raw.revealBy === 'admins' ? 'admins' : 'editors'
    if (raw.type === 'formula') column.formula = typeof raw.formula === 'string' ? raw.formula.slice(0, 1000) : ''
    if ((raw.type === 'number' || raw.type === 'formula') && raw.total === 'sum') column.total = 'sum'
    if (raw.synced === true && isBasicType(raw.type)) column.synced = true
    const autoDone = normalizeAutoDone(raw.autoDone, column)
    if (autoDone) column.autoDone = autoDone
    return column
  })
  // Only one column fills itself from the linked tasks' completion: the first one that asks to.
  let autoDoneSeen = false
  for (const column of columns)
    if (column.autoDone) {
      if (autoDoneSeen) delete column.autoDone
      autoDoneSeen = true
    }
  // Formulas may name columns as [Name] or {id}; store ids so a rename does not break them, then check them all together.
  for (const column of columns)
    if (column.type === 'formula') {
      const result = formulaFromText(formulaToText(column.formula || '', columns), columns, column.id)
      if (!result.ok) throw new TrackerError(`${column.name}: ${result.error}`)
      column.formula = result.formula
    }
  const cycle = formulaCycle(columns)
  if (cycle) throw new TrackerError(`${cycle} refers back to itself through other Calculated columns.`)
  return columns
}

export const emptyCell = (type: ColumnType): Cell =>
  type === 'number' ? null : type === 'checkbox' ? false : type === 'multiselect' ? [] : ''

export function isEmptyCell(value: Cell | undefined) {
  return (
    value === undefined || value === null || value === '' || value === false || (Array.isArray(value) && !value.length)
  )
}

export function validDate(value: string) {
  if (!DATE.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

const noControls = (text: string, multiline: boolean) =>
  text.replace(
    multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g : /[\u0000-\u001f\u007f]/g,
    multiline ? '' : ' ',
  )

/** Cleans one cell value for a column. Returns the value to store (empty values come back as the type's empty value). */
export function cleanCell(
  column: TrackerColumn,
  raw: unknown,
): { ok: true; value: Cell } | { ok: false; error: string } {
  const bad = (error: string) => ({ ok: false as const, error })
  switch (column.type) {
    case 'text': {
      if (raw === null || raw === undefined) return { ok: true, value: '' }
      const text = noControls(String(raw), false).trim()
      return text.length > TRACKER_LIMITS.text
        ? bad(`${column.name} can hold at most ${TRACKER_LIMITS.text} characters.`)
        : { ok: true, value: text }
    }
    case 'longtext': {
      if (raw === null || raw === undefined) return { ok: true, value: '' }
      const text = noControls(String(raw).replace(/\r\n?/g, '\n'), true).trim()
      return text.length > TRACKER_LIMITS.longText
        ? bad(`${column.name} can hold at most ${TRACKER_LIMITS.longText} characters.`)
        : { ok: true, value: text }
    }
    case 'number': {
      if (raw === null || raw === undefined || raw === '') return { ok: true, value: null }
      const value = typeof raw === 'number' ? raw : Number(String(raw).replace(/[,\s]/g, ''))
      return Number.isFinite(value) && Math.abs(value) <= 1e15
        ? { ok: true, value }
        : bad(`${column.name} needs a number.`)
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
      return column.options?.some(option => option.id === raw)
        ? { ok: true, value: String(raw) }
        : bad(`${column.name} has no such option.`)
    }
    case 'multiselect': {
      if (raw === null || raw === undefined || raw === '') return { ok: true, value: [] }
      if (!Array.isArray(raw)) return bad(`${column.name} needs a list of options.`)
      const unique = [...new Set(raw.map(String))]
      return unique.every(id => column.options?.some(option => option.id === id))
        ? { ok: true, value: unique }
        : bad(`${column.name} has no such option.`)
    }
    case 'person': {
      if (raw === null || raw === undefined || raw === '') return { ok: true, value: '' }
      const id = String(raw).trim()
      return id.length <= 100 && !/[\u0000-\u001f]/.test(id)
        ? { ok: true, value: id }
        : bad(`${column.name} needs a teammate.`)
    }
    case 'link': {
      if (raw === null || raw === undefined || raw === '') return { ok: true, value: '' }
      const text = String(raw).trim()
      if (text.length > TRACKER_LIMITS.link) return bad(`${column.name} is too long.`)
      const { label, address } = splitLink(text)
      try {
        // Keep the address as typed; only add https:// when no scheme was given.
        const href = /^[a-z][a-z0-9+.-]*:/i.test(address) ? address : `https://${address}`
        const url = new URL(href)
        if (!['http:', 'https:'].includes(url.protocol) || !url.hostname.includes('.')) throw new Error()
        return { ok: true, value: label ? `[${label}](${href})` : href }
      } catch {
        return bad(`${column.name} needs a web address, optionally after a short label such as "#1234 https://…".`)
      }
    }
    case 'secret':
      return bad(`${column.name} is a Secret column. Its value is set separately.`)
    case 'formula':
      return bad(`${column.name} is Calculated from other columns.`)
    default:
      return bad(`${column.name} fills itself from the linked task.`)
  }
}

export function cleanSecret(
  column: TrackerColumn,
  raw: unknown,
): { ok: true; value: string } | { ok: false; error: string } {
  if (column.type !== 'secret') return { ok: false, error: `${column.name} is not a Secret column.` }
  if (typeof raw !== 'string') return { ok: false, error: `${column.name} needs text.` }
  const text = raw.replace(/[\u0000-\u001f\u007f]/g, '')
  if (text.length > TRACKER_LIMITS.secret)
    return { ok: false, error: `${column.name} can hold at most ${TRACKER_LIMITS.secret} characters.` }
  return { ok: true, value: text }
}

const newView = (): TrackerView => ({ id: '', name: '', filters: [], sort: null, groupBy: '', hidden: [] })

/** Cleans saved views. References to columns that no longer exist are dropped rather than rejected. */
export function normalizeViews(input: unknown, columns: TrackerColumn[]): TrackerView[] {
  if (input === undefined || input === null) return []
  if (!Array.isArray(input)) throw new TrackerError('Views must be a list.')
  if (input.length > TRACKER_LIMITS.views)
    throw new TrackerError(`A tracker can have at most ${TRACKER_LIMITS.views} saved views.`)
  const known = new Set(columns.map(column => column.id))
  const seenId = new Set<string>(),
    seenName = new Set<string>()
  return input.map((raw: any) => {
    const view = newView()
    view.name = cleanName(raw?.name, 'view name', TRACKER_LIMITS.viewName)
    if (seenName.has(view.name.toLowerCase())) throw new TrackerError(`Two views are named "${view.name}".`)
    seenName.add(view.name.toLowerCase())
    let id = typeof raw?.id === 'string' && ID.test(raw.id) && !seenId.has(raw.id) ? raw.id : ''
    while (!id || seenId.has(id)) id = randomId('v_')
    seenId.add(id)
    view.id = id
    const filters = Array.isArray(raw?.filters) ? raw.filters : []
    view.filters = filters
      .filter((filter: any) => known.has(filter?.columnId) && FILTER_OPS.includes(filter?.op))
      .slice(0, TRACKER_LIMITS.filtersPerView)
      .map((filter: any) => ({
        columnId: String(filter.columnId),
        op: filter.op as FilterOp,
        value: String(filter.value ?? '').slice(0, 200),
      }))
    view.sort =
      raw?.sort && known.has(raw.sort.columnId)
        ? { columnId: String(raw.sort.columnId), dir: raw.sort.dir === 'desc' ? 'desc' : 'asc' }
        : null
    view.groupBy = known.has(raw?.groupBy) ? String(raw.groupBy) : ''
    view.hidden = Array.isArray(raw?.hidden)
      ? [...new Set<string>(raw.hidden.map(String).filter((columnId: string) => known.has(columnId)))]
      : []
    return view
  })
}

export function filterOpsFor(type: ColumnType): FilterOp[] {
  switch (type) {
    case 'number':
    case 'formula':
      return ['is', 'gt', 'lt', 'is_empty', 'not_empty']
    case 'date':
    case 'task_due':
      return ['is', 'before', 'after', 'is_empty', 'not_empty']
    case 'checkbox':
      return ['checked', 'unchecked']
    case 'select':
    case 'person':
      return ['is', 'is_not', 'is_empty', 'not_empty']
    case 'multiselect':
      return ['contains', 'is_empty', 'not_empty']
    case 'secret':
      return ['is_empty', 'not_empty']
    default:
      return ['contains', 'is', 'is_not', 'is_empty', 'not_empty']
  }
}

export const filterOpLabel: Record<FilterOp, string> = {
  contains: 'contains',
  is: 'is',
  is_not: 'is not',
  is_empty: 'is empty',
  not_empty: 'is not empty',
  gt: 'is greater than',
  lt: 'is less than',
  before: 'is before',
  after: 'is after',
  checked: 'is checked',
  unchecked: 'is not checked',
}
export const filterNeedsValue = (op: FilterOp) => !['is_empty', 'not_empty', 'checked', 'unchecked'].includes(op)

// ---- changing a column's type ----

/** Types a column can be changed between. Connected, Secret, Person, Checkbox and Multi-select columns keep their type. */
export const CONVERTIBLE_TYPES: ColumnType[] = ['text', 'longtext', 'number', 'date', 'link', 'select']
export const canConvertType = (type: string) => (CONVERTIBLE_TYPES as string[]).includes(type)

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
/** A date as typed in a sheet: 2026-02-28, "Feb 28, 2026" or "28 February 2026". Numeric forms such as 03/04/2026 are ambiguous and are not guessed. */
export function looseDate(text: string): string | null {
  const value = text.trim()
  if (validDate(value)) return value
  const named = /^(?:[A-Za-z]+,?\s+)?([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(value) || null
  const swapped = /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/.exec(value) || null
  const [month, day, year] = named
    ? [named[1], named[2], named[3]]
    : swapped
      ? [swapped[2], swapped[1], swapped[3]]
      : []
  if (!month) return null
  const at = MONTH_NAMES.indexOf(month.slice(0, 3).toLowerCase())
  if (at < 0) return null
  const iso = `${year}-${String(at + 1).padStart(2, '0')}-${String(Number(day)).padStart(2, '0')}`
  return validDate(iso) ? iso : null
}

function cellAsText(column: TrackerColumn, value: Cell | undefined): string {
  if (value === undefined || value === null || value === false) return ''
  if (column.type === 'select') return column.options?.find(option => option.id === value)?.label || ''
  if (column.type === 'link') return typeof value === 'string' ? linkToInput(value) : ''
  return typeof value === 'string' ? value : String(value)
}

export type ConversionPlan = {
  options?: SelectOption[]
  cells: { value: Cell; ok: boolean; before: string }[]
  failed: number
}

/**
 * Works out what every value in a column becomes when it changes type. A value that does not fit comes back with `ok: false`
 * and the empty value, so the caller can show how many would be cleared before anything is changed.
 */
export function planConversion(
  column: TrackerColumn,
  toType: ColumnType,
  values: (Cell | undefined)[],
): ConversionPlan {
  if (!canConvertType(column.type) || !canConvertType(toType) || column.type === toType)
    throw new TrackerError('This column cannot be changed to that type.')
  const texts = values.map(value => cellAsText(column, value).trim())
  let options: SelectOption[] | undefined
  let optionByKey: Map<string, string> | undefined
  if (toType === 'select') {
    const labels = new Map<string, string>()
    for (const text of texts)
      if (text && text.length <= TRACKER_LIMITS.optionLabel && !labels.has(text.toLowerCase()))
        labels.set(text.toLowerCase(), text)
    if (labels.size > TRACKER_LIMITS.optionsPerColumn)
      throw new TrackerError(
        `This column has ${labels.size} different values, and a Select column holds at most ${TRACKER_LIMITS.optionsPerColumn} choices. Keep it as text, or tidy the values first.`,
      )
    options = normalizeOptions([...labels.values()].map(label => ({ label })))
    optionByKey = new Map(options.map(option => [option.label.toLowerCase(), option.id]))
  }
  const target: TrackerColumn = { id: column.id, name: column.name, type: toType }
  let failed = 0
  const cells = texts.map(text => {
    const empty = emptyCell(toType)
    if (!text) return { value: empty, ok: true, before: '' }
    let result: { ok: true; value: Cell } | { ok: false }
    if (toType === 'select') {
      const id = optionByKey!.get(text.toLowerCase())
      result = id ? { ok: true, value: id } : { ok: false }
    } else if (toType === 'date') {
      const iso = looseDate(text)
      result = iso ? { ok: true, value: iso } : { ok: false }
    } else {
      const cleaned = cleanCell(target, text)
      result = cleaned.ok ? { ok: true, value: cleaned.value } : { ok: false }
    }
    if (result.ok) return { value: result.value, ok: true, before: text }
    failed++
    return { value: empty, ok: false, before: text }
  })
  return { options, cells, failed }
}

// ---------------------------------------------------------------------------------------------
// Calculated columns. A formula is plain arithmetic over other Number or Calculated columns of the same row:
// numbers, + - * /, parentheses, and column references. People type references as [Column name]; they are
// stored as {columnId}. Nothing is executed: the formula is parsed by the small reader below.
export const FORMULA_SOURCES: ColumnType[] = ['number', 'formula']
const REF_ID = /\{([A-Za-z0-9_-]{1,60})\}/g

/** A stored formula as people read it: {id} becomes [Name]. */
export function formulaToText(formula: string, columns: TrackerColumn[]) {
  return formula.replace(REF_ID, (_, id: string) => {
    const column = columns.find(item => item.id === id)
    return column ? `[${column.name}]` : '[?]'
  })
}

type Token = { kind: 'num'; value: number } | { kind: 'ref'; id: string } | { kind: 'op'; value: string }
function tokenize(formula: string): Token[] | string {
  const tokens: Token[] = []
  let at = 0
  const text = formula.trim().replace(/^=/, '')
  while (at < text.length) {
    const ch = text[at]
    if (/\s/.test(ch)) {
      at += 1
      continue
    }
    if ('+-*/()'.includes(ch)) {
      tokens.push({ kind: 'op', value: ch })
      at += 1
      continue
    }
    if (ch === '{') {
      const end = text.indexOf('}', at)
      if (end < 0) return 'A column reference is not closed.'
      tokens.push({ kind: 'ref', id: text.slice(at + 1, end) })
      at = end + 1
      continue
    }
    const number = /^(\d+(\.\d+)?|\.\d+)/.exec(text.slice(at))
    if (number) {
      tokens.push({ kind: 'num', value: Number(number[0]) })
      at += number[0].length
      continue
    }
    return `“${ch}” is not allowed. Use numbers, [Column names], + - * / and brackets.`
  }
  return tokens
}

type Node =
  | { kind: 'num'; value: number }
  | { kind: 'ref'; id: string }
  | { kind: 'neg'; of: Node }
  | { kind: 'bin'; op: string; left: Node; right: Node }
function parse(tokens: Token[]): Node | string {
  let at = 0
  const peek = () => tokens[at]
  const isOp = (value: string) => {
    const token = peek()
    return token?.kind === 'op' && token.value === value
  }
  function primary(): Node | string {
    const token = peek()
    if (!token) return 'The formula ends too early.'
    if (token.kind === 'num') {
      at += 1
      return { kind: 'num', value: token.value }
    }
    if (token.kind === 'ref') {
      at += 1
      return { kind: 'ref', id: token.id }
    }
    if (token.value === '-') {
      at += 1
      const inner = primary()
      return typeof inner === 'string' ? inner : { kind: 'neg', of: inner }
    }
    if (token.value === '(') {
      at += 1
      const inner = sum()
      if (typeof inner === 'string') return inner
      if (!isOp(')')) return 'A bracket is not closed.'
      at += 1
      return inner
    }
    return `“${token.value}” is in the wrong place.`
  }
  function product(): Node | string {
    let left = primary()
    if (typeof left === 'string') return left
    while (isOp('*') || isOp('/')) {
      const op = (peek() as any).value
      at += 1
      const right = primary()
      if (typeof right === 'string') return right
      left = { kind: 'bin', op, left, right }
    }
    return left
  }
  function sum(): Node | string {
    let left = product()
    if (typeof left === 'string') return left
    while (isOp('+') || isOp('-')) {
      const op = (peek() as any).value
      at += 1
      const right = product()
      if (typeof right === 'string') return right
      left = { kind: 'bin', op, left, right }
    }
    return left
  }
  if (!tokens.length) return 'Enter a formula, like [Qty] * [Price].'
  const tree = sum()
  if (typeof tree === 'string') return tree
  if (at < tokens.length) return 'Something after the formula was not understood. Check for a missing + - * or /.'
  return tree
}

const refsOf = (formula: string) => [...formula.matchAll(REF_ID)].map(match => match[1])

/** Turns what someone typed into a stored formula, checking every reference. */
export function formulaFromText(
  text: string,
  columns: TrackerColumn[],
  selfId: string,
): { ok: true; formula: string } | { ok: false; error: string } {
  if (text.length > 1000) return { ok: false, error: 'The formula is too long.' }
  let error = ''
  const stored = text
    .trim()
    .replace(/^=/, '')
    .replace(/\[([^\]]*)\]/g, (_, name: string) => {
      const column = columns.find(item => item.name.toLowerCase() === name.trim().toLowerCase())
      if (!column) {
        error ||=
          name.trim() === '?'
            ? 'A column used in the formula was deleted.'
            : `There is no column named “${name.trim()}”.`
        return '{x}'
      }
      if (column.id === selfId) {
        error ||= 'A Calculated column cannot use itself.'
        return '{x}'
      }
      if (!FORMULA_SOURCES.includes(column.type)) {
        error ||= `“${column.name}” is not a Number or Calculated column.`
        return '{x}'
      }
      return `{${column.id}}`
    })
  if (error) return { ok: false, error }
  const tokens = tokenize(stored)
  if (typeof tokens === 'string') return { ok: false, error: tokens }
  const tree = parse(tokens)
  if (typeof tree === 'string') return { ok: false, error: tree }
  return { ok: true, formula: stored.replace(/\s+/g, ' ').trim() }
}

/** The name of a Calculated column that refers back to itself, if any. */
export function formulaCycle(columns: TrackerColumn[]): string {
  const byId = new Map(columns.map(column => [column.id, column]))
  const state = new Map<string, 1 | 2>()
  const visit = (id: string): boolean => {
    if (state.get(id) === 2) return false
    if (state.get(id) === 1) return true
    state.set(id, 1)
    const column = byId.get(id)
    const found =
      column?.type === 'formula' &&
      refsOf(column.formula || '').some(ref => byId.get(ref)?.type === 'formula' && visit(ref))
    state.set(id, 2)
    return Boolean(found)
  }
  return columns.find(column => column.type === 'formula' && visit(column.id))?.name || ''
}

export type FormulaResult = { value: number | null; error?: string }
/** Works out a Calculated cell. Empty inputs count as 0 only when at least one input has a value; all empty gives an empty cell. */
export function evaluateFormula(
  column: TrackerColumn,
  cells: Record<string, Cell>,
  columns: TrackerColumn[],
  depth = 0,
): FormulaResult {
  if (depth > 20) return { value: null, error: 'Too deep' }
  const tokens = tokenize(column.formula || '')
  if (typeof tokens === 'string') return { value: null, error: 'Formula error' }
  const tree = parse(tokens)
  if (typeof tree === 'string') return { value: null, error: 'Formula error' }
  let seen = false,
    failed = ''
  const byId = new Map(columns.map(item => [item.id, item]))
  const read = (id: string): number => {
    const source = byId.get(id)
    if (!source) {
      failed = 'Missing column'
      return 0
    }
    if (source.type === 'formula') {
      const inner = evaluateFormula(source, cells, columns, depth + 1)
      if (inner.error) failed = inner.error
      if (inner.value !== null) seen = true
      return inner.value ?? 0
    }
    const value = cells[id]
    if (typeof value === 'number' && Number.isFinite(value)) {
      seen = true
      return value
    }
    return 0
  }
  const run = (node: Node): number => {
    switch (node.kind) {
      case 'num':
        return node.value
      case 'ref':
        return read(node.id)
      case 'neg':
        return -run(node.of)
      case 'bin': {
        const left = run(node.left),
          right = run(node.right)
        if (node.op === '+') return left + right
        if (node.op === '-') return left - right
        if (node.op === '*') return left * right
        if (right === 0) {
          failed ||= 'Divide by 0'
          return 0
        }
        return left / right
      }
    }
  }
  const value = run(tree)
  if (failed) return { value: null, error: failed }
  if (!seen && refsOf(column.formula || '').length) return { value: null }
  return {
    value: Number.isFinite(value) ? Math.round(value * 1e10) / 1e10 : null,
    error: Number.isFinite(value) ? undefined : 'Too large',
  }
}

/** SUM for the totals row: Number cells as stored, Calculated cells as worked out. */
export function columnTotal(
  column: TrackerColumn,
  rows: { cells: Record<string, Cell> }[],
  columns: TrackerColumn[],
): number | null {
  let total = 0,
    any = false
  for (const row of rows) {
    const value = column.type === 'formula' ? evaluateFormula(column, row.cells, columns).value : row.cells[column.id]
    if (typeof value === 'number' && Number.isFinite(value)) {
      total += value
      any = true
    }
  }
  return any ? Math.round(total * 1e10) / 1e10 : null
}

/** Trackers keep their clients in one text field as comma-separated ids. */
export const TRACKER_CLIENTS = 20
export const splitClientIds = (value: unknown) => [
  ...new Set(
    String(value ?? '')
      .split(',')
      .map(id => id.trim())
      .filter(Boolean),
  ),
]
