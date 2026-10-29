/**
 * A project timeline tracker and the Tasks list, kept in step. Each phase (the Phase column) is a task and each row
 * under it a subtask, in the tracker's client and project. Pure functions, shared by the browser and the tests:
 * - planRowTasks: the tasks and subtasks to create for rows that have a name but no task yet;
 * - rowTaskPatch: what a row edit changes on its task (title, dates, done);
 * - phaseRollup: a phase task spans its subtasks' dates and is done when all of them are.
 */
import type { WorkItem } from '../../shared/types'
import { autoDoneColumn, autoDoneValues } from './trackerAutoDone'
import { isEmptyCell, taskFieldColumn, type Cell, type TrackerColumn, type TrackerRow } from './trackerModel'
import type { TaskDraft } from './TrackerWork'

/** A change to one task, as the tracker asks for it. */
export type TaskPatch = {
  id: string
  title?: string
  startDate?: string
  dueDate?: string
  parentTaskId?: string
  /** true: complete it; false: reopen it. */
  done?: boolean
}

type Item = Pick<
  WorkItem,
  'id' | 'title' | 'clientId' | 'projectId' | 'parentTaskId' | 'status' | 'startDate' | 'dueDate' | 'archived'
>

/** A cell as plain text: a Choice column's label, anything else as written. */
export function cellText(column: TrackerColumn | undefined, value: Cell | undefined) {
  if (!column || value === undefined || value === null) return ''
  if (column.type === 'select') return column.options?.find(option => option.id === value)?.label || ''
  return typeof value === 'string' ? value.trim() : String(value)
}
const dateOf = (value: Cell | undefined) =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : ''

/** Whether this tracker keeps tasks for its rows: it has a column that mirrors the task title. */
export const keepsTasks = (columns: TrackerColumn[]) => Boolean(taskFieldColumn(columns, 'title'))

/**
 * Tasks and subtasks to create for rows with a name and no (living) task. Rows with a phase become subtasks of that
 * phase's task: the one other rows of the phase already sit under, else an open task of the same name in the
 * project, else a new one. Rows without a phase become tasks of their own.
 */
export function planRowTasks(input: {
  columns: TrackerColumn[]
  rows: TrackerRow[]
  items: Item[]
  phaseId: string
  leadId: string
  clientId: string
  projectId: string
  /** Used when the tracker has no project: a project of this name is made (or reused). */
  newProjectName: string
  assigneeId: string
  /** Only these rows get tasks; the others still show which task each phase already has. All rows when missing. */
  onlyRowIds?: string[]
}): { drafts: TaskDraft[]; links: { rowId: string; draft: number }[] } {
  const titleColumn = taskFieldColumn(input.columns, 'title')
  const startColumn = taskFieldColumn(input.columns, 'start')
  const dueColumn = taskFieldColumn(input.columns, 'due')
  const byId = new Map(input.columns.map(column => [column.id, column]))
  const phaseColumn = byId.get(input.phaseId)
  const leadColumn = byId.get(input.leadId)
  const items = new Map(input.items.map(item => [item.id, item]))
  const drafts: TaskDraft[] = []
  const links: { rowId: string; draft: number }[] = []
  if (!titleColumn || !input.clientId) return { drafts, links }
  const where = input.projectId
    ? { projectId: input.projectId }
    : { projectId: '', newProjectName: input.newProjectName }
  const phaseOf = (row: TrackerRow) => (phaseColumn ? cellText(phaseColumn, row.cells[phaseColumn.id]) : '')

  // Phase tasks already in use: the parent of any row's living subtask.
  const phaseTask = new Map<string, { id?: string; draft?: number }>()
  for (const row of input.rows) {
    const item = row.taskId ? items.get(row.taskId) : undefined
    const phase = phaseOf(row).toLowerCase()
    if (phase && item?.parentTaskId && items.has(item.parentTaskId) && !phaseTask.has(phase))
      phaseTask.set(phase, { id: item.parentTaskId })
  }
  const span = (rows: TrackerRow[]) => {
    const starts = rows.map(row => dateOf(startColumn ? row.cells[startColumn.id] : '')).filter(Boolean)
    const dues = rows.map(row => dateOf(dueColumn ? row.cells[dueColumn.id] : '')).filter(Boolean)
    return { startDate: starts.sort()[0] || '', dueDate: dues.sort()[dues.length - 1] || '' }
  }
  const pending = input.rows.filter(
    row =>
      (!input.onlyRowIds || input.onlyRowIds.includes(row.id)) &&
      cellText(titleColumn, row.cells[titleColumn.id]) &&
      !(row.taskId && items.has(row.taskId)),
  )
  for (const row of pending) {
    const title = cellText(titleColumn, row.cells[titleColumn.id])
    const lead = cellText(leadColumn, leadColumn ? row.cells[leadColumn.id] : undefined)
    const dates = span([row])
    const description = lead ? `Lead: ${lead}` : ''
    const phase = phaseOf(row)
    if (!phase) {
      links.push({ rowId: row.id, draft: drafts.length })
      drafts.push({
        title,
        clientId: input.clientId,
        ...where,
        ...dates,
        description,
        assignedToUserId: input.assigneeId,
      })
      continue
    }
    let parent = phaseTask.get(phase.toLowerCase())
    if (!parent) {
      const existing = input.items.find(
        item =>
          !item.parentTaskId &&
          !item.archived &&
          item.clientId === input.clientId &&
          (input.projectId ? item.projectId === input.projectId : false) &&
          item.title.trim().toLowerCase() === phase.toLowerCase(),
      )
      if (existing) parent = { id: existing.id }
      else {
        const inPhase = input.rows.filter(other => phaseOf(other).toLowerCase() === phase.toLowerCase())
        parent = { draft: drafts.length }
        drafts.push({
          title: phase,
          clientId: input.clientId,
          ...where,
          ...span(inPhase),
          description: 'Phase of a project timeline tracker.',
          assignedToUserId: input.assigneeId,
        })
      }
      phaseTask.set(phase.toLowerCase(), parent)
    }
    links.push({ rowId: row.id, draft: drafts.length })
    drafts.push({
      title,
      clientId: input.clientId,
      projectId: input.projectId,
      ...(parent.id ? { parentTaskId: parent.id } : { parentIndex: parent.draft }),
      ...dates,
      description,
    })
  }
  return { drafts, links }
}

