/**
 * The access part of each workspace, kept in memory so every request can treat an Account Manager as a Viewer
 * of four pages without reading the whole workspace. Refreshed whenever a workspace is loaded or saved
 * (core/tenant-state.ts); sessions live in this process too, so the two always agree.
 */
import { effectiveAccount } from '../../src/shared/access'

type AccessSnapshot = {
  access: unknown
  seeds?: { connected?: unknown; users: Record<string, { lastSuccessAt?: unknown }> }
}
const snapshots = new Map<string, AccessSnapshot>()

export function rememberAccess(organizationId: string | null | undefined, state: any) {
  if (!organizationId || !state || typeof state !== 'object') return
  snapshots.set(String(organizationId), {
    access: state.access,
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
  })
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
}
