/**
 * Time logged straight from a Google Calendar event in the Action Center, without a task. The event itself stays in
 * Google (read-only, private); the entry is kept here, linked to the event's id, so its card can show it and it can be
 * sent to Seeds with the person's other time. It is the person's own: it never leaves the server in the workspace
 * (sanitizeStateForClient drops it) and is read through /api/seeds/calendar-time. One entry per event per person, so
 * the same meeting is not logged twice.
 */
import { isClosedProject } from '../../src/features/tasks/lifecycle'
import { seedsTimeRule, type TimeEntry, validateTimeEntryInput } from '../../src/features/tasks/effort'
import { scopeFor } from '../../src/shared/access'
import { asList as list } from '../../src/shared/lists'

export type CalendarTimeEntry = TimeEntry & {
  /** The Google Calendar event this time was for, and its title when logged. */
  eventId: string
  eventTitle: string
  projectId: string
  clientId?: string
}

type Actor = { id: string; name?: string; username?: string; role?: string }
type Result<T> = { ok: true; value: T } | { ok: false; status: number; error: string }

const MAX_PER_PERSON = 5000
const text = (value: unknown) => (value == null ? '' : String(value))

/** This person's calendar time, newest first. */
export const calendarTimeOf = (state: any, userId: string): CalendarTimeEntry[] =>
  list(state?.calendarTime)
    .filter((entry: any) => entry?.userId === userId)
    .sort((a: any, b: any) => text(b.date).localeCompare(text(a.date)))

/** What an entry's time is "on" for Seeds: its project and client, named after the event. */
export const calendarTimeWork = (entry: CalendarTimeEntry) => ({
  id: `calendar:${entry.eventId}`,
  title: entry.eventTitle,
  projectId: entry.projectId,
  ...(entry.clientId ? { clientId: entry.clientId } : {}),
})

/**
 * Logs time for a calendar event: on an open Seeds project the person can work on (and a client of theirs, if one is
 * named), by the same rules as time on a task of that project (Seeds task, product, remarks, 15-minute steps).
 */
export function logCalendarTime(
  state: any,
  actor: Actor,
  input: any,
  now: Date,
  id: string,
): Result<{ state: any; entry: CalendarTimeEntry }> {
  if (actor.role === 'Viewer') return { ok: false, status: 403, error: 'Viewers cannot log time.' }
  if (state?.seeds?.connected !== true)
    return { ok: false, status: 409, error: 'Time from the calendar goes to Seeds, and Seeds is not turned on.' }
  const eventId = text(input?.eventId).trim().slice(0, 1024)
  const eventTitle = text(input?.eventTitle).trim().slice(0, 300) || 'Calendar event'
  if (!eventId) return { ok: false, status: 400, error: 'Choose the calendar event.' }
  const project = list(state?.projects).find((candidate: any) => candidate?.id && candidate.id === input?.projectId)
  if (!project) return { ok: false, status: 400, error: 'Choose the project.' }
  if (!project.seedsId) return { ok: false, status: 400, error: 'Choose a Seeds project: this time goes to Seeds.' }
  if (isClosedProject(project)) return { ok: false, status: 409, error: 'That project is completed in Seeds.' }
  const clientId = text(input?.clientId)
  if (clientId && !list(state?.clients).some((client: any) => client?.id === clientId))
    return { ok: false, status: 400, error: 'Choose a client from the list.' }
  const scope = scopeFor(state, actor.id)
  const writes = (set: Set<string>, value: string) => Boolean(value) && set.has(value)
  if (!scope.all && !writes(scope.writeProjects, project.id) && !writes(scope.writeClients, clientId))
    return { ok: false, status: 403, error: 'You cannot log time on that project.' }
  const mine = calendarTimeOf(state, actor.id)
  if (mine.some(entry => entry.eventId === eventId))
    return { ok: false, status: 409, error: 'Time is already logged for this event. Remove it to log it again.' }
  if (mine.length >= MAX_PER_PERSON)
    return { ok: false, status: 409, error: 'You have reached the limit of time logged from the calendar.' }
  const rule = seedsTimeRule(state, { id: `calendar:${eventId}`, title: eventTitle, projectId: project.id })
  const checked = validateTimeEntryInput({ ...input, subtaskId: undefined }, rule)
  if (!checked.ok) return { ok: false, status: 400, error: checked.error }
  const entry: CalendarTimeEntry = {
    id,
    ...checked.value,
    forSeeds: true,
    userId: actor.id,
    userName: actor.name || actor.username || 'User',
    createdAt: now.toISOString(),
    eventId,
    eventTitle,
    projectId: project.id,
    ...(clientId ? { clientId } : {}),
  }
  return { ok: true, value: { state: { ...state, calendarTime: [...list(state?.calendarTime), entry] }, entry } }
}

/** Removes the person's own entry (an Administrator may remove anyone's) while it is not in Seeds yet. */
export function removeCalendarTime(state: any, actor: Actor, entryId: string): Result<{ state: any }> {
  const entry = list(state?.calendarTime).find((candidate: any) => candidate?.id === entryId)
  if (!entry || (entry.userId !== actor.id && actor.role !== 'Administrator'))
    return { ok: false, status: 404, error: 'That time entry was not found.' }
  if (entry.seedsEntryId)
    return { ok: false, status: 409, error: 'This time is already in Seeds. Change or remove it in Seeds.' }
  return {
    ok: true,
    value: { state: { ...state, calendarTime: list(state?.calendarTime).filter((e: any) => e?.id !== entryId) } },
  }
}
