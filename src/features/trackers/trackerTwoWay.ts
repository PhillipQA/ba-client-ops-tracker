/**
 * Two-way sync: tracker edits written back to the connected Google Sheet. Pure functions, shared by the server and the
 * tests. The Sheet stays the place rows are recognised by (task name and order, see sheetRowKeys); the tracker writes
 * single cells, and adds rows at the bottom of the tab when they get a task name.
 */
import { isEmptyCell, linkToInput, type Cell, type TrackerColumn } from './trackerModel'
import { sheetRowKeys } from './trackerSync'
import { sheetTextFor } from './trackerAutoDone'

export type Person = { id: string; name: string }

/**
 * How Google should read a value: RAW keeps text exactly as written (a label like "=5" or "00123" stays text);
 * USER_ENTERED lets numbers, dates and TRUE/FALSE become real numbers, dates and checkboxes in the Sheet.
 */
export type InputOption = 'RAW' | 'USER_ENTERED'

/** The Sheet text for a tracker value, and how Google should read it. `previous` is the cell's text now (for style). */
export function sheetTextOf(
  column: TrackerColumn,
  value: Cell | undefined,
  people: Person[],
  previous = '',
): { text: string; input: InputOption } {
  // An unticked checkbox goes as USER_ENTERED too: written RAW, FALSE became the word "FALSE" in the cell instead of
  // an empty checkbox.
  if (value === undefined || isEmptyCell(value as Cell))
    return column.type === 'checkbox'
      ? { text: sheetTextFor(column, false, previous), input: 'USER_ENTERED' }
      : { text: '', input: 'RAW' }
  switch (column.type) {
    case 'number':
      return { text: String(value), input: 'USER_ENTERED' }
    case 'date':
      // An ISO date is read as a date; the cell keeps its own date format.
      return { text: String(value), input: 'USER_ENTERED' }
    case 'checkbox':
      return { text: sheetTextFor(column, Boolean(value), previous), input: 'USER_ENTERED' }
    case 'select':
      return { text: column.options?.find(option => option.id === value)?.label || '', input: 'RAW' }
    case 'multiselect':
      return {
        text: (Array.isArray(value) ? value : [])
          .map(id => column.options?.find(option => option.id === id)?.label || '')
          .filter(Boolean)
          .join(', '),
        input: 'RAW',
      }
    case 'person':
      return { text: people.find(person => person.id === value)?.name || '', input: 'RAW' }
    case 'link':
      return { text: linkToInput(String(value)), input: 'RAW' }
    default:
      return { text: String(value), input: 'RAW' }
  }
}

const headerKey = (value: string) => value.replace(/\s+/g, ' ').trim().toLowerCase()

/** A cell edit that could not be written because the Sheet changed since the last sync. */
export type Conflict = { columnId: string; name: string; header: string; sheet: string; mine: string }

/**
 * Plans the writes for one row's edited cells. `baseline` is the Sheet text at the last sync (source_values). A cell
 * whose Sheet text differs from it is a conflict, unless the Sheet already holds what the person typed, or `overwrite`
 * says the person chose to replace it.
 */
