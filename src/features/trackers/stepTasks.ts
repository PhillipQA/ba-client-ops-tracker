/**
 * Site rollout trackers keep a task for each site and a subtask for each step. A row with a name ("Branch – Terminal/
 * Site") gets its task, assigned to whoever added it, due on the Go Live Date; each Checkbox column (Hardware, COR,
 * Signed DRF…) becomes a subtask of it, named after the column and linked to that cell. Ticking a step completes its
 * subtask and completing the subtask ticks the step (the server does that side, see trackers.ts).
 *
 * Pure functions, shared by the screen and the tests.
 */
import type { Cell, Tracker, TrackerColumn, TrackerRow } from './trackerModel'
import { cellText } from './trackerTasks'
import type { TaskDraft } from './TrackerWork'

/** The templates whose trackers keep a task per row and a subtask per step. */
export const STEP_TASK_TEMPLATES = ['site-rollout']
/** On when the tracker says so (its own switch, schema v35); otherwise when it was made from Site rollout. */
export const keepsStepTasks = (tracker: Pick<Tracker, 'template' | 'stepTasks'> | null | undefined) =>
  Boolean(tracker && (tracker.stepTasks ?? STEP_TASK_TEMPLATES.includes(tracker.template)))

/** The steps: every Checkbox column. */
export const stepColumns = (columns: TrackerColumn[]) => columns.filter(column => column.type === 'checkbox')

const named = (columns: TrackerColumn[], pattern: RegExp) => columns.find(column => pattern.test(column.name.trim()))
const BRANCH = /^branch$/i
const SITE = /^terminal\s*\/\s*site$/i

/** The task's name: "Branch – Terminal/Site", or whichever of the two is filled in. */
export function siteTaskTitle(columns: TrackerColumn[], cells: Record<string, Cell>) {
  const branch = named(columns, BRANCH)
  const site =
    named(columns, SITE) ||
    columns.find(column => column.type === 'text' && column.id !== branch?.id && !BRANCH.test(column.name.trim()))
  return [branch, site]
    .map(column => (column ? cellText(column, cells[column.id]) : ''))
    .filter(Boolean)
    .join(' – ')
}

/** The date the site's task is due: the Go Live Date column. */
export const goLiveColumn = (columns: TrackerColumn[]) =>
  columns.find(column => column.type === 'date' && /^go[\s-]*live/i.test(column.name.trim()))

const dateOf = (value: Cell | undefined) =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : ''

export type StepPlan = {
  drafts: TaskDraft[]
  /** Which draft becomes each row's task. */
  rowTasks: { rowId: string; draft: number }[]
  /** Which draft goes in each step cell. */
  cellTasks: { rowId: string; columnId: string; draft: number }[]
  /** Drafts for steps already ticked: completed once made. */
  ticked: number[]
}

/** The tasks and subtasks for named rows that have no task yet. */
export function planStepTasks(input: {
  columns: TrackerColumn[]
  rows: Pick<TrackerRow, 'id' | 'cells' | 'taskId'>[]
  clientId: string
  projectId: string
  assigneeId: string
}): StepPlan {
  const plan: StepPlan = { drafts: [], rowTasks: [], cellTasks: [], ticked: [] }
  const steps = stepColumns(input.columns)
  const goLive = goLiveColumn(input.columns)
  for (const row of input.rows) {
    if (row.taskId) continue
    const title = siteTaskTitle(input.columns, row.cells)
    if (!title) continue
    const parent = plan.drafts.length
    plan.drafts.push({
      title,
      clientId: input.clientId,
      projectId: input.projectId,
      assignedToUserId: input.assigneeId || undefined,
      dueDate: dateOf(goLive ? row.cells[goLive.id] : undefined) || undefined,
      description: 'A site of a Site rollout tracker. Its steps are the subtasks.',
    })
    plan.rowTasks.push({ rowId: row.id, draft: parent })
    for (const step of steps) {
      const at = plan.drafts.length
      plan.drafts.push({
        title: step.name,
        clientId: input.clientId,
        projectId: input.projectId,
        parentIndex: parent,
        assignedToUserId: input.assigneeId || undefined,
      })
      plan.cellTasks.push({ rowId: row.id, columnId: step.id, draft: at })
      if (row.cells[step.id] === true) plan.ticked.push(at)
    }
  }
  return plan
}

