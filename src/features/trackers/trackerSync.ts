/**
 * One-way sync from a Google Sheet into a tracker. Pure functions, used by the server on every sync and by tests.
 * Every non-empty Sheet row comes in. The task name column groups them: a row with a name starts a task (names may
 * repeat), and a row with a blank name belongs to the task above it. Rows are recognised again by name and order (the
 * 2nd "EGG" row, the 1st row under it), never by position, so sorting or inserting other rows in the Sheet is safe.
 * The values as they were at the last sync are kept per row (`values`), which is what a later two-way sync needs to
 * tell a Sheet change from a tracker change.
 */
import {
  OPTION_COLORS,
  TRACKER_LIMITS,
  emptyCell,
  isEmptyCell,
  randomId,
  type Cell,
  type SelectOption,
  type SyncReport,
  type TrackerColumn,
} from './trackerModel'
import { planImport, type Mapping, type Person } from './trackerImport'

/** The spreadsheet id from a link (or an id pasted on its own). */
export function sheetIdFrom(input: string): string {
  const text = String(input || '').trim()
  const link = /\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,120})/.exec(text)
  if (link) return link[1]
  return /^[a-zA-Z0-9_-]{20,120}$/.test(text) ? text : ''
}

/** A Sheets A1 range for a whole tab: the name in single quotes, with quotes doubled. */
export const tabRange = (tab: string) => `'${tab.replace(/'/g, "''")}'`

/** Separates a repeated name from its number: the 2nd "EGG" row is `EGG␟2`. */
const REPEAT = '\u001f'
/** Separates a task's key from the number of a row under it: the 1st row under "EGG" is `EGG␞1`. */
const UNDER = '\u001e'

/**
 * Keys for the rows of a Sheet tab, from the task name column, in Sheet order.
 * A row with a name gets the name, then `name␟2`, `name␟3` when it repeats (ignoring case).
 * A row with a blank name gets the key of the named row above it, then `␞1`, `␞2` and so on.
 * Rows above the first name get `␞1`, `␞2` with no task key in front.
 */
export function sheetRowKeys(names: string[]): string[] {
  const used = new Set<string>(),
    repeats = new Map<string, number>()
  let task = '',
    under = 0
  return names.map(raw => {
    const name = String(raw ?? '').trim()
    if (!name) {
      under += 1
      return `${task}${UNDER}${under}`
    }
    let count = (repeats.get(name.toLowerCase()) || 0) + 1
    let key = count === 1 ? name : `${name}${REPEAT}${count}`
    while (used.has(key.toLowerCase())) {
      count += 1
      key = `${name}${REPEAT}${count}`
    }
    repeats.set(name.toLowerCase(), count)
    used.add(key.toLowerCase())
    task = key
    under = 0
    return key
  })
}

/**
 * The key of the task a Sheet row belongs to: `null` for a row that is a task itself, `''` for a row above the first
 * name (no task above it), or the named row's key.
 */
export function parentKeyOf(key: string): string | null {
  const at = key.lastIndexOf(UNDER)
  return at < 0 ? null : key.slice(0, at)
}

/** Headers as people see them, cleaned for matching. */
const headerKey = (value: string) => value.replace(/\s+/g, ' ').trim().toLowerCase()

export type SyncRow = {
  id: string
  sourceKey: string
  data: Record<string, Cell>
  values: Record<string, string>
  missing: boolean
}
export type SyncPlan = {
  /** Columns with any Select options the Sheet added. */
  columns: TrackerColumn[]
  columnsChanged: boolean
  inserts: { key: string; cells: Record<string, Cell>; values: Record<string, string> }[]
  updates: { id: string; cells: Record<string, Cell>; values: Record<string, string> }[]
  /** Rows that left the Sheet, and rows that came back. */
  missing: string[]
  returned: string[]
  report: SyncReport
}

/**
 * Works out what a sync changes. `grid` is the tab's values with the header row first.
 * Only columns in `headerMap` are written; every other column, and tasks and links, are left alone.
 */
