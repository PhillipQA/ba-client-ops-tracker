/**
 * Logging time straight from a Google Calendar event (server/seeds/calendar-time.ts): no task needed. The form starts
 * from the event (its date, its length in 15-minute steps, its title as the remarks); the person picks the Seeds
 * project, and the client when the project has none of its own. The entry is kept with the event and sent to Seeds
 * with the person's other time. One entry per event.
 */
import { Clock3, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Store } from '../../app/store'
import { requestJson } from '../../shared/http'
import { Dialog } from '../../shared/ui/Dialog'
import ClientSelect, { SearchSelect } from '../../shared/ui/SearchSelect'
import { isClosedProject } from '../tasks/lifecycle'
import { formatHours, MAX_SEEDS_REMARKS_LENGTH, seedsTimeRule, type TimeEntry } from '../tasks/effort'
import { SendToSeedsButton } from '../seeds/SendToSeeds'
import type { CalendarEvent } from './googleCalendar'

export type CalendarTimeEntry = TimeEntry & {
  eventId: string
  eventTitle: string
  projectId: string
  clientId?: string
}
type Listing = { ready: boolean; entries: CalendarTimeEntry[] }

/** The person's calendar time, read once when the panel opens; `ready` once Seeds is on. */
export function useCalendarTime(enabled: boolean) {
  const [listing, setListing] = useState<Listing>({ ready: false, entries: [] })
  const reload = useCallback(async () => {
    try {
      setListing(await requestJson<Listing>('/api/seeds/calendar-time', { fallback: 'Calendar time could not load.' }))
    } catch {
      setListing({ ready: false, entries: [] })
    }
  }, [])
  useEffect(() => {
    if (enabled) void reload()
  }, [enabled, reload])
  const setEntries = (entries: CalendarTimeEntry[]) => setListing(current => ({ ...current, entries }))
  return { ...listing, setEntries, reload }
}

/** The event's length in hours, in 15-minute steps (at least 15 minutes); none for an all-day event. */
export function eventHours(event: Pick<CalendarEvent, 'allDay' | 'startTime' | 'endTime'>) {
  if (event.allDay) return 0
  const minutes = (time: string) => {
    const [h, m] = time.split(':').map(Number)
    return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : Number.NaN
  }
  const length = minutes(event.endTime) - minutes(event.startTime)
  if (!Number.isFinite(length) || length <= 0) return 0
  return Math.max(15, Math.round(length / 15) * 15) / 60
}

/** On an event's card: what was logged for it (with Send and Remove), or Log time. */
export function CalendarTimeBlock({
  event,
  store,
  entry,
  onEntries,
}: {
  event: CalendarEvent
  store: Store
  entry?: CalendarTimeEntry
  onEntries: (entries: CalendarTimeEntry[]) => void
}) {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')
  if (!entry)
    return (
      <>
        <button type="button" className="secondary compact" onClick={() => setOpen(true)}>
          <Clock3 size={14} aria-hidden="true" /> Log time
        </button>
        {open && (
          <CalendarTimeDialog
            event={event}
            store={store}
            onClose={() => setOpen(false)}
            onSaved={entries => {
              onEntries(entries)
              setOpen(false)
            }}
          />
        )}
      </>
    )
  const project = store.projects.find(candidate => candidate.id === entry.projectId)
  const remove = async () => {
    setError('')
    try {
      const result = await requestJson<{ entries: CalendarTimeEntry[] }>(
        `/api/seeds/calendar-time/${encodeURIComponent(entry.id)}`,
        { method: 'DELETE', fallback: 'The time could not be removed.' },
      )
      onEntries(result.entries)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The time could not be removed.')
    }
  }
  const summary = `${formatHours(entry.hours)} on ${project?.name || 'a project'} ·`
  const status = entry.seedsEntryId ? 'In Seeds' : 'Not sent'
  return (
    <div className="calendar-time">
      <span>
        <Clock3 size={14} aria-hidden="true" /> {summary} <strong>{status}</strong>
      </span>
      {entry.seedsError && !entry.seedsEntryId && <small role="alert">{entry.seedsError}</small>}
      {!entry.seedsEntryId && (
        <span className="calendar-time-actions">
          <SendToSeedsButton
            entryIds={[entry.id]}
            className="secondary compact"
            onSent={result => {
              if (result.calendarTime) onEntries(result.calendarTime)
            }}
          />
          <button type="button" className="secondary compact" onClick={() => void remove()}>
            <Trash2 size={14} aria-hidden="true" /> Remove
          </button>
        </span>
      )}
      {error && <small role="alert">{error}</small>}
    </div>
  )
}

const HOURS = Array.from({ length: 13 }, (_, hour) => hour)
const MINUTES = [0, 15, 30, 45]

