import { businessDateKey } from './businessDate'
import type { PlannerActivity } from './types'
import { dateFormat } from './intlFormat'

export function localDateKey(date: Date) {
  const yyyy = date.getFullYear()
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

export function todayOrLater(date: string) {
  return date && date >= businessDateKey()
}

export function niceDate(date: string) {
  if (!date) return '—'
  const [year, month, day] = date.split('-').map(Number)
  return dateFormat('en', {
    month: 'short',
    day: 'numeric',
    year: year === new Date().getFullYear() ? undefined : 'numeric',
  }).format(new Date(Date.UTC(year, month - 1, day)))
}

export function dateFromKey(date: string) {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(year, month - 1, day)
}

export function addDays(date: string, amount: number) {
  const next = dateFromKey(date)
  next.setDate(next.getDate() + amount)
  return localDateKey(next)
}

export function weekStartKey(date: string) {
  const value = dateFromKey(date)
  return addDays(date, -value.getDay())
}

export function weekEndKey(date: string) {
  return addDays(weekStartKey(date), 6)
}

export function activityTime(activity: PlannerActivity) {
  if (activity.allDay) return 'All day'
  if (!activity.startTime) return 'Time not set'
  return activity.endTime ? `${activity.startTime}–${activity.endTime}` : activity.startTime
}
