/**
 * The Timeline view: a Gantt chart of a tracker's rows, like a project schedule kept in a spreadsheet.
 * Pure functions, so the view and tests share them. Dates are ISO `YYYY-MM-DD` strings and are worked on as whole
 * days in UTC, so a bar never shifts with the viewer's time zone.
 */
import type { OptionColor, TrackerColumn, TrackerRow } from './trackerModel'

/** Which columns the timeline reads. Empty means "not used". */
export type TimelineFields = {
  startId: string
  endId: string
  progressId: string
  groupId: string
  statusId: string
  leadId: string
}

const named = (columns: TrackerColumn[], types: string[], pattern: RegExp, skip: string[] = []) =>
  columns.find(column => types.includes(column.type) && pattern.test(column.name) && !skip.includes(column.id))

/** Picks the columns by type and name: Start/End dates, % done, Phase, Status, Lead. Anything can be changed in the view. */
export function guessTimelineFields(columns: TrackerColumn[]): TimelineFields {
  const dates = columns.filter(column => column.type === 'date')
  const start = named(columns, ['date'], /start|begin|from|kick/i) || dates[0]
  const end =
    named(columns, ['date'], /end|finish|due|target|until|go.?live|deadline/i, start ? [start.id] : []) ||
    dates.find(column => column.id !== start?.id)
  const progress =
    named(columns, ['number', 'formula'], /%|percent|progress|complete|done/i) ||
    named(columns, ['number', 'formula'], /progress/i)
  const group = named(columns, ['select', 'text'], /phase|stage|workstream|milestone|epic/i)
  const status = named(columns, ['select'], /status|remarks|state/i, group ? [group.id] : [])
  const lead = named(columns, ['text', 'person'], /lead|owner|assign|responsible|who|pic/i)
  return {
    startId: start?.id || '',
    endId: end?.id || '',
    progressId: progress?.id || '',
    groupId: group?.id || '',
    statusId: status?.id || '',
    leadId: lead?.id || '',
  }
}

/** Keeps saved choices that still point at a usable column, and fills the rest with guesses. */
export function settleTimelineFields(columns: TrackerColumn[], saved: Partial<TimelineFields> | null): TimelineFields {
  const guess = guessTimelineFields(columns)
  const fits = (id: unknown, types: string[]) =>
    typeof id === 'string' && (id === '' || columns.some(column => column.id === id && types.includes(column.type)))
  const pick = (key: keyof TimelineFields, types: string[]) =>
    saved && key in saved && fits(saved[key], types) ? String(saved[key]) : guess[key]
  return {
    startId: pick('startId', ['date']),
    endId: pick('endId', ['date']),
    progressId: pick('progressId', ['number', 'formula']),
    groupId: pick('groupId', ['select', 'text', 'person']),
    statusId: pick('statusId', ['select']),
    leadId: pick('leadId', ['text', 'person']),
  }
}

// ---- days ----

const DAY = 86_400_000
const ISO = /^(\d{4})-(\d{2})-(\d{2})$/
/** Days since 1970-01-01 for an ISO date, or null. */
export function dayNumber(value: unknown): number | null {
  const match = typeof value === 'string' ? ISO.exec(value.trim().slice(0, 10)) : null
  if (!match) return null
  const time = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return Number.isFinite(time) ? Math.round(time / DAY) : null
}
export const isoOf = (day: number) => new Date(day * DAY).toISOString().slice(0, 10)
/** 0 = Sunday … 6 = Saturday. */
export const weekdayOf = (day: number) => new Date(day * DAY).getUTCDay()
/** The Monday on or before a day, as the sheet's weeks start on Monday. */
export const mondayOf = (day: number) => day - ((weekdayOf(day) + 6) % 7)
export const isWeekend = (day: number) => weekdayOf(day) === 0 || weekdayOf(day) === 6

/** Working days from start to end, both included, Monday to Friday (like NETWORKDAYS). */
export function workingDays(start: number, end: number): number {
  if (end < start) return 0
  let count = 0
  for (let day = start; day <= end; day++) if (!isWeekend(day)) count++
  return count
}

// ---- building the chart ----

export type TimelineItem = {
  row: TrackerRow
  start: number | null
  end: number | null
  /** 0–100. */
  progress: number
  status: { label: string; color: OptionColor } | null
  lead: string
  group: string
  /** The end has passed and it is not finished. */
  late: boolean
}
export type TimelineGroup = {
  key: string
  label: string
  items: TimelineItem[]
  start: number | null
  end: number | null
  /** 0–100: each scheduled item counts by its length in working days (at least one). */
  progress: number
}
export type Timeline = {
  groups: TimelineGroup[]
  /** First Monday and last Sunday shown. Null when no row has a date. */
  from: number | null
  to: number | null
  /** The Monday of the earliest start: week 1, as the sheet counts weeks. */
  weekOne: number | null
  scheduled: number
  unscheduled: number
}

