// Effort tracking: optional per-task estimates and time entries.
// Shared by the browser and the server, so this module stays free of React and Node APIs.

export const EFFORT_CATEGORIES = [
  'Analysis',
  'Meeting',
  'Documentation',
  'Testing / UAT',
  'Client comms',
  'Other',
] as const
export type EffortCategory = (typeof EFFORT_CATEGORIES)[number]

export const MAX_ENTRY_HOURS = 24
export const MAX_ESTIMATE_HOURS = 1000
export const MAX_ENTRY_NOTE_LENGTH = 500
export const MAX_ENTRIES_PER_TASK = 2000
/** Default weekly capacity until per-user capacity is configurable. */
export const DEFAULT_WEEKLY_CAPACITY_HOURS = 40

export interface TimeEntry {
  id: string
  date: string
  hours: number
  category: EffortCategory
  note: string
  userId: string
  userName: string
  createdAt: string
}

export interface TimeEntryInput {
  date: string
  hours: number
  category: EffortCategory
  note: string
}

interface EffortItem {
  id: string
  parentTaskId?: string
  estimateHours?: number
  timeEntries?: TimeEntry[]
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export function isDateKey(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

/** Hours are kept to the nearest quarter hour so totals stay exact. */
export function roundToQuarter(hours: number) {
  return Math.round(hours * 4) / 4
}

export function isEffortCategory(value: unknown): value is EffortCategory {
  return typeof value === 'string' && (EFFORT_CATEGORIES as readonly string[]).includes(value)
}

export function validateTimeEntryInput(
  input: unknown,
): { ok: true; value: TimeEntryInput } | { ok: false; error: string } {
  const body = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  if (!isDateKey(body.date)) return { ok: false, error: 'Choose a valid date for the time entry.' }
  const rawHours = typeof body.hours === 'string' ? Number(body.hours) : body.hours
  if (typeof rawHours !== 'number' || !Number.isFinite(rawHours))
    return { ok: false, error: 'Enter the hours spent as a number.' }
  const hours = roundToQuarter(rawHours)
  if (hours < 0.25) return { ok: false, error: 'Log at least 15 minutes (0.25 hours).' }
  if (hours > MAX_ENTRY_HOURS) return { ok: false, error: `A single entry cannot exceed ${MAX_ENTRY_HOURS} hours.` }
  if (!isEffortCategory(body.category)) return { ok: false, error: 'Choose a work category.' }
  const note = typeof body.note === 'string' ? body.note.trim() : ''
  if (note.length > MAX_ENTRY_NOTE_LENGTH)
    return { ok: false, error: `Notes must be ${MAX_ENTRY_NOTE_LENGTH} characters or fewer.` }
  return { ok: true, value: { date: body.date, hours, category: body.category, note } }
}

/**
 * Normalizes an estimate supplied by a workspace save. Blank means "no estimate".
 * Returns an error string for values that cannot be stored.
 */
export function normalizeEstimate(
  value: unknown,
): { ok: true; value: number | undefined } | { ok: false; error: string } {
  if (value === undefined || value === null || value === '') return { ok: true, value: undefined }
  const raw = typeof value === 'string' ? Number(value) : value
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0)
    return { ok: false, error: 'Estimates must be a number of hours of 0 or more.' }
  const hours = roundToQuarter(raw)
  if (hours > MAX_ESTIMATE_HOURS) return { ok: false, error: `Estimates cannot exceed ${MAX_ESTIMATE_HOURS} hours.` }
  return { ok: true, value: hours === 0 ? undefined : hours }
}

export function sumEntryHours(entries: readonly TimeEntry[] | undefined) {
  return roundToQuarter(
    (entries || []).reduce((total, entry) => total + (Number.isFinite(entry?.hours) ? entry.hours : 0), 0),
  )
}

export interface EffortSummary {
  /** The task's own estimate, or the sum of its subtasks' estimates when it has none. */
  estimate?: number
  estimateFromSubtasks: boolean
  ownLogged: number
  subtaskLogged: number
  logged: number
  /** Positive when logged time exceeds the estimate. */
  overBy: number
  /** Logged as a percentage of the estimate; undefined without an estimate. */
  percent?: number
  byCategory: { category: EffortCategory; hours: number }[]
}

/** Effort for one task. A parent task rolls up its subtasks' time and, when it has no estimate, their estimates. */
export function effortSummary(item: EffortItem, allItems: readonly EffortItem[] = []): EffortSummary {
  const children = item.parentTaskId ? [] : allItems.filter(candidate => candidate.parentTaskId === item.id)
  const ownLogged = sumEntryHours(item.timeEntries)
  const subtaskLogged = sumEntryHours(children.flatMap(child => child.timeEntries || []))
  const logged = roundToQuarter(ownLogged + subtaskLogged)
  const childEstimates = children
    .map(child => child.estimateHours)
    .filter((value): value is number => typeof value === 'number' && value > 0)
  const ownEstimate = typeof item.estimateHours === 'number' && item.estimateHours > 0 ? item.estimateHours : undefined
  const estimate =
    ownEstimate ?? (childEstimates.length ? roundToQuarter(childEstimates.reduce((a, b) => a + b, 0)) : undefined)
  const totals = new Map<EffortCategory, number>()
  for (const entry of [...(item.timeEntries || []), ...children.flatMap(child => child.timeEntries || [])]) {
    if (!isEffortCategory(entry?.category) || !Number.isFinite(entry?.hours)) continue
    totals.set(entry.category, (totals.get(entry.category) || 0) + entry.hours)
  }
  return {
    estimate,
    estimateFromSubtasks: ownEstimate === undefined && estimate !== undefined,
    ownLogged,
    subtaskLogged,
    logged,
    overBy: estimate === undefined ? 0 : Math.max(0, roundToQuarter(logged - estimate)),
    percent: estimate ? Math.round((logged / estimate) * 100) : undefined,
    byCategory: EFFORT_CATEGORIES.filter(category => totals.has(category)).map(category => ({
      category,
      hours: roundToQuarter(totals.get(category) || 0),
    })),
  }
}

export function formatHours(hours: number) {
  const rounded = roundToQuarter(hours)
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(2).replace(/0$/, '')}h`
}

/** Monday–Friday days in an inclusive date range. */
export function workingDaysBetween(from: string, to: string) {
  if (!isDateKey(from) || !isDateKey(to) || to < from) return 0
  const [fy, fm, fd] = from.split('-').map(Number)
  const [ty, tm, td] = to.split('-').map(Number)
  const cursor = new Date(Date.UTC(fy, fm - 1, fd))
  const end = Date.UTC(ty, tm - 1, td)
  let days = 0
  while (cursor.getTime() <= end) {
    const weekday = cursor.getUTCDay()
    if (weekday !== 0 && weekday !== 6) days += 1
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return days
}

export function capacityHoursBetween(from: string, to: string, weeklyHours = DEFAULT_WEEKLY_CAPACITY_HOURS) {
  return roundToQuarter(workingDaysBetween(from, to) * (weeklyHours / 5))
}

export interface EffortRow<T> {
  item: T
  entry: TimeEntry
}

/** Flattens time entries for reporting. The user filter matches who logged the time, not the assignee. */
export function effortRows<T extends EffortItem & { clientId?: string; projectId?: string }>(
  items: readonly T[],
  filter: { from: string; to: string; clientId?: string; projectId?: string; userId?: string },
): EffortRow<T>[] {
  const rows: EffortRow<T>[] = []
  for (const item of items) {
    if (filter.clientId && item.clientId !== filter.clientId) continue
    if (filter.projectId && item.projectId !== filter.projectId) continue
    for (const entry of item.timeEntries || []) {
      if (!entry || entry.date < filter.from || entry.date > filter.to) continue
      if (filter.userId && entry.userId !== filter.userId) continue
      rows.push({ item, entry })
    }
  }
  return rows.sort(
    (a, b) => b.entry.date.localeCompare(a.entry.date) || b.entry.createdAt.localeCompare(a.entry.createdAt),
  )
}

/** Whether the person may remove an entry: its author, or an Administrator. */
export function canRemoveTimeEntry(entry: Pick<TimeEntry, 'userId'>, user: { id: string; role?: string }) {
  return user.role === 'Administrator' || entry.userId === user.id
}
