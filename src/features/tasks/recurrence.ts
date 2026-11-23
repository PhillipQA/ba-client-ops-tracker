/**
 * Recurring tasks: a task can repeat every N days (optionally workdays only), weeks (on chosen weekdays), months or
 * years, until an optional end date. When a repeating task is closed, the next one is made: a copy with the same
 * details, Open, its dates moved to the next occurrence, and its subtasks copied as Open subtasks. The closed task
 * remembers the copy (`recurrenceNextId`), so reopening and closing it again makes no second copy.
 *
 * The next due date counts from the closed task's due date (or start, follow-up, or the day it was closed), and is
 * never in the past: missed occurrences are skipped instead of piling up. Only top-level tasks repeat; their subtasks
 * come along. Nothing else about closing changes.
 */
import type { TaskSettings, WorkItem } from '../../shared/types'

/** A task's dates as the repeat rules read them (a task, or a form's dates as typed). */
type Dates = { dueDate?: string; startDate?: string; followUpDate?: string }

export type RepeatUnit = 'day' | 'week' | 'month' | 'year'
export type Recurrence = {
  every: number
  unit: RepeatUnit
  /** Weekly: the weekdays (0 = Sunday). Defaults to the due date's weekday. */
  weekdays?: number[]
  /** Daily: skip Saturdays and Sundays. */
  workdaysOnly?: boolean
  /** Monthly: the day of the month to keep (a short month uses its last day). Set from the due date. */
  monthDay?: number
  /** No copy is made for an occurrence after this day. */
  until?: string
}

const DAY = 86_400_000
const isDay = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
const time = (day: string) => Date.parse(`${day}T00:00:00Z`)
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const addDays = (day: string, count: number) => dayOf(time(day) + count * DAY)
const weekday = (day: string) => new Date(time(day)).getUTCDay()
const daysIn = (year: number, month: number) => new Date(Date.UTC(year, month + 1, 0)).getUTCDate()

/** A repeat rule as stored or sent, or undefined when it doesn't hold together. */
export function cleanRecurrence(raw: unknown): Recurrence | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const rule = raw as Record<string, unknown>
  const unit = ['day', 'week', 'month', 'year'].includes(rule.unit as string) ? (rule.unit as RepeatUnit) : null
  const every = Math.round(Number(rule.every))
  if (!unit || !Number.isFinite(every) || every < 1 || every > 99) return undefined
  const out: Recurrence = { every, unit }
  if (unit === 'week' && Array.isArray(rule.weekdays)) {
    const days = [...new Set(rule.weekdays.map(Number).filter(day => Number.isInteger(day) && day >= 0 && day <= 6))]
    if (days.length) out.weekdays = days.sort((a, b) => a - b)
  }
  if (unit === 'day' && rule.workdaysOnly === true) out.workdaysOnly = true
  if (unit === 'month') {
    const monthDay = Math.round(Number(rule.monthDay))
    if (monthDay >= 1 && monthDay <= 31) out.monthDay = monthDay
  }
  if (isDay(rule.until)) out.until = rule.until
  return out
}

/** The occurrence after `from` by the rule. */
export function nextOccurrence(from: string, rule: Recurrence): string {
  switch (rule.unit) {
    case 'day': {
      let next = addDays(from, rule.every)
      if (rule.workdaysOnly) while ([0, 6].includes(weekday(next))) next = addDays(next, 1)
      return next
    }
    case 'week': {
      const days = rule.weekdays?.length ? rule.weekdays : [weekday(from)]
      const today = weekday(from)
      const later = days.find(day => day > today)
      if (later !== undefined) return addDays(from, later - today)
      // The first chosen weekday of the week `every` weeks on.
      const weekStart = addDays(from, -today + 7 * rule.every)
      return addDays(weekStart, days[0])
    }
    case 'month': {
      const [year, month, day] = from.split('-').map(Number)
      const target = new Date(Date.UTC(year, month - 1 + rule.every, 1))
      const want = rule.monthDay || day
      const clamped = Math.min(want, daysIn(target.getUTCFullYear(), target.getUTCMonth()))
      return dayOf(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), clamped))
    }
    case 'year': {
      const [year, month, day] = from.split('-').map(Number)
      const nextYear = year + rule.every
      return dayOf(Date.UTC(nextYear, month - 1, Math.min(day, daysIn(nextYear, month - 1))))
    }
  }
}

/** The date a closed task's next copy counts from: due, start, follow-up, or the day it closed. */
export function anchorDay(item: Dates, today: string) {
  return [item.dueDate, item.startDate, item.followUpDate].find(isDay) || today
}

/**
 * The next occurrence on or after today (missed ones are skipped), or null when the series has ended (`until`).
 */