const DONE = /^(done|completed?|finished|closed|live|approved|fixed)$/i

/**
 * Turns rows into bars. `rows` arrive already filtered and sorted. A row with only a start or only an end is a
 * one-day bar; a row with neither is listed without a bar. Values in a % column of 0–1 (as Excel stores 90%) are
 * read as fractions when no value in the column is above 1.
 */
export function buildTimeline(
  rows: TrackerRow[],
  columns: TrackerColumn[],
  fields: TimelineFields,
  options: { today: number; personName?: (id: string) => string; groupLabel?: (row: TrackerRow) => string },
): Timeline {
  const byId = new Map(columns.map(column => [column.id, column]))
  const statusColumn = byId.get(fields.statusId)
  const groupColumn = byId.get(fields.groupId)
  const leadColumn = byId.get(fields.leadId)
  const numbers = fields.progressId
    ? rows.map(row => row.cells[fields.progressId]).filter((value): value is number => typeof value === 'number')
    : []
  const fractions = numbers.length > 0 && numbers.every(value => value >= 0 && value <= 1)
  const textOf = (column: TrackerColumn | undefined, row: TrackerRow) => {
    if (!column) return ''
    const value = row.cells[column.id]
    if (column.type === 'select') return column.options?.find(option => option.id === value)?.label || ''
    if (column.type === 'person') return typeof value === 'string' && value ? options.personName?.(value) || '' : ''
    return typeof value === 'string' ? value.trim() : value == null ? '' : String(value)
  }

  const items: TimelineItem[] = rows.map(row => {
    let start = dayNumber(row.cells[fields.startId])
    let end = fields.endId ? dayNumber(row.cells[fields.endId]) : null
    if (start === null) start = end
    if (end === null) end = start
    if (start !== null && end !== null && end < start) [start, end] = [end, start]
    const option = statusColumn?.options?.find(item => item.id === row.cells[statusColumn.id])
    const status = option ? { label: option.label, color: option.color } : null
    const raw = fields.progressId ? row.cells[fields.progressId] : null
    let progress: number
    if (typeof raw === 'number' && Number.isFinite(raw)) progress = fractions ? raw * 100 : raw
    else progress = status && DONE.test(status.label) ? 100 : 0
    progress = Math.max(0, Math.min(100, Math.round(progress)))
    return {
      row,
      start,
      end,
      progress,
      status,
      lead: textOf(leadColumn, row),
      group: options.groupLabel ? options.groupLabel(row) : textOf(groupColumn, row),
      late: end !== null && end < options.today && progress < 100,
    }
  })

  // Groups keep the order their first row appears in, so the phases read top to bottom as in the sheet.
  const groups: TimelineGroup[] = []
  const byKey = new Map<string, TimelineGroup>()
  const grouped = Boolean(groupColumn || options.groupLabel)
  for (const item of items) {
    const key = grouped ? item.group.toLowerCase() : ''
    let group = byKey.get(key)
    if (!group) {
      group = { key, label: grouped ? item.group || 'No phase' : '', items: [], start: null, end: null, progress: 0 }
      byKey.set(key, group)
      groups.push(group)
    }
    group.items.push(item)
  }
  for (const group of groups) {
    let weight = 0,
      done = 0
    for (const item of group.items) {
      if (item.start === null || item.end === null) continue
      group.start = group.start === null ? item.start : Math.min(group.start, item.start)
      group.end = group.end === null ? item.end : Math.max(group.end, item.end)
      const days = Math.max(1, workingDays(item.start, item.end))
      weight += days
      done += (days * item.progress) / 100
    }
    group.progress = weight ? Math.round((done / weight) * 100) : 0
  }

  const scheduled = items.filter(item => item.start !== null)
  const first = scheduled.length ? Math.min(...scheduled.map(item => item.start!)) : null
  const last = scheduled.length ? Math.max(...scheduled.map(item => item.end!)) : null
  return {
    groups,
    from: first === null ? null : mondayOf(Math.min(first, options.today)),
    to: last === null ? null : mondayOf(Math.max(last, options.today)) + 6,
    weekOne: first === null ? null : mondayOf(first),
    scheduled: scheduled.length,
    unscheduled: items.length - scheduled.length,
  }
}

/** "Week 3" for a day, counting from the week the project starts in (week 1). */
export const weekLabel = (day: number, weekOne: number) => `Week ${Math.floor((mondayOf(day) - weekOne) / 7) + 1}`

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** "21 Jan", or "21 Jan 2026" with the year. */
export function shortDate(day: number, withYear = false) {
  const date = new Date(day * DAY)
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}${withYear ? ` ${date.getUTCFullYear()}` : ''}`
}
export const monthLabel = (day: number) => {
  const date = new Date(day * DAY)
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`
}

/** Today as a day number, in the viewer's own calendar. */
export function todayNumber(now = new Date()) {
  return Math.round(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / DAY)
}