/** What a row edit changes on its site task: the name and the due date. Null when neither changed. */
export function siteTaskPatch(
  columns: TrackerColumn[],
  taskId: string,
  before: Record<string, Cell>,
  after: Record<string, Cell>,
) {
  const patch: { id: string; title?: string; dueDate?: string } = { id: taskId }
  const title = siteTaskTitle(columns, after)
  if (title && title !== siteTaskTitle(columns, before)) patch.title = title
  const goLive = goLiveColumn(columns)
  if (goLive && JSON.stringify(before[goLive.id] ?? null) !== JSON.stringify(after[goLive.id] ?? null))
    patch.dueDate = dateOf(after[goLive.id])
  return Object.keys(patch).length > 1 ? patch : null
}

/** Steps whose tick changed between two versions of a row: true when ticked, false when unticked. */
export function stepChanges(columns: TrackerColumn[], before: Record<string, Cell>, after: Record<string, Cell>) {
  const changes: { columnId: string; done: boolean }[] = []
  for (const step of stepColumns(columns)) {
    const was = before[step.id] === true
    const now = after[step.id] === true
    if (was !== now) changes.push({ columnId: step.id, done: now })
  }
  return changes
}

export type MissingStepsPlan = {
  /** New subtasks, under each row's own task. */
  drafts: TaskDraft[]
  cellTasks: { rowId: string; columnId: string; draft: number }[]
  /** Subtasks the task already has, named like a step, put in that step's cell instead of making another. */
  existing: { rowId: string; columnId: string; taskId: string }[]
  ticked: number[]
}

/**
 * Rows that have their task but not every step's subtask (the task was picked or made from the cell, or a step column
 * was added later): the missing subtasks, under that task. A subtask of the task with the step's name is used first.
 */
export function planMissingSteps(input: {
  columns: TrackerColumn[]
  rows: Pick<TrackerRow, 'id' | 'cells' | 'taskId'>[]
  links: { rowId: string; columnId: string; taskId: string }[]
  items: {
    id: string
    title: string
    parentTaskId?: string
    clientId?: string
    projectId?: string
    archived?: boolean
  }[]
  clientId: string
  projectId: string
  assigneeId: string
}): MissingStepsPlan {
  const plan: MissingStepsPlan = { drafts: [], cellTasks: [], existing: [], ticked: [] }
  const steps = stepColumns(input.columns)
  const taken = new Set(input.links.map(link => link.taskId))
  for (const row of input.rows) {
    if (!row.taskId) continue
    // A task made a moment ago may not be in the list yet; an archived one gets no new subtasks.
    const task = input.items.find(item => item.id === row.taskId) || { id: row.taskId, archived: false }
    if (task.archived) continue
    const filled = new Set(
      input.links.filter(link => link.rowId === row.id && link.columnId).map(link => link.columnId),
    )
    for (const step of steps) {
      if (filled.has(step.id)) continue
      const same = input.items.find(
        item =>
          item.parentTaskId === task.id &&
          !item.archived &&
          !taken.has(item.id) &&
          item.title.trim().toLowerCase() === step.name.trim().toLowerCase(),
      )
      if (same) {
        taken.add(same.id)
        plan.existing.push({ rowId: row.id, columnId: step.id, taskId: same.id })
        continue
      }
      const at = plan.drafts.length
      plan.drafts.push({
        title: step.name,
        clientId: ('clientId' in task && task.clientId) || input.clientId,
        projectId: ('projectId' in task && task.projectId) || input.projectId,
        parentTaskId: task.id,
        assignedToUserId: input.assigneeId || undefined,
      })
      plan.cellTasks.push({ rowId: row.id, columnId: step.id, draft: at })
      if (row.cells[step.id] === true) plan.ticked.push(at)
    }
  }
  return plan
}
