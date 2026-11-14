/**
 * The assistant's watcher: the few things in a person's day that are at risk, picked from the morning brief's facts by
 * fixed rules. It uses no AI and reads nothing the brief does not already count, so checking costs no tokens and
 * little work. Shared by the server (which checks) and the browser (which shows the heads-ups).
 *
 * A heads-up's key says what it is about and how bad it is. A dismissed heads-up stays away until it gets worse
 * (a warning that turns urgent has a new key and shows again).
 */
import { addDayKeys, type BriefFacts, type BriefItem, weekdayOf } from './brief'
import type { TaskUpdate } from './taskUpdate'

export type WatchSeverity = 'urgent' | 'warning'
export type WatchAlert = {
  key: string
  severity: WatchSeverity
  title: string
  detail: string
  /** Where it opens. */
  open:
    | { kind: 'task'; id: string }
    | { kind: 'email'; id: string; source: string }
    | { kind: 'tracker'; trackerId: string; rowId: string }
    | { kind: 'time' }
    | { kind: 'none' }
  /** A question about it for the BA Assistant, sent only if the person chooses to. */
  ask: string
  /** Changes the person can approve with one click, without the AI (a new due or follow-up date). */
  actions?: WatchAction[]
}
export type WatchAction = {
  label: string
  /** A change to a task. */
  update?: TaskUpdate
  /** Adds a new Seeds project to a tracker, as a row with its task. */
  addToTracker?: { trackerId: string; projectId: string }
}

