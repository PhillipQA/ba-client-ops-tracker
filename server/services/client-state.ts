/**
 * Shapes the stored workspace for the signed-in browser. This is the only place workspace data leaves the
 * server wholesale, so anything the browser must not hold is removed here.
 */
export function sanitizeStateForClient(state: any, user: { id: string; role?: string }) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return state
  const administrator = user.role === 'Administrator'
  return {
    ...state,
    items: Array.isArray(state.items) ? state.items.filter((item: any) => !(item?.source === 'Discord' && item?.externalSourceId)) : [],
    activity: Array.isArray(state.activity) ? state.activity.filter((item: any) => !String(item?.text || '').startsWith('Discord inquiry captured:')) : [],
    accounts: Array.isArray(state.accounts)
      // Password hashes never leave the server. Colleagues' contact details are shown only to
      // Administrators (in Users & Permissions) and to the person they belong to (My profile).
      ? state.accounts.map((account: any) => ({
        ...account,
        passwordHash: '',
        ...(!administrator && String(account?.id || '') !== user.id ? { email: '', phone: '' } : {}),
      }))
      : state.accounts,
    notifications: Array.isArray(state.notifications)
      ? state.notifications.filter((notification: any) => String(notification?.recipientUserId || '') === user.id)
      : [],
  }
}
