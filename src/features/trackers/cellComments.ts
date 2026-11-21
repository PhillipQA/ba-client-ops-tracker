/**
 * Comments on one cell of a tracker, as in Google Sheets: a corner on the cell, and the comments in a tooltip.
 *
 * - A cell linked to a Task or Subtask (its chip shows in the cell) talks in that task's Comments: what is written on
 *   the cell is saved as a task comment, and the tooltip shows the task's comments. One conversation, kept in Tasks.
 * - Any other cell keeps its own comments in the tracker (row comments with a column), like Google Sheets.
 * - A cell that had its own comments before a task was linked keeps them; the tooltip shows both.
 * - Comments from the tracker's Google Sheet or Excel file show too (sheetComments.ts); resolved threads do not. One
 *   copied into the cell's task is shown once.
 *
 * Pure helpers, shared by the grid and the tests.
 */
import type { TaskComment, WorkItem } from '../../shared/types'
import type { RowComment } from './trackerComments'

export const cellKey = (rowId: string, columnId: string) => `${rowId}|${columnId}`

/** The tracker's own cell comments, by cell, oldest first. */
export function cellCommentMap(cells: readonly (RowComment & { rowId: string })[]) {
  const map = new Map<string, RowComment[]>()
  for (const comment of cells) {
    if (!comment.columnId) continue
    const key = cellKey(comment.rowId, comment.columnId)
    map.set(key, [...(map.get(key) || []), comment])
  }
  for (const list of map.values()) list.sort((a, b) => a.at.localeCompare(b.at))
  return map
}

/**
 * The Task or Subtask a cell is linked to, or '': the row's own Task in its first column, a Subtask linked to the
 * cell in any other column.
 */
export function cellTaskId(
  row: { id: string; taskId?: string | null },
  columnId: string,
  firstColumnId: string,
  cellLinks: ReadonlyMap<string, ReadonlyMap<string, { taskId: string }>>,
) {
  if (columnId === firstColumnId) return row.taskId || ''
  return cellLinks.get(row.id)?.get(columnId)?.taskId || ''
}

/** What people wrote on a task: its comments, without the ones the app adds by itself. */
export const peopleComments = (task: Pick<WorkItem, 'comments'> | undefined | null): TaskComment[] =>
  (Array.isArray(task?.comments) ? task.comments : []).filter(comment => comment.kind === 'User')

export type CellTipEntry = {
  id: string
  author: string
  at: string
  text: string
  /** 'task': the linked task's comment. 'sheet': from the Google Sheet or Excel file. */
  source: 'cell' | 'task' | 'sheet'
  edited?: boolean
  /** A tracker comment not (yet) in the Google Sheet: why. */
  notInSheet?: string
  excel?: boolean
}

/** Everything said on a cell, oldest first: its own comments and its task's. */
export function cellEntries(own: readonly RowComment[], task: Pick<WorkItem, 'comments'> | undefined | null) {
  const shown = own.filter(comment => !comment.resolved)
  const copies = new Set(own.map(comment => comment.taskCommentId).filter(Boolean))
  const entries: CellTipEntry[] = [
    ...shown.map(comment => ({
      id: comment.id,
      author: comment.authorName || 'Someone',
      at: comment.at,
      text: comment.text,
      source: comment.source === 'sheet' ? ('sheet' as const) : ('cell' as const),
      ...(comment.editedAt ? { edited: true } : {}),
      ...(comment.excel ? { excel: true } : {}),
      ...(comment.sheet?.state === 'failed'
        ? { notInSheet: comment.sheet.error || 'Not sent to the Google Sheet.' }
        : comment.sheet?.state === 'pending'
          ? { notInSheet: 'Not in the Google Sheet yet.' }
          : {}),
    })),
    ...peopleComments(task)
      .filter(comment => !copies.has(comment.id))
      .map(comment => ({
      id: comment.id,
      author: comment.createdByName || 'Someone',
      at: comment.createdAt,
      text: comment.text,
      source: 'task' as const,
    })),
  ]
  return entries.sort((a, b) => a.at.localeCompare(b.at))
}

/** The tooltip shows the latest few; the rest are counted. */
export const TIP_SHOWN = 4
export function tipOf(entries: readonly CellTipEntry[]) {
  const shown = entries.slice(-TIP_SHOWN)
  return { shown, more: entries.length - shown.length }
}

/** A comment's text for the tooltip: one paragraph, not too long. */
export const tipText = (text: string) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 280 ? `${flat.slice(0, 279)}…` : flat
}
