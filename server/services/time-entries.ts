import {
  canRemoveTimeEntry,
  MAX_ENTRIES_PER_TASK,
  normalizeEstimate,
  type SeedsTimeRule,
  validateTimeEntryInput,
  type TimeEntry,
} from '../../src/features/tasks/effort'

type Actor = { id: string; name?: string; username?: string; role?: string }
type Result<T> = { ok: true; value: T } | { ok: false; status: number; error: string }

/**
 * Applies the effort rules to a task arriving through a workspace save:
 * time entries always come from the stored copy (only the time-entry API writes them),
 * and the estimate is validated and rounded to a quarter hour.
 */
export function applyEffortSaveRules(currentItem: any, incoming: any): Result<any> {
  const estimate = normalizeEstimate(incoming?.estimateHours)
  if (!estimate.ok)
    return { ok: false, status: 400, error: `Task “${String(incoming?.title || 'Untitled')}”: ${estimate.error}` }
  const timeEntries: TimeEntry[] = Array.isArray(currentItem?.timeEntries) ? currentItem.timeEntries : []
  const next = { ...incoming, timeEntries }
  if (estimate.value === undefined) delete next.estimateHours
  else next.estimateHours = estimate.value
  return { ok: true, value: next }
}

export function addTimeEntry(
  task: any,
  input: unknown,
  actor: Actor,
  now: Date,
  id: string,
  /** Once Seeds is on (see seedsTimeRule): only work tagged with a Seeds task takes time. */
  seeds: SeedsTimeRule | null = null,
): Result<{ task: any; entry: TimeEntry }> {
  const checked = validateTimeEntryInput(input, seeds)
  if (!checked.ok) return { ok: false, status: 400, error: checked.error }
  const existing: TimeEntry[] = Array.isArray(task?.timeEntries) ? task.timeEntries : []
  if (existing.length >= MAX_ENTRIES_PER_TASK)
    return {
      ok: false,
      status: 409,
      error: 'This task has reached the time-entry limit. Log further time on a subtask.',
    }
  const entry: TimeEntry = {
    id,
    ...checked.value,
    userId: actor.id,
    userName: actor.name || actor.username || 'User',
    createdAt: now.toISOString(),
  }
  return { ok: true, value: { task: { ...task, timeEntries: [...existing, entry] }, entry } }
}

/**
 * Changes an entry that has not gone to Seeds yet: its date, duration, Seeds task, product, subtask and remarks, by the
 * same rules as logging it. Only its author or an Administrator may. Once it is in Seeds it is changed there instead.
 * A failed send's reason is cleared, so the next send tries the changed entry afresh.
 */
export function updateTimeEntry(
  task: any,
  entryId: string,
  input: unknown,
  actor: Actor,
  now: Date,
  seeds: SeedsTimeRule | null = null,
): Result<{ task: any; entry: TimeEntry }> {
  const existing: TimeEntry[] = Array.isArray(task?.timeEntries) ? task.timeEntries : []
  const entry = existing.find(candidate => String(candidate?.id || '') === entryId)
  if (!entry) return { ok: false, status: 404, error: 'Time entry was not found.' }
  if (entry.seedsEntryId) return { ok: false, status: 409, error: 'This time is already in Seeds. Change it in Seeds.' }
  if (!canRemoveTimeEntry(entry, actor))
    return { ok: false, status: 403, error: 'Only the person who logged this time or an Administrator can change it.' }
  const checked = validateTimeEntryInput(input, seeds)
  if (!checked.ok) return { ok: false, status: 400, error: checked.error }
  const {
    seedsError: _failed,
    seedsTaskId: _task,
    productId: _product,
    subtaskId: _subtask,
    forSeeds: _forSeeds,
    ...kept
  } = entry
  const changed: TimeEntry = { ...kept, ...checked.value, updatedAt: now.toISOString() }
  return {
    ok: true,
    value: {
      task: { ...task, timeEntries: existing.map(candidate => (candidate === entry ? changed : candidate)) },
      entry: changed,
    },
  }
}

export function removeTimeEntry(task: any, entryId: string, actor: Actor): Result<{ task: any; entry: TimeEntry }> {
  const existing: TimeEntry[] = Array.isArray(task?.timeEntries) ? task.timeEntries : []
  const entry = existing.find(candidate => String(candidate?.id || '') === entryId)
  if (!entry) return { ok: false, status: 404, error: 'Time entry was not found.' }
  if (entry.seedsEntryId)
    return { ok: false, status: 409, error: 'This time is already in Seeds. Change or remove it in Seeds.' }
  if (!canRemoveTimeEntry(entry, actor))
    return { ok: false, status: 403, error: 'Only the person who logged this time or an Administrator can remove it.' }
  return {
    ok: true,
    value: { task: { ...task, timeEntries: existing.filter(candidate => candidate !== entry) }, entry },
  }
}
