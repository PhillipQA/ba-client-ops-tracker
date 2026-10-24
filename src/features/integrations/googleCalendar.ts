export type CalendarConnection = {
  enabled: boolean
  connected: boolean
  hasConnection: boolean
  email: string
  selectedCalendarIds: string[]
  reconnectRequired: boolean
}
export type CalendarChoice = { id: string; name: string; primary: boolean; timeZone: string }
export type CalendarEvent = {
  id: string
  calendarId: string
  title: string
  date: string
  endDate: string
  startTime: string
  endTime: string
  allDay: boolean
  notes: string
  location: string
  calendarLink?: string
}

export async function calendarRequest<T = any>(
  url: string,
  method = 'GET',
  data?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(url, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(result.error || 'Calendar request failed. Please retry.')
  return result as T
}
export function scheduleRange(mode: 'today' | 'week', today = new Date()) {
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  if (mode === 'week') start.setDate(start.getDate() - start.getDay())
  const end = new Date(start)
  end.setDate(end.getDate() + (mode === 'week' ? 7 : 1))
  return {
    start: start.toISOString(),
    end: end.toISOString(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Manila',
  }
}