/**
 * What an edit to a row changes on its task: the title, start and due date from the columns that mirror them, and
 * done or reopened from the done column (Status set to Done, or back). Null when nothing that the task holds changed.
 */
export function rowTaskPatch(
  columns: TrackerColumn[],
  taskId: string,
  before: Record<string, Cell>,
  after: Record<string, Cell>,
): TaskPatch | null {
  if (!taskId) return null
  const patch: TaskPatch = { id: taskId }
  const changed = (column: TrackerColumn | undefined) =>
    column && JSON.stringify(before[column.id] ?? null) !== JSON.stringify(after[column.id] ?? null)
  const title = taskFieldColumn(columns, 'title')
  if (changed(title) && cellText(title, after[title!.id])) patch.title = cellText(title, after[title!.id])
  const start = taskFieldColumn(columns, 'start')
  if (changed(start)) patch.startDate = dateOf(after[start!.id])
  const due = taskFieldColumn(columns, 'due')
  if (changed(due)) patch.dueDate = dateOf(after[due!.id])
  const doneColumn = autoDoneColumn(columns)
  if (doneColumn && changed(doneColumn)) {
    const { done } = autoDoneValues(doneColumn)
    const same = (value: Cell | undefined) => !isEmptyCell(value) && JSON.stringify(value) === JSON.stringify(done)
    if (same(after[doneColumn.id])) patch.done = true
    else if (same(before[doneColumn.id])) patch.done = false
  }
  return Object.keys(patch).length > 1 ? patch : null
}

/**
 * Phase tasks follow their subtasks: Start is the earliest subtask start, Due the latest due date, and the task is
 * done when every subtask is (and reopened when one is reopened). Returns the patches still needed.
 */
export function phaseRollup(items: Item[], parentIds: Iterable<string>, isClosed: (status: string) => boolean) {
  const patches: TaskPatch[] = []
  for (const id of new Set(parentIds)) {
    const parent = items.find(item => item.id === id)
    const subtasks = items.filter(item => item.parentTaskId === id && !item.archived)
    if (!parent || parent.parentTaskId || !subtasks.length) continue
    const starts = subtasks
      .map(item => item.startDate || '')
      .filter(Boolean)
      .sort()
    const dues = subtasks
      .map(item => item.dueDate || '')
      .filter(Boolean)
      .sort()
    const patch: TaskPatch = { id }
    if (starts.length && starts[0] !== (parent.startDate || '')) patch.startDate = starts[0]
    if (dues.length && dues[dues.length - 1] !== (parent.dueDate || '')) patch.dueDate = dues[dues.length - 1]
    const allDone = subtasks.every(item => isClosed(item.status))
    if (allDone !== isClosed(parent.status)) patch.done = allDone
    if (Object.keys(patch).length > 1) patches.push(patch)
  }
  return patches
}

/**
 * Applies tracker patches to the task list, then rolls up the phase tasks they touch. Completing a task with open
 * subtasks is skipped, as in Tasks. `close` and `open` give the fields a completed or reopened task takes.
 */
