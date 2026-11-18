/**
 * The review of new tracker rows, as pure functions: what each row starts as, how rows group into tasks with their
 * subtasks for display, what "the task above" a row is, and what Create would make. Used by TrackerReview and tests.
 */
import type { TaskDraft } from './TrackerWork'
import { parentKeyOf } from './trackerSync'

/** What a reviewed row becomes. A row with no choice is left for later; a skipped row stays a plain row. */
export type Choice =
  | { kind: 'task' }
  | { kind: 'subtask'; parentTaskId: string }
  | { kind: 'subtask_new'; parentRowId: string }

export type PlanRow = { id: string; taskId?: string | null; sourceKey?: string | null }

/** A column chosen on import: by id, or by name when it was made by the import. */
export type ColumnRef = { id?: string; name: string }
/**
 * Choices made on import, so the review starts from them: the task name column, the columns that give every task a
 * subtask, and where the tasks go. With `auto`, the tasks are created at once, without the row-by-row list.
 */
export type ReviewPreset = {
  nameColumn?: ColumnRef
  subColumns?: ColumnRef[]
  clientId?: string
  projectId?: string
  auto?: boolean
}
export type Choices = Record<string, Choice>

/**
 * Starting choices for rows from a Sheet: a row with a name becomes a task, and a row under it becomes a subtask of
 * that task (a new one from this list, or the task its row already has). Rows above the first name, and rows whose
 * task row is not loaded, are left for later.
 */
export function choicesFromSheet(open: PlanRow[], rows: PlanRow[]): Choices {
  const byKey = new Map(rows.filter(row => row.sourceKey).map(row => [String(row.sourceKey).toLowerCase(), row]))
  const reviewing = new Set(open.map(row => row.id))
  const choices: Choices = {}
  for (const row of open) {
    if (!row.sourceKey) continue
    const parentKey = parentKeyOf(row.sourceKey)
    if (parentKey === null) {
      choices[row.id] = { kind: 'task' }
      continue
    }
    const parent = parentKey ? byKey.get(parentKey.toLowerCase()) : undefined
    if (!parent) continue
    if (parent.taskId) choices[row.id] = { kind: 'subtask', parentTaskId: parent.taskId }
    else if (reviewing.has(parent.id)) choices[row.id] = { kind: 'subtask_new', parentRowId: parent.id }
  }
  return choices
}

/**
 * Starting choices for uploaded rows, in file order, the same way a Sheet groups: a row with a name becomes a task,
 * and a row with the name blank becomes a subtask of the task above it. Rows above the first name are left for later.
 */
export function choicesFromOrder(open: { id: string; name: string }[]): Choices {
  const choices: Choices = {}
  let task = ''
  for (const row of open) {
    if (row.name.trim()) {
      choices[row.id] = { kind: 'task' }
      task = row.id
    } else if (task) choices[row.id] = { kind: 'subtask_new', parentRowId: task }
  }
  return choices
}

/**
 * The task a row would join as "subtask of the task above": the nearest row before it that is (or will be) a task,
 * or that already belongs to one. Skipped and undecided rows are passed over. `null` when nothing is above.
 */
export function taskAbove(rows: PlanRow[], id: string, choices: Choices, skipped: Set<string>): Choice | null {
  const at = rows.findIndex(row => row.id === id)
  for (let i = at - 1; i >= 0; i -= 1) {
    const row = rows[i]
    if (row.taskId) return { kind: 'subtask', parentTaskId: row.taskId }
    if (skipped.has(row.id)) continue
    const choice = choices[row.id]
    if (!choice) continue
    if (choice.kind === 'task') return { kind: 'subtask_new', parentRowId: row.id }
    return choice
  }
  return null
}

export const sameChoice = (a: Choice | null | undefined, b: Choice | null | undefined) =>
  !!a &&
  !!b &&
  a.kind === b.kind &&
  (a.kind !== 'subtask' || a.parentTaskId === (b as typeof a).parentTaskId) &&
  (a.kind !== 'subtask_new' || a.parentRowId === (b as typeof a).parentRowId)

/**
 * Sets one row's choice. When a row stops being a task, the rows that were its subtasks move to the task above them,
 * or are left for later when there is none.
 */
export function setChoice(rows: PlanRow[], choices: Choices, id: string, choice: Choice | null): Choices {
  const next: Choices = { ...choices }
  if (choice && !(choice.kind === 'subtask_new' && choice.parentRowId === id)) next[id] = choice
  else delete next[id]
  if (next[id]?.kind !== 'task')
    for (const row of rows) {
      const value = next[row.id]
      if (value?.kind === 'subtask_new' && value.parentRowId === id) {
        delete next[row.id]
        const above = taskAbove(rows, row.id, next, new Set())
        if (above) next[row.id] = above
      }
    }
  return next
}

/** One entry of the review list: a task with its subtasks under it, or a row on its own. */
export type ReviewGroup =
  | { kind: 'new'; rowId: string; children: string[] }
  | { kind: 'existing'; taskId: string; children: string[] }
  | { kind: 'loose'; rowId: string }

