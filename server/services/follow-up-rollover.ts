import { randomUUID } from 'node:crypto'

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/
const FALLBACK_CLOSED_STATUSES = new Set(['done', 'resolved', 'closed', 'complete', 'completed'])

export type FollowUpRolloverChange = {
  taskId: string
  title: string
  previousDate: string
  nextDate: string
  daysMoved: number
}

export type FollowUpRolloverResult = {
  state: any
  changed: boolean
  changes: FollowUpRolloverChange[]
}

function dateParts(value: string) {
  const [year, month, day] = value.split('-').map(Number)
  return { year, month, day }
}

function utcDay(value: string) {
  const { year, month, day } = dateParts(value)
  return Date.UTC(year, month - 1, day)
}

export function calendarDaysBetween(from: string, to: string) {
  return Math.max(0, Math.round((utcDay(to) - utcDay(from)) / 86_400_000))
}

export function dateKeyInTimeZone(now = new Date(), timeZone = 'Asia/Manila') {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${value.year}-${value.month}-${value.day}`
}

function isClosed(item: any, state: any) {
  if (String(item?.waitingOn || '').toLowerCase() === 'done' || item?.resolvedDate) return true
  const configured = new Set(
    (Array.isArray(state?.taskSettings?.statuses) ? state.taskSettings.statuses : [])
      .filter((status: any) => Boolean(status?.closed))
      .map((status: any) => String(status?.label || '').trim().toLowerCase()),
  )
  const status = String(item?.status || '').trim().toLowerCase()
  return configured.has(status) || FALLBACK_CLOSED_STATUSES.has(status)
}

function safeComments(item: any) {
  return Array.isArray(item?.comments) ? item.comments.filter((comment: any) => comment && comment.id && comment.text) : []
}

export function rollOverOpenSubtaskFollowUps(state: any, options: {
  today?: string
  occurredAt?: string
  timeZone?: string
  id?: () => string
} = {}): FollowUpRolloverResult {
  const now = options.occurredAt ? new Date(options.occurredAt) : new Date()
  const occurredAt = Number.isNaN(now.getTime()) ? new Date().toISOString() : now.toISOString()
  const today = options.today || dateKeyInTimeZone(now, options.timeZone || 'Asia/Manila')
  if (!DATE_KEY.test(today)) throw new Error('Follow-up rollover date must use YYYY-MM-DD.')

  const items = Array.isArray(state?.items) ? state.items : []
  const accounts = Array.isArray(state?.accounts) ? state.accounts : []
  const existingEvents = Array.isArray(state?.workEvents) ? state.workEvents : []
  const changes: FollowUpRolloverChange[] = []
  const createdEvents: any[] = []
  const createId = options.id || randomUUID

  const nextItems = items.map((item: any) => {
    const previousDate = String(item?.followUpDate || '')
    if (!item?.id || !DATE_KEY.test(previousDate) || previousDate >= today || isClosed(item, state)) return item

    const daysMoved = calendarDaysBetween(previousDate, today)
    if (!daysMoved) return item
    const kind = item.parentTaskId ? 'Subtask' : 'Task'
    const title = String(item.title || `Untitled ${kind.toLowerCase()}`)
    const text = daysMoved === 1
      ? `Follow-up automatically moved from ${previousDate} to ${today} because the ${kind.toLowerCase()} remains open.`
      : `Follow-up automatically caught up from ${previousDate} to ${today} after ${daysMoved} calendar days because the ${kind.toLowerCase()} remained open.`
    const comment = {
      id: createId(),
      text,
      createdAt: occurredAt,
      createdBy: 'system',
      createdByName: 'System',
      kind: 'System' as const,
      eventType: 'FOLLOW_UP_AUTO_MOVED' as const,
      previousFollowUpDate: previousDate,
      nextFollowUpDate: today,
      daysMoved,
    }
    const assignedToUserId = item.assignedToUserId ? String(item.assignedToUserId) : undefined
    const assignedToName = assignedToUserId ? accounts.find((account: any) => String(account?.id || '') === assignedToUserId)?.name : undefined
    createdEvents.push({
      id: createId(),
      occurredAt,
      date: today,
      actorUserId: 'system',
      actorName: 'System',
      actorRole: 'System',
      assignedToUserId,
      assignedToName,
      clientId: item.clientId || undefined,
      projectId: item.projectId || undefined,
      taskId: String(item.id),
      parentTaskId: item.parentTaskId ? String(item.parentTaskId) : undefined,
      itemTitle: title,
      itemKind: kind,
      action: 'follow_up_auto_moved',
      summary: text,
      field: 'followUpDate',
      oldValue: previousDate,
      newValue: today,
    })
    changes.push({ taskId: String(item.id), title, previousDate, nextDate: today, daysMoved })
    return { ...item, followUpDate: today, comments: [...safeComments(item), comment].slice(-500) }
  })

  if (!changes.length) return { state, changed: false, changes }
  return {
    state: { ...state, items: nextItems, workEvents: [...createdEvents, ...existingEvents].slice(0, 10_000) },
    changed: true,
    changes,
  }
}
