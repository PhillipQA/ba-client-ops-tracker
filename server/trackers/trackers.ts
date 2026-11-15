/**
 * Trackers: user-defined sheets. A tracker owns its columns and views; its rows live in their own table so one
 * edit saves one row instead of the whole workspace. Secret columns are encrypted before they are stored, are
 * never sent back to the browser, and can only be read through a logged reveal.
 *
 * The routes are split by job; each part takes what it needs from the parts before it:
 * - tracker-core.ts: access checks, shaping trackers and rows, history, request checks
 * - tracker-source.ts: the connected Google Sheet or Excel file (reading, workbook cache, Gantt tab)
 * - tracker-sync.ts: bringing a Sheet's rows in
 * - tracker-sheet-write.ts: writing edits back to the Sheet
 * - tracker-follow.ts: keeping rows and tasks in step after workspace saves
 * - tracker-seeds-rows.ts: rows for new Seeds projects, on trackers switched on for them
 * - tracker-source-routes.ts, tracker-routes.ts, tracker-column-routes.ts, tracker-row-routes.ts: the HTTP routes
 * - tracker-comments.ts: comments on rows, with @mentions
 * - tracker-reminders.ts: date reminders, checked every morning
 * - tracker-common.ts: shared types and helpers
 */
import type { Express } from 'express'
import { type Tracker, TRACKER_LIMITS, type TrackerRow } from '../../src/features/trackers/trackerModel'
import type { Deps, User } from './tracker-common'
import { trackerCore } from './tracker-core'
import { trackerSource } from './tracker-source'
import { trackerSync } from './tracker-sync'
import { trackerSheetWrite } from './tracker-sheet-write'
import { trackerFollow } from './tracker-follow'
import { trackerSeedsRows } from './tracker-seeds-rows'
import { trackerSourceRoutes } from './tracker-source-routes'
import { trackerRoutes } from './tracker-routes'
import { trackerColumnRoutes } from './tracker-column-routes'
import { trackerRowRoutes } from './tracker-row-routes'
import { trackerCommentRoutes } from './tracker-comments'
import { trackerReminders } from './tracker-reminders'
export { secretRuleChanges } from './tracker-common'

export function registerTrackerRoutes(app: Express, deps: Deps) {
  const core = trackerCore(deps)
  const sheetAccess = trackerSource(deps, core)
  const sync = trackerSync(deps, core, sheetAccess)
  const sheetWrite = trackerSheetWrite(core, sheetAccess)
  const follow = trackerFollow(core, sheetAccess, sheetWrite)
  trackerSourceRoutes(app, deps, core, sheetAccess, sync, sheetWrite, follow)
  trackerRoutes(app, deps, core, sheetAccess)
  trackerColumnRoutes(app, core)
  trackerRowRoutes(app, core, sheetAccess, sheetWrite)
  trackerCommentRoutes(app, deps, core)
  const { db, check, trackerVisibleIn, workspace, trackerOut, rowOut, columnsOf } = core
  const { allRows } = sheetAccess
  const seedsRows = trackerSeedsRows(deps, core, sheetAccess, sheetWrite)
  seedsRows.routes(app)
  const reminders = trackerReminders(deps, core, allRows, deps.timeZone || 'Asia/Manila')
  reminders.routes(app)
  // Date reminders: looked at every 15 minutes, sent once a day after 8:00 AM business time.
  if (deps.reminderTimer !== false) {
    const timer = setInterval(() => void reminders.runDue().catch(() => undefined), 15 * 60_000)
    timer.unref()
    setTimeout(() => void reminders.runDue().catch(() => undefined), 30_000).unref()
  }
  /** After every workspace save: rows follow their tasks, and new Seeds projects become rows where asked. */
  async function onWorkspaceSaved(
    tenant: string,
    before: any,
    after: any,
    actor: Parameters<typeof follow.onWorkspaceSaved>[3],
  ) {
    await follow.onWorkspaceSaved(tenant, before, after, actor)
    await seedsRows
      .addSeedsRows(tenant, before, after)
      .catch((error: any) => console.error('Adding new Seeds projects to trackers failed:', error?.message || error))
  }
  /**
   * Trackers as data for the AI assistant: every tracker the person can open (not archived; a private one only for
   * its creator), newest first, and the rows of the ones `pick` chooses, in their order. Rows carry ordinary cells
   * only: Secret values are never read into them.
   */
  async function trackersFor(
    tenant: string,
    user: { id: string; name: string; role: string },
    pick: (trackers: Tracker[]) => string[],
  ) {
    const r = await db
      .from('tenant_trackers')
      .select('*')
      .eq('tenant_id', tenant)
      .order('updated_at', { ascending: false })
      .limit(TRACKER_LIMITS.trackers + 100)
    check(r.error)
    const shown = trackerVisibleIn(await workspace(tenant), user as User)
    const visible = (r.data || []).filter(
      (row: any) => !row.archived_at && (!row.private || row.created_by === user.id) && shown(row),
    )
    // Row counts are left at 0 here: only the trackers that are read get their rows, and so their count.
    const trackers: Tracker[] = visible.map((row: any) => trackerOut(row, user as User, 0))
    const chosen = new Set(pick(trackers))
    const loaded: { tracker: Tracker; rows: TrackerRow[] }[] = []
    for (const [at, row] of visible.entries()) {
      if (!chosen.has(row.id)) continue
      const rows = (await allRows(tenant, row.id)).map(entry => rowOut(entry, columnsOf(row)))
      loaded.push({ tracker: { ...trackers[at], rowCount: rows.length }, rows })
    }
    return { trackers, loaded }
  }

  return { onWorkspaceSaved, trackersFor, reminders }
}
