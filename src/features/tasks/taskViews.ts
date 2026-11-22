/**
 * The Tasks page's views of one filtered list: Table, Board, Calendar and Timeline, and each person's saved views
 * (a name for a set of filters plus a layout). Pure helpers for the Calendar's month grid and the Timeline's bars.
 * Dates are day keys (YYYY-MM-DD) handled in UTC, so no time zone shifts a day.
 */
import type { WorkItem } from '../../shared/types'
import type { BoardGroup, TaskLayout } from './taskBoardModel'

export type CalendarDate = 'due' | 'followUp'
export type TaskDateFilter = 'All' | 'due-3' | 'due-7' | 'followup-3' | 'followup-7' | 'overdue'
export const TASK_LAYOUTS: TaskLayout[] = ['table', 'board', 'calendar', 'timeline']
const DATE_FILTERS: TaskDateFilter[] = ['All', 'due-3', 'due-7', 'followup-3', 'followup-7', 'overdue']

export type TaskViewFilters = {
  query: string
  status: string
  client: string
  project: string
  date: TaskDateFilter
  waiting: string
}
export type SavedTaskView = {
  id: string
  name: string
  layout: TaskLayout
  group: BoardGroup
  subtasks: boolean
  calendarDate: CalendarDate
  filters: TaskViewFilters
}
export const MAX_SAVED_VIEWS = 30

const text = (value: unknown, max: number) => (typeof value === 'string' ? value.trim().slice(0, max) : '')

/** Saved views as stored (or sent): anything malformed is dropped, names are unique, at most MAX_SAVED_VIEWS. */
export function cleanSavedViews(raw: unknown): SavedTaskView[] {
  if (!Array.isArray(raw)) return []
  const out: SavedTaskView[] = []
  const names = new Set<string>()
  for (const entry of raw) {
    if (out.length >= MAX_SAVED_VIEWS) break
    if (!entry || typeof entry !== 'object') continue
    const view = entry as Record<string, any>
    const name = text(view.name, 60)
    const id = text(view.id, 60)
    if (!name || !id || names.has(name.toLowerCase())) continue
    names.add(name.toLowerCase())
    const filters = view.filters && typeof view.filters === 'object' ? view.filters : {}
    out.push({
      id,
      name,
      layout: TASK_LAYOUTS.includes(view.layout) ? view.layout : 'table',
      group: view.group === 'waiting' ? 'waiting' : 'status',
      subtasks: view.subtasks === true,
      calendarDate: view.calendarDate === 'followUp' ? 'followUp' : 'due',
      filters: {
        query: text(filters.query, 200),
        status: text(filters.status, 80),
        client: text(filters.client, 80),
        project: text(filters.project, 80),
        date: DATE_FILTERS.includes(filters.date) ? filters.date : 'All',
        waiting: text(filters.waiting, 80) || 'All',
      },
    })
  }
  return out
}

/** A saved view's text for its tooltip: "Board · Status: In Progress · Overdue". */
export function viewSummary(view: SavedTaskView) {
  const parts = [view.layout[0].toUpperCase() + view.layout.slice(1)]
  if (view.filters.status) parts.push(`Status: ${view.filters.status}`)
  if (view.filters.waiting && view.filters.waiting !== 'All') parts.push(`Waiting on: ${view.filters.waiting}`)
  if (view.filters.date !== 'All') parts.push(view.filters.date.replace('-', ' ').replace('followup', 'follow-up'))
  if (view.filters.query) parts.push(`“${view.filters.query}”`)
  return parts.join(' · ')
}

// ---- Day keys -------------------------------------------------------------------------------------------------

const DAY = 86_400_000
const toTime = (day: string) => Date.parse(`${day}T00:00:00Z`)
const toDay = (time: number) => new Date(time).toISOString().slice(0, 10)
export const isDay = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(toTime(value))
export const addDay = (day: string, count: number) => toDay(toTime(day) + count * DAY)
export const daysBetween = (from: string, to: string) => Math.round((toTime(to) - toTime(from)) / DAY)
/** 0 = Sunday. */
export const weekday = (day: string) => new Date(toTime(day)).getUTCDay()

