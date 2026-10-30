import { randomUUID } from 'node:crypto'
import type { DonePatch } from '../../src/features/trackers/cellSubtasks'
import { isClosedStatus } from '../../src/features/trackers/trackerAutoDone'
import { applyTaskPatches } from '../../src/features/trackers/trackerTasks'
import { archivedWorkReason } from '../../src/features/tasks/lifecycle'
import { defaultWaitingOn, doneWaitingOn } from '../../src/features/tasks/waitingOn'

/**
 * Tasks completed or reopened by the server for a tracker: a box ticked or unticked in the connected Google Sheet
 * completes or reopens the subtask in that cell (see cellSubtasks). The same rules as a tick in the tracker itself
 * (updateTrackerTasks in the app): a completed task takes the first closed status, the done "Waiting on" option and
 * today's resolved date; a reopened one the first open status and the first open "Waiting on" option. A task with open
 * subtasks is not completed, archived work and work of archived clients or projects is left alone, and phase tasks
 * roll up as in Tasks.
 */
export type TrackerActor = { id: string; name: string; role: string }

const list = (value: unknown): any[] => (Array.isArray(value) ? value : [])

/** The workspace after the patches, and the tasks that were completed or reopened. Pure. */
export function applyTrackerTaskPatches(state: any, patches: DonePatch[], options: { today: string; from: string }) {
  const statuses = list(state?.taskSettings?.statuses).filter(
    (status: any) => status && typeof status.label === 'string' && status.label,
  )
  const closedStatus = String(statuses.find((status: any) => status.closed)?.label || 'Resolved')
  const openStatus = String(statuses.find((status: any) => !status.closed)?.label || 'Open')
  const items = list(state?.items)
  const context = { ...state, clients: list(state?.clients), projects: list(state?.projects), items }
  const workable = items.filter(item => item?.archived !== true && !archivedWorkReason(context, item))
  const ids = new Set(workable.map(item => item.id))
  // One patch per task, the last one winning, and only for tasks that may change.
  const wanted = [...new Map(patches.map(patch => [patch.id, patch.done]))]
  const todo = wanted.filter(([id]) => ids.has(id)).map(([id, done]) => ({ id, done }))
  const { items: patched, changed } = applyTaskPatches(workable, todo, {
    isClosed: status => isClosedStatus(status, statuses),
    close: () => ({
      status: closedStatus,
      waitingOn: doneWaitingOn(state?.taskSettings),
      followUpDate: '',
      resolvedDate: options.today,
    }),
    open: () => ({
      status: openStatus,
      waitingOn: defaultWaitingOn(state?.taskSettings),
      resolvedDate: undefined,
    }),
  })
  if (!changed.length) return { state, changed: [] as { id: string; title: string; done: boolean }[] }
  const updated = new Map(patched.map(item => [item.id, item]))
  const done = changed.filter(entry => entry.done !== undefined)
  const activity = done.map(entry => ({
    id: randomUUID(),
    clientId: entry.item.clientId,
    projectId: entry.item.projectId,
    date: options.today,
    text: `${entry.done ? 'Completed' : 'Reopened'} ${entry.item.parentTaskId ? 'subtask' : 'task'} from ${options.from}: ${entry.item.title}`,
  }))
  return {
    state: {
      ...state,
      items: items.map(item => updated.get(item.id) || item),
      activity: [...activity, ...list(state?.activity)],
    },
    changed: done.map(entry => ({
      id: String(entry.item.id),
      title: String(entry.item.title || ''),
      done: Boolean(entry.done),
    })),
  }
}

/**
 * Saves tracker task changes to the workspace, as the given person, with one retry when the workspace changed in
 * between. Returns how many tasks were completed or reopened.
 */
export function trackerTaskUpdater(deps: {
  /** The current workspace. Its `data` must be the object the save compares against. */
  load: (tenantId: string) => Promise<{ data: any }>
  /** Saves the workspace with its work history, like a person's save. */
  commit: (tenantId: string, next: any, actor: TrackerActor, reason: string, current: any) => Promise<unknown>
  today: () => string
  /** True when the save lost a race with another save and is worth one more try. */
  retryable: (error: unknown) => boolean
}) {
  return async function updateTasks(tenantId: string, patches: DonePatch[], actor: TrackerActor, from: string) {
    if (!patches.length) return 0
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const current = await deps.load(tenantId)
      if (!current?.data) return 0
      const result = applyTrackerTaskPatches(current.data, patches, { today: deps.today(), from })
      if (!result.changed.length) return 0
      try {
        await deps.commit(tenantId, result.state, actor, 'tracker-cell-tick', current.data)
        return result.changed.length
      } catch (error) {
        if (attempt === 0 && deps.retryable(error)) continue
        throw error
      }
    }
    return 0
  }
}
