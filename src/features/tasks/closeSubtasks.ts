/**
 * Closing a task that still has open subtasks: after the person confirms (by typing a word, see
 * CloseWithSubtasksDialog), the open subtasks close with it, in the same save. The task rules (lifecycle.ts) still
 * hold: a task closes only when its subtasks are finished, and here they finish together.
 */
import type { TaskSettings, WorkItem } from '../../shared/types'
import { doneWaitingOn, isWaitingOnDone } from './waitingOn'

/** A closed status (Resolved, Closed…), as the account's task settings say; the same rule as app/store isTaskClosed. */
const isClosed = (status: string, settings: TaskSettings) =>
  settings.statuses.find(candidate => candidate.label === status)?.closed ?? ['Resolved', 'Closed'].includes(status)

/** The task's subtasks that are not finished: not in a closed status, and not waiting on the completion option. */
export const openSubtasks = (items: WorkItem[], taskId: string, settings: TaskSettings) =>
  items.filter(
    item =>
      item.parentTaskId === taskId && !isClosed(item.status, settings) && !isWaitingOnDone(item.waitingOn, settings),
  )

/**
 * The items with the task's open subtasks closed: the same closed status as the task (Resolved or Closed), waiting on
 * the completion option, no follow-up, resolved today. Finished subtasks keep their own status and date.
 */
export function closeOpenSubtasks(
  items: WorkItem[],
  taskId: string,
  status: string,
  settings: TaskSettings,
  today: string,
): WorkItem[] {
  const open = new Set(openSubtasks(items, taskId, settings).map(item => item.id))
  if (!open.size) return items
  const closedStatus = isClosed(status, settings) ? status : 'Closed'
  return items.map(item =>
    open.has(item.id)
      ? {
          ...item,
          status: closedStatus,
          waitingOn: doneWaitingOn(settings),
          followUpDate: '',
          resolvedDate: item.resolvedDate || today,
        }
      : item,
  )
}

/** Words the person types to confirm; one is picked at random each time so it is read, not typed from habit. */
export const CONFIRM_WORDS = ['close', 'finish', 'resolve', 'complete', 'confirm', 'wrap up', 'done all'] as const
export const confirmWord = (random = Math.random) => CONFIRM_WORDS[Math.floor(random() * CONFIRM_WORDS.length)]
/** Typed text matches the word: case and surrounding spaces don't matter. */
export const confirmMatches = (typed: string, word: string) => typed.trim().toLowerCase().replace(/\s+/g, ' ') === word