/** A Seeds project that came in lately and is on no tracker yet, with the trackers it could go on. */
export type NewProject = {
  id: string
  name: string
  clientName?: string
  contractNumber?: string
  addedAt: string
  trackers: { id: string; name: string }[]
}
/** New Seeds projects as heads-ups: the person picks the tracker (one click), or dismisses it. No AI. */
export function newProjectAlerts(projects: NewProject[]): WatchAlert[] {
  return projects.map(project => {
    const client = project.clientName ? ` for ${project.clientName}` : ''
    const where = project.trackers.length
      ? 'Add it to a tracker, or dismiss it.'
      : 'No tracker for this client can take it yet.'
    return {
      key: `seeds-project:${project.id}`,
      severity: 'warning' as const,
      title: `New Seeds project${client}: ${project.name}`,
      detail: [project.contractNumber ? `Contract ${project.contractNumber}` : '', where].filter(Boolean).join(' · '),
      open: { kind: 'none' as const },
      ask: project.trackers.length
        ? `A new Seeds project "${project.name}"${client} came in. Which of my trackers should it go on, and what should I set up for it?`
        : `Create a Site rollout tracker${client} that includes the new Seeds project "${project.name}".`,
      actions: project.trackers.map(tracker => ({
        label: `Add to ${tracker.name}`,
        addToTracker: { trackerId: tracker.id, projectId: project.id },
      })),
    }
  })
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
/** The next working day after this one, and the Monday after this week. */
export function nextWorkday(day: string) {
  let next = addDayKeys(day, 1)
  while ([0, 6].includes(weekdayOf(next))) next = addDayKeys(next, 1)
  return next
}
export function nextMonday(day: string) {
  return addDayKeys(day, (8 - weekdayOf(day)) % 7 || 7)
}

/**
 * New dates offered for a task's due or follow-up date: today (a due date only), the next working day, and next
 * Monday. Each is a whole approved change, with the date it replaces, so a task changed since is left alone.
 */
export function dateActions(item: BriefItem, field: 'dueDate' | 'followUpDate', today: string): WatchAction[] {
  const verb = field === 'dueDate' ? 'Due' : 'Follow up'
  const soon = nextWorkday(today)
  const monday = nextMonday(today)
  const options: [string, string][] = [
    ...(field === 'dueDate' ? ([[today, 'today']] as [string, string][]) : []),
    [soon, soon === addDayKeys(today, 1) ? 'tomorrow' : WEEKDAYS[weekdayOf(soon)]],
    ...(monday === soon ? [] : ([[monday, 'next Monday']] as [string, string][])),
  ]
  return options.map(([date, when]) => ({
    label: `${verb} ${when}`,
    update: {
      tasks: [
        {
          taskId: item.id,
          title: item.title,
          changes: [
            { field, label: field === 'dueDate' ? 'Due date' : 'Follow-up date', from: item.date || '', to: date },
          ],
        },
      ],
    },
  }))
}

export const WATCH_RULES = {
  /** A go-live this close with steps still open. */
  goLiveDays: 3,
  /** An email waiting this long, and when it becomes urgent. */
  emailDays: 2,
  emailUrgentDays: 5,
  /** Work this long past its due date, and when it becomes urgent. */
  overdueDays: 3,
  overdueUrgentDays: 7,
  /** A follow-up this long past its date. */
  followUpDays: 3,
  /** Heads-ups of one kind, and in all. */
  perKind: 3,
  total: 8,
} as const

const days = (count: number) => `${count} day${count === 1 ? '' : 's'}`
const where = (item: { client?: string; project?: string }) => [item.client, item.project].filter(Boolean).join(' · ')

export function watchAlerts(facts: BriefFacts): WatchAlert[] {
  const alerts: WatchAlert[] = []
  const some = <T>(items: T[]) => items.slice(0, WATCH_RULES.perKind)

  // Go-lives passed or close, with steps still open.
  for (const site of some(
    facts.goLives.items.filter(site => site.openSteps > 0 && site.days <= WATCH_RULES.goLiveDays),
  )) {
    const passed = site.days < 0
    const urgent = site.days <= 1
    const when = passed ? `was ${days(-site.days)} ago` : site.days === 0 ? 'is today' : `is in ${days(site.days)}`
    alerts.push({
      key: `golive:${site.trackerId}:${site.rowId}:${urgent ? 'urgent' : 'warning'}`,
      severity: urgent ? 'urgent' : 'warning',
      title: `${site.site}: go-live ${when}`,
      detail: `${site.openSteps} of ${site.totalSteps} steps still open · ${site.trackerName}`,
      open: { kind: 'tracker', trackerId: site.trackerId, rowId: site.rowId },
      ask: `The go-live of ${site.site} in the ${site.trackerName} tracker ${when} with ${site.openSteps} steps open. What is still open and what should I do first?`,
    })
  }

  // Emails nobody answered.
  for (const email of some((facts.emails?.items || []).filter(email => email.days >= WATCH_RULES.emailDays))) {
    const urgent = email.days >= WATCH_RULES.emailUrgentDays
    alerts.push({
      key: `email:${email.id}:${urgent ? 'urgent' : 'warning'}`,
      severity: urgent ? 'urgent' : 'warning',
      title: `No reply for ${days(email.days)}: ${email.subject}`,
      detail: `From ${email.from || 'unknown sender'}`,
      open: { kind: 'email', id: email.id, source: email.source },
      ask: `Draft a short reply to the email "${email.subject}" from ${email.from}, which has waited ${days(email.days)}.`,
    })
  }

  // Work well past its due date.
  for (const item of some(facts.overdue.items.filter(item => -(item.days || 0) >= WATCH_RULES.overdueDays))) {
    const late = -(item.days || 0)
    const urgent = late >= WATCH_RULES.overdueUrgentDays
    alerts.push({
      key: `overdue:${item.id}:${urgent ? 'urgent' : 'warning'}`,
      severity: urgent ? 'urgent' : 'warning',
      title: `${days(late)} overdue: ${item.title}`,
      detail: [where(item), item.waitingOn ? `waiting on ${item.waitingOn}` : ''].filter(Boolean).join(' · '),
      open: { kind: 'task', id: item.id },
      ask: `"${item.title}" is ${days(late)} overdue. What is blocking it and what is the next step?`,
      actions: dateActions(item, 'dueDate', facts.date),
    })
  }

  // Follow-ups left for days.
  for (const item of some(facts.followUps.items.filter(item => -(item.days || 0) >= WATCH_RULES.followUpDays))) {
    const late = -(item.days || 0)
    alerts.push({
      key: `followup:${item.id}:${item.date || ''}`,
      severity: 'warning',
      title: `Follow-up ${days(late)} late: ${item.title}`,
      detail: [where(item), item.waitingOn ? `waiting on ${item.waitingOn}` : ''].filter(Boolean).join(' · '),
      open: { kind: 'task', id: item.id },
      ask: `Draft a short, polite follow-up about "${item.title}"${item.client ? ` for ${item.client}` : ''}. Its follow-up date passed ${days(late)} ago.`,
      actions: dateActions(item, 'followUpDate', facts.date),
    })
  }

  // Time that Seeds refused.
  const unsent = facts.time.unsent
  if (unsent?.failed)
    alerts.push({
      key: `seeds-failed:${facts.date}`,
      severity: 'warning',
      title: `${unsent.failed} time ${unsent.failed === 1 ? 'entry' : 'entries'} could not be sent to Seeds`,
      detail: unsent.tasks.map(task => task.title).join(' · '),
      open: unsent.tasks[0] ? { kind: 'task', id: unsent.tasks[0].id } : { kind: 'time' },
      ask: 'Which of my time entries failed to send to Seeds, and why?',
    })

  const rank = (alert: WatchAlert) => (alert.severity === 'urgent' ? 0 : 1)
  return alerts.sort((a, b) => rank(a) - rank(b)).slice(0, WATCH_RULES.total)
}

/** The keys a person dismissed that still match a heads-up: the rest are forgotten, so the list stays small. */
export function keptDismissals(dismissed: unknown, alerts: WatchAlert[]) {
  const live = new Set(alerts.map(alert => alert.key))
  return (Array.isArray(dismissed) ? dismissed : []).filter(
    (key): key is string => typeof key === 'string' && live.has(key),
  )
}
