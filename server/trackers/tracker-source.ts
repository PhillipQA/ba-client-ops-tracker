/**
 * A tracker's connected Google Sheet or Excel file: Google access for a person, reading tabs and values, the
 * workbook cache, dropdown lists, and the Gantt tab.
 */
import { TrackerError, type TrackerSource, type TrackerColumn } from '../../src/features/trackers/trackerModel'
import { SYNC_LIMITS, tabRange, sheetIdFrom, dropdownOf } from '../../src/features/trackers/trackerSync'
import { type Workbook, EXCEL_MIME, XLSX_MAX_BYTES, readXlsx, XlsxError } from './xlsx'
import {
  type GanttFields,
  ganttFields,
  GANTT_TAB,
  ganttLayout,
  HEAD_ROWS,
  columnLetter as ganttColumn,
  trackerTabWrites,
  ganttEdits,
  ganttRows,
  ganttShows,
  ganttRedrawRequests,
} from '../../src/features/trackers/sheetGantt'
import { columnLetter } from '../../src/features/trackers/trackerAutoDone'
import type { Person } from '../../src/features/trackers/trackerTwoWay'
import { type Deps, PAGE } from './tracker-common'
import type { TrackerCore } from './tracker-core'

export type GanttState = { sheetId: number; rowCount: number; shown: any[][]; fields: GanttFields; written: number }

