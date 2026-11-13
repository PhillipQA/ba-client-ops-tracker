/**
 * The weekly status report for one project: what was done this week, what comes next, what needs the client, and
 * what could slip. Shared by the server (which builds it) and the browser (which shows it).
 *
 * The facts are counted here; the AI only words them as an email. Without AI, statusEmail writes the same email
 * from the facts, so the report always works.
 */
import type { TaskSettings, WorkItem } from '../../shared/types'
import { isTaskArchived, isTaskFinished } from '../tasks/lifecycle'
import { waitingOnOptions } from '../tasks/waitingOn'
import { goLiveColumn, siteTaskTitle, stepColumns } from '../trackers/stepTasks'
import { trackerClientIds, trackerProjectIds, type Tracker, type TrackerRow } from '../trackers/trackerModel'
import { addDayKeys, daysBetween, describeItem, type BriefItem, weekdayOf } from './brief'

/** For the client (sent to them), or for the team (internal: names, hours and notes). */
export type ReportAudience = 'client' | 'team'
export const REPORT_LISTED = 12

export type ReportSite = { site: string; date: string; openSteps: number; totalSteps: number }
export type ReportTracker = {
  name: string
  sites: number
  /** Every step ticked. */
  complete: number
  /** Going live in the next 7 days. */
  upcoming: ReportSite[]
  /** Go-live date passed with steps still open. */
  late: ReportSite[]
}
export type ReportSection = { total: number; items: BriefItem[] }
export type StatusFacts = {
  audience: ReportAudience
  project: { id: string; name: string; contractNumber?: string }
  client?: { id: string; name: string; email?: string }
  /** Monday to Friday of the week reported on, and the day it is written. */
  week: { start: string; end: string; asOf: string }
  done: ReportSection
  next: ReportSection
  /** Open work past its due date. */
  overdue: ReportSection
  /** Open work waiting on the client. */
  needsClient: ReportSection
  /** Documents sent for signature and not fully signed. */
  signatures: { title: string; task: string; signed: number; total: number }[]
  trackers: ReportTracker[]
  /** Team only: open work waiting on someone other than the client or the person. */
  waitingOthers?: ReportSection
  /** Team only: hours logged on the project this week, by person. */
  hours?: { total: number; people: { name: string; hours: number }[] }
  /** Team only: project notes written this week. */
  notes?: string[]
}

const list = (value: unknown): any[] => (Array.isArray(value) ? value : [])
const text = (value: unknown) => String(value ?? '').trim()
const isDateKey = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
const section = (items: BriefItem[]): ReportSection => ({ total: items.length, items: items.slice(0, REPORT_LISTED) })

/** The working week reported on: Monday to Friday of this week, or of the week just ended on a weekend. */
export function reportWeek(asOf: string) {
  const weekday = weekdayOf(asOf)
  const start = addDayKeys(asOf, weekday === 0 ? -6 : 1 - weekday)
  return { start, end: addDayKeys(start, 4), asOf }
}

/** When a finished task was finished: its resolved date, else the day its completion was recorded. */
function finishedOn(item: WorkItem, events: any[]) {
  const resolved = text(item.resolvedDate).slice(0, 10)
  if (isDateKey(resolved)) return resolved
  const completed = events
    .filter(event => event?.taskId === item.id && event?.action === 'completed' && isDateKey(event?.date))
    .map(event => String(event.date))
    .sort()
  return completed[completed.length - 1] || ''
}

/**
 * The clients a project's work is for: its own client, else every client its tasks belong to. A project can serve
 * several clients, so a report for one client counts only that client's tasks.
 */
export function projectClientIds(state: any, projectId: string): string[] {
  const project = list(state?.projects).find(record => record?.id === projectId)
  if (!project) return []
  if (text(project.clientId)) return [text(project.clientId)]
  return [
    ...new Set(
      (list(state?.items) as WorkItem[])
        .filter(item => item.projectId === projectId && text(item.clientId))
        .map(item => text(item.clientId)),
    ),
  ]
}

