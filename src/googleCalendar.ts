import type { PlannerActivity } from './types'

type GoogleTokenResponse = {
  access_token?: string
  error?: string
  error_description?: string
}

type GoogleTokenClient = {
  callback: (response: GoogleTokenResponse) => void
  requestAccessToken: (options?: { prompt?: string }) => void
}

type GoogleCalendarEvent = {
  id?: string
  summary?: string
  description?: string
  htmlLink?: string
  status?: string
  start?: { date?: string; dateTime?: string }
  end?: { date?: string; dateTime?: string }
}

declare global {
  interface Window {
    google?: {
      accounts?: {
        oauth2?: {
          initTokenClient: (config: {
            client_id: string
            scope: string
            callback: (response: GoogleTokenResponse) => void
          }) => GoogleTokenClient
        }
      }
    }
  }
}

const GIS_SRC = 'https://accounts.google.com/gsi/client'
const READ_ONLY_SCOPE = 'https://www.googleapis.com/auth/calendar.events.readonly'

function localDateKey(date: Date) {
  const yyyy = date.getFullYear()
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

function localTimeKey(date: Date) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function loadGoogleIdentityServices() {
  if (window.google?.accounts?.oauth2) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GIS_SRC}"]`)
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true })
      existing.addEventListener('error', () => reject(new Error('Could not load Google Identity Services.')), { once: true })
      return
    }
    const script = document.createElement('script')
    script.src = GIS_SRC
    script.async = true
    script.defer = true
    script.addEventListener('load', () => resolve(), { once: true })
    script.addEventListener('error', () => reject(new Error('Could not load Google Identity Services.')), { once: true })
    document.head.appendChild(script)
  })
}

async function requestCalendarAccessToken(clientId: string) {
  await loadGoogleIdentityServices()
  const oauth2 = window.google?.accounts?.oauth2
  if (!oauth2) throw new Error('Google Identity Services did not initialize.')

  return new Promise<string>((resolve, reject) => {
    const client = oauth2.initTokenClient({
      client_id: clientId,
      scope: READ_ONLY_SCOPE,
      callback: (response) => {
        if (response.error || !response.access_token) {
          reject(new Error(response.error_description || response.error || 'Google Calendar authorization was not completed.'))
          return
        }
        resolve(response.access_token)
      },
    })
    client.requestAccessToken({ prompt: 'consent' })
  })
}

function mapEvent(event: GoogleCalendarEvent): PlannerActivity | null {
  if (!event.id || event.status === 'cancelled' || !event.start) return null
  const allDay = Boolean(event.start.date)
  const startDate = event.start.dateTime ? new Date(event.start.dateTime) : null
  const endDateTime = event.end?.dateTime ? new Date(event.end.dateTime) : null
  const date = event.start.date || (startDate ? localDateKey(startDate) : '')
  if (!date) return null
  let activityEndDate = endDateTime ? localDateKey(endDateTime) : date
  if (allDay && event.end?.date) {
    const exclusiveEnd = new Date(`${event.end.date}T00:00:00`)
    exclusiveEnd.setDate(exclusiveEnd.getDate() - 1)
    activityEndDate = localDateKey(exclusiveEnd)
  }

  return {
    id: crypto.randomUUID(),
    title: event.summary || '(Untitled calendar event)',
    date,
    startTime: allDay || !startDate ? '' : localTimeKey(startDate),
    endTime: allDay || !endDateTime ? '' : localTimeKey(endDateTime),
    endDate: activityEndDate,
    allDay,
    source: 'Google Calendar',
    status: 'Planned',
    notes: event.description || '',
    calendarEventId: event.id,
    calendarLink: event.htmlLink,
  }
}

export async function importPrimaryCalendar(clientId: string, startIso: string, endIso: string) {
  const token = await requestCalendarAccessToken(clientId)
  const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events')
  url.searchParams.set('singleEvents', 'true')
  url.searchParams.set('orderBy', 'startTime')
  url.searchParams.set('maxResults', '250')
  url.searchParams.set('timeMin', startIso)
  url.searchParams.set('timeMax', endIso)

  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Google Calendar import failed (${response.status}). ${text.slice(0, 180)}`)
  }

  const payload = await response.json() as { items?: GoogleCalendarEvent[] }
  return (payload.items ?? []).map(mapEvent).filter((item): item is PlannerActivity => Boolean(item))
}