export function planCellWrites(input: {
  grid: string[][]
  keyHeader: string
  sourceKey: string
  headerMap: Record<string, string>
  columns: TrackerColumn[]
  cells: Record<string, Cell>
  baseline: Record<string, string>
  people: Person[]
  overwrite: boolean
}):
  | { error: 'no_row' | 'no_key_column' }
  | {
      row: number
      writes: { header: string; column: number; text: string; input: InputOption }[]
      conflicts: Conflict[]
      /** Header → Sheet text after the write, for the new baseline. */
      values: Record<string, string>
    } {
  const [rawHeaders = [], ...body] = input.grid
  const headers = rawHeaders.map(value => String(value ?? '').trim())
  const indexOf = (name: string) => headers.findIndex(item => item && headerKey(item) === headerKey(name))
  const keyIndex = indexOf(input.keyHeader)
  if (keyIndex < 0) return { error: 'no_key_column' }
  const lines = body
    .map((line, at) => ({ at, values: headers.map((_, index) => String(line?.[index] ?? '')) }))
    .filter(line => line.values.some(value => value.trim()))
  const keys = sheetRowKeys(lines.map(line => line.values[keyIndex]))
  const found = keys.findIndex(key => key.toLowerCase() === input.sourceKey.toLowerCase())
  if (found < 0) return { error: 'no_row' }
  const line = lines[found]
  const byId = new Map(input.columns.map(column => [column.id, column]))
  const writes: { header: string; column: number; text: string; input: InputOption }[] = []
  const conflicts: Conflict[] = []
  const values: Record<string, string> = {}
  for (const [header, columnId] of Object.entries(input.headerMap)) {
    if (!(columnId in input.cells)) continue
    const column = byId.get(columnId)
    const index = indexOf(header)
    if (!column || index < 0) continue
    const now = line.values[index]
    const next = sheetTextOf(column, input.cells[columnId], input.people, now)
    if (now.trim() === next.text.trim()) {
      values[header] = now
      continue
    }
    const baseline = String(input.baseline[header] ?? '')
    if (!input.overwrite && now.trim() !== baseline.trim()) {
      conflicts.push({ columnId, name: column.name, header, sheet: now, mine: next.text })
      continue
    }
    writes.push({ header, column: index, text: next.text, input: next.input })
    values[header] = next.text
  }
  return { row: line.at + 2, writes, conflicts, values }
}

/**
 * Plans adding tracker rows at the bottom of the Sheet tab. Each row needs a task name (the key column's value);
 * rows without one are left out, since a nameless row in the Sheet belongs to the task above it. Returns the
 * line to append for each row and the key the next sync will know it by.
 */
export function planAppend(input: {
  grid: string[][]
  keyHeader: string
  headerMap: Record<string, string>
  columns: TrackerColumn[]
  rows: { id: string; cells: Record<string, Cell> }[]
  people: Person[]
}): {
  appends: {
    id: string
    key: string
    line: string[]
    typed: { column: number; text: string }[]
    values: Record<string, string>
  }[]
  skipped: string[]
} {
  const [rawHeaders = [], ...body] = input.grid
  const headers = rawHeaders.map(value => String(value ?? '').trim())
  const indexOf = (name: string) => headers.findIndex(item => item && headerKey(item) === headerKey(name))
  const keyIndex = indexOf(input.keyHeader)
  const keyColumnId = Object.entries(input.headerMap).find(
    ([header]) => headerKey(header) === headerKey(input.keyHeader),
  )?.[1]
  const byId = new Map(input.columns.map(column => [column.id, column]))
  const keyColumn = keyColumnId ? byId.get(keyColumnId) : undefined
  if (keyIndex < 0 || !keyColumn) return { appends: [], skipped: input.rows.map(row => row.id) }
  const names = body
    .map(line => headers.map((_, index) => String(line?.[index] ?? '')))
    .filter(values => values.some(value => value.trim()))
    .map(values => values[keyIndex])
  const appends: ReturnType<typeof planAppend>['appends'] = []
  const skipped: string[] = []
  for (const row of input.rows) {
    const name = sheetTextOf(keyColumn, row.cells[keyColumn.id], input.people).text.trim()
    if (!name) {
      skipped.push(row.id)
      continue
    }
    const line = headers.map(() => '')
    const typed: { column: number; text: string }[] = []
    const values: Record<string, string> = {}
    for (const [header, columnId] of Object.entries(input.headerMap)) {
      const column = byId.get(columnId)
      const index = indexOf(header)
      if (!column || index < 0) continue
      const cell = sheetTextOf(column, row.cells[columnId], input.people)
      values[header] = cell.text
      if (cell.input === 'USER_ENTERED' && cell.text) typed.push({ column: index, text: cell.text })
      else line[index] = cell.text
    }
    names.push(name)
    const keys = sheetRowKeys(names)
    appends.push({ id: row.id, key: keys[keys.length - 1] || name, line, typed, values })
  }
  return { appends, skipped }
}
