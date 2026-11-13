/**
 * Changes to existing tasks that are prepared for the person to approve with one click: a due date, a follow-up date,
 * a priority, an open status, or who it is waiting on. The BA Assistant drafts them (kind "task_update") and the
 * heads-ups offer the common ones ("Due tomorrow") without any AI.
 *
 * Shared by the server (which checks what the AI drafted) and the browser (which applies an approved change through
 * the app's usual save). Closing, reopening and reassigning stay on the task itself: they have their own questions
 * (open subtasks, inherited assignees), and one click should not skip them.
 */
import type { TaskSettings, WorkItem } from '../../shared/types'
import { isTaskArchived, isTaskFinished } from '../tasks/lifecycle'
import { openWaitingOnOptions } from '../tasks/waitingOn'

export const TASK_UPDATE_FIELDS = ['dueDate', 'followUpDate', 'priority', 'status', 'waitingOn'] as const
export type TaskUpdateField = (typeof TASK_UPDATE_FIELDS)[number]
export const TASK_UPDATE_LIMIT = 10

export type TaskFieldChange = { field: TaskUpdateField; label: string; from: string; to: string }
export type TaskUpdateDraft = { taskId: string; title: string; changes: TaskFieldChange[] }
export type TaskUpdate = { tasks: TaskUpdateDraft[] }

const LABELS: Record<TaskUpdateField, string> = {
  dueDate: 'Due date',
  followUpDate: 'Follow-up date',
  priority: 'Priority',
  status: 'Status',
  waitingOn: 'Waiting on',
}
const PRIORITIES = ['Low', 'Medium', 'High', 'Urgent']
const isDate = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
const text = (value: unknown) => String(value ?? '').trim()

/** Open statuses a task may be moved to here. */
export function openStatuses(settings: TaskSettings) {
  return (settings?.statuses || []).filter(status => !status.closed).map(status => status.label)
}

/** A new value for a field, as it would be stored; undefined when it is not one the field takes. */
function valueFor(field: TaskUpdateField, value: unknown, settings: TaskSettings): string | undefined {
  const given = text(value)
  if (field === 'dueDate' || field === 'followUpDate') return given === '' || isDate(given) ? given : undefined
  const among = (options: string[]) => options.find(option => option.toLowerCase() === given.toLowerCase())
  if (field === 'priority') return among(PRIORITIES)
  if (field === 'status') return among(openStatuses(settings))
  return among(openWaitingOnOptions(settings).map(option => option.label))
}

/** Why this person cannot change a task here; empty when they can. */
export function taskUpdateBlock(
  items: WorkItem[],
  item: WorkItem | undefined,
  settings: TaskSettings,
  mayEdit: (item: WorkItem) => boolean,
) {
  if (!item) return 'it is no longer there'
  if (isTaskArchived(items, item)) return 'it is archived'
  if (isTaskFinished(item, settings)) return 'it is already closed'
  if (!mayEdit(item)) return 'it is assigned to someone else'
  return ''
}

/**
 * Checks requested changes ({ taskId, dueDate?, followUpDate?, priority?, status?, waitingOn? }) against the tasks:
 * only tasks this person may change, only values the field takes, only real changes. Each change records the value
 * it replaces, so a task changed in the meantime is not overwritten.
 */
export function draftTaskUpdates(
  requested: unknown,
  items: WorkItem[],
  settings: TaskSettings,
  mayEdit: (item: WorkItem) => boolean,
): TaskUpdate {
  const tasks: TaskUpdateDraft[] = []
  const seen = new Set<string>()
  for (const raw of Array.isArray(requested) ? requested : []) {
    if (!raw || typeof raw !== 'object') continue
    const taskId = text((raw as Record<string, unknown>).taskId)
    const item = items.find(entry => `${entry.id}` === taskId)
    if (!item || seen.has(taskId) || taskUpdateBlock(items, item, settings, mayEdit)) continue
    const changes: TaskFieldChange[] = []
    for (const field of TASK_UPDATE_FIELDS) {
      if (!(field in raw)) continue
      const to = valueFor(field, (raw as Record<string, unknown>)[field], settings)
      const from = text(item[field])
      if (to === undefined || to === from) continue
      changes.push({ field, label: LABELS[field], from, to })
    }
    if (!changes.length) continue
    seen.add(taskId)
    tasks.push({ taskId, title: text(item.title).slice(0, 200) || 'Untitled', changes })
    if (tasks.length >= TASK_UPDATE_LIMIT) break
  }
  return { tasks }
}

export type TaskUpdateResult = {
  items: WorkItem[]
  /** Titles of the tasks changed. */
  done: string[]
  skipped: { title: string; reason: string }[]
}
/** Applies approved changes. A task that cannot be changed any more, or was changed since, is skipped and said so. */
export function applyTaskUpdates(
  items: WorkItem[],
  settings: TaskSettings,
  update: TaskUpdate,
  mayEdit: (item: WorkItem) => boolean,
  today: string,
): TaskUpdateResult {
  const done: string[] = []
  const skipped: TaskUpdateResult['skipped'] = []
  let next = items
  for (const draft of (update?.tasks || []).slice(0, TASK_UPDATE_LIMIT)) {
    const item = next.find(entry => `${entry.id}` === draft.taskId)
    const block = taskUpdateBlock(next, item, settings, mayEdit)
    if (!item || block) {
      skipped.push({ title: draft.title, reason: block })
      continue
    }
    const patch: Partial<WorkItem> = {}
    let stale = ''
    for (const change of draft.changes || []) {
      if (!TASK_UPDATE_FIELDS.includes(change.field)) continue
      const to = valueFor(change.field, change.to, settings)
      if (to === undefined) continue
      if (text(item[change.field]) !== text(change.from)) stale = change.label.toLowerCase()
      else Object.assign(patch, { [change.field]: to })
    }
    if (stale || !Object.keys(patch).length) {
      skipped.push({ title: draft.title, reason: stale ? `its ${stale} changed since` : 'nothing to change' })
      continue
    }
    if (patch.status === 'In Progress' && !item.startDate) patch.startDate = today
    next = next.map(entry => (entry === item ? { ...entry, ...patch } : entry))
    done.push(text(item.title) || draft.title)
  }
  return { items: next, done, skipped }
}

/** What happened, in a sentence. */
export function taskUpdateMessage(result: Pick<TaskUpdateResult, 'done' | 'skipped'>) {
  const count = result.done.length
  const changed = count === 1 ? `Updated “${result.done[0]}”.` : count ? `Updated ${count} tasks.` : ''
  const left = result.skipped.length
    ? `Not changed: ${result.skipped.map(skip => `“${skip.title}” (${skip.reason})`).join('; ')}.`
    : ''
  return [changed, left].filter(Boolean).join(' ')
}

/** A shown value: dates as they are, an empty one as "none". */
export const shownValue = (value: string) => value || 'none'