export function trackerSource(deps: Deps, core: TrackerCore) {
  const { db, check, columnsOf, workspace } = core
  // ---- trackers ----
  // ---------------------------------------------------------------------------------------------------------------
  // Connected Google Sheets. A tracker can follow one tab of a Sheet: one-way (Sheet → tracker) today, with what two-way
  // needs (row keys, the values at the last sync, a mode) already stored. The sync runs as the person who connected it.
  const SHEETS_READ = 'https://www.googleapis.com/auth/spreadsheets.readonly'
  /** Full Sheets access, asked for only when a tracker writes done marks back to its Sheet. It includes reading. */
  const SHEETS_WRITE = 'https://www.googleapis.com/auth/spreadsheets'
  const scopesOf = (scope: unknown) => String(scope || '').split(/\s+/)
  const canReadSheets = (scope: unknown) => scopesOf(scope).some(item => item === SHEETS_READ || item === SHEETS_WRITE)
  const canWriteSheets = (scope: unknown) => scopesOf(scope).includes(SHEETS_WRITE)
  /** Reading an Excel file kept in Drive downloads it, which needs Drive read access (asked for with ?excel=1). */
  const DRIVE_READ = 'https://www.googleapis.com/auth/drive.readonly'
  const canReadDriveFiles = (scope: unknown) =>
    scopesOf(scope).some(item => item === DRIVE_READ || item === 'https://www.googleapis.com/auth/drive')
  const sourceCheck = (error: any) => {
    if (error)
      throw new TrackerError(
        'Connected Sheets are unavailable. Check the database connection; a new database needs database/schema.sql.',
        503,
      )
  }
  async function googleFor(tenant: string, userId: string) {
    if (!deps.googleAccess)
      throw new TrackerError(
        'Google is not set up for this account. An Administrator connects it in Settings → Integrations.',
        503,
      )
    try {
      return await deps.googleAccess(tenant, userId)
    } catch (error: any) {
      throw new TrackerError(
        error?.status === 409 || /connect/i.test(String(error?.message))
          ? 'Allow Google Sheets first: the Google account needs to be connected again.'
          : 'Google could not be reached. Try again in a moment.',
        error?.status === 409 ? 409 : 502,
        { needsGoogle: true },
      )
    }
  }
  async function sheetsGet(token: string, url: string, write?: { method: 'POST' | 'PUT'; body: unknown }) {
    let response: globalThis.Response
    try {
      response = await fetch(url, {
        method: write?.method || 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          ...(write ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(write ? { body: JSON.stringify(write.body) } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(25000),
      })
    } catch {
      throw new TrackerError('Google Sheets did not answer in time. Try again in a moment.', 504)
    }
    const data: any = await response.json().catch(() => ({}))
    if (response.ok) return data
    const reason = JSON.stringify(data?.error ?? '')
    // The API itself is switched off in the Google Cloud project: an admin fixes this, not the person connecting.
    if (/SERVICE_DISABLED|accessNotConfigured|has not been used in project|API is disabled/i.test(reason))
      throw new TrackerError(
        `The ${url.includes('/drive/') ? 'Google Drive API' : 'Google Sheets API'} is turned off in the Google Cloud project used for Gmail. An admin needs to enable it (APIs & Services → Library), then try again.`,
        503,
        { apiDisabled: true },
      )
    if (response.status === 400 && /not supported for this document/i.test(reason)) throw notASheet()
    if (response.status === 401 || response.status === 403) {
      if (/insufficient|scope/i.test(String(data?.error?.message || data?.error?.status || '')))
        throw new TrackerError(
          write
            ? 'Allow editing Google Sheets first, so the tracker can write to the Sheet.'
            : 'Allow Google Sheets first, so the tracker can read your Sheets.',
          403,
          { needsGoogle: true },
        )
      if (write)
        throw new TrackerError(
          'The Google account used here can open that Sheet but not edit it. Ask its owner for edit access.',
          403,
          { noEdit: true },
        )
      throw new TrackerError(
        'The Google account used here cannot open that Sheet. Ask its owner to share it, or reconnect with an account that can open it.',
        403,
        { noAccess: true },
      )
    }
    if (response.status === 404)
      throw new TrackerError('That Sheet or tab was not found. It may have been deleted or renamed.', 404)
    if (response.status === 429)
      throw new TrackerError('Google Sheets is busy for this account. Wait a minute and try again.', 429)
    throw new TrackerError('Google Sheets returned an error. Try again in a moment.', 502)
  }
  const notASheet = (name = '') =>
    new TrackerError(
      `${name ? `"${name}"` : 'That link'} is an Excel file kept in Google Drive, not a Google Sheet. Open it in Google Drive, choose File → Save as Google Sheets, and use the new Sheet's link.`,
      422,
      { notASheet: true },
    )
  // When a Sheet cannot be read, Drive can still say what the file is: an Excel file gets its own message.
  async function explainSheetError(token: string, id: string, error: unknown): Promise<never> {
    if (error instanceof TrackerError && [403, 404, 422].includes(error.status)) {
      const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=name,mimeType&supportsAllDrives=true`
      const file = await sheetsGet(token, url).catch(() => null)
      if (file?.mimeType && file.mimeType !== 'application/vnd.google-apps.spreadsheet') throw notASheet(file.name)
    }
    throw error
  }
  // ---- Excel files kept in Google Drive ----
  // A tracker can follow an .xlsx the same way as a Sheet, one-way only: the file is downloaded and read on each sync,
  // and nothing is ever written back. Which ids are Excel files is remembered, so writes can be refused without a call.
  const excelIds = new Map<string, boolean>()
  const workbooks = new Map<string, { version: string; book: Workbook }>()
  const needsExcel = () =>
    new TrackerError('Allow reading Excel files in Google Drive first, so the tracker can open this .xlsx file.', 403, {
      needsGoogle: true,
      needsExcel: true,
    })
  /** What a Drive file is: name, type and version. Null when Drive cannot say (no access, or not found). */
  async function driveFile(token: string, id: string) {
    const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=name,mimeType,modifiedTime,size&supportsAllDrives=true`
    const file = await sheetsGet(token, url).catch(() => null)
    if (!file?.mimeType) return null
    excelIds.set(id, file.mimeType === EXCEL_MIME)
    return {
      name: String(file.name || 'Untitled'),
      mimeType: String(file.mimeType),
      version: String(file.modifiedTime || ''),
      size: Number(file.size || 0),
    }
  }
  /** Whether a source is an Excel file. Asks Drive only the first time for each file. */
  async function isExcel(token: string, id: string) {
    if (!excelIds.has(id)) await driveFile(token, id)
    return excelIds.get(id) === true
  }
  /**
   * Whether a connected source is an Excel file. Excel files are connected under their Drive name, which ends in .xlsx,
   * so a Sheet never costs a Drive call here.
   */
  async function sourceIsExcel(token: string, source: any) {
    const known = excelIds.get(source.spreadsheet_id)
    if (known !== undefined) return known
    if (!/\.xlsx$/i.test(String(source.spreadsheet_name || ''))) return false
    return isExcel(token, source.spreadsheet_id)
  }
  /** Downloads and reads an Excel file; the last few are kept until the file changes. */
  async function openWorkbook(token: string, scope: unknown, id: string): Promise<{ name: string; book: Workbook }> {
    const file = await driveFile(token, id)
    if (!file)
      throw new TrackerError(
        'The Google account used here cannot open that file. Ask its owner to share it, or reconnect with an account that can open it.',
        403,
        { noAccess: true },
      )
    if (file.mimeType !== EXCEL_MIME) throw new TrackerError('That file is not an Excel workbook (.xlsx).', 422)
    if (file.size > XLSX_MAX_BYTES)
      throw new TrackerError(
        'That Excel file is larger than 20 MB, too large to follow. Save it as a Google Sheet.',
        413,
      )
    const kept = workbooks.get(id)
    if (kept && file.version && kept.version === file.version) return { name: file.name, book: kept.book }
    if (!canReadDriveFiles(scope)) throw needsExcel()
    let response: globalThis.Response
    try {
      response = await fetch(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`,
        { headers: { Authorization: `Bearer ${token}` }, redirect: 'follow', signal: AbortSignal.timeout(30000) },
      )
    } catch {
      throw new TrackerError('Google Drive did not answer in time. Try again in a moment.', 504)
    }
    if (response.status === 401 || response.status === 403) {
      const reason = await response.text().catch(() => '')
      if (/insufficient|scope/i.test(reason)) throw needsExcel()
      throw new TrackerError(
        'The Google account used here cannot download that Excel file. Ask its owner to share it, or reconnect with an account that can open it.',
        403,
        { noAccess: true },
      )
    }
    if (response.status === 404)
      throw new TrackerError('That Excel file was not found. It may have been deleted or moved.', 404)
    if (!response.ok) throw new TrackerError('Google Drive returned an error. Try again in a moment.', 502)
    const data = Buffer.from(await response.arrayBuffer())
    let book: Workbook
    try {
      book = readXlsx(data)
    } catch (error) {
      throw new TrackerError(error instanceof XlsxError ? error.message : 'That Excel file could not be read.', 422)
    }
    workbooks.delete(id)
    workbooks.set(id, { version: file.version, book })
    for (const old of workbooks.keys()) if (workbooks.size > 5) workbooks.delete(old)
    return { name: file.name, book }
  }
  /** One tab of an Excel file, as the Sheets API would give it (header row first). */
  async function excelGrid(token: string, scope: unknown, id: string, tab: string) {
    const { book } = await openWorkbook(token, scope, id)
    const grid = book.grid(tab, { rows: SYNC_LIMITS.rows + 1, columns: SYNC_LIMITS.columns })
    if (!grid) throw new TrackerError('That tab was not found in the Excel file. It may have been renamed.', 404)
    return grid
  }
  /** The tab a source follows, from a Google Sheet or an Excel file. */
  async function sourceGrid(token: string, scope: unknown, source: any): Promise<string[][]> {
    if (await sourceIsExcel(token, source)) return excelGrid(token, scope, source.spreadsheet_id, source.tab)
    const values = await sheetsGet(
      token,
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(source.spreadsheet_id)}/values/${encodeURIComponent(tabRange(source.tab))}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`,
    )
    return (Array.isArray(values.values) ? values.values : [])
      .slice(0, SYNC_LIMITS.rows + 1)
      .map((line: unknown[]) =>
        (Array.isArray(line) ? line : []).slice(0, SYNC_LIMITS.columns).map(value => String(value ?? '')),
      )
  }
  const excelReadOnly = () =>
    new TrackerError(
      'This tracker follows an Excel file, which the tracker only reads. Make the change in the Excel file; it comes in on the next sync.',
      409,
      { excel: true },
    )
  const sheetId = (value: unknown) => {
    const id = sheetIdFrom(String(value ?? ''))
    if (!id) throw new TrackerError('That is not a Google Sheets link.')
    return id
  }
  const sourceOut = (row: any): TrackerSource => ({
    spreadsheetId: row.spreadsheet_id,
    spreadsheetName: row.spreadsheet_name || '',
    tab: row.tab,
    keyHeader: row.key_header,
    headerMap: row.header_map || {},
    mode: row.mode === 'two_way' ? 'two_way' : 'one_way',
    connectedBy: row.connected_by || '',
    connectedByName: row.connected_by_name || '',
    connectedEmail: row.connected_email || '',
    lastSyncedAt: row.last_synced_at || '',
    lastStatus: row.last_status === 'ok' || row.last_status === 'error' ? row.last_status : 'never',
    lastError: row.last_error || '',
    lastReport: row.last_report || null,
    // Excel files keep their .xlsx name in Drive, so the name tells until Drive has been asked.
    ...((excelIds.get(row.spreadsheet_id) ?? /\.xlsx$/i.test(String(row.spreadsheet_name || '')))
      ? { excel: true }
      : {}),
  })
  /** The tracker's Sheet connection, or null. Before schema v27 there is no table, and no tracker is connected. */
  async function sourceRow(tenant: string, trackerId: string) {
    try {
      const r = await db
        .from('tenant_tracker_sources')
        .select('*')
        .eq('tenant_id', tenant)
        .eq('tracker_id', trackerId)
        .maybeSingle()
      return r.error ? null : r.data || null
    } catch {
      return null
    }
  }
  async function allRows(tenant: string, trackerId: string) {
    const rows: any[] = []
    for (;;) {
      const r = await db
        .from('tenant_tracker_rows')
        .select('*')
        .eq('tenant_id', tenant)
        .eq('tracker_id', trackerId)
        .order('position', { ascending: true })
        .range(rows.length, rows.length + PAGE - 1)
      check(r.error)
      rows.push(...(r.data || []))
      if ((r.data || []).length < PAGE) return rows
    }
  }
  const lastSync = new Map<string, number>()

  /**
   * The dropdown choices of the Sheet columns that fill Choice, Text or Checkbox columns: Sheet header → choices. Reads the data
   * validation of each such column (a list typed into the rule, or a range it points to) for the rows in use.
   */
  async function dropdownLists(token: string, source: any, grid: string[][], columns: TrackerColumn[]) {
    const lists: Record<string, string[]> = {}
    const headers = (grid[0] || []).map(value => String(value ?? '').trim())
    const byId = new Map(columns.map(column => [column.id, column]))
    const wanted = Object.entries<string>(source.header_map || {})
      .filter(([, id]) => ['select', 'multiselect', 'text', 'longtext', 'checkbox'].includes(byId.get(id)?.type || ''))
      .map(([header]) => ({ header, index: headers.findIndex(item => item.toLowerCase() === header.toLowerCase()) }))
      .filter(item => item.index >= 0)
    if (!token || !wanted.length) return lists
    // Dropdowns are usually set on more rows than are filled in, so look a little past the last row.
    const last = Math.min(Math.max(grid.length + 20, 50), 1000)
    const params = new URLSearchParams({
      includeGridData: 'true',
      fields: 'sheets(data(rowData(values(dataValidation(condition)))))',
    })
    for (const item of wanted)
      params.append('ranges', `${tabRange(source.tab)}!${columnLetter(item.index)}2:${columnLetter(item.index)}${last}`)
    const data = await sheetsGet(
      token,
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(source.spreadsheet_id)}?${params}`,
    )
    const blocks: any[] = data?.sheets?.[0]?.data || []
    const ranges = new Map<string, string[]>()
    for (const [at, item] of wanted.entries()) {
      const choices: string[] = []
      for (const row of blocks[at]?.rowData || []) {
        const dropdown = dropdownOf(row?.values?.[0]?.dataValidation)
        if (!dropdown) continue
        let list: string[] = []
        if ('list' in dropdown) list = dropdown.list
        else if (ranges.has(dropdown.range)) list = ranges.get(dropdown.range)!
        else if (ranges.size < 5) {
          const read = await sheetsGet(
            token,
            `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(source.spreadsheet_id)}/values/${encodeURIComponent(dropdown.range)}?majorDimension=ROWS`,
          ).catch(() => null)
          list = (Array.isArray(read?.values) ? read.values : [])
            .flat()
            .map((value: unknown) => String(value ?? '').trim())
            .filter(Boolean)
          ranges.set(dropdown.range, list)
        }
        for (const choice of list) if (!choices.includes(choice)) choices.push(choice)
      }
      if (choices.length) lists[item.header] = choices
    }
    return lists
  }

  // ---- two-way: tracker edits written to the Sheet ----
  /** The Google access of the person who connected the Sheet, which must allow editing Sheets. */
  /**
   * The Google access a Sheet write uses: the account of the person making the change, so Google's own sharing decides
   * what they may do there. Only automatic writes (`fallback`, such as done marks) use the account that connected the
   * Sheet when the person has not connected one that may edit Sheets.
   */
  async function writeAccess(
    tenant: string,
    source: any,
    user: { id: string } | null,
    fallback = false,
  ): Promise<{ token: string; email: string }> {
    if (user?.id) {
      const access = deps.googleAccess ? await deps.googleAccess(tenant, user.id).catch(() => null) : null
      if (access && (await sourceIsExcel(access.token, source))) throw excelReadOnly()
      if (access && canWriteSheets(access.scope)) return { token: access.token, email: access.email || '' }
      if (!fallback)
        throw new TrackerError(
          access
            ? 'Your Google account has not allowed this app to edit Google Sheets yet. Sharing the Sheet with you is not enough: Google asks you once to let the app make the change for you. Nothing was changed.'
            : 'Connect your Google account, with permission to edit Google Sheets, to change the Sheet from here. Nothing was changed.',
          409,
          { needsWrite: true },
        )
    }
    const access = await googleFor(tenant, source.connected_by)
    if (await sourceIsExcel(access.token, source)) throw excelReadOnly()
    if (!canWriteSheets(access.scope))
      throw new TrackerError(
        `${source.connected_by_name || 'The person who connected this Sheet'} has not allowed editing Google Sheets, so the Sheet could not be updated.`,
        409,
        { needsWrite: true },
      )
    return { token: access.token, email: access.email || '' }
  }
  /** Google refusing a person names their account, so they know which one to ask access for. */
  function asAccount(email: string, error: unknown): never {
    if (error instanceof TrackerError && (error.extra?.noEdit || error.extra?.noAccess))
      throw new TrackerError(
        error.extra?.noEdit
          ? `Your Google account${email ? ` (${email})` : ''} can open this Sheet but not edit it. Ask its owner for edit access. Nothing was changed.`
          : `Your Google account${email ? ` (${email})` : ''} cannot open this Sheet. Ask its owner to share it with you. Nothing was changed.`,
        403,
        { noEdit: true },
      )
    throw error
  }
  async function readTab(token: string, source: any): Promise<string[][]> {
    const values = await sheetsGet(
      token,
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(source.spreadsheet_id)}/values/${encodeURIComponent(tabRange(source.tab))}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`,
    )
    return (Array.isArray(values.values) ? values.values : []).map((line: unknown[]) =>
      (Array.isArray(line) ? line : []).map(value => String(value ?? '')),
    )
  }
  /** A range read as stored: numbers as numbers, dates as serial numbers, text as text. */
  async function readRaw(token: string, spreadsheetId: string, range: string): Promise<any[][]> {
    const data = await sheetsGet(
      token,
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`,
    )
    return Array.isArray(data.values) ? data.values : []
  }
  /**
   * Changes a person made in the Sheet's Gantt chart tab (Lead, Start, End, % Done, Remarks) are written to the synced
   * tab, so the sync that follows brings them into the tracker. Returns what the redraw afterwards needs, or null when
   * the Sheet has no Gantt tab or the tracker has nothing to chart. Needs permission to edit the Sheet.
   */
  async function ganttEditsToTab(token: string, source: any, tracker: any): Promise<GanttState | null> {
    const fields = ganttFields(
      columnsOf(tracker),
      tracker.timeline || undefined,
      source.header_map || {},
      source.key_header,
    )
    if (!fields) return null
    const base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(source.spreadsheet_id)}`
    const meta = await sheetsGet(token, `${base}?fields=sheets.properties(sheetId,title,gridProperties(rowCount))`)
    const tab = (meta?.sheets || [])
      .map((sheet: any) => sheet.properties || {})
      .find((item: any) => item.title === GANTT_TAB)
    if (!tab) return null
    const grid = await readRaw(token, source.spreadsheet_id, tabRange(source.tab))
    const layout = ganttLayout(
      (grid[0] || []).map((value: unknown) => String(value ?? '')),
      fields,
    )
    if ('error' in layout) return null
    const rowCount = Number(tab.gridProperties?.rowCount || 1000)
    const shown = await readRaw(
      token,
      source.spreadsheet_id,
      `${tabRange(GANTT_TAB)}!A${HEAD_ROWS + 1}:${ganttColumn(layout.left.length - 1)}${rowCount}`,
    )
    const writes = trackerTabWrites(layout, source.tab, grid, ganttEdits(layout, shown))
    if (writes.length)
      await sheetsGet(token, `${base}/values:batchUpdate`, {
        method: 'POST',
        body: { valueInputOption: 'USER_ENTERED', data: writes },
      })
    return { sheetId: Number(tab.sheetId), rowCount, shown, fields, written: writes.length }
  }
  /** Writes the Gantt tab's rows again from the synced tab, when they differ from what it shows. */
  async function redrawGantt(token: string, source: any, state: GanttState) {
    const grid = await readRaw(token, source.spreadsheet_id, tabRange(source.tab))
    const layout = ganttLayout(
      (grid[0] || []).map((value: unknown) => String(value ?? '')),
      state.fields,
    )
    if ('error' in layout) return
    const rows = ganttRows(layout, grid)
    if (ganttShows(layout, rows, state.shown)) return
    const room = rows.length + HEAD_ROWS + 20 - state.rowCount
    await sheetsGet(
      token,
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(source.spreadsheet_id)}:batchUpdate`,
      {
        method: 'POST',
        body: {
          requests: [
            ...(room > 0 ? [{ appendDimension: { sheetId: state.sheetId, dimension: 'ROWS', length: room } }] : []),
            ...ganttRedrawRequests(layout, state.sheetId, rows, Math.max(state.rowCount, rows.length + HEAD_ROWS)),
          ],
        },
      },
    )
  }
  async function peopleOf(tenant: string): Promise<Person[]> {
    const state = await workspace(tenant)
    return (Array.isArray(state.accounts) ? state.accounts : []).map((account: any) => ({
      id: String(account.id),
      name: String(account.name || ''),
    }))
  }

  return {
    sourceRow,
    lastSync,
    sourceOut,
    googleFor,
    canReadSheets,
    sourceIsExcel,
    driveFile,
    canWriteSheets,
    ganttEditsToTab,
    sourceGrid,
    sourceCheck,
    dropdownLists,
    allRows,
    redrawGantt,
    writeAccess,
    sheetsGet,
    readTab,
    asAccount,
    peopleOf,
    canReadDriveFiles,
    sheetId,
    isExcel,
    openWorkbook,
    explainSheetError,
    excelReadOnly,
    readRaw,
  }
}

export type TrackerSheetAccess = ReturnType<typeof trackerSource>
