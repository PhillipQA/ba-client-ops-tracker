/**
 * "Done when its tasks are done": a tracker can name one Checkbox or Choice column that fills itself from the tasks
 * and subtasks linked to each row. When every linked task is completed the column is ticked (or set to the chosen
 * option); when one of them is reopened it goes back. If that column comes from a connected Google Sheet, the same
 * change is written to the Sheet cell, unless someone changed that cell in the Sheet since the last sync.
 *
 * Pure functions, shared by the server and the tests.
 */
import { canAutoDone, cleanCell, isEmptyCell, type Cell, type TrackerColumn } from './trackerModel'
import { sheetRowKeys } from './trackerSync'

export { canAutoDone, normalizeAutoDone, type AutoDone } from './trackerModel'

/** The tracker's auto-done column, if it has one. Only the first is used. */
export const autoDoneColumn = (columns: TrackerColumn[]) =>
  columns.find(column => column.autoDone && canAutoDone(column))

/** The cell values the setting stands for. */
export function autoDoneValues(column: TrackerColumn): { done: Cell; undone: Cell } {
  if (column.type === 'checkbox') return { done: true, undone: false }
  return { done: column.autoDone?.done || '', undone: column.autoDone?.undone || '' }
}

const same = (a: Cell | undefined, b: Cell | undefined) =>
  JSON.stringify(isEmptyCell(a) ? null : a) === JSON.stringify(isEmptyCell(b) ? null : b)

type Status = { label: string; closed: boolean }
/** Whether a task status counts as completed, the same way the task list decides it. */
export function isClosedStatus(status: unknown, statuses: Status[] | undefined) {
  const text = String(status ?? '')
  const known = (statuses || []).find(item => item?.label === text)
  return known ? Boolean(known.closed) : ['Resolved', 'Closed'].includes(text)
}

/**
 * Tasks and subtasks whose completed state changed between two saves of the workspace: true when it became completed,
 * false when it was reopened. New tasks that are already completed count as completed; deleted tasks are left out.
 */
export function completionChanges(before: any, after: any): Map<string, boolean> {
  const statuses = (state: any): Status[] | undefined =>
    Array.isArray(state?.taskSettings?.statuses) ? state.taskSettings.statuses : undefined
  const old = new Map<string, any>(
    (Array.isArray(before?.items) ? before.items : []).map((item: any) => [String(item?.id || ''), item]),
  )
  const changes = new Map<string, boolean>()
  for (const item of Array.isArray(after?.items) ? after.items : []) {
    const id = String(item?.id || '')
    if (!id) continue
    const now = isClosedStatus(item.status, statuses(after))
    const previous = old.get(id)
    const was = previous ? isClosedStatus(previous.status, statuses(before) || statuses(after)) : false
    if (now !== was) changes.set(id, now)
  }
  return changes
}

/**
 * What the auto-done column of one row should become after a save, or null to leave it alone.
 * - Every linked task completed, and one of them was just completed: set the done value.
 * - A linked task was just reopened, and the cell still shows the done value: set the not-done value.
 *   A value someone picked by hand (say "Blocked") is never overwritten by a reopen.
 */
export function planAutoDone(input: {
  column: TrackerColumn
  current: Cell | undefined
  /** Every task linked to the row (the row's task and the tasks linked to the row or its cells). */
  linked: string[]
  /** Whether a task is completed now; undefined for a task that no longer exists. */
  closed: (taskId: string) => boolean | undefined
  /** The completion changes in this save (completionChanges). */
  changes: Map<string, boolean>
}): { value: Cell; reason: 'done' | 'reopened'; taskIds: string[] } | null {
  const { done, undone } = autoDoneValues(input.column)
  if (input.column.type === 'select' && !done) return null
  const linked = [...new Set(input.linked.filter(Boolean))]
  const existing = linked.filter(id => input.closed(id) !== undefined)
  if (!existing.length) return null
  const reopened = linked.filter(id => input.changes.get(id) === false)
  const completed = linked.filter(id => input.changes.get(id) === true)
  if (reopened.length) {
    if (!same(input.current, done) || same(done, undone)) return null
    return { value: undone, reason: 'reopened', taskIds: reopened }
  }
  if (completed.length && existing.every(id => input.closed(id) === true)) {
    if (same(input.current, done)) return null
    return { value: done, reason: 'done', taskIds: completed }
  }
  return null
}

