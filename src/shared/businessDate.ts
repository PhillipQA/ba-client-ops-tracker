import { useEffect, useState } from 'react'

let timeZone = 'Asia/Manila'
export function setBusinessTimeZone(value: unknown) {
  if (typeof value !== 'string') return
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(); timeZone = value }
  catch { return }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('business-date-changed'))
}
export function businessDateKey(value: Date | string = new Date()) {
  const date = typeof value === 'string' ? new Date(value) : value
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date)
  const part = (type: string) => parts.find(p => p.type === type)?.value || ''
  return `${part('year')}-${part('month')}-${part('day')}`
}
export function useBusinessDate() {
  const [today, setToday] = useState(() => businessDateKey())
  useEffect(() => {
    const update = () => setToday(businessDateKey())
    update()
    const timer = window.setInterval(update, 1000)
    window.addEventListener('focus', update)
    window.addEventListener('business-date-changed', update)
    document.addEventListener('visibilitychange', update)
    return () => { window.clearInterval(timer); window.removeEventListener('focus', update); window.removeEventListener('business-date-changed', update); document.removeEventListener('visibilitychange', update) }
  }, [])
  return today
}
