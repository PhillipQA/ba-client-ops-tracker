/**
 * One-way sync from a Google Sheet into a tracker. Pure functions, used by the server on every sync and by tests.
 * Rows are matched by the Sheet's key column, never by position, so sorting or inserting rows in the Sheet is safe.
 * The values as they were at the last sync are kept per row (`values`), which is what a later two-way sync needs to
 * tell a Sheet change from a tracker change.
 */
import { TRACKER_LIMITS, emptyCell, isEmptyCell, type Cell, type SyncReport, type TrackerColumn } from './trackerModel'
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

  // Rows: the first row with a key wins; blank keys and repeats are skipped and reported.
  const seen = new Set<string>(),
    duplicates: string[] = [],
    kept: { key: string; values: string[] }[] = []
  let skippedNoKey = 0
  for (const line of body) {
    const values = headers.map((_, index) => String(line[index] ?? ''))
    if (!values.some(value => value.trim())) continue
    const key = values[keyIndex].trim()
    if (!key) {
      skippedNoKey += 1
      continue
    }
    if (seen.has(key.toLowerCase())) {
      if (duplicates.length < 20) duplicates.push(key)
      continue
    }
    seen.add(key.toLowerCase())
    kept.push({ key, values })
  }

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

/** How well one Sheet column would work as the key column, using the same rules as the sync. */
export type KeyColumnCheck = {
  header: string
  /** Rows that would come into the tracker with this key. */
  kept: number
  /** Rows with nothing in this column: skipped. */
  blank: number
  /** Rows whose value an earlier row already has: skipped. */
  repeated: number
  /** A few of the repeated values, to show. */
  examples: string[]
  /** Every row has its own value. */
  unique: boolean
}

/** Checks each column of a Sheet tab as a possible key. `rows` are the data rows, without the header row. */
export function checkKeyColumns(headers: string[], rows: string[][]): KeyColumnCheck[] {
  const filled = rows.filter(row => row.some(cell => String(cell ?? '').trim()))
  return headers.map((header, index) => {
    const seen = new Set<string>(),
      examples = new Set<string>()
    let blank = 0,
      repeated = 0
    for (const row of filled) {
      const key = String(row[index] ?? '').trim()
      if (!key) {
        blank += 1
        continue
      }
      if (seen.has(key.toLowerCase())) {
        repeated += 1
        if (examples.size < 3) examples.add(key)
        continue
      }
      seen.add(key.toLowerCase())
    }
    return {
      header,
      kept: seen.size,
      blank,
      repeated,
      examples: [...examples],
      unique: filled.length > 0 && blank === 0 && repeated === 0,
    }
  })
}

/** The key to suggest: the first column unique on every row, or else the one that keeps the most rows. */
export function suggestedKeyColumn(checks: KeyColumnCheck[]): string {
  const unique = checks.find(check => check.unique)
  if (unique) return unique.header
  let best: KeyColumnCheck | null = null
  for (const check of checks) if (!best || check.kept > best.kept) best = check
  return best?.header ?? ''
}