/** Sent for signature and not fully signed yet. */
const AWAITING_SIGNATURES = new Set(['SENT', 'VIEWED', 'PARTIALLY_SIGNED'])

export function statusFacts(input: {
  /** The part of the workspace the person may see. */
  state: any
  projectId: string
  audience: ReportAudience
  asOf: string
  settings: TaskSettings
  /** Trackers read for this report (any; only the project's are used). */
  trackers?: { tracker: Tracker; rows: TrackerRow[] }[]
  /** Only this client's work (one of projectClientIds). Without it, every client's work in the project counts. */
  clientId?: string
}): StatusFacts | null {
  const { state, projectId, audience, asOf, settings } = input
  const project = list(state?.projects).find(record => record?.id === projectId)
  if (!project) return null
  const only = text(input.clientId)
  const clientIds = projectClientIds(state, projectId)
  if (only && !clientIds.includes(only)) return null
  const week = reportWeek(asOf)
  const items = (list(state?.items) as WorkItem[]).filter(
    item =>
      item.projectId === projectId &&
      !isTaskArchived(list(state?.items), item) &&
      (!only || text(item.clientId) === only || (!text(item.clientId) && text(project.clientId) === only)),
  )
  const events = list(state?.workEvents)
  const open = items.filter(item => !isTaskFinished(item, settings))
  const dated = (item: WorkItem, date?: string): BriefItem => ({
    ...describeItem(state, item),
    ...(date ? { date, days: daysBetween(asOf, date) } : {}),
    ...(text(item.waitingOn) ? { waitingOn: text(item.waitingOn) } : {}),
  })
  const byDate = (a: BriefItem, b: BriefItem) => String(a.date).localeCompare(String(b.date))

  const done = items
    .filter(item => isTaskFinished(item, settings))
    .map(item => ({ item, on: finishedOn(item, events) }))
    .filter(({ on }) => on && on >= week.start && on <= asOf)
    .map(({ item, on }) => dated(item, on))
    .sort(byDate)
  const nextEnd = addDayKeys(asOf, 7)
  const next = open
    .filter(item => isDateKey(item.dueDate) && item.dueDate > asOf && item.dueDate <= nextEnd)
    .map(item => dated(item, item.dueDate))
    .sort(byDate)
  const overdue = open
    .filter(item => isDateKey(item.dueDate) && item.dueDate < asOf)
    .map(item => dated(item, item.dueDate))
    .sort(byDate)
  // Who the work waits on, by the account's own waiting-on options: the client, the person themselves, or others.
  const options = waitingOnOptions(settings)
  const isClient = (label: string) => /client|customer/i.test(label)
  const isMine = (label: string) =>
    !label || /^me$/i.test(label) || options.find(option => option.label === label)?.done === true
  const needsClient = open
    .filter(item => isClient(text(item.waitingOn)))
    .map(item => dated(item, isDateKey(item.followUpDate) ? item.followUpDate : undefined))
  const waitingOthers = open
    .filter(item => !isClient(text(item.waitingOn)) && !isMine(text(item.waitingOn)))
    .map(item => dated(item, isDateKey(item.followUpDate) ? item.followUpDate : undefined))

  const signatures = items.flatMap(item =>
    list(item.docHubDocuments)
      .filter(doc => AWAITING_SIGNATURES.has(text(doc?.status)))
      .map(doc => ({
        title: text(doc.title) || 'Document',
        task: text(item.title),
        signed: Number(doc.signed) || 0,
        total: Number(doc.total) || 0,
      })),
  )

  const trackers: ReportTracker[] = []
  for (const { tracker, rows } of input.trackers || []) {
    if (!trackerProjectIds(tracker).includes(projectId)) continue
    // A tracker kept for another client of the project stays out of this client's report.
    if (only && trackerClientIds(tracker).length && !trackerClientIds(tracker).includes(only)) continue
    const column = goLiveColumn(tracker.columns || [])
    const steps = stepColumns(tracker.columns || [])
    if (!column || !steps.length) continue
    const site = (row: TrackerRow): ReportSite => ({
      site: siteTaskTitle(tracker.columns, row.cells || {}) || `Row ${Number(row.position ?? 0) + 1}`,
      date: String(row.cells?.[column.id] || ''),
      openSteps: steps.filter(step => row.cells?.[step.id] !== true).length,
      totalSteps: steps.length,
    })
    const all = rows.map(site)
    trackers.push({
      name: text(tracker.name),
      sites: all.length,
      complete: all.filter(entry => !entry.openSteps).length,
      upcoming: all
        .filter(entry => isDateKey(entry.date) && entry.date >= asOf && entry.date <= nextEnd)
        .sort((a, b) => a.date.localeCompare(b.date))
        .slice(0, REPORT_LISTED),
      late: all
        .filter(entry => isDateKey(entry.date) && entry.date < asOf && entry.openSteps)
        .sort((a, b) => a.date.localeCompare(b.date))
        .slice(0, REPORT_LISTED),
    })
  }

  // The client the report is for: the one asked for, else the project's only client. A shared project has none.
  const clientId = only || (clientIds.length === 1 ? clientIds[0] : '')
  const client = clientId ? list(state?.clients).find(record => record?.id === clientId) : undefined
  const facts: StatusFacts = {
    audience,
    project: {
      id: project.id,
      name: text(project.name),
      ...(text(project.contractNumber) ? { contractNumber: text(project.contractNumber) } : {}),
    },
    ...(client
      ? {
          client: {
            id: client.id,
            name: text(client.name),
            ...(text(client.email) ? { email: text(client.email) } : {}),
          },
        }
      : {}),
    week,
    done: section(done),
    next: section(next),
    overdue: section(overdue),
    needsClient: section(needsClient),
    signatures: signatures.slice(0, REPORT_LISTED),
    trackers,
  }
  if (audience === 'team') {
    const people = new Map<string, number>()
    for (const item of items)
      for (const entry of list(item.timeEntries))
        if (isDateKey(entry?.date) && entry.date >= week.start && entry.date <= asOf)
          people.set(
            text(entry.userName) || 'Someone',
            (people.get(text(entry.userName) || 'Someone') || 0) + (Number(entry.hours) || 0),
          )
    const round = (value: number) => Math.round(value * 100) / 100
    facts.waitingOthers = section(waitingOthers)
    facts.hours = {
      total: round([...people.values()].reduce((sum, value) => sum + value, 0)),
      people: [...people].map(([name, hours]) => ({ name, hours: round(hours) })).sort((a, b) => b.hours - a.hours),
    }
    facts.notes = list(state?.activity)
      .filter(
        entry =>
          entry?.projectId === projectId &&
          (!only || !entry?.clientId || entry.clientId === only) &&
          isDateKey(entry?.date) &&
          entry.date >= week.start &&
          entry.date <= asOf,
      )
      .map(entry => text(entry.text).slice(0, 300))
      .filter(Boolean)
      .slice(0, 8)
  }
  return facts
}

