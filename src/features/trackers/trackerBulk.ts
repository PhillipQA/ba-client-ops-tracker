/**
 * Bulk edit: set one column to one value for every selected row. Each row is changed the same way as editing its cell
 * by hand (history, the linked task, the Google Sheet), so nothing new can go wrong per row; this file only decides
 * which columns can be set in bulk and which rows a change will touch.
 */
import { type Cell, emptyCell, isEmptyCell, type TrackerColumn, type TrackerRow } from './trackerModel'

const BULK_TYPES = ['select', 'person', 'checkbox', 'date', 'text', 'number']

/** Columns that can be set for many rows at once: plain values a person picks or types, not filled from elsewhere. */
export function bulkColumns(columns: TrackerColumn[]) {
  return columns.filter(
    column =>
      BULK_TYPES.includes(column.type) &&
      !column.autoDone &&
      column.taskField !== 'contract' &&
      column.taskField !== 'project',
  )
}

const same = (a: Cell | undefined, b: Cell | undefined) =>
  JSON.stringify(isEmptyCell(a) ? null : a) === JSON.stringify(isEmptyCell(b) ? null : b)

export type BulkPlan = {
  /** Rows the change will be written to. */
  change: TrackerRow[]
  /** Rows that already have the value. */
  same: number
  /** Rows whose cell comes from a one-way Google Sheet: skipped. */
  locked: TrackerRow[]
  /** How many of the changed rows have a linked task (it may follow the change). */
  withTask: number
}

export function planBulk(
  rows: TrackerRow[],
  column: TrackerColumn,
  value: Cell,
  isLocked: (row: TrackerRow, column: TrackerColumn) => boolean,
): BulkPlan {
  const plan: BulkPlan = { change: [], same: 0, locked: [], withTask: 0 }
  for (const row of rows) {
    if (isLocked(row, column)) plan.locked.push(row)
    else if (same(row.cells[column.id] ?? emptyCell(column.type), value)) plan.same += 1
    else {
      plan.change.push(row)
      if (row.taskId) plan.withTask += 1
    }
  }
  return plan
}

/** What to put back for Undo: each changed row's value before the change. */
export function bulkUndo(plan: BulkPlan, column: TrackerColumn): { rowId: string; value: Cell }[] {
  return plan.change.map(row => ({ rowId: row.id, value: row.cells[column.id] ?? emptyCell(column.type) }))
}

/** The typed or picked text as a cell value for the column, or an error to show. */
export function bulkValue(column: TrackerColumn, raw: string): { value: Cell } | { error: string } {
  const text = raw.trim()
  switch (column.type) {
    case 'checkbox':
      return { value: text === 'true' }
    case 'number': {
      if (!text) return { value: emptyCell('number') }
      const number = Number(text.replace(/,/g, ''))
      return Number.isFinite(number) ? { value: number } : { error: 'Type a number.' }
    }
    case 'date':
      if (!text) return { value: emptyCell('date') }
      return /^\d{4}-\d{2}-\d{2}$/.test(text) ? { value: text } : { error: 'Pick a date.' }
    case 'select':
      if (!text) return { value: emptyCell('select') }
      return column.options?.some(option => option.id === text)
        ? { value: text }
        : { error: 'Pick one of the options.' }
    default:
      return { value: text || emptyCell(column.type) }
  }
}
