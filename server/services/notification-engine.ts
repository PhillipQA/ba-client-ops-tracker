import { randomUUID } from 'node:crypto'

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/
const FALLBACK_CLOSED = new Set(['done', 'resolved', 'closed', 'complete', 'completed'])

export type NotificationReconcileResult = {
  state: any
  changed: boolean
  created: any[]
}

function isClosed(item: any, state: any) {
  if (String(item?.waitingOn || '').toLowerCase() === 'done' || item?.resolvedDate) return true
  const configured = new Set((Array.isArray(state?.taskSettings?.statuses) ? state.taskSettings.statuses : [])
    .filter((status: any) => Boolean(status?.closed))
    .map((status: any) => String(status?.label || '').trim().toLowerCase()))
  const status = String(item?.status || '').trim().toLowerCase()
  return configured.has(status) || FALLBACK_CLOSED.has(status)
}

function activeUsers(state: any) {
  return (Array.isArray(state?.accounts) ? state.accounts : []).filter((account: any) => account?.status === 'Active' && ['Administrator', 'Contributor'].includes(String(account?.role || '')))
}

function trimPerRecipient(notifications: any[]) {
  const counts = new Map<string, number>()
  return [...notifications].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))).filter((notification) => {
    const recipient = String(notification?.recipientUserId || '')
    const count = counts.get(recipient) || 0
    if (!recipient || count >= 1000) return false
    counts.set(recipient, count + 1)
    return true
  })
}

