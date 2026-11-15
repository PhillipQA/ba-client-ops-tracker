// The roll-up across trackers: the rows of several trackers in one list, read live (nothing is copied). Only trackers
// the person can open take part, and only the four columns the roll-up shows (Site, Status, Go-live, Owner) are sent.
// Edits go through the ordinary row route of each row's own tracker, so this file only reads.
import type { Express } from 'express'
import { defaultRollupIds, ROLLUP_LIMITS, rollupColumnIds, rollupFits } from '../../src/features/trackers/trackerRollup'
import { TRACKER_LIMITS } from '../../src/features/trackers/trackerModel'
import { UUID } from './tracker-common'
import type { TrackerCore } from './tracker-core'

export function trackerRollupRoutes(
  app: Express,
  core: TrackerCore,
  allRows: (tenant: string, trackerId: string) => Promise<any[]>,
) {
  const { scope, route, who, db, check, workspace, trackerVisibleIn, trackerOut, rowOut, columnsOf } = core
  app.get(
    '/api/tracker-rollup',
    ...scope,
    route(async (req, res) => {
      const user = who(req),
        tenant = user.organizationId
      const r = await db
        .from('tenant_trackers')
        .select('*')
        .eq('tenant_id', tenant)
        .order('updated_at', { ascending: false })
        .limit(TRACKER_LIMITS.trackers + 100)
      check(r.error)
      const shown = trackerVisibleIn(await workspace(tenant), user)
      const open = (r.data || []).filter(
        (row: any) =>
          !row.archived_at && (!row.private || row.created_by === user.id) && shown(row) && rollupFits(columnsOf(row)),
      )
      const candidates = open.map((row: any) => trackerOut(row, user, 0))
      // The person's own choice (?ids=a,b), kept to trackers they can open; otherwise every Site rollout tracker.
      const asked = String(req.query.ids || '')
        .split(',')
        .map(value => value.trim())
        .filter(value => UUID.test(value))
      const known = new Set(candidates.map(tracker => tracker.id))
      const chosen = (asked.length ? asked.filter(id => known.has(id)) : defaultRollupIds(candidates)).slice(
        0,
        ROLLUP_LIMITS.trackers,
      )
      const sets = []
      let total = 0,
        cut = false
      for (const id of chosen) {
        const row = open.find((entry: any) => entry.id === id)
        const columns = columnsOf(row)
        const keep = new Set(rollupColumnIds(columns))
        const used = columns.filter(column => keep.has(column.id))
        let rows = (await allRows(tenant, id)).map(entry => rowOut(entry, used))
        if (total + rows.length > ROLLUP_LIMITS.rows) {
          rows = rows.slice(0, Math.max(0, ROLLUP_LIMITS.rows - total))
          cut = true
        }
        total += rows.length
        const tracker = candidates.find(item => item.id === id)!
        sets.push({
          tracker: { id, name: tracker.name, clientIds: tracker.clientIds, columns: used, canEdit: tracker.canEdit },
          rows: rows.map(entry => ({ ...entry, secretSet: {} })),
        })
        if (cut) break
      }
      res.json({
        trackers: candidates.map(tracker => ({
          id: tracker.id,
          name: tracker.name,
          template: tracker.template,
          clientIds: tracker.clientIds,
        })),
        chosen,
        sets,
        ...(cut ? { warning: `Only the first ${ROLLUP_LIMITS.rows} rows are shown.` } : {}),
      })
    }),
  )
}
