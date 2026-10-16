/**
 * Authorization invariant for account changes that arrive through a workspace save (`PUT /api/store`).
 *
 * Account management proper (roles, modules, status, other users) lives in Users & Permissions and
 * Internal Admin. A tracker save must never be a side door into those: the only account edit it may
 * carry is the signed-in user changing their OWN profile fields. `accountChangesAreSelfOnly` is the
 * gate for that — it returns true only when every difference between the server's accounts and the
 * incoming accounts is confined to the caller's own record and to the allow-listed profile fields.
 *
 * This is kept as a standalone pure function (not inlined in the save handler) so it can be unit
 * tested directly — index.ts starts the HTTP server on import and cannot be loaded by a test. The
 * accompanying test pins the escalation cases, so a future refactor of the save path cannot silently
 * widen what a non-administrator may change about accounts.
 */

/** Order-independent serialization: object keys are sorted so field reordering is not seen as a change. */
export function stableAccount(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
    ? Object.fromEntries(Object.keys(entry).sort().map((key) => [key, entry[key]])) : entry)
}

/** Profile fields the signed-in user may change on their own account through a workspace save. */
export const SELF_EDITABLE_ACCOUNT_FIELDS = ['name', 'email', 'phone', 'passwordHash', 'theme'] as const

export function accountChangesAreSelfOnly(currentAccounts: any[], nextAccounts: any[], userId: string) {
  if (currentAccounts.length !== nextAccounts.length) return false
  const currentMap = new Map(currentAccounts.map((account) => [String(account.id), account]))
  for (const next of nextAccounts) {
    const current = currentMap.get(String(next.id))
    if (!current) return false
    if (String(next.id) !== userId) {
      // Any change to another user's record disqualifies the save; account management is elsewhere.
      if (stableAccount(current) !== stableAccount(next)) return false
      continue
    }
    const allowed = SELF_EDITABLE_ACCOUNT_FIELDS as readonly string[]
    const keys = new Set([...Object.keys(current), ...Object.keys(next)])
    for (const key of keys) {
      // role, modules, status and anything else outside the allow-list cannot be self-escalated.
      if (allowed.includes(key)) continue
      if (stableAccount(current[key]) !== stableAccount(next[key])) return false
    }
  }
  return true
}
