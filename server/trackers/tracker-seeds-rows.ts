/**
 * New Seeds projects become tracker rows. After a save that brings in projects from Seeds (the Seeds sync), each
 * tracker switched on for it ("Add new Seeds projects as rows", the seeds_rows column) whose clients include the
 * project's client gets, for each such project:
 * - the project among its projects;
 * - a row named after it (with its contract number in a Contract number column);
 * - the row's task in that project, assigned to the tracker's creator, and on a Site rollout tracker a subtask for
 *   each step, linked to the step's cell, as when a person names a site.
 * When the tasks cannot be made (no task rights on the server, say), the row is still added and the tracker offers to
 * make its task. See src/features/trackers/seedsRows.ts for the rules.
 */
import { randomUUID } from 'node:crypto'
import { newSeedsProjects, projectsForTracker, seedsRowCells } from '../../src/features/trackers/seedsRows'
import { keepsStepTasks, planStepTasks, type StepPlan } from '../../src/features/trackers/stepTasks'
import { splitClientIds, TRACKER_LIMITS, TRACKER_PROJECTS } from '../../src/features/trackers/trackerModel'
import type { TaskDraft } from '../../src/features/trackers/TrackerWork'
import type { Deps } from './tracker-common'
import type { TrackerCore } from './tracker-core'
import type { TrackerSheetAccess } from './tracker-source'
import type { TrackerSheetWrite } from './tracker-sheet-write'

/** Who the rows, history and tasks are recorded as. */
export const SEEDS_ROWS_ACTOR = { id: 'system:seeds', name: 'Seeds sync', role: 'Administrator', organizationId: '' }

