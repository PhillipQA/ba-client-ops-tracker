/**
 * Routes that change a tracker's shape: columns, converting a column's type, row highlights and order, saved
 * views and timeline settings.
 */
import type { Express } from 'express'
import {
  TrackerError,
  normalizeColumns,
  normalizeViews,
  TRACKER_LIMITS,
  isColumnType,
  canConvertType,
  planConversion,
  type TrackerColumn,
  OPTION_COLORS,
  type OptionColor,
} from '../../src/features/trackers/trackerModel'
import { cleanTimelineSettings } from '../../src/features/trackers/timelineModel'
import { secretRuleChanges, type User, UUID } from './tracker-common'
import type { TrackerCore } from './tracker-core'

export function trackerColumnRoutes(app: Express, core: TrackerCore) {
  const {
    db,
    now,
    check,
    trackerRow,
    trackerOut,
    rowCount,
    scope,
    route,
    who,
    idParam,
    columnsOf,
    manageable,
    record,
    readOnly,
    touch,
  } = core
  // ---- columns and views ----
  async function replaceTracker(tenant: string, row: any, patch: Record<string, unknown>, user: User) {
    const saved = await db
      .from('tenant_trackers')
      .update({ ...patch, revision: Number(row.revision || 1) + 1, updated_at: now() })
      .eq('tenant_id', tenant)
      .eq('id', row.id)
      .eq('revision', Number(row.revision || 1))
      .select('id')
    check(saved.error)
    if (!saved.data?.length) {
      const current = await trackerRow(tenant, row.id, user)
      throw new TrackerError('Someone else changed this tracker. It was reloaded; review it and try again.', 409, {
        tracker: trackerOut(current, user, await rowCount(tenant, row.id)),
      })
    }
    const fresh = await trackerRow(tenant, row.id, user)
    return trackerOut(fresh, user, await rowCount(tenant, row.id))
  }
  async function requireRevision(tenant: string, row: any, body: any, user: User) {
    if (Number(body?.revision) === Number(row.revision || 1)) return
    throw new TrackerError('Someone else changed this tracker. It was reloaded; review it and try again.', 409, {
      tracker: trackerOut(row, user, await rowCount(tenant, row.id)),
    })
  }

  app.put(
    '/api/trackers/:id/columns',
    ...scope,
    route(async (req, res) => {
      const user = who(req),
        tenant = user.organizationId,
        id = idParam(req)
      const row = await trackerRow(tenant, id, user)
      if (row.archived_at) throw new TrackerError('This tracker is archived. Restore it to change its columns.', 409)
      await requireRevision(tenant, row, req.body, user)
      const before = columnsOf(row)
      const columns = normalizeColumns(req.body?.columns, before)
      const revealRules = secretRuleChanges(before, columns)
      // Who may reveal a Secret column, and deleting one (which erases every stored value), are for the tracker's
      // owner or an Administrator. Anyone who edits the tracker may still add and rename Secret columns.
      if (!manageable(user, row)) {
        const deleted = before.find(old => old.type === 'secret' && !columns.some(column => column.id === old.id))
        if (deleted)
          throw new TrackerError(
            `Only the tracker's owner or an Administrator can delete the Secret column “${deleted.name}”.`,
            403,
          )
        if (revealRules.length)
          throw new TrackerError(
            `Only the tracker's owner or an Administrator can change who can reveal “${revealRules[0].name}”.`,
            403,
          )
      }
      const views = normalizeViews(row.views, columns)
      const tracker = await replaceTracker(tenant, row, { columns, views }, user)
      const kept = new Set(columns.map(column => column.id))
      const removed = before.filter(column => !kept.has(column.id)),
        added = columns.filter(column => !before.some(old => old.id === column.id))
      const renamed = columns.filter(column => before.some(old => old.id === column.id && old.name !== column.name))
      if (removed.length || added.length || renamed.length || revealRules.length)
        await record(tenant, id, '', user, 'columns', {
          added: added.map(c => c.name),
          removed: removed.map(c => c.name),
          renamed: renamed.map(c => c.name),
          ...(revealRules.length ? { revealRules } : {}),
        })
      // A deleted Secret column takes its encrypted values with it.
      const gone = removed.filter(column => column.type === 'secret').map(column => column.id)
      if (gone.length) {
        const rows = await db
          .from('tenant_tracker_rows')
          .select('id,secrets')
          .eq('tenant_id', tenant)
          .eq('tracker_id', id)
          .limit(TRACKER_LIMITS.rows + 100)
        for (const entry of rows.data || []) {
          if (!gone.some(columnId => entry.secrets?.[columnId])) continue
          const next = { ...entry.secrets }
          for (const columnId of gone) delete next[columnId]
          await db
            .from('tenant_tracker_rows')
            .update({ secrets: next })
            .eq('tenant_id', tenant)
            .eq('tracker_id', id)
            .eq('id', entry.id)
        }
      }
      res.json({ tracker })
    }),
  )

  /** Changes a column to another basic type. Without `confirm`, nothing is changed and the answer says how many values would be cleared. */
  app.post(
    '/api/trackers/:id/columns/:columnId/convert',
    ...scope,
    route(async (req, res) => {
      const user = who(req),
        tenant = user.organizationId,
        id = idParam(req)
      const row = await trackerRow(tenant, id, user)
      if (row.archived_at) throw new TrackerError('This tracker is archived. Restore it to change its columns.', 409)
      const before = columnsOf(row)
      const column = before.find(item => item.id === String(req.params.columnId))
      if (!column) throw new TrackerError('That column no longer exists.', 404)
      const toType = req.body?.type
      if (!isColumnType(toType) || !canConvertType(toType) || !canConvertType(column.type) || toType === column.type)
        throw new TrackerError('This column cannot be changed to that type.')
      const loaded = await db
        .from('tenant_tracker_rows')
        .select('id,data,version,position')
        .eq('tenant_id', tenant)
        .eq('tracker_id', id)
        .order('position')
        .order('created_at')
        .limit(TRACKER_LIMITS.rows + 100)
      check(loaded.error)
      const entries: any[] = loaded.data || []
      const plan = planConversion(
        column,
        toType,
        entries.map(entry => entry.data?.[column.id]),
      )
      const samples = entries
        .flatMap((entry, at) => (plan.cells[at].ok ? [] : [{ row: at + 1, value: plan.cells[at].before.slice(0, 80) }]))
        .slice(0, 8)
      if (req.body?.confirm !== true)
        return void res.json({
          applied: false,
          rows: entries.length,
          filled: plan.cells.filter(cell => cell.before).length,
          failed: plan.failed,
          samples,
        })
      await requireRevision(tenant, row, req.body, user)
      if (plan.failed && req.body?.clearUnfit !== true)
        throw new TrackerError(
          `${plan.failed} value${plan.failed === 1 ? '' : 's'} cannot be converted. Confirm that they will be cleared, or fix them first.`,
          409,
        )
      // Rows first, then the column: if this stops part-way, the values are still all here and the change can simply be run again.
      const stamp = now()
      const todo = entries
        .map((entry, at) => ({ entry, cell: plan.cells[at] }))
        .filter(({ entry, cell }) => JSON.stringify(entry.data?.[column.id] ?? null) !== JSON.stringify(cell.value))
      for (let i = 0; i < todo.length; i += 25) {
        await Promise.all(
          todo.slice(i, i + 25).map(async ({ entry, cell }) => {
            const saved = await db
              .from('tenant_tracker_rows')
              .update({
                data: { ...(entry.data || {}), [column.id]: cell.value },
                version: Number(entry.version || 1) + 1,
                updated_at: stamp,
                updated_by: user.id,
              })
              .eq('tenant_id', tenant)
              .eq('tracker_id', id)
              .eq('id', entry.id)
            check(saved.error)
          }),
        )
      }
      const columns = before.map(item => {
        if (item.id !== column.id) return item
        const { options: _options, ...rest } = item
        return { ...rest, type: toType, ...(plan.options ? { options: plan.options } : {}) } as TrackerColumn
      })
      // Saved views that filter, sort or group by this column are cleaned of it, since the old settings may not fit the new type.
      const views = normalizeViews(row.views, columns).map(view => ({
        ...view,
        filters: view.filters.filter(filter => filter.columnId !== column.id),
        sort: view.sort?.columnId === column.id ? null : view.sort,
        groupBy: view.groupBy === column.id ? '' : view.groupBy,
      }))
      const tracker = await replaceTracker(tenant, row, { columns, views }, user)
      await record(tenant, id, '', user, 'columns', {
        converted: column.name,
        from: column.type,
        to: toType,
        cleared: plan.failed,
      })
      res.json({ applied: true, tracker, failed: plan.failed })
    }),
  )

  /** Moves rows to just before another row, or to the end. The rest keep their order. */
  /** Gives rows a highlight colour everyone sees, or clears it (''). A view setting: rows keep their version. */
  app.put(
    '/api/trackers/:id/rows/highlight',
    ...scope,
    route(async (req, res) => {
      const user = who(req),
        tenant = user.organizationId,
        id = idParam(req)
      const tracker = await trackerRow(tenant, id, user)
      if (readOnly(user)) throw new TrackerError('Viewers cannot highlight rows.', 403)
      if (tracker.archived_at) throw new TrackerError('This tracker is archived. Restore it to highlight rows.', 409)
      const ids = Array.isArray(req.body?.ids) ? [...new Set<string>(req.body.ids.map(String))] : []
      if (!ids.length || ids.length > TRACKER_LIMITS.importBatch || ids.some(value => !UUID.test(value)))
        throw new TrackerError('Choose the rows to highlight.')
      const color = String(req.body?.color ?? '')
      if (color && !OPTION_COLORS.includes(color as OptionColor)) throw new TrackerError('Choose one of the colours.')
      const saved = await db
        .from('tenant_tracker_rows')
        .update({ highlight: color })
        .eq('tenant_id', tenant)
        .eq('tracker_id', id)
        .in('id', ids)
      if (saved.error && /highlight/i.test(String(saved.error.message || '')))
        throw new TrackerError(
          'Highlighting rows needs the database upgrade schema v30. An admin applies it once.',
          409,
          {
            needsMigration: true,
          },
        )
      check(saved.error)
      res.json({ ids, color })
    }),
  )

  app.post(
    '/api/trackers/:id/rows/move',
    ...scope,
    route(async (req, res) => {
      const user = who(req),
        tenant = user.organizationId,
        id = idParam(req)
      const tracker = await trackerRow(tenant, id, user)
      if (tracker.archived_at) throw new TrackerError('This tracker is archived. Restore it to move rows.', 409)
      const ids = Array.isArray(req.body?.ids) ? [...new Set<string>(req.body.ids.map(String))] : []
      if (!ids.length || ids.length > TRACKER_LIMITS.importBatch || ids.some(value => !UUID.test(value)))
        throw new TrackerError(`Choose between 1 and ${TRACKER_LIMITS.importBatch} rows to move.`)
      const target = req.body?.before
      if (target !== null && target !== undefined && target !== 'start' && !UUID.test(String(target)))
        throw new TrackerError('Choose where to move the rows.')
      const all = await db
        .from('tenant_tracker_rows')
        .select('id,position')
        .eq('tenant_id', tenant)
        .eq('tracker_id', id)
        .order('position')
        .order('created_at')
        .limit(TRACKER_LIMITS.rows + 100)
      check(all.error)
      const current: { id: string; position: number }[] = (all.data || []).map((entry: any) => ({
        id: entry.id,
        position: Number(entry.position),
      }))
      const wanted = new Set(ids)
      const moving = current.filter(entry => wanted.has(entry.id)).map(entry => entry.id)
      if (!moving.length) throw new TrackerError('Those rows no longer exist.', 404)
      const rest = current.filter(entry => !wanted.has(entry.id)).map(entry => entry.id)
      let at = rest.length
      if (target === 'start') at = 0
      else if (typeof target === 'string') {
        at = rest.indexOf(target)
        if (at < 0)
          throw new TrackerError(
            wanted.has(target)
              ? 'Choose a row that is not being moved.'
              : 'That row no longer exists. Refresh and try again.',
            wanted.has(target) ? 400 : 404,
          )
      }
      const order = [...rest.slice(0, at), ...moving, ...rest.slice(at)]
      const sorted = current.map(entry => entry.position)
      const distinct = new Set(sorted).size === sorted.length
      const slots = distinct ? sorted : order.map((_, index) => index + 1)
      const old = new Map(current.map(entry => [entry.id, entry.position]))
      const changes = order
        .map((rowId, index) => ({ rowId, position: slots[index] }))
        .filter(item => old.get(item.rowId) !== item.position)
      for (let i = 0; i < changes.length; i += 25) {
        await Promise.all(
          changes.slice(i, i + 25).map(async item => {
            const saved = await db
              .from('tenant_tracker_rows')
              .update({ position: item.position })
              .eq('tenant_id', tenant)
              .eq('tracker_id', id)
              .eq('id', item.rowId)
            check(saved.error)
          }),
        )
      }
      if (changes.length) {
        await record(tenant, id, moving.length === 1 ? moving[0] : '', user, 'rows_moved', { count: moving.length })
        await touch(tenant, id)
      }
      res.json({
        moved: moving.length,
        positions: Object.fromEntries(changes.map(item => [item.rowId, item.position])),
      })
    }),
  )

  app.put(
    '/api/trackers/:id/views',
    ...scope,
    route(async (req, res) => {
      const user = who(req),
        tenant = user.organizationId,
        id = idParam(req)
      const row = await trackerRow(tenant, id, user)
      if (row.archived_at) throw new TrackerError('This tracker is archived. Restore it to change its views.', 409)
      await requireRevision(tenant, row, req.body, user)
      const views = normalizeViews(req.body?.views ?? [], columnsOf(row))
      res.json({ tracker: await replaceTracker(tenant, row, { views }, user) })
    }),
  )

  /**
   * The Timeline view's settings, shared by everyone who opens the tracker. They are view settings, not content, so
   * they neither need nor change the tracker's revision.
   */
  app.put(
    '/api/trackers/:id/timeline',
    ...scope,
    route(async (req, res) => {
      const user = who(req),
        tenant = user.organizationId,
        id = idParam(req)
      const row = await trackerRow(tenant, id, user)
      if (user.role === 'Viewer') throw new TrackerError('Viewers can change the timeline only for themselves.', 403)
      if (row.archived_at) throw new TrackerError('This tracker is archived. Restore it to change its timeline.', 409)
      const timeline = cleanTimelineSettings(req.body?.timeline, columnsOf(row))
      const saved = await db.from('tenant_trackers').update({ timeline }).eq('tenant_id', tenant).eq('id', id)
      if (saved.error && /timeline/i.test(String(saved.error.message || '')))
        throw new TrackerError(
          'Timeline settings can be shared once the database is upgraded (schema v29). Until then they are kept in your browser.',
          409,
          { needsMigration: true },
        )
      check(saved.error)
      res.json({ timeline })
    }),
  )
}
