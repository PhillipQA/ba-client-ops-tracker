/**
 * A Checkbox cell can hold a subtask: a Site rollout step, or any subtask picked for the cell. Ticking the box completes
 * the subtask and unticking it reopens it, on every tracker. The other way round, completing or reopening the subtask
 * ticks or unticks the box (the server does that side, see followCellTasks in trackers.ts).
 *
 * Who follows a tick depends on where it was made. A tick made in the tracker is followed by the screen of the person
 * who made it, once the row is saved. A tick that comes from the connected Google Sheet is followed by the server during
 * the sync, so it counts whoever has the tracker open (see runSync in trackers.ts).
 *
 * Pure functions, shared by the screen, the server and the tests.
 */
import type { Cell, TrackerColumn } from './trackerModel'

/** A task linked to a tracker row; `columnId` is set when it sits in one cell of the row. */
export type CellLink = { rowId: string; columnId?: string | null; taskId: string }
/** Complete (`done: true`) or reopen (`done: false`) one task. */
export type DonePatch = { id: string; done: boolean }
/** One row before and after a change. */
export type RowChange = { rowId: string; before: Record<string, Cell>; after: Record<string, Cell> }

const ticked = (value: Cell | undefined) => value === true

/** Checkbox cells whose tick changed between two versions of a row: true when ticked, false when unticked. */
export function tickChanges(columns: TrackerColumn[], before: Record<string, Cell>, after: Record<string, Cell>) {
  const changes: { columnId: string; done: boolean }[] = []
  for (const column of columns)
    if (column.type === 'checkbox' && ticked(before[column.id]) !== ticked(after[column.id]))
      changes.push({ columnId: column.id, done: ticked(after[column.id]) })
  return changes
}

/**
 * The tasks to complete or reopen for rows whose boxes were ticked or unticked: the task in each changed Checkbox cell.
 * One patch per task; when the same task sits in several changed cells, the last change wins.
 */
export function cellSubtaskPatches(columns: TrackerColumn[], changes: RowChange[], links: CellLink[]): DonePatch[] {
  const byTask = new Map<string, boolean>()
  for (const change of changes)
    for (const tick of tickChanges(columns, change.before, change.after))
      for (const link of links)
        if (link.rowId === change.rowId && link.columnId === tick.columnId && link.taskId)
          byTask.set(link.taskId, tick.done)
  return [...byTask].map(([id, done]) => ({ id, done }))
}

/**
 * Subtasks in a ticked Checkbox cell that are still open: to complete. A tick normally completes its subtask as it
 * changes; this covers subtasks made for boxes that were already ticked (an import or a Sheet: the box was ticked
 * before its subtask existed). It only completes, never reopens: an unticked box with a done subtask is left alone.
 */
export function tickedCellPatches(
  columns: TrackerColumn[],
  rows: { id: string; cells: Record<string, Cell> }[],
  links: CellLink[],
  isOpen: (taskId: string) => boolean,
): DonePatch[] {
  const checkbox = new Set(columns.filter(column => column.type === 'checkbox').map(column => column.id))
  const cellsOf = new Map(rows.map(row => [row.id, row.cells]))
  const ids = new Set<string>()
  for (const link of links)
    if (
      link.columnId &&
      link.taskId &&
      checkbox.has(link.columnId) &&
      ticked(cellsOf.get(link.rowId)?.[link.columnId]) &&
      isOpen(link.taskId)
    )
      ids.add(link.taskId)
  return [...ids].map(id => ({ id, done: true }))
}
