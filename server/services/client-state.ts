import { clientAccessFor, scopedState, scopeFor } from '../../src/shared/access'
import { seedsStatusFor } from '../../src/shared/seeds'

/**
 * Shapes the stored workspace for the signed-in browser. This is the only place workspace data leaves the
 * server wholesale, so anything the browser must not hold is removed here.
 */
export function sanitizeStateForClient(state: any, user: { id: string; role?: string }) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return state
  const administrator = user.role === 'Administrator'
  // With per-person visibility on, only the clients, projects and work this person is assigned to leave the server.
  // Time logged from calendar events is private: each person reads their own through /api/seeds/calendar-time.
  const {
    access: _access,
    seeds: _seeds,
    calendarTime: _calendarTime,
    ...visible
  } = scopedState(state, scopeFor(state, user.id))
  return {
    ...visible,
    access: clientAccessFor(state, user),
    seeds: seedsStatusFor(state, user),
    items: Array.isArray(visible.items)
      ? visible.items.filter((item: any) => !(item?.source === 'Discord' && item?.externalSourceId))
      : [],
    activity: Array.isArray(visible.activity)
      ? visible.activity.filter((item: any) => !String(item?.text || '').startsWith('Discord inquiry captured:'))
      : [],
    accounts: Array.isArray(state.accounts)
      ? // Password hashes never leave the server. Colleagues' contact details are shown only to
        // Administrators (in Users & Permissions) and to the person they belong to (My profile).
        state.accounts.map((account: any) => ({
          ...account,
          passwordHash: '',
          ...(!administrator && String(account?.id || '') !== user.id ? { email: '', phone: '' } : {}),
        }))
      : state.accounts,
    notifications: Array.isArray(visible.notifications)
      ? visible.notifications.filter((notification: any) => String(notification?.recipientUserId || '') === user.id)
      : [],
  }
}
