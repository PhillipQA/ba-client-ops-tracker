/** What the "My time this week" and "Follow-ups due" widgets show, kept apart from the components for testing. */
import { unsentToSeeds } from '../tasks/effort'
import type { WorkItem } from '../../shared/types'

const DAY = 86_400_000
const dayKey = (time: number) => new Date(time).toISOString().slice(0, 10)
const LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/** Monday to Sunday of the week holding `today` (YYYY-MM-DD). */
export function weekDays(today: string) {
  const at = Date.parse(`${today}T00:00:00Z`)
  const monday = at - ((new Date(at).getUTCDay() + 6) % 7) * DAY
  return LABELS.map((label, index) => ({ date: dayKey(monday + index * DAY), label }))
}

export type WeekTime = {
  days: { date: string; label: string; hours: number }[]
  total: number
  target: number
  /** The target for a working day (Monday to Friday). */
  daily: number
  unsentEntries: number
  unsentHours: number
}

const round = (value: number) => Math.round(value * 100) / 100

/** The person's hours this week, by day, against their weekly target; and their time still to send to Seeds. */
export function timeThisWeek(items: WorkItem[], meId: string, today: string, weeklyHours: number): WeekTime {
  const days = weekDays(today).map(day => ({ ...day, hours: 0 }))
  const byDate = new Map(days.map(day => [day.date, day]))
  let unsentEntries = 0,
    unsentHours = 0
  for (const item of items)
    for (const entry of item.timeEntries || []) {
      if (entry.userId !== meId) continue
      const hours = Number(entry.hours) || 0
      const day = byDate.get(String(entry.date || '').slice(0, 10))
      if (day) day.hours += hours
      if (unsentToSeeds(entry)) {
        unsentEntries += 1
        unsentHours += hours
      }
    }
  for (const day of days) day.hours = round(day.hours)
  return {
    days,
    total: round(days.reduce((sum, day) => sum + day.hours, 0)),
    target: weeklyHours,
    daily: round(weeklyHours / 5),
    unsentEntries,
    unsentHours: round(unsentHours),
  }
}

const RANK: Record<string, number> = { Urgent: 3, High: 2, Medium: 1, Low: 0 }

/** Open work to follow up today or before: the oldest first, then the most urgent. */
export function followUpsDue(open: WorkItem[], today: string) {
  return open
    .filter(item => item.followUpDate && item.followUpDate <= today)
    .sort(
      (a, b) =>
        a.followUpDate.localeCompare(b.followUpDate) ||
        (RANK[b.priority] ?? 0) - (RANK[a.priority] ?? 0) ||
        a.title.localeCompare(b.title),
    )
}

/** "Today", "Yesterday", "3 days late". */
export function lateness(date: string, today: string) {
  const days = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / DAY)
  return days <= 0 ? 'Today' : days === 1 ? 'Yesterday' : `${days} days late`
}