export function reconcileNotifications(state: any, options: {
  today: string
  occurredAt?: string
  newEventIds?: string[]
  id?: () => string
}): NotificationReconcileResult {
  if (!DATE_KEY.test(options.today)) throw new Error('Notification date must use YYYY-MM-DD.')
  const occurredAt = options.occurredAt || new Date().toISOString()
  const createId = options.id || randomUUID
  const users = activeUsers(state)
  const userMap = new Map(users.map((user: any) => [String(user.id), user]))
  const admins = users.filter((user: any) => user.role === 'Administrator')
  const existing = Array.isArray(state?.notifications) ? state.notifications : []
  const dedupe = new Set(existing.map((notification: any) => String(notification?.dedupeKey || '')).filter(Boolean))
  const initializedAt = String(state?.notificationState?.initializedAt || '')
  const newEventIds = new Set(options.newEventIds || [])
  const created: any[] = []

  const add = (recipientUserId: string | undefined, input: any) => {
    if (!recipientUserId || !userMap.has(recipientUserId)) return
    const dedupeKey = `${input.dedupeBase}:${recipientUserId}`
    if (dedupe.has(dedupeKey)) return
    dedupe.add(dedupeKey)
    created.push({
      id: createId(), dedupeKey, recipientUserId, createdAt: input.createdAt || occurredAt,
      type: input.type, scope: input.scope || 'personal', severity: input.severity || 'info',
      title: input.title, message: input.message, taskId: input.taskId || undefined,
      parentTaskId: input.parentTaskId || undefined, clientId: input.clientId || undefined,
      projectId: input.projectId || undefined, actorUserId: input.actorUserId || undefined,
      actorName: input.actorName || undefined, readAt: undefined, dismissedAt: undefined,
    })
  }

  const recipientsWithAdmins = (assigneeId?: string) => {
    const recipients = new Map<string, 'personal' | 'team'>()
    if (assigneeId) recipients.set(assigneeId, 'personal')
    for (const admin of admins) if (!recipients.has(String(admin.id))) recipients.set(String(admin.id), 'team')
    return recipients
  }

  const events = Array.isArray(state?.workEvents) ? state.workEvents : []
  const rolledTaskIds = new Set(events.filter((event: any) => event?.action === 'follow_up_auto_moved' && (newEventIds.has(String(event?.id || '')) || (initializedAt && String(event?.occurredAt || '') >= initializedAt))).map((event: any) => String(event.taskId || '')))
  for (const event of events) {
    const eventId = String(event?.id || '')
    if (!eventId) continue
    const isNew = newEventIds.has(eventId) || (initializedAt && String(event.occurredAt || '') >= initializedAt)
    if (!isNew) continue
    const assigneeId = event.assignedToUserId ? String(event.assignedToUserId) : undefined
    const actorId = event.actorUserId ? String(event.actorUserId) : undefined
    const base = { taskId: event.taskId, parentTaskId: event.parentTaskId, clientId: event.clientId, projectId: event.projectId, actorUserId: actorId, actorName: event.actorName, createdAt: event.occurredAt }
    if (event.action === 'assigned' || event.action === 'reassigned') {
      add(assigneeId, { ...base, dedupeBase: `event:${eventId}:assigned`, type: event.action, severity: 'info', title: event.action === 'assigned' ? 'Work assigned to you' : 'Work reassigned to you', message: event.summary })
      if (event.action === 'reassigned' && event.oldValue && String(event.oldValue) !== assigneeId) add(String(event.oldValue), { ...base, dedupeBase: `event:${eventId}:removed`, type: 'reassigned', severity: 'info', title: 'Work reassigned', message: event.summary })
    } else if (event.action === 'follow_up_auto_moved') {
      for (const [recipient, scope] of recipientsWithAdmins(assigneeId)) add(recipient, { ...base, dedupeBase: `event:${eventId}:followup`, scope, type: 'follow_up_moved', severity: 'warning', title: 'Subtask follow-up moved', message: event.summary })
    } else if (event.action === 'reopened') {
      for (const [recipient, scope] of recipientsWithAdmins(assigneeId)) if (recipient !== actorId) add(recipient, { ...base, dedupeBase: `event:${eventId}:reopened`, scope, type: 'reopened', severity: 'warning', title: 'Work reopened', message: event.summary })
    } else if (event.action === 'completed') {
      for (const admin of admins) if (String(admin.id) !== actorId) add(String(admin.id), { ...base, dedupeBase: `event:${eventId}:completed`, scope: String(admin.id) === assigneeId ? 'personal' : 'team', type: 'completed', severity: 'success', title: 'Work completed', message: event.summary })
      if (assigneeId && assigneeId !== actorId) add(assigneeId, { ...base, dedupeBase: `event:${eventId}:completed`, type: 'completed', severity: 'success', title: 'Assigned work completed', message: event.summary })
    } else if (event.action === 'evidence_uploaded' && assigneeId !== actorId) {
      add(assigneeId, { ...base, dedupeBase: `event:${eventId}:evidence`, type: 'evidence_uploaded', severity: 'info', title: 'Evidence uploaded', message: event.summary })
    } else if (event.action === 'comment_added' && assigneeId !== actorId) {
      add(assigneeId, { ...base, dedupeBase: `event:${eventId}:comment`, type: 'comment_added', severity: 'info', title: 'New work comment', message: event.summary })
    }
  }

  const items = Array.isArray(state?.items) ? state.items : []
  for (const item of items) {
    if (isClosed(item, state)) continue
    const assigneeId = item.assignedToUserId ? String(item.assignedToUserId) : undefined
    if (!assigneeId || !userMap.has(assigneeId)) continue
    const context = { taskId: item.id, parentTaskId: item.parentTaskId, clientId: item.clientId, projectId: item.projectId }
    const kind = item.parentTaskId ? 'Subtask' : 'Task'
    const dueDate = String(item.dueDate || '')
    if (DATE_KEY.test(dueDate) && dueDate === options.today) {
      for (const [recipient, scope] of recipientsWithAdmins(assigneeId)) add(recipient, { ...context, dedupeBase: `due-today:${item.id}:${dueDate}`, scope, type: 'due_today', severity: 'warning', title: `${kind} due today`, message: `“${item.title}” is due today (${dueDate}).` })
    } else if (DATE_KEY.test(dueDate) && dueDate < options.today) {
      for (const [recipient, scope] of recipientsWithAdmins(assigneeId)) add(recipient, { ...context, dedupeBase: `overdue:${item.id}:${dueDate}`, scope, type: 'overdue', severity: 'urgent', title: `${kind} overdue`, message: `“${item.title}” has been overdue since ${dueDate}.` })
    }
    const followUpDate = String(item.followUpDate || '')
    if (DATE_KEY.test(followUpDate) && followUpDate === options.today && !rolledTaskIds.has(String(item.id))) add(assigneeId, { ...context, dedupeBase: `follow-up-today:${item.id}:${followUpDate}`, type: 'follow_up_today', severity: 'warning', title: `${kind} follow-up today`, message: `“${item.title}” needs follow-up today.` })
  }

  const notificationState = initializedAt ? state.notificationState : { ...(state?.notificationState || {}), initializedAt: occurredAt }
  const changed = created.length > 0 || !initializedAt
  if (!changed) return { state, changed: false, created }
  return { state: { ...state, notifications: trimPerRecipient([...created, ...existing]), notificationState }, changed: true, created }
}

export function updateNotificationForUser(state: any, notificationId: string, userId: string, action: 'read' | 'unread' | 'dismiss', occurredAt = new Date().toISOString()) {
  let matched = false
  const notifications = (Array.isArray(state?.notifications) ? state.notifications : []).map((notification: any) => {
    if (String(notification?.id || '') !== notificationId || String(notification?.recipientUserId || '') !== userId) return notification
    matched = true
    if (action === 'read') return { ...notification, readAt: occurredAt }
    if (action === 'unread') return { ...notification, readAt: undefined }
    return { ...notification, dismissedAt: occurredAt, readAt: notification.readAt || occurredAt }
  })
  return { state: matched ? { ...state, notifications } : state, matched }
}

export function markAllNotificationsReadForUser(state: any, userId: string, occurredAt = new Date().toISOString()) {
  let changed = false
  const notifications = (Array.isArray(state?.notifications) ? state.notifications : []).map((notification: any) => {
    if (String(notification?.recipientUserId || '') !== userId || notification.dismissedAt || notification.readAt) return notification
    changed = true
    return { ...notification, readAt: occurredAt }
  })
  return { state: changed ? { ...state, notifications } : state, changed }
}
