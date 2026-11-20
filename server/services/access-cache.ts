/**
 * The access part of each workspace (assignments, job roles), kept in memory so every request gets each person's
 * pages and rights from their job roles without reading the whole workspace. Refreshed whenever a workspace is loaded or saved
 * (core/tenant-state.ts); sessions live in this process too, so the two always agree.
 */
import { effectiveAccount } from '../../src/shared/access'
import { seedsAdmits, seedsEmployeeEmails } from '../auth/google-sign-in'

type AccessSnapshot = {
  access: unknown
  jobRoles: unknown
  accounts: { id: unknown; role: unknown; jobRoles: unknown; email?: unknown }[]
  seeds?: { connected?: unknown; users: Record<string, { lastSuccessAt?: unknown }> }
  /** Seeds' active employees by email, once Seeds is on and has given them; else null (nothing to check). */
  employees: Set<string> | null
}
const snapshots = new Map<string, AccessSnapshot>()

export function rememberAccess(organizationId: string | null | undefined, state: any) {
  if (!organizationId || !state || typeof state !== 'object') return
  snapshots.set(String(organizationId), {
    access: state.access,
    // Job roles decide each person's pages (shared/roles.ts).
    jobRoles: state.jobRoles,
    accounts: (Array.isArray(state.accounts) ? state.accounts : []).map((account: any) => ({
      id: account?.id,
      role: account?.role,
      jobRoles: account?.jobRoles,
      email: account?.email,
    })),
    // Whose Seeds sync has succeeded decides whose Seeds assignments count (see shared/access.ts).
    seeds: state.seeds
      ? {
          connected: state.seeds.connected,
          users: Object.fromEntries(
            Object.entries(state.seeds.users || {}).map(([userId, sync]: [string, any]) => [
              userId,
              { lastSuccessAt: sync?.lastSuccessAt },
            ]),
          ),
        }
      : undefined,
    employees: seedsEmployeeEmails(state),
  })
}

/**
 * Password sessions of people with a Seeds exception (set in Internal Admin; see auth/google-sign-in.ts), by session
 * token, with whose they are. They stay signed in when Seeds does not list them. Kept here, in memory, like the
 * sessions themselves, so the two end together on a restart.
 */
const exceptionSessions = new Map<string, string>()

export function rememberSeedsException(token: string, userId: string) {
  if (token && userId) exceptionSessions.set(token, String(userId))
}

export function forgetSeedsException(token: string) {
  exceptionSessions.delete(token)
}

/** Internal Admin took a person's exception away: their sessions are checked against Seeds again. */
export function forgetSeedsExceptionsOf(userId: string) {
  for (const [token, owner] of exceptionSessions) if (owner === String(userId)) exceptionSessions.delete(token)
}

/**
 * Whether Seeds still lets this signed-in person in (see auth/google-sign-in.ts). The email is read from the
 * workspace, so a change there counts at once; an unknown workspace lets the session through until it is loaded.
 * A password session that came in by a Seeds exception stays in.
 */
export function seedsStillAdmits(
  user: { id: string; role: string; email?: string; organizationId?: string },
  token = '',
) {
  const snapshot = user.organizationId ? snapshots.get(user.organizationId) : undefined
  if (!snapshot) return true
  const account = snapshot.accounts.find(entry => String(entry.id) === user.id)
  if (seedsAdmits({ email: account?.email ?? user.email }, snapshot.employees)) return true
  return Boolean(token) && exceptionSessions.get(token) === String(user.id)
}

/** The session as permission checks should see it. */
export function withAccess<T extends { id: string; role: string; modules: string[]; organizationId?: string }>(
  user: T,
): T {
  const snapshot = user.organizationId ? snapshots.get(user.organizationId) : undefined
  return snapshot ? effectiveAccount(user, snapshot) : user
}

export function forgetAccess() {
  snapshots.clear()
  exceptionSessions.clear()
}