export function trackerSeedsRows(
  deps: Deps,
  core: TrackerCore,
  sheetAccess: TrackerSheetAccess,
  sheetWrite: TrackerSheetWrite,
) {
  const { db, check, columnsOf, cleanRowInput, mergeCells, now, record, touch, rowCount } = core
  const { sourceRow } = sheetAccess
  const { appendRowsToSheet } = sheetWrite

  /** Follows up a save. Never throws: a failure here must not look like a failed save or sync. */
  async function addSeedsRows(tenant: string, before: any, after: any) {
    if (!db || !tenant) return
    const fresh = newSeedsProjects(before, after)
    if (!fresh.length) return
    const found = await db.from('tenant_trackers').select('*').eq('tenant_id', tenant).eq('seeds_rows', true)
    // Before schema v37 there is no seeds_rows column, so no tracker is switched on.
    if (found.error) return
    for (const tracker of found.data || []) {
      try {
        await addTo(tenant, tracker, projectsForTracker(tracker, fresh), after)
      } catch (error: any) {
        console.error('Adding new Seeds projects to a tracker failed:', error?.message || error)
      }
    }
  }

  async function addTo(tenant: string, tracker: any, wanted: ReturnType<typeof projectsForTracker>, state: any) {
    const columns = columnsOf(tracker)
    const actor = { ...SEEDS_ROWS_ACTOR, organizationId: tenant }
    const rows = wanted
      .map(project => ({ project, cells: seedsRowCells(columns, project) }))
      .filter((entry): entry is { project: (typeof wanted)[number]; cells: NonNullable<typeof entry.cells> } =>
        Boolean(entry.cells),
      )
      .slice(0, TRACKER_LIMITS.importBatch)
      .map(entry => ({ ...entry, id: randomUUID(), cells: cleanRowInput(columns, { cells: entry.cells }, '').cells }))
    if (!rows.length) return
    const total = await rowCount(tenant, tracker.id)
    if (total + rows.length > TRACKER_LIMITS.rows) return
    // A tracker that only follows its Google Sheet (one-way) takes its rows from the Sheet alone.
    const source = await sourceRow(tenant, tracker.id).catch(() => null)
    if (source && source.mode !== 'two_way') return

    // The projects join the tracker's own (at most TRACKER_PROJECTS; the default stays first).
    const projectIds = [...new Set([...splitClientIds(tracker.project_id), ...rows.map(row => row.project.id)])]
    if (projectIds.length <= TRACKER_PROJECTS) {
      const moved = await db
        .from('tenant_trackers')
        .update({ project_id: projectIds.join(','), updated_at: now() })
        .eq('tenant_id', tenant)
        .eq('id', tracker.id)
      check(moved.error)
    }

    // The tasks, made in the workspace first so the rows are saved already linked to them.
    const accounts = Array.isArray(state?.accounts) ? state.accounts : []
    const creator = accounts.find((account: any) => account?.id === tracker.created_by && account.status !== 'Inactive')
    const byRow = new Map(rows.map(row => [row.id, row.project]))
    let plan: StepPlan
    if (keepsStepTasks({ template: tracker.template || '', stepTasks: tracker.step_tasks ?? undefined }))
      plan = planStepTasks({
        columns,
        rows: rows.map(row => ({ id: row.id, cells: row.cells, taskId: '' })),
        clientId: '',
        projectId: '',
        assigneeId: creator?.id || '',
        placeFor: row => ({ clientId: byRow.get(row.id)?.clientId || '', projectId: byRow.get(row.id)?.id || '' }),
      })
    else {
      const drafts: TaskDraft[] = rows.map(row => ({
        title: row.project.name,
        clientId: row.project.clientId,
        projectId: row.project.id,
        ...(creator ? { assignedToUserId: creator.id } : {}),
      }))
      plan = { drafts, rowTasks: rows.map((row, at) => ({ rowId: row.id, draft: at })), cellTasks: [], ticked: [] }
    }
    let made: { id: string }[] = []
    if (plan.drafts.length && deps.createTasks)
      made = await deps.createTasks(tenant, plan.drafts, actor).catch((error: any) => {
        console.error('Making tasks for new Seeds rows failed:', error?.message || error)
        return []
      })
    const taskOf = new Map(
      plan.rowTasks.flatMap(link => (made[link.draft] ? [[link.rowId, made[link.draft].id] as const] : [])),
    )

    const last = await db
      .from('tenant_tracker_rows')
      .select('position')
      .eq('tenant_id', tenant)
      .eq('tracker_id', tracker.id)
      .order('position', { ascending: false })
      .limit(1)
    check(last.error)
    let position = Number(last.data?.[0]?.position ?? 0)
    const stamp = now()
    const records = rows.map(row => ({
      tenant_id: tenant,
      tracker_id: tracker.id,
      id: row.id,
      position: ++position,
      data: mergeCells({}, columns, row.cells),
      secrets: {},
      task_id: taskOf.get(row.id) || '',
      version: 1,
      created_by: actor.id,
      updated_by: actor.id,
      created_at: stamp,
      updated_at: stamp,
    }))
    const saved = await db.from('tenant_tracker_rows').insert(records)
    check(saved.error)
    const links = plan.cellTasks.flatMap(link =>
      made[link.draft]
        ? [
            {
              id: randomUUID(),
              tenant_id: tenant,
              tracker_id: tracker.id,
              row_id: link.rowId,
              column_id: link.columnId,
              task_id: made[link.draft].id,
              created_by: actor.id,
              created_by_name: actor.name,
              created_at: stamp,
            },
          ]
        : [],
    )
    if (links.length) {
      const linked = await db.from('tenant_tracker_task_links').insert(links)
      if (linked.error) console.error('Linking the steps of new Seeds rows failed:', linked.error.message)
    }
    await record(tenant, tracker.id, '', actor, 'rows_added', {
      count: records.length,
      from: 'Seeds',
      projects: rows.map(row => row.project.name),
    })
    // Two-way: the rows go to the Google Sheet too, as rows a person adds do, with the tracker creator's Google access.
    if (source?.mode === 'two_way')
      await appendRowsToSheet(tenant, tracker, source, records, { id: tracker.created_by || actor.id }).catch(
        (error: unknown) =>
          console.error(
            'New Seeds rows were not added to the Google Sheet:',
            error instanceof Error ? error.message : error,
          ),
      )
    await touch(tenant, tracker.id)
  }

  return { addSeedsRows }
}
