/**
 * The morning brief: what needs the person today, worked out from what they can see. Shared by the server (which
 * builds it) and the browser (which shows it), so it stays free of React, the DOM and Node APIs.
 *
 * The facts are always counted here, never by the AI: the AI only words a short summary of them.
 */
import type { TaskSettings, WorkItem } from '../../shared/types'
import { isTaskArchived, isTaskFinished } from '../tasks/lifecycle'
import { type TimeEntry, unsentToSeeds } from '../tasks/effort'
import { goLiveColumn, siteTaskTitle, stepColumns } from '../trackers/stepTasks'
import type { Tracker, TrackerRow } from '../trackers/trackerModel'

/** How many of each kind the brief lists; the totals are always exact. */
export const BRIEF_LISTED = 5
/** A working day, as the app's capacity counts it (40 hours a week). */
export const BRIEF_DAY_HOURS = 8
/** Emails older than this no longer count as waiting. */
export const BRIEF_EMAIL_DAYS = 14
/** Go-lives this many days ahead count, and passed ones this many days back while steps are open. */
export const BRIEF_GO_LIVE_AHEAD = 6
export const BRIEF_GO_LIVE_BEHIND = 7

export type BriefItem = {
  id: string
  title: string
  /** For a subtask: its task. */
  parentTitle?: string
  client?: string
  project?: string
  /** The date that put it here (due or follow-up), and how many days from today (negative: passed). */
  date?: string
  days?: number
  waitingOn?: string
  priority?: string
}
export type BriefGoLive = {
  trackerId: string
  trackerName: string
  rowId: string
  site: string
  date: string
  days: number
  openSteps: number
  totalSteps: number
}
export type BriefEmail = {
  id: string
  source: string
  subject: string
  from: string
  receivedAt: string
  /** Whole days it has waited. */
  days: number
  unread: boolean
}
export type BriefTime = {
  /** The last working day before today. */
  day: string
  hours: number
  expected: number
  /** Logged for Seeds but not sent yet (only when Seeds is on), and the first tasks holding it, to open and resend. */
  unsent: { count: number; hours: number; failed: number; tasks: { id: string; title: string }[] } | null
}
export type BriefSection<T> = { total: number; items: T[] }
export type BriefFacts = {
  date: string
  firstName: string
  overdue: BriefSection<BriefItem>
  dueToday: BriefSection<BriefItem>
  followUps: BriefSection<BriefItem>
  goLives: BriefSection<BriefGoLive>
  /** Null when the person has no Work Hub. */
  emails: BriefSection<BriefEmail> | null
  time: BriefTime
}

// Dates as YYYY-MM-DD, counted in whole days without any time zone.
const DAY = 86_400_000
const isDateKey = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
const dayNumber = (key: string) =>
  Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10))) / DAY
export const addDayKeys = (key: string, days: number) =>
  new Date((dayNumber(key) + days) * DAY).toISOString().slice(0, 10)
export const daysBetween = (from: string, to: string) => Math.round(dayNumber(to) - dayNumber(from))
/** 0 Sunday … 6 Saturday. */
export const weekdayOf = (key: string) => new Date(dayNumber(key) * DAY).getUTCDay()
/** The working day before this one: Friday for a Monday or a weekend. */
export function previousWorkday(today: string) {
  const weekday = weekdayOf(today)
  return addDayKeys(today, weekday === 1 ? -3 : weekday === 0 ? -2 : -1)
}

const list = (value: unknown): any[] => (Array.isArray(value) ? value : [])
const text = (value: unknown) => String(value ?? '').trim()

/** The person's open work: assigned to them, not finished, not put away. */
export function openWorkFor(state: any, userId: string, settings: TaskSettings): WorkItem[] {
  const items = list(state?.items) as WorkItem[]
  return items.filter(
    item => text(item.assignedToUserId) === userId && !isTaskFinished(item, settings) && !isTaskArchived(items, item),
  )
}