export function nextDueDay(
  item: Dates,
  rule: Recurrence,
  today: string,
) {
  let next = nextOccurrence(anchorDay(item, today), rule)
  for (let guard = 0; next < today && guard < 2000; guard++) next = nextOccurrence(next, rule)
  if (rule.until && next > rule.until) return null
  return next
}

const UNIT_NAMES: Record<RepeatUnit, [string, string]> = {
  day: ['day', 'days'],
  week: ['week', 'weeks'],
  month: ['month', 'months'],
  year: ['year', 'years'],
}
const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** "Every week on Mon, Thu", "Every 2 days (workdays)", "Every month on day 31 · until Dec 31, 2026". */
export function recurrenceText(rule: Recurrence) {
  const [one, many] = UNIT_NAMES[rule.unit]
  let text = rule.every === 1 ? `Every ${one}` : `Every ${rule.every} ${many}`
  if (rule.unit === 'week' && rule.weekdays?.length)
    text += ` on ${rule.weekdays.map(day => WEEKDAY_NAMES[day]).join(', ')}`
  if (rule.unit === 'day' && rule.workdaysOnly) text += ' (workdays)'
  if (rule.unit === 'month' && rule.monthDay) text += ` on day ${rule.monthDay}`
  if (rule.until) text += ` · until ${rule.until}`
  return text
}

type Ids = () => string

/**
 * The next copy of a closed repeating task, with its subtasks: Open, dates moved by the same number of days as the
 * due date moves, no comments, evidence, time, files or results carried over. Null when the series has ended.
 */
export function nextCopy(
  task: WorkItem,
  items: readonly WorkItem[],
  settings: { openStatus: string; openWaitingOn: WorkItem['waitingOn'] },
  today: string,
  newId: Ids = () => crypto.randomUUID(),
): WorkItem[] | null {
  const rule = cleanRecurrence(task.recurrence)
  if (!rule || task.parentTaskId) return null
  const due = nextDueDay(task, rule, today)
  if (!due) return null
  const shift = Math.round((time(due) - time(anchorDay(task, today))) / DAY)
  const move = (day: string | undefined) => (isDay(day) ? addDays(day, shift) : day)
  const fresh = (item: WorkItem, id: string, parentTaskId?: string): WorkItem => ({
    id,
    clientId: item.clientId,
    projectId: item.projectId,
    parentTaskId,
    subtaskOrder: item.subtaskOrder,
    title: item.title,
    type: item.type,
    priority: item.priority,
    status: settings.openStatus,
    waitingOn: settings.openWaitingOn,
    owner: item.owner,
    assignedToUserId: item.assignedToUserId,
    assignmentInherited: item.assignmentInherited,
    dateRaised: today,
    startDate: move(item.startDate),
    dueDate: move(item.dueDate),
    followUpDate: move(item.followUpDate) || '',
    description: item.description,
    resolution: '',
    source: item.source,
    estimateHours: item.estimateHours,
    productId: item.productId,
    seedsTaskId: item.seedsTaskId,
    ...(item.custom ? { custom: { ...item.custom } } : {}),
  })
  const id = newId()
  const head: WorkItem = {
    ...fresh(task, id),
    dueDate: due,
    recurrence:
      rule.unit === 'month' && !rule.monthDay ? { ...rule, monthDay: Number(anchorDay(task, today).slice(8)) } : rule,
    recurrenceOf: task.recurrenceOf || task.id,
  }
  const subtasks = items
    .filter(item => item.parentTaskId === task.id && !item.archived)
    .map(item => fresh(item, newId(), id))
  return [head, ...subtasks]
}

/**
 * After a change: every repeating task that has just been closed (it was open before) gets its next copy, once.
 * Returns the items with the copies added and the closed tasks pointing at them, plus what was made.
 */
export function withRecurrences(
  before: readonly WorkItem[],
  after: readonly WorkItem[],
  taskSettings: TaskSettings,
  isClosed: (status: string, settings: TaskSettings) => boolean,
  open: { openStatus: string; openWaitingOn: WorkItem['waitingOn'] },
  today: string,
  newId?: Ids,
): { items: WorkItem[]; made: { from: WorkItem; next: WorkItem }[] } {
  const was = new Map(before.map(item => [item.id, item]))
  const made: { from: WorkItem; next: WorkItem }[] = []
  const added: WorkItem[] = []
  const items = after.map(item => {
    if (!item.recurrence || item.recurrenceNextId || item.parentTaskId) return item
    const previous = was.get(item.id)
    if (!previous || isClosed(previous.status, taskSettings) || !isClosed(item.status, taskSettings)) return item
    const copy = nextCopy(item, after, open, today, newId)
    if (!copy) return item
    added.push(...copy)
    made.push({ from: item, next: copy[0] })
    return { ...item, recurrenceNextId: copy[0].id }
  })
  return { items: added.length ? [...items, ...added] : items, made }
}
