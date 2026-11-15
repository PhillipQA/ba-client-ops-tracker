// Recent changes across the trackers a person can open, newest first, for the Action Center's "Recent tracker changes":
// edits, comments, task links and automation runs. Private kinds (Secret values, reveals, snoozes) are left out.
import type { Express } from 'express'
import { changeSummary, HIDDEN_CHANGE_KINDS } from '../../src/features/trackers/trackerChangeSummary'
import { TRACKER_LIMITS } from '../../src/features/trackers/trackerModel'
import type { TrackerCore } from './tracker-core'

const SHOWN = 15

export function trackerRecentRoutes(app: Express, core: TrackerCore) {
  const { scope, route, who, db, check, workspace, trackerVisibleIn, columnsOf } = core
  app.get(
    '/api/tracker-changes/recent',
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
      const state = await workspace(tenant)
      const shown = trackerVisibleIn(state, user)
      const open = (r.data || []).filter(
        (row: any) => !row.archived_at && (!row.private || row.created_by === user.id) && shown(row),
      )
      if (!open.length) {
        res.json({ changes: [] })
        return
      }
      const byId = new Map<string, any>(open.map((row: any) => [row.id, row]))
      const changes = await db
        .from('tenant_tracker_changes')
        .select('id,tracker_id,row_id,actor_name,kind,detail,created_at')
        .eq('tenant_id', tenant)
        .in(
          'tracker_id',
          open.map((row: any) => row.id),
        )
        .order('created_at', { ascending: false })
        .limit(80)
      check(changes.error)
      const listed = (changes.data || [])
        .filter((entry: any) => !HIDDEN_CHANGE_KINDS.includes(entry.kind))
        .slice(0, SHOWN)
      const rowIds = [...new Set(listed.map((entry: any) => entry.row_id).filter(Boolean))]
      const rows = rowIds.length
        ? await db.from('tenant_tracker_rows').select('id,tracker_id,data').eq('tenant_id', tenant).in('id', rowIds)
        : { data: [], error: null }
      check(rows.error)
      const rowName = new Map<string, string>()
      for (const row of rows.data || []) {
        const column = columnsOf(byId.get(row.tracker_id) || {}).find(item => item.type === 'text')
        const value = column ? row.data?.[column.id] : ''
        rowName.set(row.id, typeof value === 'string' && value ? value : 'Untitled row')
      }
      const accounts = new Map<string, string>(
        (Array.isArray(state?.accounts) ? state.accounts : []).map((account: any) => [account.id, account.name || '']),
      )
      // Person cells hold account ids: say which, so the line shows the name.
      const detailOf = (entry: any) => {
        if (entry.kind !== 'cells' || !Array.isArray(entry.detail?.cells)) return entry.detail
        const columns = columnsOf(byId.get(entry.tracker_id) || {})
        return {
          ...entry.detail,
          cells: entry.detail.cells.map((cell: any) => ({
            ...cell,
            person: columns.find(column => column.id === cell.columnId)?.type === 'person',
          })),
        }
      }
      res.json({
        changes: listed.map((entry: any) => ({
          id: entry.id,
          trackerId: entry.tracker_id,
          trackerName: byId.get(entry.tracker_id)?.name || '',
          rowId: entry.row_id || '',
          row: entry.row_id ? rowName.get(entry.row_id) || 'A removed row' : '',
          by: entry.actor_name || '',
          kind: entry.kind,
          text: changeSummary(entry.kind, detailOf(entry), id => accounts.get(id) || id),
          at: entry.created_at,
        })),
      })
    }),
  )
}