/** A date as "Thu, Nov 13" (dates are calendar days, so no time zone applies). */
export function reportDate(key: string) {
  if (!isDateKey(key)) return ''
  const [year, month, day] = key.split('-').map(Number)
  return new Intl.DateTimeFormat('en', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(year, month - 1, day)),
  )
}
const shortDate = (key: string) => reportDate(key).replace(/^\w+, /, '')

/** A task as a line: "Hardware (SM Tarlac)" for a subtask, with its date when it has one. */
function line(item: BriefItem, when?: 'due' | 'done' | 'follow') {
  const title = item.parentTitle ? `${item.title} (${item.parentTitle})` : item.title
  if (!item.date || !when) return `- ${title}`
  const label = when === 'done' ? 'done' : when === 'follow' ? 'follow-up' : 'due'
  return `- ${title}: ${label} ${shortDate(item.date)}`
}

/** The subject the report email gets: project and week. */
export function statusSubject(facts: StatusFacts) {
  return `${facts.project.name}: weekly update (${shortDate(facts.week.start)} to ${shortDate(facts.week.end)})`
}

/**
 * The report as an email, written from the facts without AI: short sections, empty ones left out. No greeting name
 * and no signature (the composer adds the person's signature).
 */
export function statusEmail(facts: StatusFacts): { subject: string; body: string } {
  const parts: string[] = []
  const more = (shown: number, total: number) => (total > shown ? [`- and ${total - shown} more`] : [])
  const add = (heading: string, lines: string[]) => {
    if (lines.length) parts.push([heading, ...lines].join('\n'))
  }
  const team = facts.audience === 'team'
  add('Done this week', [
    ...facts.done.items.map(item => line(item, team ? 'done' : undefined)),
    ...more(facts.done.items.length, facts.done.total),
  ])
  add('Coming up', [
    ...facts.next.items.map(item => line(item, 'due')),
    ...more(facts.next.items.length, facts.next.total),
  ])
  for (const tracker of facts.trackers) {
    const lines = [
      `- ${tracker.complete} of ${tracker.sites} sites have every step done`,
      ...tracker.upcoming.map(
        site =>
          `- ${site.site}: going live ${shortDate(site.date)}${site.openSteps ? `, ${site.openSteps} of ${site.totalSteps} steps still open` : ', ready'}`,
      ),
    ]
    add(tracker.name, lines)
  }
  add(team ? 'Waiting on the client' : 'Needs your input', [
    ...facts.needsClient.items.map(item => line(item)),
    ...more(facts.needsClient.items.length, facts.needsClient.total),
    ...facts.signatures.map(
      doc =>
        `- ${doc.title} (${doc.task}): ${team ? 'awaiting signatures' : 'awaiting your signature'}${doc.total ? `, ${doc.signed} of ${doc.total} signed` : ''}`,
    ),
  ])
  add(team ? 'At risk' : 'Watch-outs', [
    ...facts.overdue.items.map(item => line(item, 'due')),
    ...more(facts.overdue.items.length, facts.overdue.total),
    ...facts.trackers.flatMap(tracker =>
      tracker.late.map(
        site => `- ${site.site}: go-live was ${shortDate(site.date)}, ${site.openSteps} steps still open`,
      ),
    ),
  ])
  if (team && facts.waitingOthers?.total)
    add('Waiting on others', [
      ...facts.waitingOthers.items.map(item => `${line(item)}${item.waitingOn ? ` (${item.waitingOn})` : ''}`),
      ...more(facts.waitingOthers.items.length, facts.waitingOthers.total),
    ])
  if (team && facts.hours?.total)
    add(
      `Time logged: ${facts.hours.total} h`,
      facts.hours.people.map(person => `- ${person.name}: ${person.hours} h`),
    )
  if (team && facts.notes?.length)
    add(
      'Notes',
      facts.notes.map(note => `- ${note}`),
    )

  const intro = team
    ? `Status of ${facts.project.name} for the week of ${shortDate(facts.week.start)}.`
    : `Here is this week's update on ${facts.project.name}.`
  const close = team ? '' : '\n\nLet me know if you have any questions.'
  const body = parts.length
    ? `Hi,\n\n${intro}\n\n${parts.join('\n\n')}${close}`
    : `Hi,\n\n${intro} There were no task changes this week.${close}`
  return { subject: statusSubject(facts), body }
}

/** The AI's email, kept only when it has a subject and a body, and cut to sizes an email can carry. */
export function cleanStatusEmail(value: any): { subject: string; body: string } | null {
  const subject = String(value?.subject ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
  const body = String(value?.body ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 8000)
  return subject && body ? { subject, body } : null
}
