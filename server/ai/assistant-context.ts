import { dateKeyInTimeZone } from '../services/follow-up-rollover'
import { isWaitingOnDone } from '../../src/features/tasks/waitingOn'

const dayOffset = (date: string, days: number) =>
  new Date(Date.parse(date + 'T12:00:00Z') + days * 86400000).toISOString().slice(0, 10)
export function assistantPeriod(message: string, today: string) {
  const dates =
    message
      .match(/\b\d{4}-\d{2}-\d{2}\b/g)
      ?.filter(d => Number.isFinite(Date.parse(d)) && new Date(d).toISOString().slice(0, 10) === d) || []
  if (dates.length) return { from: dates[0], to: dates[1] || dates[0], label: 'requested dates' }
  const monday = dayOffset(today, -(new Date(today + 'T12:00:00Z').getUTCDay() + 6) % 7)
  if (/last week/i.test(message))
    return { from: dayOffset(monday, -7), to: dayOffset(monday, -1), label: 'last week (Monday–Sunday)' }
  if (/this week|weekly/i.test(message)) return { from: monday, to: today, label: 'this week to date (Monday start)' }
  if (/\btoday\b/i.test(message)) return { from: today, to: today, label: 'today' }
  if (/all.time|entire history/i.test(message)) return { from: '0001-01-01', to: today, label: 'all retained history' }
  return { from: dayOffset(today, -29), to: today, label: 'last 30 days' }
}

