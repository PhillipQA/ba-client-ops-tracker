import { dateKeyInTimeZone } from './follow-up-rollover'

export function workspaceRevision(updatedAt: unknown, timeZone: string, now = new Date()) {
  return `${String(updatedAt || 'empty')}:${dateKeyInTimeZone(now, timeZone)}`
}

export async function readWorkspaceRevision(db: any, organizationId: string, timeZone: string) {
  const { data, error } = await db.from('tenant_state').select('updated_at').eq('organization_id', organizationId).maybeSingle()
  if (error) throw error
  return { configured: true, updatedAt: data?.updated_at, revision: workspaceRevision(data?.updated_at, timeZone), timeZone }
}

export async function readNotificationState(db: any, organizationId: string) {
  const { data, error } = await db.from('tenant_state').select('notifications:data->notifications,updated_at').eq('organization_id', organizationId).maybeSingle()
  if (error) throw error
  return { notifications: Array.isArray(data?.notifications) ? data.notifications : [], updatedAt: data?.updated_at }
}