/** A task as the brief and report show it: title, its task for a subtask, client and project names. */
export function describeItem(state: any, item: WorkItem): BriefItem {
  const items = list(state?.items) as WorkItem[]
  const name = (key: string, id?: string) =>
    id ? text(list(state?.[key]).find(record => record?.id === id)?.name) : ''
  const parent = item.parentTaskId ? items.find(other => other.id === item.parentTaskId) : undefined
  return {
    id: item.id,
    title: text(item.title) || 'Untitled',
    ...(parent ? { parentTitle: text(parent.title) } : {}),
    ...(name('clients', item.clientId) ? { client: name('clients', item.clientId) } : {}),
    ...(name('projects', item.projectId) ? { project: name('projects', item.projectId) } : {}),
    ...(text(item.priority) ? { priority: text(item.priority) } : {}),
  }
}

const section = <T>(all: T[], limit = BRIEF_LISTED): BriefSection<T> => ({
  total: all.length,
  items: all.slice(0, limit),
})

/** Go-lives on the trackers read: coming within the week, or passed in the last week with steps still open. */
export function goLivesFrom(loaded: { tracker: Tracker; rows: TrackerRow[] }[], today: string): BriefGoLive[] {
  const found: BriefGoLive[] = []
  for (const { tracker, rows } of loaded) {
    const column = goLiveColumn(tracker.columns || [])
    if (!column) continue
    const steps = stepColumns(tracker.columns || [])
    for (const row of rows) {
      const date = row.cells?.[column.id]
      if (!isDateKey(date)) continue
      const days = daysBetween(today, date)
      if (days > BRIEF_GO_LIVE_AHEAD || days < -BRIEF_GO_LIVE_BEHIND) continue
      const openSteps = steps.filter(step => row.cells?.[step.id] !== true).length
      if (days < 0 && !openSteps) continue
      found.push({
        trackerId: tracker.id,
        trackerName: text(tracker.name),
        rowId: row.id,
        site: siteTaskTitle(tracker.columns || [], row.cells || {}) || `Row ${Number(row.position ?? 0) + 1}`,
        date,
        days,
        openSteps,
        totalSteps: steps.length,
      })
    }
  }
  // Passed ones with open steps first, then the nearest.
  return found.sort((a, b) => a.days - b.days || b.openSteps - a.openSteps || a.site.localeCompare(b.site))
}

/**
 * Emails waiting on the person: conversations whose latest message is not one they sent, not resolved or archived,
 * from the last two weeks. Longest waiting first.
 */
export function waitingEmailsFrom(rows: any[], now: Date): BriefEmail[] {
  const cutoff = now.getTime() - BRIEF_EMAIL_DAYS * DAY
  const latest = new Map<string, any>()
  for (const row of rows) {
    const at = Date.parse(row?.received_at)
    if (!Number.isFinite(at) || at < cutoff) continue
    const key = `${text(row.source)}:${text(row.thread_id) || text(row.id)}`
    const seen = latest.get(key)
    if (!seen || Date.parse(seen.received_at) < at) latest.set(key, row)
  }
  return [...latest.values()]
    .filter(row => {
      const labels = list(row.source_labels).map(String)
      return !labels.includes('SENT') && !['Resolved', 'Archived'].includes(text(row.status))
    })
    .map(row => ({
      id: text(row.id),
      source: text(row.source) || 'Gmail',
      subject: text(row.subject).slice(0, 200) || '(no subject)',
      from: text(row.sender)
        .replace(/\s*<[^>]*>\s*$/, '')
        .replace(/^"|"$/g, '')
        .slice(0, 120),
      receivedAt: new Date(Date.parse(row.received_at)).toISOString(),
      days: Math.max(0, Math.floor((now.getTime() - Date.parse(row.received_at)) / DAY)),
      unread: !row.read_at,
    }))
    .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))
}