export function planSync(input: {
  grid: string[][]
  keyHeader: string
  headerMap: Record<string, string>
  columns: TrackerColumn[]
  rows: SyncRow[]
  people: Person[]
  today: string
  capacity: number
}): SyncPlan | { error: string } {
  const [rawHeaders = [], ...body] = input.grid
  const headers = rawHeaders.map(value => String(value ?? '').trim())
  if (!headers.some(Boolean)) return { error: 'The Sheet tab is empty, or its first row has no column names.' }
  const indexOf = new Map<string, number>()
  headers.forEach((header, index) => {
    if (header && !indexOf.has(headerKey(header))) indexOf.set(headerKey(header), index)
  })
  const keyIndex = indexOf.get(headerKey(input.keyHeader))
  if (keyIndex === undefined)
    return {
      error: `The key column “${input.keyHeader}” is no longer in the Sheet. Reconnect and choose the key column again.`,
    }

  const byId = new Map(input.columns.map(column => [column.id, column]))
  const mappings: Mapping[] = [],
    used: { header: string; index: number; column: TrackerColumn }[] = []
  const missingHeaders: string[] = []
  for (const [header, columnId] of Object.entries(input.headerMap)) {
    const index = indexOf.get(headerKey(header)),
      column = byId.get(columnId)
    if (index === undefined) {
      missingHeaders.push(header)
      continue
    }
    if (!column) continue
    mappings.push({ index, include: true, target: column.id, name: column.name, type: column.type, options: [] })
    used.push({ header, index, column })
  }
  const mappedKeys = new Set(Object.keys(input.headerMap).map(headerKey))
  const newHeaders = headers.filter(header => header && !mappedKeys.has(headerKey(header)))

  // Rows: every non-empty row comes in, keyed by its task name and order (see sheetRowKeys).
  const lines = body
    .map(line => headers.map((_, index) => String(line[index] ?? '')))
    .filter(values => values.some(value => value.trim()))
  const keys = sheetRowKeys(lines.map(values => values[keyIndex]))
  const kept = lines.map((values, at) => ({ key: keys[at], values }))
  const skippedNoKey = 0,
    duplicates: string[] = []

  // Values are converted exactly as a manual import would convert them (dates, numbers, Select options, people).
  const plan = mappings.length
    ? planImport({ headers, rows: kept.map(row => row.values) }, mappings, input.columns, {
        today: input.today,
        people: input.people,
        capacity: Number.MAX_SAFE_INTEGER,
        firstRowIsHeader: true,
      })
    : null
  if (plan?.fatal) return { error: plan.fatal }
  const columns = plan ? plan.columns : input.columns
  const snapshot = (values: string[]) => Object.fromEntries(used.map(item => [item.header, values[item.index] ?? '']))

  const existing = new Map(input.rows.filter(row => row.sourceKey).map(row => [row.sourceKey.toLowerCase(), row]))
  const report: SyncReport = {
    added: 0,
    updated: 0,
    missing: 0,
    returned: 0,
    unchanged: 0,
    skippedNoKey,
    duplicateKeys: duplicates,
    capped: 0,
    missingHeaders,
    newHeaders,
    problems: plan?.problems.length || 0,
  }
  const result: SyncPlan = {
    columns,
    columnsChanged: JSON.stringify(columns) !== JSON.stringify(input.columns),
    inserts: [],
    updates: [],
    missing: [],
    returned: [],
    report,
  }
  let room = input.capacity
  kept.forEach((row, at) => {
    const converted = plan?.rows[at]?.cells || {}
    const cells: Record<string, Cell> = {}
    for (const item of used) {
      const value = converted[item.column.id]
      cells[item.column.id] = value === undefined ? emptyCell(item.column.type) : value
    }
    const values = snapshot(row.values)
    const current = existing.get(row.key.toLowerCase())
    if (!current) {
      if (room <= 0) {
        report.capped += 1
        return
      }
      room -= 1
      result.inserts.push({
        key: row.key,
        cells: Object.fromEntries(Object.entries(cells).filter(([, value]) => !isEmptyCell(value))),
        values,
      })
      report.added += 1
      return
    }
    existing.delete(row.key.toLowerCase())
    if (current.missing) {
      result.returned.push(current.id)
      report.returned += 1
    }
    const changed: Record<string, Cell> = {}
    for (const [id, value] of Object.entries(cells)) {
      const before = current.data[id]
      if (JSON.stringify(isEmptyCell(before) ? null : before) !== JSON.stringify(isEmptyCell(value) ? null : value))
        changed[id] = value
    }
    if (Object.keys(changed).length || JSON.stringify(values) !== JSON.stringify(current.values)) {
      result.updates.push({ id: current.id, cells: changed, values })
      if (Object.keys(changed).length) report.updated += 1
      else report.unchanged += 1
    } else report.unchanged += 1
  })
  for (const row of existing.values())
    if (!row.missing) {
      result.missing.push(row.id)
      report.missing += 1
    }
  return result
}

