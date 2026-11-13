/**
 * Helpers shared by the app state hooks (see useAppState.tsx).
 */
import { organizationStorageKey } from '../store'

/**
 * What this browser keeps for a signed-in person: the workspace copy that makes the next start fast, and AI BA
 * Assistant conversations. Removed at sign-out, so the next person at a shared computer cannot read them in the
 * browser's storage. Unsaved edits kept after a save conflict stay: they are the only copy.
 */
export function forgetBrowserCopies(user: { id?: string; organizationId?: string } | null) {
  try {
    localStorage.removeItem(organizationStorageKey(user?.organizationId))
    const threadsKey = 'ba-client-ops-ai-threads-v1'
    const threads = JSON.parse(localStorage.getItem(threadsKey) || '{}') as Record<string, unknown>
    const mine = `${user?.id || ''}:`
    const others = Object.fromEntries(Object.entries(threads).filter(([key]) => !key.startsWith(mine)))
    if (Object.keys(others).length) localStorage.setItem(threadsKey, JSON.stringify(others))
    else localStorage.removeItem(threadsKey)
  } catch {
    /* Storage unavailable: nothing was kept. */
  }
}
