// When → then automations, run on the server right after a row is saved from the app (see
// src/features/trackers/trackerAutomations.ts). They never fail the save: anything that goes wrong is logged in the
// run log and the row stays as the person saved it. Changes made here are not fed back in, so automations can't loop.
import { randomUUID } from 'node:crypto'
import type { Express } from 'express'
import {
  type AutomationPlan,
  describeTrigger,
  planAutomations,
  triggered,
} from '../../src/features/trackers/trackerAutomations'
import { keepsStepTasks } from '../../src/features/trackers/stepTasks'
import { cleanTimelineSettings } from '../../src/features/trackers/timelineModel'
import { splitClientIds } from '../../src/features/trackers/trackerModel'
import { makeLookup, rowTitle } from '../../src/features/trackers/trackerQuery'
import { keepsTasks } from '../../src/features/trackers/trackerTasks'
import { dateKeyInTimeZone } from '../services/follow-up-rollover'
import type { Deps, User } from './tracker-common'
import type { TrackerCore } from './tracker-core'

const KIND = 'automation'
const NOTIFICATIONS_KEPT = 500

export type AutomationResult = {
  /** The row as it is after the automations (unchanged when they changed nothing on it). */
  record: any
  done: string[]
  skipped: string[]
  taskId?: string
}

export function trackerAutomations(deps: Deps, core: TrackerCore, timeZone: string) {
  const { db, check, columnsOf, rowOut, mergeCells, record: recordChange, workspace, trackerVisibleIn, now } = core

  async function notify(
    tenant: string,
    user: User,
    tracker: any,
    people: string[],
    title: string,
    message: string,
    rowId: string,
  ) {
    if (!people.length || !deps.commit) return
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const current = await deps.load(tenant)
        if (!current.data) return
        const accounts = Array.isArray(current.data.accounts) ? current.data.accounts : []
        const allowed = people.filter(id => {
          const account = accounts.find((item: any) => String(item.id) === id && item.status === 'Active')
          if (!account || (tracker.private && tracker.created_by !== id)) return false
          return trackerVisibleIn(current.data, {
            id,
            name: String(account.name || ''),
            role: String(account.role || ''),
            organizationId: tenant,
          })(tracker)
        })
        if (!allowed.length) return
        const existing = Array.isArray(current.data.notifications) ? current.data.notifications : []
        const added = allowed.map(id => ({
          id: randomUUID(),
          dedupeKey: `tracker-automation:${randomUUID()}`,
          recipientUserId: id,
          createdAt: now(),
          type: 'tracker_automation',
          scope: 'personal',
          severity: 'info',
          title,
          message,
          trackerId: tracker.id,
          trackerRowId: rowId,
          actorUserId: user.id,
          actorName: user.name,
        }))
        await deps.commit(
          tenant,
          { ...current.data, notifications: [...added, ...existing].slice(0, NOTIFICATIONS_KEPT) },
          user,
          'tracker-automation',
          current.data,
        )
        return
      } catch {
        /* Someone saved at the same moment: read again and try once more. */
      }
    }
  }

  /**
   * Runs the tracker's automations for one saved row. `before` is the row as it was (null for a new row); `saved` is
   * the database record as now saved. Returns the record after the automations.
   */
  async function run(
    tenant: string,
    tracker: any,
    user: User,
    before: any | null,
    saved: any,
  ): Promise<AutomationResult> {
    const columns = columnsOf(tracker)
    const automations = cleanTimelineSettings(tracker.timeline, columns).automations || []
    const none = { record: saved, done: [], skipped: [] }
    if (!automations.some(automation => !automation.off)) return none
    const state = await workspace(tenant)
    const today = dateKeyInTimeZone(new Date(now()), timeZone)
    const lookup = { ...makeLookup(state?.items || [], state?.accounts || [], today), columns }
    const after = rowOut(saved, columns)
    const ran = triggered(automations, before ? rowOut(before, columns) : null, after, columns, lookup, today)
    if (!ran.length) return none
    const title = rowTitle(columns, after)
    let plan: AutomationPlan
    try {
      plan = planAutomations(ran, after, columns, {
        today,
        // A cell that comes from the Sheet is never set here (one-way it is the Sheet's; two-way it would need a write).
        locked: column => Boolean(column.synced),
        tasksByTemplate:
          keepsTasks(columns) ||
          keepsStepTasks({ template: tracker.template || '', stepTasks: tracker.step_tasks ?? undefined }),
        personName: id => lookup.person(id),
      })
    } catch (error: any) {
      console.error('Tracker automation failed:', error?.message || error)
      return none
    }

    // The task, made first so the row is saved already linked to it.
    let taskId = ''
    if (plan.task && deps.createTasks)
      try {
        const [made] = await deps.createTasks(
          tenant,
          [
            {
              title,
              clientId: splitClientIds(tracker.client_id)[0] || '',
              projectId: splitClientIds(tracker.project_id)[0] || '',
              assignedToUserId: plan.task.assignee || user.id,
            },
          ],
          user,
        )
        taskId = made?.id || ''
      } catch (error: any) {
        plan.skipped.push(`the task could not be made: ${error?.message || 'try again'}`)
        plan.done = plan.done.filter(item => item !== 'created its task')
      }
    else if (plan.task) {
      plan.skipped.push('no task: tasks cannot be made here')
      plan.done = plan.done.filter(item => item !== 'created its task')
    }

    let record = saved
    if (Object.keys(plan.cells).length || taskId) {
      const data = mergeCells(saved.data || {}, columns, plan.cells)
      const stamp = now()
      const next = Number(saved.version || 1) + 1
      const written = await db
        .from('tenant_tracker_rows')
        .update({ data, version: next, updated_at: stamp, ...(taskId ? { task_id: taskId } : {}) })
        .eq('tenant_id', tenant)
        .eq('tracker_id', tracker.id)
        .eq('id', saved.id)
        .eq('version', saved.version)
        .select('id')
      if (written.error || !written.data?.length) {
        plan.skipped.push('the row changed again before the automation could save; nothing was set')
        plan.done = plan.done.filter(item => !item.startsWith('set ') && item !== 'created its task')
      } else record = { ...saved, data, version: next, updated_at: stamp, ...(taskId ? { task_id: taskId } : {}) }
    }

    for (const text of plan.comments) {
      const inserted = await db.from('tenant_tracker_changes').insert({
        id: randomUUID(),
        tenant_id: tenant,
        tracker_id: tracker.id,
        row_id: saved.id,
        actor_id: 'automation',
        actor_name: 'Automation',
        kind: 'comment',
        detail: { text, mentions: [] },
        created_at: now(),
      })
      if (inserted.error) plan.skipped.push('a comment could not be added')
    }
    const trigger = ran.map(automation => describeTrigger(automation.when, columns, id => lookup.person(id))).join('; ')
    await notify(tenant, user, tracker, plan.notify, `${title || 'A row'}: ${trigger}`, tracker.name, saved.id).catch(
      () => undefined,
    )
    await recordChange(tenant, tracker.id, saved.id, user, KIND, {
      trigger,
      row: title,
      done: plan.done,
      skipped: plan.skipped,
      automations: ran.map(automation => automation.id),
    })
    return { record, done: plan.done, skipped: plan.skipped, ...(taskId ? { taskId } : {}) }
  }

  function routes(app: Express) {
    const { scope, route, who, idParam, trackerRow } = core
    // The run log: what ran lately, on which row, what it did and what it skipped.
    app.get(
      '/api/trackers/:id/automation-runs',
      ...scope,
      route(async (req, res) => {
        const user = who(req),
          tenant = user.organizationId,
          id = idParam(req)
        await trackerRow(tenant, id, user)
        const r = await db
          .from('tenant_tracker_changes')
          .select('id,row_id,actor_name,detail,created_at')
          .eq('tenant_id', tenant)
          .eq('tracker_id', id)
          .eq('kind', KIND)
          .order('created_at', { ascending: false })
          .limit(30)
        check(r.error)
        res.json({
          runs: (r.data || []).map((entry: any) => ({
            id: entry.id,
            rowId: entry.row_id,
            row: String(entry.detail?.row || ''),
            by: entry.actor_name || '',
            trigger: String(entry.detail?.trigger || ''),
            done: Array.isArray(entry.detail?.done) ? entry.detail.done.map(String) : [],
            skipped: Array.isArray(entry.detail?.skipped) ? entry.detail.skipped.map(String) : [],
            at: entry.created_at,
          })),
        })
      }),
    )
  }

  return { run, routes }
}
export type TrackerAutomations = ReturnType<typeof trackerAutomations>
