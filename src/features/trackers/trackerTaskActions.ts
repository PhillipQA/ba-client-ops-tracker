/**
 * Making the tasks and subtasks of a project timeline tracker, in the browser (tasks are saved with the workspace).
 * The plan comes from trackerTasks; this file creates the tasks, links each row to its task and, when the tracker had
 * no project, files the tracker under the project the tasks were made in.
 */
import type { WorkItem } from '../../shared/types'
import { settleTimelineFields } from './timelineModel'
import { trackerApi } from './trackerApi'
import type { Tracker, TrackerRow } from './trackerModel'
import { keepsTasks, planRowTasks } from './trackerTasks'
import { trackerClients, type TaskDraft } from './TrackerWork'

export type RowTasksResult = { created: number; rows: TrackerRow[]; projectId?: string; error?: string }

export async function createRowTasks(input: {
  tracker: Tracker
  rows: TrackerRow[]
  items: WorkItem[]
  currentUserId: string
  onCreateTasks: (drafts: TaskDraft[]) => Promise<WorkItem[]>
  /** Only these rows get tasks; all rows are still read to find each phase's task. */
  onlyRowIds?: string[]
}): Promise<RowTasksResult> {
  const { tracker } = input
  if (!keepsTasks(tracker.columns)) return { created: 0, rows: [] }
  const clientId = trackerClients(tracker)[0] || ''
  if (!clientId) return { created: 0, rows: [], error: 'Choose a client for this tracker so its tasks can be made.' }
  const fields = settleTimelineFields(tracker.columns, tracker.timeline?.fields || null)
  const plan = planRowTasks({
    columns: tracker.columns,
    rows: input.rows,
    items: input.items,
    phaseId: fields.groupId,
    leadId: fields.leadId,
    clientId,
    projectId: tracker.projectId,
    newProjectName: tracker.name,
    assigneeId: input.currentUserId,
    onlyRowIds: input.onlyRowIds,
  })
  if (!plan.drafts.length) return { created: 0, rows: [] }
  const made = await input.onCreateTasks(plan.drafts)
  const links = plan.links.flatMap(link =>
    made[link.draft] ? [{ rowId: link.rowId, taskId: made[link.draft].id }] : [],
  )
  const linked = links.length ? (await trackerApi.linkRowTasks(tracker.id, links)).rows : []
  let projectId: string | undefined
  const madeIn = made.find(item => item.projectId)?.projectId
  if (!tracker.projectId && madeIn) {
    await trackerApi.update(tracker.id, { projectId: madeIn }).catch(() => undefined)
    projectId = madeIn
  }
  return { created: made.length, rows: linked, projectId }
}