/** A short sentence for the sync bar and the history. */
export function describeSync(report: SyncReport) {
  const parts: string[] = []
  if (report.added) parts.push(`${report.added} new row${report.added === 1 ? '' : 's'}`)
  if (report.updated) parts.push(`${report.updated} updated`)
  if (report.missing) parts.push(`${report.missing} no longer in the Sheet`)
  if (report.returned) parts.push(`${report.returned} back in the Sheet`)
  if (!parts.length) parts.push('No changes')
  return parts.join(' · ')
}

export const SYNC_LIMITS = { rows: TRACKER_LIMITS.rows, columns: 200, minSeconds: 60, autoMinutes: 5 } as const

/** What one Sheet column would do as the task name column. */
export type NameColumnCheck = {
  header: string
  /** Rows with a name: each starts a task. */
  tasks: number
  /** Rows with a blank name under a named row: each belongs to the task above. */
  under: number
  /** Rows with a blank name above the first name: no task above them. */
  beforeFirst: number
  /** Names used on more than one row (each such row is still its own task). */
  repeated: number
}

/** Checks each column of a Sheet tab as the task name column. `rows` are the data rows, without the header row. */
export function checkNameColumns(headers: string[], rows: string[][]): NameColumnCheck[] {
  const filled = rows.filter(row => row.some(cell => String(cell ?? '').trim()))
  return headers.map((header, index) => {
    const seen = new Set<string>()
    let tasks = 0,
      under = 0,
      beforeFirst = 0,
      repeated = 0
    for (const row of filled) {
      const name = String(row[index] ?? '').trim()
      if (!name) {
        if (tasks) under += 1
        else beforeFirst += 1
        continue
      }
      tasks += 1
      if (seen.has(name.toLowerCase())) repeated += 1
      seen.add(name.toLowerCase())
    }
    return { header, tasks, under, beforeFirst, repeated }
  })
}

/**
 * The choices of a Sheets dropdown, from a cell's data validation rule: a list typed into the rule, or the range it
 * reads its choices from (to be read separately). Anything else (a checkbox, a number rule…) is not a dropdown.
 */
export function dropdownOf(validation: any): { list: string[] } | { range: string } | null {
  const condition = validation?.condition
  const values: any[] = Array.isArray(condition?.values) ? condition.values : []
  if (condition?.type === 'ONE_OF_LIST')
    return { list: values.map(value => String(value?.userEnteredValue ?? '').trim()).filter(Boolean) }
  if (condition?.type === 'ONE_OF_RANGE') {
    const range = String(values[0]?.userEnteredValue ?? '')
      .replace(/^=/, '')
      .replace(/\$/g, '')
      .trim()
    return range ? { range } : null
  }
  return null
}

/** Column types that turn into a Choice column when the Sheet column they follow has a dropdown. */
export const DROPDOWN_CONVERTIBLE = ['text', 'longtext'] as const