/** Rows grouped for display, in source order: each task is followed by its subtasks, wherever they sit in the list. */
export function reviewGroups(rows: PlanRow[], choices: Choices): ReviewGroup[] {
  const groups: ReviewGroup[] = []
  const newGroups = new Map<string, Extract<ReviewGroup, { kind: 'new' }>>()
  const existing = new Map<string, Extract<ReviewGroup, { kind: 'existing' }>>()
  for (const row of rows)
    if (!row.taskId && choices[row.id]?.kind === 'task')
      newGroups.set(row.id, { kind: 'new', rowId: row.id, children: [] })
  for (const row of rows) {
    const choice = row.taskId ? undefined : choices[row.id]
    if (choice?.kind === 'task') groups.push(newGroups.get(row.id)!)
    else if (choice?.kind === 'subtask_new' && newGroups.has(choice.parentRowId))
      newGroups.get(choice.parentRowId)!.children.push(row.id)
    else if (choice?.kind === 'subtask') {
      let group = existing.get(choice.parentTaskId)
      if (!group) {
        group = { kind: 'existing', taskId: choice.parentTaskId, children: [] }
        existing.set(choice.parentTaskId, group)
        groups.push(group)
      }
      group.children.push(row.id)
    } else groups.push({ kind: 'loose', rowId: row.id })
  }
  return groups
}

/** Whether a row will be created: decided, not skipped, and (for a subtask of a new task) its task is created too. */
export function willCreate(id: string, choices: Choices, skipped: Set<string>): boolean {
  const choice = choices[id]
  if (!choice || skipped.has(id)) return false
  if (choice.kind === 'subtask_new')
    return choices[choice.parentRowId]?.kind === 'task' && !skipped.has(choice.parentRowId)
  return true
}

/** Counts for the summary line and the Create button. */
export function reviewCounts(open: PlanRow[], choices: Choices, skipped: Set<string>, columnSubtasks = 0) {
  let tasks = 0,
    subtasks = 0,
    plain = 0,
    later = 0
  for (const row of open) {
    if (willCreate(row.id, choices, skipped)) {
      if (choices[row.id].kind === 'task') tasks += 1
      else subtasks += 1
    } else if (skipped.has(row.id) || choices[row.id]) plain += 1
    else later += 1
  }
  return { tasks, subtasks: subtasks + tasks * columnSubtasks, plain, later }
}

/** Where a created task goes back to in the tracker: its row, or (a column's subtask) one cell of that row. */
export type DraftLink = { rowId: string; columnId?: string }

/**
 * What Create makes, in order: a task for each task row; then for each task row, a subtask for each chosen column
 * (named after the column, linked to that cell); then the rows under a task as its subtasks. Subtasks of a new task
 * point at its draft by index, so one batch makes them all.
 */
export function reviewDrafts(input: {
  open: PlanRow[]
  choices: Choices
  skipped: Set<string>
  /** The columns that give every new task a subtask, in the order they were chosen. */
  subColumns: { id: string; name: string }[]
  titleOf: (rowId: string) => string
  clientId: string
  /** An existing project, or '' with `newProjectName` to make one. */
  projectId: string
  newProjectName?: string
}): { drafts: TaskDraft[]; links: (DraftLink | null)[] } {
  const { open, choices, skipped, subColumns, titleOf, clientId, projectId, newProjectName } = input
  const drafts: TaskDraft[] = []
  const links: (DraftLink | null)[] = []
  const draftOfRow = new Map<string, number>()
  const push = (draft: TaskDraft, link: DraftLink | null) => {
    drafts.push(draft)
    links.push(link)
    return drafts.length - 1
  }
  const making = open.filter(row => willCreate(row.id, choices, skipped))
  const taskRows = making.filter(row => choices[row.id].kind === 'task')
  for (const row of taskRows)
    draftOfRow.set(
      row.id,
      push(
        { title: titleOf(row.id), clientId, projectId: newProjectName ? '' : projectId, newProjectName },
        { rowId: row.id },
      ),
    )
  for (const row of taskRows)
    for (const column of subColumns)
      push(
        { title: column.name || 'Subtask', clientId: '', projectId: '', parentIndex: draftOfRow.get(row.id) },
        { rowId: row.id, columnId: column.id },
      )
  for (const row of making) {
    const choice = choices[row.id]
    if (choice.kind === 'subtask_new')
      push(
        { title: titleOf(row.id), clientId: '', projectId: '', parentIndex: draftOfRow.get(choice.parentRowId) },
        { rowId: row.id },
      )
    if (choice.kind === 'subtask')
      push(
        { title: titleOf(row.id), clientId: '', projectId: '', parentTaskId: choice.parentTaskId },
        { rowId: row.id },
      )
  }
  return { drafts, links }
}

/** What was created, as row links and cell links for the tracker. */
export function reviewOutcome(made: { id: string }[], links: (DraftLink | null)[], reviewed: string[]) {
  const outcome = {
    rowTasks: [] as { rowId: string; taskId: string }[],
    cellLinks: [] as { rowId: string; columnId: string; taskId: string }[],
    reviewed,
  }
  made.forEach((item, at) => {
    const link = links[at]
    if (!link) return
    if (link.columnId) outcome.cellLinks.push({ rowId: link.rowId, columnId: link.columnId, taskId: item.id })
    else outcome.rowTasks.push({ rowId: link.rowId, taskId: item.id })
  })
  return outcome
}