/** Time the person logged on the last working day, and what is still to go to Seeds. */
export function timeFor(state: any, userId: string, today: string): BriefTime {
  const day = previousWorkday(today)
  const mine = list(state?.items).flatMap(item =>
    list(item?.timeEntries).filter((entry: TimeEntry) => text(entry?.userId) === userId),
  ) as TimeEntry[]
  const hours = mine.filter(entry => entry.date === day).reduce((sum, entry) => sum + (Number(entry.hours) || 0), 0)
  const seedsOn = state?.seeds?.connected === true
  const unsent = mine.filter(unsentToSeeds)
  const unsentTasks = list(state?.items)
    .filter(item =>
      list(item?.timeEntries).some((entry: TimeEntry) => text(entry?.userId) === userId && unsentToSeeds(entry)),
    )
    .slice(0, 3)
    .map(item => ({ id: text(item.id), title: text(item.title).slice(0, 200) }))
  return {
    day,
    hours: Math.round(hours * 100) / 100,
    expected: BRIEF_DAY_HOURS,
    unsent: seedsOn
      ? {
          count: unsent.length,
          hours: Math.round(unsent.reduce((sum, entry) => sum + (Number(entry.hours) || 0), 0) * 100) / 100,
          failed: unsent.filter(entry => entry.seedsError).length,
          tasks: unsentTasks,
        }
      : null,
  }
}

/** The whole brief for one person. `state` is the part of the workspace they may see. */
export function briefFacts(input: {
  state: any
  user: { id: string; name: string }
  today: string
  settings: TaskSettings
  trackers?: { tracker: Tracker; rows: TrackerRow[] }[]
  /** The person's own Work Hub messages; leave out when they have no Work Hub. */
  emails?: any[]
  now?: Date
}): BriefFacts {
  const { state, user, today, settings } = input
  const open = openWorkFor(state, user.id, settings)
  const dated = (item: WorkItem, date: string): BriefItem => ({
    ...describeItem(state, item),
    date,
    days: daysBetween(today, date),
    ...(text(item.waitingOn) ? { waitingOn: text(item.waitingOn) } : {}),
  })
  const overdue = open
    .filter(item => isDateKey(item.dueDate) && item.dueDate < today)
    .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)))
  const dueToday = open.filter(item => item.dueDate === today)
  const listed = new Set([...overdue, ...dueToday].map(item => item.id))
  const followUps = open
    .filter(item => !listed.has(item.id) && isDateKey(item.followUpDate) && item.followUpDate <= today)
    .sort((a, b) => a.followUpDate.localeCompare(b.followUpDate))
  return {
    date: today,
    firstName: text(user.name).split(/\s+/)[0] || 'there',
    overdue: section(overdue.map(item => dated(item, String(item.dueDate)))),
    dueToday: section(dueToday.map(item => dated(item, today))),
    followUps: section(followUps.map(item => dated(item, item.followUpDate))),
    goLives: section(goLivesFrom(input.trackers || [], today), BRIEF_LISTED + 1),
    emails: input.emails ? section(waitingEmailsFrom(input.emails, input.now || new Date())) : null,
    time: timeFor(state, user.id, today),
  }
}

/** Whether anything needs the person: when nothing does, the brief says so instead of showing empty lists. */
export function briefIsClear(facts: BriefFacts) {
  return (
    !facts.overdue.total &&
    !facts.dueToday.total &&
    !facts.followUps.total &&
    !facts.goLives.total &&
    !facts.emails?.total &&
    facts.time.hours >= facts.time.expected &&
    !facts.time.unsent?.count
  )
}

/** What the AI summary may say: the facts it is given, and its answer cleaned to plain short text. */
export type BriefSummary = { summary: string; focus: string[]; generatedAt: string }
export function cleanBriefSummary(value: any, generatedAt: string): BriefSummary | null {
  const line = (input: unknown, max: number) =>
    String(input ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max)
  const summary = line(value?.summary, 500)
  if (!summary) return null
  // Each line once (the screen lists them by their text).
  const focus = [...new Set(list(value?.focus).map(item => line(item, 200)))].filter(Boolean).slice(0, 4)
  return { summary, focus, generatedAt }
}