/**
 * Adds the choices of the Sheet's dropdowns to the Choice columns they fill, so options that no row uses yet (such as
 * "Pending") are there too. The Sheet's order comes first; options only the tracker has stay, after them. Existing
 * options keep their id and colour. `lists` is Sheet header → its dropdown's choices.
 * A Text column that follows a Sheet dropdown becomes a Choice column (its ids are listed in `converted`), so the
 * tracker gets the same dropdown; `convertRowsToChoice` moves the values already in it over to the new options.
 */
export function mergeDropdownOptions(
  columns: TrackerColumn[],
  headerMap: Record<string, string>,
  lists: Record<string, string[]>,
): { columns: TrackerColumn[]; changed: boolean; converted: string[] } {
  const byColumn = new Map<string, string[]>()
  for (const [header, columnId] of Object.entries(headerMap))
    if (lists[header]?.length) byColumn.set(columnId, [...(byColumn.get(columnId) || []), ...lists[header]])
  let changed = false
  const converted: string[] = []
  const next = columns.map(column => {
    const list = byColumn.get(column.id)
    if (!list) return column
    const toChoice = (DROPDOWN_CONVERTIBLE as readonly string[]).includes(column.type)
    if (!toChoice && column.type !== 'select' && column.type !== 'multiselect') return column
    const existing = toChoice ? [] : column.options || []
    const used = new Set<string>()
    const options: SelectOption[] = []
    for (const raw of list) {
      const label = raw.replace(/\s+/g, ' ').trim().slice(0, TRACKER_LIMITS.optionLabel)
      if (!label || used.has(label.toLowerCase())) continue
      used.add(label.toLowerCase())
      options.push(
        existing.find(option => option.label.toLowerCase() === label.toLowerCase()) || {
          id: randomId('o_'),
          label,
          color: OPTION_COLORS[((existing.length + options.length) % (OPTION_COLORS.length - 1)) + 1],
        },
      )
    }
    for (const option of existing) if (!used.has(option.label.toLowerCase())) options.push(option)
    const kept = options.slice(0, TRACKER_LIMITS.optionsPerColumn)
    if (toChoice) {
      if (!kept.length) return column
      changed = true
      converted.push(column.id)
      return { ...column, type: 'select', options: kept } as TrackerColumn
    }
    if (JSON.stringify(kept) === JSON.stringify(existing)) return column
    changed = true
    return { ...column, options: kept }
  })
  return { columns: next, changed, converted }
}

/**
 * The values of columns that just became Choice columns, as option ids. A value matches an option by its label
 * (ignoring case); a value the dropdown does not list becomes a new option, so nothing typed before is lost.
 * Returns the columns (with any added options) and, per row id, the cells that changed.
 */
export function convertRowsToChoice(
  columns: TrackerColumn[],
  converted: string[],
  rows: { id: string; data: Record<string, Cell> }[],
): { columns: TrackerColumn[]; changes: Map<string, Record<string, Cell>> } {
  const changes = new Map<string, Record<string, Cell>>()
  if (!converted.length) return { columns, changes }
  const next = columns.map(column =>
    converted.includes(column.id) ? { ...column, options: [...(column.options || [])] } : column,
  )
  for (const column of next) {
    if (!converted.includes(column.id)) continue
    const options = column.options!
    for (const row of rows) {
      const raw = row.data?.[column.id]
      if (typeof raw !== 'string') continue
      if (options.some(option => option.id === raw)) continue
      const label = raw.replace(/\s+/g, ' ').trim().slice(0, TRACKER_LIMITS.optionLabel)
      let option = label ? options.find(item => item.label.toLowerCase() === label.toLowerCase()) : undefined
      if (label && !option && options.length < TRACKER_LIMITS.optionsPerColumn) {
        option = { id: randomId('o_'), label, color: OPTION_COLORS[(options.length % (OPTION_COLORS.length - 1)) + 1] }
        options.push(option)
      }
      changes.set(row.id, { ...(changes.get(row.id) || {}), [column.id]: option ? option.id : '' })
    }
  }
  return { columns: next, changes }
}
