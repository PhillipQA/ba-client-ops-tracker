/**
 * Step 2 of importing rows into a tracker ("Pick your headers"): what each header of the file or Sheet becomes, and a
 * preview of what will be created. Pure functions, used by TrackerImportDialog and tests.
 *
 * - Task name: one header. A row with a name here becomes a task; a row with it blank becomes a subtask of the task
 *   above (rows above the first name are left for the review). On a Sheet that stays in sync, it is also how each row
 *   is recognised on every sync.
 * - Subtask: every task gets a subtask named after this header, linked to that cell.
 * - Info: kept as a column of the tracker, nothing more.
 * - Leave out: not brought in.
 *
 * The outcome is the review's: the same tasks and subtasks the "Create tasks" review makes from these choices.
 */
import { checkNameColumns } from './trackerSync'
import type { ColumnType } from './trackerModel'

export type HeaderRole = 'task' | 'subtask' | 'info' | 'skip'
export const HEADER_ROLES: { role: HeaderRole; label: string; about: string }[] = [
  { role: 'task', label: 'Task name', about: 'Each row with a name here becomes a task.' },
  { role: 'subtask', label: 'Subtask', about: 'Every task gets a subtask named after this header.' },
  { role: 'info', label: 'Info', about: 'Kept as a column, nothing more.' },
  { role: 'skip', label: 'Leave out', about: 'Not brought in.' },
]

export type HeaderChoices = {
  /** The task name header's index, or -1 for none. */
  task: number
  /** Headers that give every task a subtask. */
  subtasks: number[]
  /** Headers that are brought in at all (the others are left out). */
  included: boolean[]
}

/** What each header is. */
export function roleOf(choices: HeaderChoices, index: number): HeaderRole {
  if (!choices.included[index]) return 'skip'
  if (choices.task === index) return 'task'
  return choices.subtasks.includes(index) ? 'subtask' : 'info'
}

/**
 * Gives a header a role. One header is the task name: choosing another moves it. A header left out is neither the
 * task name nor a subtask.
 */
export function setRole(choices: HeaderChoices, index: number, role: HeaderRole): HeaderChoices {
  const included = choices.included.map((value, at) => (at === index ? role !== 'skip' : value))
  const subtasks = choices.subtasks.filter(at => at !== index)
  if (role === 'subtask') subtasks.push(index)
  const task = role === 'task' ? index : choices.task === index ? -1 : choices.task
  return { task, subtasks: subtasks.sort((a, b) => a - b), included }
}

/** Headers that look like steps of work (Checkbox columns), suggested as subtasks but never chosen for the person. */
export function suggestedSubtasks(types: ColumnType[], choices: HeaderChoices): number[] {
  return types
    .map((type, index) => ({ type, index }))
    .filter(({ type, index }) => type === 'checkbox' && index !== choices.task && !choices.subtasks.includes(index))
    .map(({ index }) => index)
}

export type ImportPreview = {
  /** Rows with a task name: one task each. */
  tasks: number
  /** Rows with the task name blank, under a task: one subtask each. */
  rowSubtasks: number
  /** One subtask per task for each Subtask header. */
  headerSubtasks: number
  subtasks: number
  /** Rows above the first task name: left for the person to decide in the review. */
  undecided: number
  /** The first task, as an example of what is made. */
  example: { task: string; subtasks: string[]; rowsUnder: number } | null
}

/** What will be created from the file's rows with these choices. */
export function importPreview(headers: string[], rows: string[][], choices: HeaderChoices): ImportPreview {
  const none: ImportPreview = {
    tasks: 0,
    rowSubtasks: 0,
    headerSubtasks: 0,
    subtasks: 0,
    undecided: 0,
    example: null,
  }
  if (choices.task < 0 || !choices.included[choices.task]) return none
  const check = checkNameColumns(headers, rows)[choices.task]
  if (!check) return none
  const subtaskHeaders = choices.subtasks.filter(index => choices.included[index] && index !== choices.task)
  const headerSubtasks = check.tasks * subtaskHeaders.length
  // The first named row, and how many blank-named rows sit under it before the next name.
  const filled = rows.filter(row => row.some(cell => String(cell ?? '').trim()))
  const first = filled.findIndex(row => String(row[choices.task] ?? '').trim())
  let rowsUnder = 0
  if (first >= 0)
    for (const row of filled.slice(first + 1)) {
      if (String(row[choices.task] ?? '').trim()) break
      rowsUnder += 1
    }
  return {
    tasks: check.tasks,
    rowSubtasks: check.under,
    headerSubtasks,
    subtasks: check.under + headerSubtasks,
    undecided: check.beforeFirst,
    example:
      first >= 0
        ? {
            task: String(filled[first][choices.task]).trim(),
            subtasks: subtaskHeaders.map(index => headers[index]),
            rowsUnder,
          }
        : null,
  }
}