export function applyTaskPatches<T extends Item>(
  items: T[],
  patches: TaskPatch[],
  rules: {
    isClosed: (status: string) => boolean
    close: (item: T) => Partial<T>
    open: (item: T) => Partial<T>
  },
): { items: T[]; changed: { item: T; done?: boolean }[] } {
  let next = [...items]
  const changed = new Map<string, { item: T; done?: boolean }>()
  const apply = (patch: TaskPatch) => {
    const at = next.findIndex(item => item.id === patch.id)
    if (at < 0) return
    const current = next[at]
    const update: Partial<T> = {}
    if (patch.title !== undefined && patch.title.trim() && patch.title.trim() !== current.title)
      update.title = patch.title.trim().slice(0, 200) as T['title']
    if (patch.startDate !== undefined && patch.startDate !== (current.startDate || ''))
      update.startDate = patch.startDate as T['startDate']
    if (patch.dueDate !== undefined && patch.dueDate !== (current.dueDate || ''))
      update.dueDate = patch.dueDate as T['dueDate']
    if (patch.parentTaskId !== undefined && patch.parentTaskId !== current.parentTaskId) {
      const parent = next.find(item => item.id === patch.parentTaskId)
      if (
        parent &&
        !parent.parentTaskId &&
        parent.id !== current.id &&
        !next.some(item => item.parentTaskId === current.id)
      )
        Object.assign(update, { parentTaskId: parent.id, projectId: parent.projectId, clientId: parent.clientId })
    }
    let done: boolean | undefined
    if (patch.done === true && !rules.isClosed(current.status)) {
      const open = next.some(item => item.parentTaskId === current.id && !item.archived && !rules.isClosed(item.status))
      if (!open) {
        Object.assign(update, rules.close(current))
        done = true
      }
    } else if (patch.done === false && rules.isClosed(current.status)) {
      Object.assign(update, rules.open(current))
      done = false
    }
    if (!Object.keys(update).length) return
    next[at] = { ...current, ...update }
    changed.set(current.id, { item: next[at], done: done ?? changed.get(current.id)?.done })
  }
  for (const patch of patches) apply(patch)
  // Phase tasks of everything touched: before the patch (a subtask moved away) and after.
  const parents = new Set<string>()
  for (const patch of patches) {
    const before = items.find(item => item.id === patch.id)?.parentTaskId
    const after = next.find(item => item.id === patch.id)?.parentTaskId
    if (before) parents.add(before)
    if (after) parents.add(after)
  }
  for (const patch of phaseRollup(next, parents, rules.isClosed)) apply(patch)
  return { items: next, changed: [...changed.values()] }
}

/** Title, start and due date of tasks that changed between two saves of the workspace (tasks that already existed). */
export function taskFieldChanges(before: any, after: any) {
  const old = new Map<string, any>(
    (Array.isArray(before?.items) ? before.items : []).map((item: any) => [String(item?.id || ''), item]),
  )
  const changes = new Map<string, { title?: string; startDate?: string; dueDate?: string }>()
  for (const item of Array.isArray(after?.items) ? after.items : []) {
    const previous = old.get(String(item?.id || ''))
    if (!previous) continue
    const change: { title?: string; startDate?: string; dueDate?: string } = {}
    if (String(item.title || '') !== String(previous.title || '')) change.title = String(item.title || '')
    if (String(item.startDate || '') !== String(previous.startDate || ''))
      change.startDate = String(item.startDate || '')
    if (String(item.dueDate || '') !== String(previous.dueDate || '')) change.dueDate = String(item.dueDate || '')
    if (Object.keys(change).length) changes.set(String(item.id), change)
  }
  return changes
}

/**
 * The cells a row takes from its task after a save: the mirrored title and dates when they changed on the task, and
 * progress 100 when the task was completed (back to 0 when it is reopened from 100). Only cells that differ.
 */
export function rowCellsFromTask(
  columns: TrackerColumn[],
  current: Record<string, Cell>,
  change: { title?: string; startDate?: string; dueDate?: string } | undefined,
  completed: boolean | undefined,
): Record<string, Cell> {
  const next: Record<string, Cell> = {}
  const set = (column: TrackerColumn | undefined, value: Cell) => {
    if (!column) return
    const before = isEmptyCell(current[column.id]) ? null : current[column.id]
    const after = isEmptyCell(value) ? null : value
    if (JSON.stringify(before) !== JSON.stringify(after)) next[column.id] = value
  }
  if (change?.title !== undefined && change.title.trim()) set(taskFieldColumn(columns, 'title'), change.title.trim())
  if (change?.startDate !== undefined) set(taskFieldColumn(columns, 'start'), dateOf(change.startDate))
  if (change?.dueDate !== undefined) set(taskFieldColumn(columns, 'due'), dateOf(change.dueDate))
  const progress = taskFieldColumn(columns, 'progress')
  if (progress && completed === true) set(progress, 100)
  if (progress && completed === false && current[progress.id] === 100) set(progress, 0)
  return next
}
