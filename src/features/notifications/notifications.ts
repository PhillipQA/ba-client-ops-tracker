import type { AppNotification } from '../../shared/types'

async function notificationResponse(response: Response) {
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>
  if (!response.ok) throw new Error(String(body.error || 'Notification request failed.'))
  return {
    notifications: Array.isArray(body.notifications) ? (body.notifications as AppNotification[]) : [],
    updatedAt: typeof body.updatedAt === 'string' ? body.updatedAt : undefined,
  }
}

export async function loadNotifications() {
  return notificationResponse(await fetch('/api/notifications', { credentials: 'same-origin' }))
}

export async function updateNotification(id: string, action: 'read' | 'unread' | 'dismiss') {
  return notificationResponse(
    await fetch(`/api/notifications/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ action }),
    }),
  )
}

export async function markAllNotificationsRead() {
  return notificationResponse(
    await fetch('/api/notifications/read-all', { method: 'POST', credentials: 'same-origin' }),
  )
}