/** A1 column letters for a zero-based index: 0 → A, 25 → Z, 26 → AA. */
export function columnLetter(index: number) {
  let n = Math.floor(index) + 1,
    letters = ''
  while (n > 0) {
    const rest = (n - 1) % 26
    letters = String.fromCharCode(65 + rest) + letters
    n = Math.floor((n - 1) / 26)
  }
  return letters
}

const headerKey = (value: string) => value.replace(/\s+/g, ' ').trim().toLowerCase()

/**
 * Finds a tracker row in a Sheet tab the same way a sync recognises it (task name and order), so a row that moved in
 * the Sheet is still found. Returns the 1-based Sheet row, the 0-based column index of `header`, and the cell's text.
 */
export function locateSheetCell(
  grid: string[][],
  keyHeader: string,
  sourceKey: string,
  header: string,
): { row: number; column: number; text: string } | { error: 'no_header' | 'no_key_column' | 'no_row' } {
  const [rawHeaders = [], ...body] = grid
  const headers = rawHeaders.map(value => String(value ?? '').trim())
  const indexOf = (name: string) => headers.findIndex(item => item && headerKey(item) === headerKey(name))
  const keyIndex = indexOf(keyHeader)
  if (keyIndex < 0) return { error: 'no_key_column' }
  const column = indexOf(header)
  if (column < 0) return { error: 'no_header' }
  // The same rows a sync reads: every row with any value under a header, in Sheet order.
  const lines = body
    .map((line, at) => ({ at, values: headers.map((_, index) => String(line?.[index] ?? '')) }))
    .filter(line => line.values.some(value => value.trim()))
  const keys = sheetRowKeys(lines.map(line => line.values[keyIndex]))
  const found = keys.findIndex(key => key.toLowerCase() === sourceKey.toLowerCase())
  if (found < 0) return { error: 'no_row' }
  const line = lines[found]
  return { row: line.at + 2, column, text: line.values[column] }
}

/** Whether Sheet text means the same as a tracker value for this column. */
export function sheetTextMatches(column: TrackerColumn, text: string, value: Cell) {
  if (column.type === 'checkbox') {
    const read = cleanCell(column, text)
    return read.ok && Boolean(read.value) === Boolean(value)
  }
  if (column.type === 'select') {
    const label = (column.options || []).find(option => option.id === value)?.label || ''
    return text.trim().toLowerCase() === label.toLowerCase()
  }
  return text.trim() === String(value ?? '').trim()
}

const CHECK_PAIRS: [string, string][] = [
  ['true', 'false'],
  ['yes', 'no'],
  ['y', 'n'],
  ['1', '0'],
  ['checked', 'unchecked'],
  ['x', ''],
  ['✓', ''],
  ['✔', ''],
  ['done', ''],
]
const matchCase = (word: string, like: string) =>
  like === like.toUpperCase() && like !== like.toLowerCase()
    ? word.toUpperCase()
    : like[0] && like[0] === like[0].toUpperCase() && like[0] !== like[0].toLowerCase()
      ? word.charAt(0).toUpperCase() + word.slice(1)
      : word

/**
 * The text to write to the Sheet for a value. Checkboxes keep the style the Sheet already uses (Yes/No, x,
 * TRUE/FALSE…); with nothing to go by they are written as TRUE/FALSE, which Google shows as a ticked box in a
 * checkbox cell.
 */
export function sheetTextFor(column: TrackerColumn, value: Cell, previous: string) {
  if (column.type === 'select') return (column.options || []).find(option => option.id === value)?.label || ''
  if (column.type !== 'checkbox') return String(value ?? '')
  const before = previous.trim()
  const pair = CHECK_PAIRS.find(([yes, no]) => before.toLowerCase() === yes || (no && before.toLowerCase() === no))
  if (!pair) return value ? 'TRUE' : 'FALSE'
  const word = value ? pair[0] : pair[1]
  return word ? matchCase(word, before) : ''
}

/** Why a row's done mark did not reach the Sheet, in words for the row and the banner. */
export const SHEET_ISSUES = {
  conflict: 'The cell was changed in the Sheet since the last sync, so it was not overwritten.',
  no_access: 'The Google account connected to this Sheet is not allowed to edit Google Sheets.',
  no_edit: 'The Google account connected to this Sheet can open it but not edit it.',
  no_row: 'The row was not found in the Sheet. It may have been renamed or removed there.',
  no_header: 'The column is no longer in the Sheet.',
  no_key_column: 'The key column is no longer in the Sheet.',
  error: 'Google Sheets could not be reached.',
} as const
export type SheetIssueCode = keyof typeof SHEET_ISSUES
export type SheetIssue = { code: SheetIssueCode; message: string; value: Cell; at: string }
