/**
 * Routes for a tracker's connected Sheet: connect, create, sync, reconnect, stop, the Gantt tab, and retrying
 * or dismissing writes the Sheet refused.
 */
import type { Express } from 'express'
import {
  TRACKER_LIMITS,
  TrackerError,
  type Cell,
  isBasicType,
  normalizeColumns,
  splitClientIds,
} from '../../src/features/trackers/trackerModel'
import { SYNC_LIMITS, tabRange, adoptRows } from '../../src/features/trackers/trackerSync'
import { EXCEL_MIME } from './xlsx'
import { sheetFromTracker, sheetFormatRequests } from '../../src/features/trackers/sheetFromTracker'
import { sheetHasGantt, ganttFields, ganttSheetRequests, GANTT_TAB } from '../../src/features/trackers/sheetGantt'
import { autoDoneColumn } from '../../src/features/trackers/trackerAutoDone'
import { type Deps, SPARE_SHEET_ROWS, UUID } from './tracker-common'
import type { TrackerCore } from './tracker-core'
import type { TrackerSheetAccess } from './tracker-source'
import type { TrackerSyncPart } from './tracker-sync'
import type { TrackerSheetWrite } from './tracker-sheet-write'
import type { TrackerFollow } from './tracker-follow'

export function trackerSourceRoutes(
  app: Express,
  deps: Deps,
  core: TrackerCore,
  sheetAccess: TrackerSheetAccess,
  sync: TrackerSyncPart,
  sheetWrite: TrackerSheetWrite,
  follow: TrackerFollow,
) {
  const {
    scope,
    route,
    who,
    idParam,
    trackerRow,
    columnsOf,
    touch,
    db,
    check,
    now,
    record,
    trackerOut,
    rowCount,
    readOnly,
    workspace,
  } = core
  const {
    allRows,
    sourceRow,
    writeAccess,
    sourceCheck,
    sourceOut,
    canReadSheets,
    canWriteSheets,
    canReadDriveFiles,
    googleFor,
    sheetsGet,
    sheetId,
    isExcel,
    openWorkbook,
    explainSheetError,
    excelReadOnly,
    sourceGrid,
    readRaw,
    sourceIsExcel,
    ganttEditsToTab,
  } = sheetAccess
  const { runSync } = sync
  const { writeToSheet } = sheetWrite
  const { saveAutoDone } = follow
  /** Rows whose done mark did not reach the Sheet: try again (after a fresh sync), or stop showing the problem. */
  const issueRows = async (tenant: string, trackerId: string, body: any) => {
    const ids = Array.isArray(body?.ids) ? [...new Set<string>(body.ids.map(String))] : []
    if (ids.some(value => !UUID.test(value)) || ids.length > TRACKER_LIMITS.importBatch)
      throw new TrackerError('Choose the rows to update.')
    const rows = (await allRows(tenant, trackerId)).filter(
      row => row.sheet_issue?.code && (!ids.length || ids.includes(row.id)),
    )
    return rows
  }
  app.post(
    '/api/trackers/:id/sheet-issues/retry',
    ...scope,
    route(async (req, res) => {
      const user = who(req),
        tenant = user.organizationId,
        id = idParam(req)
      const tracker = await trackerRow(tenant, id, user)
      if (tracker.archived_at) throw new TrackerError('This tracker is archived. Restore it first.', 409)
      const column = autoDoneColumn(columnsOf(tracker))
      if (!column?.synced) throw new TrackerError('No column here is set to be marked done in the Sheet.', 409)
      if (!(await issueRows(tenant, id, req.body)).length) return void res.json({ written: 0, failed: 0 })
      // Sync first, so each row's baseline is what the Sheet holds now: retrying is the person choosing to overwrite.
      await runSync(tenant, tracker, user, true)
      const fresh = await trackerRow(tenant, id, user)
      const source = await sourceRow(tenant, id)
      if (!source) throw new TrackerError('This tracker is not connected to a Google Sheet.', 404)
      const rows = (await issueRows(tenant, id, req.body)).filter(row => row.source_key)
      const entries = rows.map(row => ({ row, value: row.sheet_issue.value as Cell }))
      const results = await writeToSheet(tenant, source, column, entries, user)
      let written = 0,
        failed = 0
      for (const entry of entries) {
        const ok = await saveAutoDone(tenant, fresh, column, entry.row, entry.value, results.get(entry.row.id), user, {
          reason: 'retry',
        })
        if (ok && results.get(entry.row.id)?.ok) written += 1
        else failed += 1
      }
      if (written) await touch(tenant, id)
      res.json({ written, failed })
    }),
  )
  app.post(
    '/api/trackers/:id/sheet-issues/dismiss',
    ...scope,
    route(async (req, res) => {
      const user = who(req),
        tenant = user.organizationId,
        id = idParam(req)
      await trackerRow(tenant, id, user)
      const rows = await issueRows(tenant, id, req.body)
      for (let at = 0; at < rows.length; at += TRACKER_LIMITS.importBatch) {
        const saved = await db
          .from('tenant_tracker_rows')
          .update({ sheet_issue: null })
          .eq('tenant_id', tenant)
          .eq('tracker_id', id)
          .in(
            'id',
            rows.slice(at, at + TRACKER_LIMITS.importBatch).map(row => row.id),
          )
        check(saved.error)
      }
      res.json({ dismissed: rows.length })
    }),
  )

  /** Switches a connected tracker between one-way (Sheet → tracker) and two-way. */
  app.post(
    '/api/trackers/:id/source/mode',
    ...scope,
    route(async (req, res) => {
      const user = who(req),
        tenant = user.organizationId,
        id = idParam(req)
      const tracker = await trackerRow(tenant, id, user)
      if (tracker.archived_at) throw new TrackerError('This tracker is archived. Restore it first.', 409)
      const source = await sourceRow(tenant, id)
      if (!source) throw new TrackerError('This tracker is not connected to a Google Sheet.', 404)
      const mode = req.body?.mode === 'two_way' ? 'two_way' : req.body?.mode === 'one_way' ? 'one_way' : ''
      if (!mode) throw new TrackerError('Choose one-way or two-way.')
      // Turning it on needs this person's own permission to edit Sheets; each person's edits then use their own account.
      if (mode === 'two_way') await writeAccess(tenant, source, user)
      const saved = await db
        .from('tenant_tracker_sources')
        .update({ mode, updated_at: now() })
        .eq('tenant_id', tenant)
        .eq('tracker_id', id)
      sourceCheck(saved.error)
      await record(tenant, id, '', user, 'sheet_mode', { mode })
      res.json({ source: { ...sourceOut({ ...source, mode }), youCanWrite: true } })
    }),
  )

  app.get(
    '/api/trackers/sheets/status',
    ...scope,
    route(async (req, res) => {
      const user = who(req)
      if (!deps.googleAccess) return void res.json({ available: false, connected: false, email: '' })
      try {
        const access = await deps.googleAccess(user.organizationId, user.id)
        res.json({
          available: true,
          connected: canReadSheets(access.scope),
          canWrite: canWriteSheets(access.scope),
          canReadExcel: canReadDriveFiles(access.scope),
          email: access.email || '',
        })
      } catch {
        res.json({ available: true, connected: false, canWrite: false, email: '' })
      }
    }),
  )
  app.get(
    '/api/trackers/sheets/files',
    ...scope,
    route(async (req, res) => {
      const user = who(req),
        access = await googleFor(user.organizationId, user.id)
      const words = String(req.query.q || '')
        .trim()
        .slice(0, 100)
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
      // Google Sheets, and Excel files kept in Drive (followed one-way).
      const q = `(mimeType='application/vnd.google-apps.spreadsheet' or mimeType='${EXCEL_MIME}') and trashed=false${words ? ` and name contains '${words}'` : ''}`
      const params = new URLSearchParams({
        q,
        corpora: 'allDrives',
        includeItemsFromAllDrives: 'true',
        supportsAllDrives: 'true',
        orderBy: 'modifiedTime desc',
        pageSize: '40',
        fields: 'files(id,name,mimeType,modifiedTime,owners(displayName),shared,driveId)',
      })
      const data = await sheetsGet(access.token, `https://www.googleapis.com/drive/v3/files?${params}`)
      res.json({
        files: (data.files || []).map((file: any) => ({
          id: String(file.id),
          name: String(file.name || 'Untitled'),
          modifiedTime: file.modifiedTime || '',
          owner: file.owners?.[0]?.displayName || '',
          shared: Boolean(file.shared),
          sharedDrive: Boolean(file.driveId),
          ...(file.mimeType === EXCEL_MIME ? { excel: true } : {}),
        })),
      })
    }),
  )
  app.get(
    '/api/trackers/sheets/:sheetId/tabs',
    ...scope,
    route(async (req, res) => {
      const user = who(req),
        access = await googleFor(user.organizationId, user.id),
        id = sheetId(req.params.sheetId)
      if (await isExcel(access.token, id)) {
        const { name, book } = await openWorkbook(access.token, access.scope, id)
        return void res.json({ id, name, excel: true, tabs: book.tabs })
      }
      const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}?fields=properties.title,sheets.properties(title,index,gridProperties(rowCount,columnCount))`
      const data = await sheetsGet(access.token, url).catch(error => explainSheetError(access.token, id, error))
      res.json({
        id,
        name: data.properties?.title || 'Untitled',
        tabs: (data.sheets || []).map((sheet: any) => ({
          title: String(sheet.properties?.title || ''),
          rows: Number(sheet.properties?.gridProperties?.rowCount || 0),
          columns: Number(sheet.properties?.gridProperties?.columnCount || 0),
        })),
      })
    }),
  )
  app.get(
    '/api/trackers/sheets/:sheetId/values',
    ...scope,
    route(async (req, res) => {
      const user = who(req),
        access = await googleFor(user.organizationId, user.id),
        id = sheetId(req.params.sheetId)
      const tab = String(req.query.tab || '').slice(0, 100)
      if (!tab) throw new TrackerError('Choose a tab.')
      if (await isExcel(access.token, id)) {
        const { book } = await openWorkbook(access.token, access.scope, id)
        const grid = book.grid(tab, { rows: SYNC_LIMITS.rows + 2, columns: SYNC_LIMITS.columns })
        if (!grid) throw new TrackerError('That tab was not found in the Excel file.', 404)
        return void res.json({
          grid: grid.slice(0, SYNC_LIMITS.rows + 1),
          truncated: grid.length > SYNC_LIMITS.rows + 1,
        })
      }
      const data = await sheetsGet(
        access.token,
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}/values/${encodeURIComponent(tabRange(tab))}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`,
      )
      const grid = (Array.isArray(data.values) ? data.values : [])
        .slice(0, SYNC_LIMITS.rows + 1)
        .map((line: unknown[]) =>
          (Array.isArray(line) ? line : []).slice(0, SYNC_LIMITS.columns).map(value => String(value ?? '')),
        )
      res.json({ grid, truncated: Array.isArray(data.values) && data.values.length > SYNC_LIMITS.rows + 1 })
    }),
  )

  app.post(
    '/api/trackers/:id/source',
    ...scope,
    route(async (req, res) => {
      const user = who(req),
        tenant = user.organizationId,
        id = idParam(req)
      const tracker = await trackerRow(tenant, id, user)
      if (tracker.archived_at) throw new TrackerError('This tracker is archived. Restore it first.', 409)
      const body = req.body || {}
      const spreadsheetId = sheetId(body.spreadsheetId),
        tab = String(body.tab || '')
          .trim()
          .slice(0, 100),
        keyHeader = String(body.keyHeader || '')
          .trim()
          .slice(0, 200)
      if (!tab) throw new TrackerError('Choose the Sheet tab to follow.')
      if (!keyHeader)
        throw new TrackerError('Choose the key column: the column that names each row, such as a branch number.')
      const mode = body.mode === 'two_way' ? 'two_way' : 'one_way'
      const columns = columnsOf(tracker),
        byId = new Map(columns.map(column => [column.id, column]))
      const headerMap: Record<string, string> = {}
      for (const [header, columnId] of Object.entries<unknown>(body.headerMap || {})) {
        const column = byId.get(String(columnId))
        if (!column || !isBasicType(column.type))
          throw new TrackerError(`“${header}” must go to a basic column (text, number, date, choice, person or link).`)
        headerMap[String(header).trim().slice(0, 200)] = column.id
      }
      if (!Object.keys(headerMap).length) throw new TrackerError('Choose at least one Sheet column to follow.')
      // The person connecting must be able to open it now; their access is what the sync uses.
      const access = await googleFor(tenant, user.id)
      if (!canReadSheets(access.scope))
        throw new TrackerError('Allow Google Sheets first, so the tracker can read your Sheets.', 403, {
          needsGoogle: true,
        })
      // An Excel file is followed one-way: it is read on each sync and never written to.
      const excel = await isExcel(access.token, spreadsheetId)
      if (excel && mode === 'two_way') throw excelReadOnly()
      if (mode === 'two_way' && !canWriteSheets(access.scope))
        throw new TrackerError(
          'Allow editing Google Sheets first, so tracker edits can be written to the Sheet.',
          403,
          {
            needsWrite: true,
          },
        )
      const meta = excel
        ? { properties: { title: (await openWorkbook(access.token, access.scope, spreadsheetId)).name } }
        : await sheetsGet(
            access.token,
            `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=properties.title`,
          )
      const synced = new Set(Object.values(headerMap))
      const nextColumns = normalizeColumns(
        columns.map(column => ({ ...column, ...(synced.has(column.id) ? { synced: true } : { synced: undefined }) })),
        columns,
      )
      const stamp = now()
      const savedColumns = await db
        .from('tenant_trackers')
        .update({ columns: nextColumns, revision: Number(tracker.revision || 1) + 1, updated_at: stamp })
        .eq('tenant_id', tenant)
        .eq('id', id)
      check(savedColumns.error)
      const record_ = {
        tenant_id: tenant,
        tracker_id: id,
        spreadsheet_id: spreadsheetId,
        spreadsheet_name: String(meta.properties?.title || body.spreadsheetName || 'Google Sheet').slice(0, 200),
        tab,
        key_header: keyHeader,
        header_map: headerMap,
        mode,
        connected_by: user.id,
        connected_by_name: user.name,
        connected_email: access.email || '',
        last_status: 'never',
        last_error: '',
        last_report: null,
        created_at: stamp,
        updated_at: stamp,
      }
      await db.from('tenant_tracker_sources').delete().eq('tenant_id', tenant).eq('tracker_id', id)
      const saved = await db.from('tenant_tracker_sources').insert(record_)
      sourceCheck(saved.error)
      // Linking a tracker that already has rows: rows whose name matches a Sheet row are recognised by it from now on,
      // so the first sync updates them instead of adding the Sheet rows again.
      const keyColumnId = Object.entries(headerMap).find(
        ([header]) =>
          header.replace(/\s+/g, ' ').trim().toLowerCase() === keyHeader.replace(/\s+/g, ' ').trim().toLowerCase(),
      )?.[1]
      const current = keyColumnId ? await allRows(tenant, id) : []
      let adopted = 0
      if (current.some(row => !row.source_key)) {
        const grid = await sourceGrid(access.token, access.scope, record_)
        const matches = adoptRows({
          grid,
          keyHeader,
          keyColumn: nextColumns.find(column => column.id === keyColumnId),
          rows: current.map(row => ({ id: row.id, data: row.data || {}, sourceKey: row.source_key || '' })),
        })
        for (let at = 0; at < matches.length; at += 25)
          await Promise.all(
            matches.slice(at, at + 25).map(async item => {
              const keyed = await db
                .from('tenant_tracker_rows')
                .update({ source_key: item.key, source_missing: false })
                .eq('tenant_id', tenant)
                .eq('tracker_id', id)
                .eq('id', item.rowId)
              sourceCheck(keyed.error)
            }),
          )
        adopted = matches.length
      }
      await record(tenant, id, '', user, 'sheet_connected', { name: record_.spreadsheet_name, tab })
      const result = await runSync(
        tenant,
        { ...tracker, columns: nextColumns, revision: Number(tracker.revision || 1) + 1 },
        user,
        true,
      )
      const fresh = await trackerRow(tenant, id, user)
      res.json({
        ...result,
        adopted,
        tracker: { ...trackerOut(fresh, user, await rowCount(tenant, id)), source: result.source },
      })
    }),
  )
  /**
   * Makes a new Google Sheet from the tracker, in the Drive of the person asking, and connects it two-way: the
   * tracker's rows are written to it in order, each row is recognised by its name from then on, and later edits on
   * either side are synced. Needs that person's permission to edit Google Sheets.
   */
  app.post(
    '/api/trackers/:id/source/create',
    ...scope,
    route(async (req, res) => {
      const user = who(req),
        tenant = user.organizationId,
        id = idParam(req)
      const tracker = await trackerRow(tenant, id, user)
      if (readOnly(user)) throw new TrackerError('Viewers cannot make a Google Sheet from a tracker.', 403)
      if (tracker.archived_at) throw new TrackerError('This tracker is archived. Restore it first.', 409)
      if (await sourceRow(tenant, id))
        throw new TrackerError(
          'This tracker already follows a Google Sheet. Disconnect it first to make a new one.',
          409,
        )
      const access = await googleFor(tenant, user.id)
      if (!canWriteSheets(access.scope))
        throw new TrackerError('Allow editing Google Sheets first, so the tracker can make your Sheet.', 403, {
          needsWrite: true,
        })
      const existing = await allRows(tenant, id)
      const state = await workspace(tenant)
      const people = (Array.isArray(state.accounts) ? state.accounts : []).map((account: any) => ({
        id: String(account.id),
        name: String(account.name || account.username || ''),
      }))
      const plan = sheetFromTracker(
        columnsOf(tracker),
        existing.map(row => ({ id: row.id, cells: row.data || {} })),
        people,
      )
      if ('error' in plan) throw new TrackerError(plan.error)
      const title =
        String(req.body?.title || tracker.name)
          .trim()
          .slice(0, 100) || 'Tracker'
      const tab = 'Tracker'
      // The header, the tracker's rows and 3 blank rows ready to fill. Rows added later are inserted above the blank
      // ones, so they keep the dropdowns, checkboxes and date format.
      const gridRows = plan.rowData.length + SPARE_SHEET_ROWS
      const gridProperties = { rowCount: gridRows, columnCount: Math.max(plan.headers.length, 5), frozenRowCount: 1 }
      // In the account Drive under Client / Project when one is connected; otherwise in the person's own Drive.
      const driveReady =
        Boolean(deps.drive?.sheet && access.email) && (await deps.drive!.ready(tenant).catch(() => false))
      let spreadsheetId = ''
      let sheetTabId = 0
      let folder: string[] = []
      if (driveReady) {
        const made = await deps.drive!.sheet!({
          tenantId: tenant,
          title,
          clientId: splitClientIds(tracker.client_id)[0] || undefined,
          projectId: splitClientIds(tracker.project_id)[0] || undefined,
          editorEmail: String(access.email),
        })
        spreadsheetId = made.spreadsheetId
        folder = made.path
        const base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}`
        // Sharing can take a moment to reach Google Sheets, so the first look is tried again once.
        const meta = await sheetsGet(access.token, `${base}?fields=sheets.properties(sheetId)`).catch(async () => {
          await new Promise(resolve => setTimeout(resolve, 1500))
          return sheetsGet(access.token, `${base}?fields=sheets.properties(sheetId)`)
        })
        sheetTabId = Number(meta?.sheets?.[0]?.properties?.sheetId ?? 0)
        await sheetsGet(access.token, `${base}:batchUpdate`, {
          method: 'POST',
          body: {
            requests: [
              {
                updateSheetProperties: {
                  properties: { sheetId: sheetTabId, title: tab, gridProperties },
                  fields: 'title,gridProperties(rowCount,columnCount,frozenRowCount)',
                },
              },
              {
                updateCells: {
                  rows: plan.rowData,
                  fields: 'userEnteredValue',
                  start: { sheetId: sheetTabId, rowIndex: 0, columnIndex: 0 },
                },
              },
            ],
          },
        })
      } else {
        const created = await sheetsGet(access.token, 'https://sheets.googleapis.com/v4/spreadsheets', {
          method: 'POST',
          body: {
            properties: { title },
            sheets: [
              {
                properties: { title: tab, gridProperties },
                data: [{ startRow: 0, startColumn: 0, rowData: plan.rowData }],
              },
            ],
          },
        })
        spreadsheetId = String(created?.spreadsheetId || '')
        if (!spreadsheetId) throw new TrackerError('Google did not make the Sheet. Try again in a moment.', 502)
        sheetTabId = Number(created?.sheets?.[0]?.properties?.sheetId ?? 0)
      }
      // Dropdowns, checkboxes, date format and widths. The Sheet is usable without them, so this never fails the request.
      await sheetsGet(
        access.token,
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
        { method: 'POST', body: { requests: sheetFormatRequests(plan, sheetTabId, gridRows) } },
      ).catch(() => undefined)
      // Project timeline trackers only: a Gantt chart tab drawn from the synced tab. Best effort, like the formatting.
      const chartFields = sheetHasGantt(tracker.template)
        ? ganttFields(columnsOf(tracker), tracker.timeline || undefined, plan.headerMap, plan.keyHeader)
        : null
      const chartGrid = chartFields ? await readRaw(access.token, spreadsheetId, tabRange(tab)).catch(() => null) : null
      const chart =
        chartFields && chartGrid
          ? ganttSheetRequests({
              title,
              dataTab: tab,
              headers: plan.headers,
              fields: chartFields,
              sheetId: newSheetId([sheetTabId]),
              grid: chartGrid,
              dataRows: gridRows,
            })
          : null
      const gantt =
        chart && 'requests' in chart
          ? await sheetsGet(
              access.token,
              `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
              { method: 'POST', body: { requests: chart.requests } },
            )
              .then(() => true)
              .catch(() => false)
          : false

      const stamp = now()
      const synced = new Set(Object.values(plan.headerMap))
      const columns = columnsOf(tracker)
      const nextColumns = normalizeColumns(
        columns.map(column => ({ ...column, ...(synced.has(column.id) ? { synced: true } : { synced: undefined }) })),
        columns,
      )
      const savedColumns = await db
        .from('tenant_trackers')
        .update({ columns: nextColumns, revision: Number(tracker.revision || 1) + 1, updated_at: stamp })
        .eq('tenant_id', tenant)
        .eq('id', id)
      check(savedColumns.error)
      const record_ = {
        tenant_id: tenant,
        tracker_id: id,
        spreadsheet_id: spreadsheetId,
        spreadsheet_name: title,
        tab,
        key_header: plan.keyHeader,
        header_map: plan.headerMap,
        mode: 'two_way',
        connected_by: user.id,
        connected_by_name: user.name,
        connected_email: access.email || '',
        last_status: 'never',
        last_error: '',
        last_report: null,
        created_at: stamp,
        updated_at: stamp,
      }
      const saved = await db.from('tenant_tracker_sources').insert(record_)
      sourceCheck(saved.error)
      // Each row is recognised in the Sheet by its name and order from now on, so the first sync matches every row
      // instead of adding them again.
      for (let at = 0; at < plan.placed.length; at += 25)
        await Promise.all(
          plan.placed.slice(at, at + 25).map(async item => {
            const keyed = await db
              .from('tenant_tracker_rows')
              .update({ source_key: item.key, source_missing: false })
              .eq('tenant_id', tenant)
              .eq('tracker_id', id)
              .eq('id', item.rowId)
            sourceCheck(keyed.error)
          }),
        )
      await record(tenant, id, '', user, 'sheet_connected', { name: title, tab, created: true })
      const result = await runSync(
        tenant,
        { ...tracker, columns: nextColumns, revision: Number(tracker.revision || 1) + 1 },
        user,
        true,
      )
      const fresh = await trackerRow(tenant, id, user)
      res.json({
        ...result,
        url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
        rows: plan.placed.length,
        emptyRows: plan.skipped,
        gantt,
        /** Where it was made: the account Drive's folders, or empty for the person's own Drive. */
        folder,
        tracker: { ...trackerOut(fresh, user, await rowCount(tenant, id)), source: result.source },
      })
    }),
  )
  /** A tab id not used in the spreadsheet yet. */
  const newSheetId = (used: number[]) => {
    let id = 0
    while (!id || used.includes(id)) id = 100_000 + Math.floor(Math.random() * 2_000_000_000)
    return id
  }

  /**
   * Adds a Gantt chart tab to the Sheet this tracker follows, or draws it again (the old one is replaced). It reads the
   * synced tab with formulas, so it keeps up with every sync. Written with the asking person's own Google account.
   */
  app.post(
    '/api/trackers/:id/source/gantt',
    ...scope,
    route(async (req, res) => {
      const user = who(req),
        tenant = user.organizationId,
        id = idParam(req)
      const tracker = await trackerRow(tenant, id, user)
      if (readOnly(user)) throw new TrackerError('Viewers cannot change the Google Sheet.', 403)
      if (!sheetHasGantt(tracker.template))
        throw new TrackerError(
          'Only trackers made from the Project timeline template have a Gantt chart in their Sheet.',
          409,
        )
      if (tracker.archived_at) throw new TrackerError('This tracker is archived. Restore it first.', 409)
      const source = await sourceRow(tenant, id)
      if (!source) throw new TrackerError('This tracker is not connected to a Google Sheet.', 404)
      const access = await googleFor(tenant, user.id)
      if (await sourceIsExcel(access.token, source)) throw excelReadOnly()
      if (!canWriteSheets(access.scope))
        throw new TrackerError('Allow editing Google Sheets first, so the chart can be added to the Sheet.', 403, {
          needsWrite: true,
        })
      const base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(source.spreadsheet_id)}`
      const meta = await sheetsGet(
        access.token,
        `${base}?fields=sheets.properties(sheetId,title,gridProperties(rowCount))`,
      ).catch(error => explainSheetError(access.token, source.spreadsheet_id, error))
      const tabs: any[] = (meta?.sheets || []).map((sheet: any) => sheet.properties || {})
      const data = tabs.find(item => item.title === source.tab)
      if (!data) throw new TrackerError(`The tab “${source.tab}” is no longer in the Sheet.`, 409)
      const old = tabs.find(item => item.title === GANTT_TAB)
      // Changes made in the old tab are kept: written to the synced tab before it is replaced.
      if (old) await ganttEditsToTab(access.token, source, tracker).catch(() => null)
      const grid = await readRaw(access.token, source.spreadsheet_id, tabRange(source.tab))
      const headers = (grid[0] || []).map((value: unknown) => String(value ?? ''))
      const fields = ganttFields(
        columnsOf(tracker),
        tracker.timeline || undefined,
        source.header_map || {},
        source.key_header,
      )
      if (!fields)
        throw new TrackerError(
          'The chart needs a Start date column that follows the Sheet. Choose it in the Timeline, then try again.',
          409,
        )
      const sheetTabId = newSheetId(tabs.map(item => Number(item.sheetId)))
      const built = ganttSheetRequests({
        title: tracker.name,
        dataTab: source.tab,
        headers,
        fields,
        sheetId: sheetTabId,
        grid,
        dataRows: Number(data.gridProperties?.rowCount || 1000),
      })
      if ('error' in built) throw new TrackerError(built.error, 409)
      await sheetsGet(access.token, `${base}:batchUpdate`, {
        method: 'POST',
        body: { requests: [...(old ? [{ deleteSheet: { sheetId: Number(old.sheetId) } }] : []), ...built.requests] },
      })
      await record(tenant, id, '', user, 'sheet_gantt', { name: source.spreadsheet_name, replaced: Boolean(old) })
      res.json({
        url: `https://docs.google.com/spreadsheets/d/${source.spreadsheet_id}/edit#gid=${sheetTabId}`,
        replaced: Boolean(old),
      })
    }),
  )

  app.post(
    '/api/trackers/:id/source/sync',
    ...scope,
    route(async (req, res) => {
      const user = who(req),
        tenant = user.organizationId,
        id = idParam(req)
      const tracker = await trackerRow(tenant, id, user)
      if (tracker.archived_at) throw new TrackerError('This tracker is archived. Restore it to sync it.', 409)
      const result = await runSync(tenant, tracker, user, req.body?.force === true)
      res.json(result)
    }),
  )
  app.post(
    '/api/trackers/:id/source/reconnect',
    ...scope,
    route(async (req, res) => {
      const user = who(req),
        tenant = user.organizationId,
        id = idParam(req)
      const tracker = await trackerRow(tenant, id, user)
      const source = await sourceRow(tenant, id)
      if (!source) throw new TrackerError('This tracker is not connected to a Google Sheet.', 404)
      const access = await googleFor(tenant, user.id)
      if (!canReadSheets(access.scope))
        throw new TrackerError('Allow Google Sheets first, so the tracker can read your Sheets.', 403, {
          needsGoogle: true,
        })
      if (await sourceIsExcel(access.token, source))
        await openWorkbook(access.token, access.scope, source.spreadsheet_id)
      else
        await sheetsGet(
          access.token,
          `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(source.spreadsheet_id)}?fields=properties.title`,
        )
      const saved = await db
        .from('tenant_tracker_sources')
        .update({
          connected_by: user.id,
          connected_by_name: user.name,
          connected_email: access.email || '',
          updated_at: now(),
        })
        .eq('tenant_id', tenant)
        .eq('tracker_id', id)
      sourceCheck(saved.error)
      await record(tenant, id, '', user, 'sheet_reconnected', { name: source.spreadsheet_name })
      res.json(await runSync(tenant, tracker, user, true))
    }),
  )
  app.delete(
    '/api/trackers/:id/source',
    ...scope,
    route(async (req, res) => {
      const user = who(req),
        tenant = user.organizationId,
        id = idParam(req)
      const tracker = await trackerRow(tenant, id, user)
      const source = await sourceRow(tenant, id)
      if (!source) return void res.json({ tracker: trackerOut(tracker, user, await rowCount(tenant, id)) })
      const removed = await db.from('tenant_tracker_sources').delete().eq('tenant_id', tenant).eq('tracker_id', id)
      sourceCheck(removed.error)
      const columns = normalizeColumns(
        columnsOf(tracker).map(column => ({ ...column, synced: undefined })),
        columnsOf(tracker),
      )
      const saved = await db
        .from('tenant_trackers')
        .update({ columns, revision: Number(tracker.revision || 1) + 1, updated_at: now() })
        .eq('tenant_id', tenant)
        .eq('id', id)
      check(saved.error)
      await record(tenant, id, '', user, 'sheet_disconnected', { name: source.spreadsheet_name })
      const fresh = await trackerRow(tenant, id, user)
      res.json({ tracker: { ...trackerOut(fresh, user, await rowCount(tenant, id)), source: null } })
    }),
  )
}