// ---- Calendar ---------------------------------------------------------------------------------------------------

/** 'YYYY-MM' of a day. */
export const monthOf = (day: string) => day.slice(0, 7)
export function shiftMonth(month: string, by: number) {
  const [year, number] = month.split('-').map(Number)
  const date = new Date(Date.UTC(year, number - 1 + by, 1))
  return date.toISOString().slice(0, 7)
}
/** The weeks (Sunday to Saturday) that show a month, as day keys; days of other months fill the first and last week. */
export function monthGrid(month: string): string[][] {
  const first = `${month}-01`
  const last = addDay(`${shiftMonth(month, 1)}-01`, -1)
  const weeks: string[][] = []
  for (let start = addDay(first, -weekday(first)); start <= last; start = addDay(start, 7))
    weeks.push(Array.from({ length: 7 }, (_, offset) => addDay(start, offset)))
  return weeks
}
/** The tasks on each day by their due or follow-up date. */
export function itemsByDay(items: readonly WorkItem[], field: CalendarDate) {
  const days = new Map<string, WorkItem[]>()
  for (const item of items) {
    const day = field === 'due' ? item.dueDate : item.followUpDate
    if (!isDay(day)) continue
    const list = days.get(day)
    if (list) list.push(item)
    else days.set(day, [item])
  }
  return days
}

// ---- Timeline ---------------------------------------------------------------------------------------------------

export type TimelineZoom = 'week' | 'month'
/** Pixels per day at each zoom. */
export const DAY_WIDTH: Record<TimelineZoom, number> = { week: 28, month: 9 }
export type Span = { start: string; end: string; milestone: boolean }

/**
 * Where a task sits on the Timeline: a bar from its start date to its due date, or a single-day marker when it has
 * only one of them (a due date alone is a deadline). Tasks with neither are left off.
 */
export function spanOf(item: Pick<WorkItem, 'startDate' | 'dueDate'>): Span | null {
  const start = isDay(item.startDate) ? item.startDate : ''
  const due = isDay(item.dueDate) ? item.dueDate : ''
  if (start && due)
    return due >= start ? { start, end: due, milestone: false } : { start: due, end: start, milestone: false }
  const only = start || due
  return only ? { start: only, end: only, milestone: true } : null
}

/** The days the Timeline shows: every bar, plus a week before and two after today, from a Sunday. At most ~13 months. */
export function timelineRange(spans: readonly Span[], today: string): { start: string; days: number } {
  let first = addDay(today, -7)
  let last = addDay(today, 14)
  for (const span of spans) {
    if (span.start < first) first = span.start
    if (span.end > last) last = span.end
  }
  first = addDay(first, -weekday(first))
  const limit = addDay(first, 400)
  if (last > limit) last = limit
  return { start: first, days: daysBetween(first, last) + 7 }
}

/** The Timeline's rows: top-level tasks in date order, each followed by its subtasks (also in date order). */
export function timelineRows(items: readonly WorkItem[]): { item: WorkItem; span: Span; depth: number }[] {
  const dated = items
    .map(item => ({ item, span: spanOf(item) }))
    .filter((row): row is { item: WorkItem; span: Span } => Boolean(row.span))
  const order = (a: { span: Span; item: WorkItem }, b: { span: Span; item: WorkItem }) =>
    a.span.start.localeCompare(b.span.start) ||
    a.span.end.localeCompare(b.span.end) ||
    a.item.title.localeCompare(b.item.title)
  const shown = new Set(dated.map(row => row.item.id))
  const children = new Map<string, typeof dated>()
  const tops: typeof dated = []
  for (const row of dated) {
    const parent = row.item.parentTaskId
    if (parent && shown.has(parent)) {
      const list = children.get(parent)
      if (list) list.push(row)
      else children.set(parent, [row])
    } else tops.push(row)
  }
  return tops
    .sort(order)
    .flatMap(row => [
      { ...row, depth: 0 },
      ...(children.get(row.item.id) || []).sort(order).map(child => ({ ...child, depth: 1 })),
    ])
}
