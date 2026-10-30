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
export const keepsStepTasks = (tracker: Pick<Tracker, 'template'> | null | undefined) =>
  Boolean(tracker && STEP_TASK_TEMPLATES.includes(tracker.template))

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
