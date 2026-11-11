/**
 * A tracker the BA assistant drafted, made real once the person approves it: the template's columns, the drafted
 * rows, and visible only to them until they share it.
 */
import { trackerApi } from '../trackers/trackerApi'
import type { Cell, TrackerColumn } from '../trackers/trackerModel'
import { templateById, withDoneColumn } from '../trackers/trackerTemplates'

export type TrackerDraft = {
  template: string
  templateName: string
  name: string
  rows: Record<string, string | number | boolean>[]
  clientId?: string
  clientName?: string
  projectId?: string
  projectName?: string
}

const YES = new Set(['true', 'yes', 'y', 'done', 'x', '1'])

/**
 * One drafted row (by column name) as cells for a tracker's columns. A value that does not fit its column is left
 * out rather than guessed: an unknown choice, a date that is not YYYY-MM-DD, a number that is not one.
 */
export function draftCells(row: TrackerDraft['rows'][number], columns: TrackerColumn[]) {
  const byName = new Map(columns.map(column => [column.name.toLowerCase(), column]))
  const cells: Record<string, Cell> = {}
  for (const [name, value] of Object.entries(row)) {
    const column = byName.get(name.toLowerCase())
    if (!column) continue
    const text = `${value}`.trim()
    if (column.type === 'select') {
      const option = column.options?.find(item => item.label.toLowerCase() === text.toLowerCase())
      if (option) cells[column.id] = option.id
    } else if (column.type === 'checkbox') {
      if (value === true || YES.has(text.toLowerCase())) cells[column.id] = true
    } else if (column.type === 'number') {
      if (text && Number.isFinite(Number(text))) cells[column.id] = Number(text)
    } else if (column.type === 'date') {
      if (/^\d{4}-\d{2}-\d{2}$/.test(text)) cells[column.id] = text
    } else if (column.type === 'text' || column.type === 'longtext') {
      if (text) cells[column.id] = text
    }
  }
  return cells
}

/** Makes the drafted tracker, private to the person, and adds its rows. Answers with the tracker and the rows added. */
export async function createTrackerDraft(draft: TrackerDraft) {
  const template = templateById(draft.template)
  if (!template) throw new Error('That tracker template is no longer available.')
  const made = await trackerApi.create({
    name: draft.name,
    columns: template.columns,
    template: template.id,
    ...(template.stepTasks !== undefined ? { stepTasks: template.stepTasks } : {}),
    clientIds: draft.clientId ? [draft.clientId] : [],
    projectIds: draft.projectId ? [draft.projectId] : [],
    private: true,
  })
  let tracker = made.tracker
  const doneColumns = withDoneColumn(template, tracker.columns)
  if (doneColumns) {
    const saved = await trackerApi.saveColumns(tracker.id, doneColumns, tracker.revision).catch(() => null)
    tracker = saved?.tracker || tracker
  }
  const rows = draft.rows
    .map(row => ({ cells: draftCells(row, tracker.columns) }))
    .filter(row => Object.keys(row.cells).length)
  // The tracker exists either way: if the rows cannot be added it opens empty, and the notice says so.
  const added = rows.length ? await trackerApi.addRows(tracker.id, rows).catch(() => null) : { rows: [] }
  return { tracker, rows: added ? added.rows.length : 0, rowsFailed: !added }
}
