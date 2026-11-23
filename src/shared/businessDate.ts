import { useEffect, useState } from 'react'
import { dateFormat } from './intlFormat'

let timeZone = 'Asia/Manila'
export function setBusinessTimeZone(value: unknown) {
  if (typeof value !== 'string') return
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format()
    timeZone = value
  } catch {
    return
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('business-date-changed'))
}
export function businessDateKey(value: Date | string = new Date()) {
  const date = typeof value === 'string' ? new Date(value) : value
  const parts = dateFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const part = (type: string) => parts.find(p => p.type === type)?.value || ''
  return `${part('year')}-${part('month')}-${part('day')}`
}
/** How long until the business date next changes: the next midnight in the business time zone (at least 1 s). */
export function msUntilNextBusinessDay(now: Date = new Date()) {
  const parts = dateFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(now)
  const part = (type: string) => Number(parts.find(p => p.type === type)?.value || 0)
  const elapsed = ((part('hour') * 60 + part('minute')) * 60 + part('second')) * 1000 + now.getMilliseconds()
  return Math.max(1000, 86_400_000 - elapsed + 500)
}
/** Longest wait between checks, so a clock change or a sleeping computer can't leave the date stale for long. */
const RECHECK_MS = 15 * 60_000

/**
 * Today's business date. Checked at midnight in the business time zone (and every 15 minutes at most), when the
 * window gets focus or is shown again, and when the business time zone changes; not every second.
 */
export function useBusinessDate() {
  const [today, setToday] = useState(() => businessDateKey())
  useEffect(() => {
    let timer = 0
    const update = () => {
      setToday(businessDateKey())
      window.clearTimeout(timer)
      timer = window.setTimeout(update, Math.min(msUntilNextBusinessDay(), RECHECK_MS))
    }
    update()
    window.addEventListener('focus', update)
    window.addEventListener('business-date-changed', update)
    document.addEventListener('visibilitychange', update)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('focus', update)
      window.removeEventListener('business-date-changed', update)
      document.removeEventListener('visibilitychange', update)
    }
  }, [])
  return today
}