function CalendarTimeDialog({
  event,
  store,
  onClose,
  onSaved,
}: {
  event: CalendarEvent
  store: Store
  onClose: () => void
  onSaved: (entries: CalendarTimeEntry[]) => void
}) {
  const start = eventHours(event)
  const [projectId, setProjectId] = useState('')
  const [clientId, setClientId] = useState('')
  const [date, setDate] = useState(event.date)
  const [hours, setHours] = useState(Math.floor(start))
  const [minutes, setMinutes] = useState(Math.round((start % 1) * 60))
  const [seedsTaskId, setSeedsTaskId] = useState('')
  const [productId, setProductId] = useState('')
  const [note, setNote] = useState(event.title.slice(0, MAX_SEEDS_REMARKS_LENGTH))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const projects = useMemo(
    () =>
      store.projects
        .filter(project => project.seedsId && !project.accessLimited && !isClosedProject(project))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(project => ({
          value: project.id,
          label: project.contractNumber ? `${project.name} · ${project.contractNumber}` : project.name,
        })),
    [store.projects],
  )
  const project = store.projects.find(candidate => candidate.id === projectId)
  const rule = project ? seedsTimeRule(store, { id: `calendar:${event.id}`, title: event.title, projectId }) : null
  const taskKey = seedsTaskId || rule?.taggedTaskId || ''
  const needsProduct = Boolean(rule?.products?.length && rule.needsProduct?.includes(taskKey))
  const save = async () => {
    setBusy(true)
    setError('')
    try {
      const result = await requestJson<{ entries: CalendarTimeEntry[] }>('/api/seeds/calendar-time', {
        method: 'POST',
        body: {
          eventId: event.id,
          eventTitle: event.title,
          projectId,
          ...(clientId && !project?.clientId ? { clientId } : {}),
          date,
          hours: hours + minutes / 60,
          note,
          ...(seedsTaskId ? { seedsTaskId } : {}),
          ...(productId ? { productId } : {}),
        },
        fallback: 'The time could not be logged.',
      })
      onSaved(result.entries)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The time could not be logged.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog title="Log time from the calendar" eyebrow={event.title} onClose={onClose} busy={busy}>
      <form
        className="calendar-time-form"
        onSubmit={submitEvent => {
          submitEvent.preventDefault()
          void save()
        }}
      >
        <label>
          Project
          <SearchSelect
            choices={projects}
            value={projectId}
            onChange={value => {
              setProjectId(value)
              setSeedsTaskId('')
              setProductId('')
            }}
            placeholder="Type a project name or SLSS #"
            empty="No open Seeds project matches"
            aria-label="Project"
            required
          />
        </label>
        {project && !project.clientId && (
          <label>
            Client
            <ClientSelect
              clients={store.clients}
              value={clientId}
              onChange={setClientId}
              extra={[{ value: '', label: 'No client' }]}
              aria-label="Client"
            />
          </label>
        )}
        <div className="calendar-time-row">
          <label>
            Date
            <input type="date" value={date} onChange={change => setDate(change.target.value)} required />
          </label>
          <label>
            Hours
            <select value={hours} onChange={change => setHours(Number(change.target.value))}>
              {HOURS.map(value => (
                <option key={value} value={value}>
                  {value} h
                </option>
              ))}
            </select>
          </label>
          <label>
            Minutes
            <select value={minutes} onChange={change => setMinutes(Number(change.target.value))}>
              {MINUTES.map(value => (
                <option key={value} value={value}>
                  {value} min
                </option>
              ))}
            </select>
          </label>
        </div>
        {rule && rule.tasks.length > 0 && (
          <label>
            Seeds task
            <select value={seedsTaskId} onChange={change => setSeedsTaskId(change.target.value)}>
              <option value="">{rule.taskRequired ? 'Choose the Seeds task' : 'The project’s default'}</option>
              {rule.tasks.map(task => (
                <option key={task.id} value={task.id}>
                  {task.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {needsProduct && (
          <label>
            Product
            <select value={productId} onChange={change => setProductId(change.target.value)} required>
              <option value="">Choose the Seeds product</option>
              {rule?.products?.map(product => (
                <option key={product.id} value={product.id}>
                  {product.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Remarks
          <input
            value={note}
            maxLength={MAX_SEEDS_REMARKS_LENGTH}
            onChange={change => setNote(change.target.value)}
            required={rule?.remarksRequired === true}
          />
        </label>
        {error && (
          <p role="alert" className="calendar-message">
            {error}
          </p>
        )}
        <div className="calendar-time-buttons">
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy || !projectId || hours + minutes / 60 < 0.25}>
            {busy ? 'Logging…' : 'Log time'}
          </button>
        </div>
      </form>
    </Dialog>
  )
}