export function buildAssistantContext(
  state: any,
  user: any,
  requested: any,
  message: string,
  today: string,
  timeZone: string,
  allowed: (module: string) => boolean,
) {
  const list = (key: string): any[] => (Array.isArray(state[key]) ? state[key] : [])
  const clientId = String(requested?.client?.id || ''),
    projectId = String(requested?.project?.id || '')
  const inScope = (entry: any) =>
    (!clientId || entry.clientId === clientId) && (!projectId || entry.projectId === projectId)
  const items =
    allowed('items') || allowed('inbox')
      ? list('items')
          .filter(inScope)
          .filter(i => !(i.source === 'Discord' && i.externalSourceId))
      : []
  const closed = new Set<string>()
  for (const status of state.taskSettings?.statuses || []) if (status.closed) closed.add(status.label)
  const open = items.filter(i => !closed.has(i.status) && !isWaitingOnDone(i.waitingOn, state.taskSettings))
  const own = items.filter(i => i.assignedToUserId === user.id)
  const period = assistantPeriod(message, today)
  const events = list('workEvents')
    .filter(inScope)
    .filter(
      e =>
        user.role === 'Administrator' ||
        e.actorUserId === user.id ||
        e.assignedToUserId === user.id ||
        (e.field === 'assignedToUserId' && e.oldValue === user.id),
    )
    .map(e => ({
      ...e,
      date:
        e.occurredAt && Number.isFinite(Date.parse(e.occurredAt))
          ? dateKeyInTimeZone(new Date(e.occurredAt), timeZone)
          : e.date,
    }))
    .filter(e => e.date >= period.from && e.date <= period.to)
    .sort((a, b) => String(b.occurredAt).localeCompare(String(a.occurredAt)))
  const mine = events.filter(
    e =>
      e.actorUserId === user.id ||
      e.assignedToUserId === user.id ||
      (e.field === 'assignedToUserId' && e.oldValue === user.id),
  )
  const terms = (message.toLowerCase().match(/[\p{L}\d_-]{3,}/gu) || []).filter(
    t =>
      !new Set([
        'the',
        'and',
        'what',
        'with',
        'this',
        'that',
        'from',
        'have',
        'tasks',
        'task',
        'review',
        'summarize',
        'should',
        'week',
        'open',
      ]).has(t),
  )
  const relevance = (item: any) => {
    const text = [item.id, item.title, item.description, item.clientId, item.projectId].join(' ').toLowerCase()
    return (
      terms.reduce((score, t) => score + (text.includes(t) ? 100 : 0), 0) +
      (['Urgent', 'Critical'].includes(item.priority) ? 30 : item.priority === 'High' ? 15 : 0) +
      ((item.dueDate && item.dueDate <= today) || (item.followUpDate && item.followUpDate <= today) ? 25 : 0)
    )
  }
  const ordered = (values: any[]) =>
    [...values].sort(
      (a, b) =>
        relevance(b) - relevance(a) ||
        String(a.dueDate || a.followUpDate || '9999').localeCompare(String(b.dueDate || b.followUpDate || '9999')) ||
        String(a.id).localeCompare(String(b.id)),
    )
  const names = (key: string, id: string) => list(key).find(e => e.id === id)?.name || undefined
  const brief = (item: any) => ({
    id: item.id,
    title: item.title,
    type: item.type,
    status: item.status,
    priority: item.priority,
    waitingOn: item.waitingOn,
    parentTaskId: item.parentTaskId,
    assignedToUserId: item.assignedToUserId,
    assignedToName: names('accounts', item.assignedToUserId),
    clientId: item.clientId,
    clientName: allowed('clients') ? names('clients', item.clientId) : undefined,
    projectId: item.projectId,
    projectName: allowed('projects') ? names('projects', item.projectId) : undefined,
    dateRaised: item.dateRaised,
    startDate: item.startDate,
    dueDate: item.dueDate,
    followUpDate: item.followUpDate,
    resolvedDate: item.resolvedDate,
    description: String(item.description || '').slice(0, 1200),
    descriptionTruncated: String(item.description || '').length > 1200,
  })
  const group = (values: any[], key: string) =>
    values.reduce((counts: Record<string, number>, value) => {
      const name = String(value[key] || 'Unassigned')
      counts[name] = (counts[name] || 0) + 1
      return counts
    }, {})
  const activities = allowed('action')
    ? list('planner')
        .filter(inScope)
        .filter(a => a.status === 'Planned' && (a.endDate || a.date) >= today)
        .sort((a, b) => a.date.localeCompare(b.date))
    : []
  const selectedItems = ordered(items).slice(0, 80),
    selectedOpen = ordered(open).slice(0, 50),
    selectedMine = ordered(own).slice(0, 50)
  const selectedEvents = events.slice(0, 100),
    selectedOwnEvents = mine.slice(0, 100)
  const coverage = {
    totalItems: items.length,
    suppliedUniqueItems: new Set([...selectedItems, ...selectedOpen, ...selectedMine].map(i => i.id)).size,
    totalPeriodEvents: events.length,
    suppliedPeriodEvents: selectedEvents.length,
    totalMyPeriodEvents: mine.length,
    suppliedMyPeriodEvents: selectedOwnEvents.length,
    totalUpcomingActivities: activities.length,
    suppliedUpcomingActivities: Math.min(30, activities.length),
    historyRetention: 'Only the workspace’s retained work-event history is available.',
  }
  const partial =
    coverage.suppliedUniqueItems < coverage.totalItems ||
    events.length > 100 ||
    mine.length > 100 ||
    activities.length > 30 ||
    [...selectedItems, ...selectedOpen, ...selectedMine].some(i => String(i.description || '').length > 1200)
  return {
    currentUser: { id: user.id, name: user.name, role: user.role, modules: user.modules },
    pronounRule: `I/me/my refers to ${user.name} (${user.id}).`,
    today,
    timeZone,
    period,
    client: allowed('clients') ? list('clients').find(c => c.id === clientId) : undefined,
    project: allowed('projects') ? list('projects').find(p => p.id === projectId) : undefined,
    totals: {
      items: items.length,
      open: open.length,
      myAssignments: own.length,
      myOpen: open.filter(i => i.assignedToUserId === user.id).length,
      openByPriority: group(open, 'priority'),
      openByAssignee: group(open, 'assignedToUserId'),
      periodEventsByAction: group(events, 'action'),
      myPeriodEventsByAction: group(mine, 'action'),
      myCompletedTaskIds: [...new Set(mine.filter(e => e.action === 'completed').map(e => e.taskId))],
    },
    openItems: selectedOpen.map(brief),
    recentItems: selectedItems.map(brief),
    myAssignments: selectedMine.map(brief),
    myRecentActivity: selectedOwnEvents,
    teamActivity: user.role === 'Administrator' ? selectedEvents : undefined,
    upcomingActivities: activities.slice(0, 30),
    coverage: { ...coverage, partial },
    coverageNotice: partial
      ? `Context is partial: ${coverage.suppliedUniqueItems}/${items.length} task details and ${selectedEvents.length}/${events.length} events for ${period.from}–${period.to}. Totals use all matching retained records. Narrow the client, project or dates for a fuller detail review.`
      : '',
  }
}
