import {
  assertLifecycleMutation,
  LifecycleError,
  stableRecord,
  type LifecycleActor,
  type LifecycleStore,
} from '../../src/features/tasks/lifecycle'

/**
 * Something else saved the workspace while this save was being checked (another person, a background job). The
 * browser can fetch the latest, merge its own changes onto it and try again, so this is not a real conflict.
 */
export class WorkspaceRaceError extends LifecycleError {
  readonly raced = true
}

/** Serialize snapshot commits per tenant and recheck the authoritative state immediately before saving. */
export function createWorkspaceGuard(
  load: (id: string) => Promise<LifecycleStore | null>,
  fallback: () => LifecycleStore,
) {
  const pending = new Map<string, Promise<unknown>>()
  return async function guarded<T>(
    id: string,
    next: LifecycleStore,
    actor: LifecycleActor | null,
    before: LifecycleStore | undefined,
    write: (
      current: LifecycleStore & { rtms?: import('../../src/features/requirements/rtm').RtmMatrix[] },
    ) => Promise<T>,
  ): Promise<T> {
    const previous = pending.get(id) || Promise.resolve()
    const job = previous
      .catch(() => undefined)
      .then(async () => {
        const current = (await load(id)) || fallback()
        if (before && stableRecord(current) !== stableRecord(before))
          throw new WorkspaceRaceError(
            'This workspace changed while saving. Reload and retry; your change was not saved.',
          )
        assertLifecycleMutation(current, next, actor)
        return write(current)
      })
    pending.set(id, job)
    try {
      return await job
    } finally {
      if (pending.get(id) === job) pending.delete(id)
    }
  }
}
