import { randomUUID } from 'node:crypto'
import rateLimit from 'express-rate-limit'
import type { Express, Request, RequestHandler, Response } from 'express'
import { decryptSecret, encryptSecret, encryptionKey, IntegrationError } from '../integrations/tenant-integrations'
import {
  TRACKER_LIMITS,
  TrackerError,
  TRACKER_CLIENTS,
  canConvertType,
  cleanCell,
  splitClientIds,
  cleanName,
  cleanSecret,
  isBasicType,
  isColumnType,
  isEmptyCell,
  normalizeColumns,
  normalizeViews,
  OPTION_COLORS,
  planConversion,
  type Cell,
  type OptionColor,
  type SyncReport,
  type Tracker,
  type TrackerColumn,
  type TrackerRow,
  type TrackerSource,
} from '../../src/features/trackers/trackerModel'
import {
  SYNC_LIMITS,
  describeSync,
  dropdownOf,
  mergeDropdownOptions,
  planNewColumns,
  convertRowsToChoice,
  planSync,
  sheetIdFrom,
  tabRange,
} from '../../src/features/trackers/trackerSync'
import { cleanTimelineSettings } from '../../src/features/trackers/timelineModel'
import { sheetFormatRequests, sheetFromTracker } from '../../src/features/trackers/sheetFromTracker'
import {
  GANTT_TAB,
  HEAD_ROWS,
  columnLetter as ganttColumn,
  ganttEdits,
  ganttFields,
  ganttLayout,
  ganttRedrawRequests,
  ganttRows,
  ganttSheetRequests,
  ganttShows,
  sheetHasGantt,
  trackerTabWrites,
  type GanttFields,
} from '../../src/features/trackers/sheetGantt'
import { rowCellsFromTask, taskFieldChanges } from '../../src/features/trackers/trackerTasks'
import {
  SHEET_ISSUES,
  autoDoneColumn,
  columnLetter,
  completionChanges,
  isClosedStatus,
  locateSheetCell,
  planAutoDone,
  sheetTextFor,
  sheetTextMatches,
  type SheetIssue,
  type SheetIssueCode,
} from '../../src/features/trackers/trackerAutoDone'
import { planAppend, planCellWrites, type InputOption, type Person } from '../../src/features/trackers/trackerTwoWay'
import {
  cellSubtaskPatches,
  tickChanges,
  type DonePatch,
  type RowChange,
} from '../../src/features/trackers/cellSubtasks'

/**
 * Trackers: user-defined sheets. A tracker owns its columns and views; its rows live in their own table so one
 * edit saves one row instead of the whole workspace. Secret columns are encrypted before they are stored, are
 * never sent back to the browser, and can only be read through a logged reveal.
 */
type Deps = {
  db: any
  requireAuth: RequestHandler
  requireTenant: RequestHandler
  /** The tenant workspace, used to check that a linked task, client or project exists. */
  load: (tenantId: string) => Promise<{ data: any }>
  /** Encryption key override for tests. */
  key?: Buffer
  now?: () => Date
  /** A Google access token for a person, used to read connected Sheets as the person who connected them. */
  googleAccess?: (tenantId: string, userId: string) => Promise<{ token: string; scope: string; email?: string }>
  /**
   * The account Google Drive: a tracker's new Sheet is made there under Client / Project, shared with the person who
   * makes it. Without a connected Drive the Sheet goes to that person's own Drive.
   */
  drive?: {
    ready: (tenantId: string) => Promise<boolean>
    sheet?: (job: {
      tenantId: string
      title: string
      clientId?: string
      projectId?: string
      editorEmail: string
    }) => Promise<{ spreadsheetId: string; path: string[] }>
  }
  /**
   * Completes or reopens tasks in the workspace as the given person, saying where the change came from. Used for boxes
   * ticked or unticked in a connected Google Sheet (see cellSubtasks). Returns how many tasks changed.
   */
  updateTasks?: (
    tenantId: string,
    patches: DonePatch[],
    actor: { id: string; name: string; role: string },
    from: string,
  ) => Promise<number>
}

/** Blank rows a new Sheet gets below the tracker's rows. */
const SPARE_SHEET_ROWS = 3
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const PAGE = 1000
const HISTORY = 50

type User = { id: string; name: string; role: string; organizationId: string }

export function registerTrackerRoutes(app: Express, deps: Deps) {
  const { db } = deps
  const now = () => (deps.now ? deps.now() : new Date()).toISOString()
  const who = (req: Request) => (req as any).authUser as User
  const key = () => deps.key ?? encryptionKey()

  const guard: RequestHandler = (req, res, next) => {
    const user = (req as any).authUser
    if (!db) return void res.status(503).json({ error: 'Database is not configured.' })
    if (!user?.organizationId || user.accountType === 'platform' || !user.modules?.includes('trackers'))
      return void res.status(403).json({ error: 'Trackers access is required.' })
    if (req.method !== 'GET' && user.role === 'Viewer')
      return void res.status(403).json({ error: 'Your role can view trackers but not change them.' })
    res.setHeader('Cache-Control', 'no-store')
    next()
  }
  const scope = [deps.requireAuth, deps.requireTenant, guard]

  const check = (error: any) => {
    if (error)
      throw new TrackerError(
        'Trackers storage is unavailable. Apply database/migrations/schema-v24-trackers.sql and check the database connection.',
        503,
      )
  }
  const route =
    (handler: (req: Request, res: Response) => Promise<void>): RequestHandler =>
    async (req, res) => {
      try {
        await handler(req, res)
      } catch (error) {
        if (error instanceof TrackerError)
          return void res.status(error.status).json({ error: error.message, ...(error.extra || {}) })
        if (error instanceof IntegrationError) return void res.status(error.status).json({ error: error.message })
        res.status(500).json({ error: 'Trackers are unavailable right now. Try again in a moment.' })
      }
    }
  const idParam = (req: Request, name = 'id') => {
    const value = String(req.params[name] || '')
    if (!UUID.test(value)) throw new TrackerError('Tracker not found.', 404)
    return value
  }

  async function workspace(tenant: string) {
    try {
      return (await deps.load(tenant)).data || {}
    } catch {
      throw new TrackerError('The workspace could not be read. Try again in a moment.', 503)
    }
  }
  const manageable = (user: User, row: any) => user.role === 'Administrator' || row.created_by === user.id

  async function trackerRow(tenant: string, id: string, user: User) {
    const r = await db.from('tenant_trackers').select('*').eq('tenant_id', tenant).eq('id', id).maybeSingle()
    check(r.error)
    // A private tracker does not exist for anyone but its creator.
    if (!r.data || (r.data.private && r.data.created_by !== user.id)) throw new TrackerError('Tracker not found.', 404)
    return r.data
  }
  async function rowCount(tenant: string, trackerId: string) {
    const r = await db
      .from('tenant_tracker_rows')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenant)
      .eq('tracker_id', trackerId)
    check(r.error)
    return Number(r.count || 0)
  }
  const trackerOut = (row: any, user: User, count: number): Tracker => ({
    id: row.id,
    name: row.name,
    clientId: splitClientIds(row.client_id)[0] || '',
    clientIds: splitClientIds(row.client_id),
    projectId: row.project_id || '',
    private: Boolean(row.private),
    template: row.template || '',
    ...(typeof row.step_tasks === 'boolean' ? { stepTasks: row.step_tasks } : {}),
    columns: Array.isArray(row.columns) ? row.columns : [],
    views: Array.isArray(row.views) ? row.views : [],
    ...(row.timeline && typeof row.timeline === 'object' ? { timeline: row.timeline } : {}),
    revision: Number(row.revision || 1),
    rowCount: count,
    createdBy: row.created_by || '',
    createdByName: row.created_by_name || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archived: Boolean(row.archived_at),
    canEdit: user.role !== 'Viewer',
    canManage: manageable(user, row),
  })
  const columnsOf = (row: any): TrackerColumn[] => (Array.isArray(row.columns) ? row.columns : [])

  function rowOut(row: any, columns: TrackerColumn[]): TrackerRow {
    const cells: Record<string, Cell> = {},
      secretSet: Record<string, true> = {}
    for (const column of columns) {
      if (isBasicType(column.type)) {
        const value = row.data?.[column.id]
        if (!isEmptyCell(value)) cells[column.id] = value
      } else if (column.type === 'secret' && row.secrets?.[column.id]) secretSet[column.id] = true
    }
    return {
      id: row.id,
      position: Number(row.position),
      cells,
      secretSet,
      taskId: row.task_id || '',
      version: Number(row.version || 1),
      updatedAt: row.updated_at,
      ...(row.source_key ? { sourceKey: String(row.source_key) } : {}),
      ...(row.source_missing ? { sourceMissing: true } : {}),
      ...(row.review ? { review: true } : {}),
      ...(row.sheet_issue?.code ? { sheetIssue: row.sheet_issue as SheetIssue } : {}),
      ...(OPTION_COLORS.includes(row.highlight) ? { highlight: row.highlight as OptionColor } : {}),
    }
  }

  /** What is written to the history for a value. Secrets are never included. */
  function shown(column: TrackerColumn, value: Cell | undefined) {
    if (value === undefined || isEmptyCell(value)) return ''
    if (column.type === 'checkbox') return value ? 'Yes' : 'No'
    if (column.type === 'select') return column.options?.find(option => option.id === value)?.label || ''
    if (column.type === 'multiselect')
      return (value as string[])
        .map(id => column.options?.find(option => option.id === id)?.label || '')
        .filter(Boolean)
        .join(', ')
    return String(value).slice(0, 120)
  }
  async function record(
    tenant: string,
    trackerId: string,
    rowId: string,
    user: User,
    kind: string,
    detail: Record<string, unknown>,
    required = false,
  ) {
    const r = await db.from('tenant_tracker_changes').insert({
      id: randomUUID(),
      tenant_id: tenant,
      tracker_id: trackerId,
      row_id: rowId,
      actor_id: user.id,
      actor_name: user.name,
      kind,
      detail,
      created_at: now(),
    })
    // History is best effort, except for a reveal: a secret is never shown without a record that it was.
    if (r.error && required)
      throw new TrackerError('The reveal could not be recorded, so nothing was shown. Try again.', 503)
  }
  async function touch(tenant: string, trackerId: string) {
    await db.from('tenant_trackers').update({ updated_at: now() }).eq('tenant_id', tenant).eq('id', trackerId)
  }

  function validateLinks(state: any, body: { clientId?: unknown; clientIds?: unknown; projectId?: unknown }) {
    const pick = (value: unknown, list: any[], label: string) => {
      const id = String(value ?? '').trim()
      if (id && !(list || []).some((item: any) => item.id === id))
        throw new TrackerError(`That ${label} was not found in your account.`)
      return id
    }
    // A tracker can follow several clients. `clientIds` wins; a single `clientId` still works for older callers.
    let clientId: string | undefined
    if (body.clientIds !== undefined) {
      if (!Array.isArray(body.clientIds)) throw new TrackerError('clientIds must be a list.')
      const ids = [
        ...new Set(body.clientIds.map((value: unknown) => pick(value, state.clients, 'client')).filter(Boolean)),
      ]
      if (ids.length > TRACKER_CLIENTS)
        throw new TrackerError(`A tracker can follow at most ${TRACKER_CLIENTS} clients.`)
      clientId = ids.join(',')
    } else if (body.clientId !== undefined) clientId = pick(body.clientId, state.clients, 'client')
    return {
      clientId,
      projectId: body.projectId === undefined ? undefined : pick(body.projectId, state.projects, 'project'),
    }
  }
  function taskIdOf(state: any, value: unknown) {
    const id = String(value ?? '').trim()
    if (!id) return ''
    if (id.length > 100 || !(state.items || []).some((item: any) => item.id === id))
      throw new TrackerError('That task was not found in your account.')
    return id
  }

  /** Cleans the cells and secrets for one row. `existing` is the row being changed, if any. */
  function cleanRowInput(columns: TrackerColumn[], input: any, label: string) {
    const byId = new Map(columns.map(column => [column.id, column]))
    const cells: Record<string, Cell> = {},
      secrets: Record<string, string | null> = {}
    const fail = (message: string): never => {
      throw new TrackerError(label ? `${label}: ${message}` : message)
    }
    if (
      input?.cells !== undefined &&
      (typeof input.cells !== 'object' || input.cells === null || Array.isArray(input.cells))
    )
      fail('cells must be an object.')
    for (const [id, raw] of Object.entries<unknown>(input?.cells || {})) {
      const column = byId.get(id)
      if (!column) fail('That column no longer exists. Reload the tracker.')
      const result = cleanCell(column!, raw)
      if (!result.ok) fail(result.error)
      else cells[id] = result.value
    }
    if (
      input?.secrets !== undefined &&
      (typeof input.secrets !== 'object' || input.secrets === null || Array.isArray(input.secrets))
    )
      fail('secrets must be an object.')
    for (const [id, raw] of Object.entries<unknown>(input?.secrets || {})) {
      const column = byId.get(id)
      if (!column) fail('That column no longer exists. Reload the tracker.')
      if (raw === null || raw === '') {
        if (column!.type !== 'secret') fail(`${column!.name} is not a Secret column.`)
        secrets[id] = null
        continue
      }
      const result = cleanSecret(column!, raw)
      if (!result.ok) fail(result.error)
      else secrets[id] = result.value
    }
    return { cells, secrets }
  }
  const mergeCells = (data: Record<string, Cell>, columns: TrackerColumn[], cells: Record<string, Cell>) => {
    // Only values for columns that still exist are kept; emptied cells are removed instead of stored as empty.
    const next: Record<string, Cell> = {}
    for (const column of columns)
      if (isBasicType(column.type)) {
        const value = column.id in cells ? cells[column.id] : data?.[column.id]
        if (!isEmptyCell(value as Cell)) next[column.id] = value as Cell
      }
    return next
  }
  const mergeSecrets = (
    current: Record<string, string>,
    columns: TrackerColumn[],
    tenant: string,
    changes: Record<string, string | null>,
  ) => {
    const next: Record<string, string> = {}
    for (const column of columns)
      if (column.type === 'secret') {
        if (column.id in changes) {
          const value = changes[column.id]
          if (value) next[column.id] = encryptSecret(value, tenant, 'tracker-secret', key())
        } else if (current?.[column.id]) next[column.id] = current[column.id]
      }
    return next
  }

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
  const sourceCheck = (error: any) => {
    if (error)
      throw new TrackerError(
        'Connected Sheets need database/migrations/schema-v27-tracker-sheets.sql. Apply it and try again.',
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

  /** Reads the Sheet and applies the changes. `force` skips the one-minute pause between syncs. */
  async function runSync(
    tenant: string,
    tracker: any,
    user: User,
    force: boolean,
  ): Promise<{ source: TrackerSource; report: SyncReport | null; skipped?: boolean; tasks?: number }> {
    const source = await sourceRow(tenant, tracker.id)
    if (!source) throw new TrackerError('This tracker is not connected to a Google Sheet.', 404)
    const key = `${tenant}:${tracker.id}`
    if (!force && Date.now() - (lastSync.get(key) || 0) < SYNC_LIMITS.minSeconds * 1000)
      return { source: sourceOut(source), report: source.last_report || null, skipped: true }
    lastSync.set(key, Date.now())
    const fail = async (message: string) => {
      await db
        .from('tenant_tracker_sources')
        .update({ last_status: 'error', last_error: message.slice(0, 500), updated_at: now() })
        .eq('tenant_id', tenant)
        .eq('tracker_id', tracker.id)
    }
    let grid: string[][]
    let token = ''
    let gantt: GanttState | null = null
    try {
      const access = await googleFor(tenant, source.connected_by)
      token = access.token
      if (!canReadSheets(access.scope))
        throw new TrackerError(
          `${source.connected_by_name || 'The person who connected this Sheet'} needs to allow Google Sheets again. Anyone who can open the Sheet can reconnect it.`,
          409,
          { noAccess: true },
        )
      // Edits made in the Gantt chart tab go to the synced tab first, so this sync brings them in. Never fails the sync.
      if (canWriteSheets(access.scope))
        gantt = await ganttEditsToTab(access.token, source, tracker).catch((error: any) => {
          console.error('Reading the Gantt chart tab failed:', error?.message || error)
          return null
        })
      const values = await sheetsGet(
        access.token,
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(source.spreadsheet_id)}/values/${encodeURIComponent(tabRange(source.tab))}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`,
      )
      grid = (Array.isArray(values.values) ? values.values : [])
        .slice(0, SYNC_LIMITS.rows + 1)
        .map((line: unknown[]) =>
          (Array.isArray(line) ? line : []).slice(0, SYNC_LIMITS.columns).map(value => String(value ?? '')),
        )
    } catch (error) {
      await fail(error instanceof Error ? error.message : 'The Sheet could not be read.')
      throw error
    }
    // Columns added to the Sheet since the last sync become tracker columns, followed from now on (see planNewColumns).
    const grown = planNewColumns({
      grid,
      headerMap: source.header_map || {},
      keyHeader: source.key_header,
      columns: columnsOf(tracker),
      today: now().slice(0, 10),
      firstSync: !source.last_synced_at,
    })
    if (grown.changed) {
      const stamp = now()
      if (grown.columns.length) {
        const nextColumns = normalizeColumns([...columnsOf(tracker), ...grown.columns], columnsOf(tracker))
        const savedColumns = await db
          .from('tenant_trackers')
          .update({ columns: nextColumns, revision: Number(tracker.revision || 1) + 1, updated_at: stamp })
          .eq('tenant_id', tenant)
          .eq('id', tracker.id)
        check(savedColumns.error)
        tracker = { ...tracker, columns: nextColumns, revision: Number(tracker.revision || 1) + 1 }
      }
      const savedMap = await db
        .from('tenant_tracker_sources')
        .update({ header_map: grown.headerMap, updated_at: stamp })
        .eq('tenant_id', tenant)
        .eq('tracker_id', tracker.id)
      sourceCheck(savedMap.error)
      source.header_map = grown.headerMap
      if (grown.added.length) await record(tenant, tracker.id, '', user, 'columns', { addedFromSheet: grown.added })
    }
    // The Sheet's dropdown choices, so options no row uses yet come over too. Best effort: a sync never fails on it.
    const dropdowns = mergeDropdownOptions(
      columnsOf(tracker),
      source.header_map || {},
      await dropdownLists(token, source, grid, columnsOf(tracker)).catch(() => ({})),
    )
    const existing = await allRows(tenant, tracker.id)
    // Text and Checkbox columns that follow a Sheet dropdown just became Choice columns: move their values to the new options
    // first, for every row (rows only the tracker has too), so no cell is left holding plain text.
    if (dropdowns.converted.length) {
      const moved = convertRowsToChoice(
        dropdowns.columns,
        dropdowns.converted,
        existing.map(row => ({ id: row.id, data: row.data || {} })),
      )
      const stamp = now()
      // The column first: if this stops part-way, the next sync finds the leftover text and matches it again.
      // normalizeColumns refuses type changes against `previous`, so this one sync-made change is given as already made.
      const previous = columnsOf(tracker).map(column =>
        dropdowns.converted.includes(column.id)
          ? ({ ...column, type: 'select', options: [] } as TrackerColumn)
          : column,
      )
      const convertedColumns = normalizeColumns(moved.columns, previous)
      dropdowns.columns = convertedColumns
      const savedColumns = await db
        .from('tenant_trackers')
        .update({
          columns: convertedColumns,
          revision: Number(tracker.revision || 1) + 1,
          updated_at: stamp,
        })
        .eq('tenant_id', tenant)
        .eq('id', tracker.id)
      check(savedColumns.error)
      tracker = { ...tracker, columns: convertedColumns, revision: Number(tracker.revision || 1) + 1 }
      for (const row of existing) {
        const cells = moved.changes.get(row.id)
        if (!cells) continue
        row.data = { ...(row.data || {}), ...cells }
        row.version = Number(row.version || 1) + 1
        const saved = await db
          .from('tenant_tracker_rows')
          .update({ data: row.data, version: row.version, updated_at: stamp })
          .eq('tenant_id', tenant)
          .eq('tracker_id', tracker.id)
          .eq('id', row.id)
        sourceCheck(saved.error)
      }
    }
    const state = await workspace(tenant)
    const people = (Array.isArray(state.accounts) ? state.accounts : []).map((account: any) => ({
      id: String(account.id),
      name: String(account.name || ''),
      email: account.email,
      username: account.username,
    }))
    const planned = planSync({
      grid,
      keyHeader: source.key_header,
      headerMap: source.header_map || {},
      columns: dropdowns.columns,
      rows: existing.map(row => ({
        id: row.id,
        sourceKey: row.source_key || '',
        data: row.data || {},
        values: row.source_values || {},
        missing: Boolean(row.source_missing),
      })),
      people,
      today: now().slice(0, 10),
      capacity: TRACKER_LIMITS.rows - existing.length,
    })
    if ('error' in planned) {
      await fail(planned.error)
      throw new TrackerError(planned.error, 409)
    }
    const stamp = now()
    let columns = columnsOf(tracker)
    if (planned.columnsChanged || dropdowns.changed) {
      columns = normalizeColumns(planned.columns, columnsOf(tracker))
      const saved = await db
        .from('tenant_trackers')
        .update({ columns, revision: Number(tracker.revision || 1) + 1, updated_at: stamp })
        .eq('tenant_id', tenant)
        .eq('id', tracker.id)
      check(saved.error)
    }
    let position = existing.reduce((max, row) => Math.max(max, Number(row.position) || 0), 0)
    for (let at = 0; at < planned.inserts.length; at += TRACKER_LIMITS.importBatch) {
      const records = planned.inserts.slice(at, at + TRACKER_LIMITS.importBatch).map(entry => ({
        tenant_id: tenant,
        tracker_id: tracker.id,
        id: randomUUID(),
        position: ++position,
        data: mergeCells({}, columns, entry.cells),
        secrets: {},
        task_id: '',
        version: 1,
        created_by: source.connected_by,
        updated_by: source.connected_by,
        created_at: stamp,
        updated_at: stamp,
        source_key: entry.key,
        source_values: entry.values,
        source_missing: false,
        review: true,
      }))
      const saved = await db.from('tenant_tracker_rows').insert(records)
      sourceCheck(saved.error)
    }
    const byId = new Map(existing.map(row => [row.id, row]))
    const returned = new Set(planned.returned)
    const fromSheet: RowChange[] = []
    for (const update of planned.updates) {
      const current = byId.get(update.id)
      if (!current) continue
      const changed = Object.keys(update.cells).length > 0
      const patch: Record<string, unknown> = {
        source_values: update.values,
        ...(returned.has(update.id) ? { source_missing: false } : {}),
      }
      if (changed)
        Object.assign(patch, {
          data: mergeCells(current.data || {}, columns, update.cells),
          version: Number(current.version || 1) + 1,
          updated_at: stamp,
        })
      const saved = await db
        .from('tenant_tracker_rows')
        .update(patch)
        .eq('tenant_id', tenant)
        .eq('tracker_id', tracker.id)
        .eq('id', update.id)
      sourceCheck(saved.error)
      if (changed) fromSheet.push({ rowId: update.id, before: current.data || {}, after: patch.data as any })
    }
    // Boxes ticked or unticked in the Sheet complete or reopen the subtasks in those cells. Never fails the sync.
    const tasks = await followSheetTicks(tenant, tracker.id, columns, fromSheet, user).catch((error: any) => {
      console.error('Completing subtasks from Sheet ticks failed:', error?.message || error)
      return 0
    })
    for (const id of planned.returned)
      if (!planned.updates.some(update => update.id === id))
        await db
          .from('tenant_tracker_rows')
          .update({ source_missing: false })
          .eq('tenant_id', tenant)
          .eq('tracker_id', tracker.id)
          .eq('id', id)
    if (planned.missing.length) {
      const saved = await db
        .from('tenant_tracker_rows')
        .update({ source_missing: true })
        .eq('tenant_id', tenant)
        .eq('tracker_id', tracker.id)
        .in('id', planned.missing)
      sourceCheck(saved.error)
    }
    const report = { ...planned.report, ...(grown.added.length ? { addedColumns: grown.added } : {}) }
    const done = await db
      .from('tenant_tracker_sources')
      .update({ last_synced_at: stamp, last_status: 'ok', last_error: '', last_report: report, updated_at: stamp })
      .eq('tenant_id', tenant)
      .eq('tracker_id', tracker.id)
    sourceCheck(done.error)
    if (report.added || report.updated || report.missing || report.returned) {
      await record(tenant, tracker.id, '', user, 'sheet_synced', { summary: describeSync(report), ...report })
      await touch(tenant, tracker.id)
    }
    // The Gantt tab shows the synced tab again (with fresh snapshots), including what changed in the tracker.
    if (gantt)
      await redrawGantt(token, source, gantt).catch((error: any) =>
        console.error('Redrawing the Gantt chart tab failed:', error?.message || error),
      )
    return {
      source: sourceOut({ ...source, last_synced_at: stamp, last_status: 'ok', last_error: '', last_report: report }),
      report,
      // Tasks completed or reopened from Sheet ticks: the browser reloads the workspace to show them.
      ...(tasks ? { tasks } : {}),
    }
  }

  /**
   * Checkbox cells changed by a sync: the subtask in each one is completed when the box was ticked and reopened when it
   * was unticked (see cellSubtasks), as the person who synced. Returns how many tasks changed.
   */
  async function followSheetTicks(
    tenant: string,
    trackerId: string,
    columns: TrackerColumn[],
    changes: RowChange[],
    user: User,
  ) {
    if (!deps.updateTasks || !changes.length) return 0
    const ticked = changes.filter(change => tickChanges(columns, change.before, change.after).length)
    if (!ticked.length) return 0
    const links: any[] = []
    const rowIds = ticked.map(change => change.rowId)
    for (let at = 0; at < rowIds.length; at += 200) {
      // Before schema v25 there is no links table, and no subtasks in cells.
      const found = await db
        .from('tenant_tracker_task_links')
        .select('*')
        .eq('tenant_id', tenant)
        .eq('tracker_id', trackerId)
        .in('row_id', rowIds.slice(at, at + 200))
      if (found.error) return 0
      links.push(...(found.data || []))
    }
    const patches = cellSubtaskPatches(
      columns,
      ticked,
      links.map(link => ({ rowId: String(link.row_id), columnId: link.column_id, taskId: String(link.task_id) })),
    )
    if (!patches.length) return 0
    return deps.updateTasks(tenant, patches, user, 'the Google Sheet')
  }

  // ---- done when its tasks are done ----
  // After every workspace save: rows linked to a task or subtask whose completed state changed get their auto-done
  // column updated (see trackerAutoDone). A column that comes from the connected Sheet is written to the Sheet first,
  // as the person who connected it; a row whose Sheet cell could not be written keeps its value and says why.
  type Actor = { id: string; name: string }
  type SheetResult = { ok: true; text: string } | { ok: false; code: SheetIssueCode }
  const issueCode = (error: unknown): SheetIssueCode => {
    if (error instanceof TrackerError) {
      if (error.extra?.needsGoogle) return 'no_access'
      if (error.extra?.noEdit || error.extra?.noAccess) return 'no_edit'
    }
    return 'error'
  }
  const issueOf = (code: SheetIssueCode, value: Cell): SheetIssue => ({
    code,
    message: SHEET_ISSUES[code],
    value,
    at: now(),
  })
  /** Leading = + - @ would make Google read a choice label as a formula; an apostrophe keeps it plain text. */
  const plainText = (text: string) => (/^[=+\-@]/.test(text) ? `'${text}` : text)
  const headerFor = (source: any, columnId: string) =>
    Object.entries<string>(source?.header_map || {}).find(([, id]) => id === columnId)?.[0] || ''

  /** Writes values for several rows of one tracker to its Sheet, with one read and one write. */
  async function writeToSheet(
    tenant: string,
    source: any,
    column: TrackerColumn,
    entries: { row: any; value: Cell }[],
    actor: { id: string } | null = null,
  ): Promise<Map<string, SheetResult>> {
    const results = new Map<string, SheetResult>()
    const failAll = (code: SheetIssueCode) => {
      for (const entry of entries) results.set(entry.row.id, { ok: false, code })
      return results
    }
    const header = headerFor(source, column.id)
    if (!header) return failAll('no_header')
    let access: { token: string }
    try {
      // The person who completed the task, when their Google account may edit Sheets; otherwise the connector's.
      access = await writeAccess(tenant, source, actor, true)
    } catch {
      return failAll('no_access')
    }
    let grid: string[][]
    try {
      const values = await sheetsGet(
        access.token,
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(source.spreadsheet_id)}/values/${encodeURIComponent(tabRange(source.tab))}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`,
      )
      grid = (Array.isArray(values.values) ? values.values : []).map((line: unknown[]) =>
        (Array.isArray(line) ? line : []).map(value => String(value ?? '')),
      )
    } catch (error) {
      return failAll(issueCode(error))
    }
    const writes: { id: string; range: string; text: string }[] = []
    for (const entry of entries) {
      const cell = locateSheetCell(grid, source.key_header, String(entry.row.source_key || ''), header)
      if ('error' in cell) {
        results.set(entry.row.id, { ok: false, code: cell.error })
        continue
      }
      if (sheetTextMatches(column, cell.text, entry.value)) {
        results.set(entry.row.id, { ok: true, text: cell.text })
        continue
      }
      // Someone changed the cell in the Sheet after the last sync: their change wins until a person decides.
      const baseline = String(entry.row.source_values?.[header] ?? '')
      if (cell.text.trim() !== baseline.trim()) {
        results.set(entry.row.id, { ok: false, code: 'conflict' })
        continue
      }
      writes.push({
        id: entry.row.id,
        range: `${tabRange(source.tab)}!${columnLetter(cell.column)}${cell.row}`,
        text: sheetTextFor(column, entry.value, cell.text),
      })
    }
    if (writes.length) {
      try {
        await sheetsGet(
          access.token,
          `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(source.spreadsheet_id)}/values:batchUpdate`,
          {
            method: 'POST',
            body: {
              valueInputOption: 'USER_ENTERED',
              data: writes.map(write => ({ range: write.range, values: [[plainText(write.text)]] })),
            },
          },
        )
        for (const write of writes) results.set(write.id, { ok: true, text: write.text })
      } catch (error) {
        const code = issueCode(error)
        for (const write of writes) results.set(write.id, { ok: false, code })
      }
    }
    return results
  }

  /**
   * Stores a row's new auto-done value (and, when it went to the Sheet, the Sheet text as the new baseline), or the
   * reason it could not reach the Sheet. Guarded by the row version; false when the row changed in the meantime.
   */
  async function saveAutoDone(
    tenant: string,
    tracker: any,
    column: TrackerColumn,
    row: any,
    value: Cell,
    sheet: SheetResult | undefined,
    actor: Actor,
    detail: Record<string, unknown>,
  ) {
    const columns = columnsOf(tracker)
    const header = sheet ? headerFor(await sourceRow(tenant, tracker.id), column.id) : ''
    if (sheet && !sheet.ok) {
      const saved = await db
        .from('tenant_tracker_rows')
        .update({ sheet_issue: issueOf(sheet.code, value) })
        .eq('tenant_id', tenant)
        .eq('tracker_id', tracker.id)
        .eq('id', row.id)
      if (saved.error) console.error('A Sheet problem could not be stored on the row. Apply schema-v28.')
      await record(tenant, tracker.id, row.id, actor as User, 'auto_done_sheet_failed', {
        ...detail,
        name: column.name,
        to: shown(column, value),
        issue: sheet.code,
        message: SHEET_ISSUES[sheet.code],
      })
      return true
    }
    const version = Number(row.version || 1)
    const patch: Record<string, unknown> = {
      data: mergeCells(row.data || {}, columns, { [column.id]: value }),
      version: version + 1,
      updated_by: actor.id,
      updated_at: now(),
    }
    if (sheet?.ok && header) patch.source_values = { ...(row.source_values || {}), [header]: sheet.text }
    if (row.sheet_issue) patch.sheet_issue = null
    const saved = await db
      .from('tenant_tracker_rows')
      .update(patch)
      .eq('tenant_id', tenant)
      .eq('tracker_id', tracker.id)
      .eq('id', row.id)
      .eq('version', version)
      .select('id')
    check(saved.error)
    if (!saved.data?.length) return false
    await record(tenant, tracker.id, row.id, actor as User, 'auto_done', {
      ...detail,
      name: column.name,
      from: shown(column, row.data?.[column.id]),
      to: shown(column, value),
      ...(sheet?.ok ? { sheet: true } : {}),
    })
    return true
  }

  async function autoDoneTracker(
    tenant: string,
    trackerId: string,
    rowIds: string[],
    changes: Map<string, boolean>,
    closed: (taskId: string) => boolean | undefined,
    titles: Map<string, string>,
    actor: Actor,
  ) {
    const found = await db.from('tenant_trackers').select('*').eq('tenant_id', tenant).eq('id', trackerId).maybeSingle()
    if (found.error || !found.data || found.data.archived_at) return
    const tracker = found.data
    const column = autoDoneColumn(columnsOf(tracker))
    if (!column) return
    const loadRows = async (ids: string[]) => {
      const rows: any[] = []
      for (let at = 0; at < ids.length; at += 200) {
        const r = await db
          .from('tenant_tracker_rows')
          .select('*')
          .eq('tenant_id', tenant)
          .eq('tracker_id', trackerId)
          .in('id', ids.slice(at, at + 200))
        check(r.error)
        rows.push(...(r.data || []))
      }
      return rows
    }
    const linksFor = new Map<string, string[]>()
    for (let at = 0; at < rowIds.length; at += 200) {
      const r = await db
        .from('tenant_tracker_task_links')
        .select('*')
        .eq('tenant_id', tenant)
        .eq('tracker_id', trackerId)
        .in('row_id', rowIds.slice(at, at + 200))
      for (const link of r.error ? [] : r.data || [])
        linksFor.set(link.row_id, [...(linksFor.get(link.row_id) || []), String(link.task_id)])
    }
    const plan = (row: any) =>
      planAutoDone({
        column,
        current: row.data?.[column.id],
        linked: [row.task_id || '', ...(linksFor.get(row.id) || [])],
        closed,
        changes,
      })
    let source: any = null
    if (column.synced) source = await sourceRow(tenant, trackerId)
    let pending = rowIds
    let changed = false
    // Twice at most: a row edited by someone at the same moment is read again and planned again.
    for (let attempt = 0; attempt < 2 && pending.length; attempt += 1) {
      const planned = (await loadRows(pending))
        .map(row => ({ row, next: plan(row) }))
        .filter((entry): entry is { row: any; next: NonNullable<ReturnType<typeof plan>> } => entry.next !== null)
      if (!planned.length) break
      const toSheet = source ? planned.filter(entry => entry.row.source_key) : []
      const sheet = toSheet.length
        ? await writeToSheet(
            tenant,
            source,
            column,
            toSheet.map(entry => ({ row: entry.row, value: entry.next.value })),
            actor.id ? actor : null,
          )
        : new Map<string, SheetResult>()
      const retry: string[] = []
      for (const { row, next } of planned) {
        const detail = {
          reason: next.reason,
          tasks: next.taskIds.map(id => titles.get(id) || 'a task').slice(0, 5),
        }
        const ok = await saveAutoDone(tenant, tracker, column, row, next.value, sheet.get(row.id), actor, detail)
        if (ok) changed = true
        else retry.push(row.id)
      }
      pending = retry
    }
    if (changed) await touch(tenant, trackerId)
  }

  /**
   * Rows that mirror a field of their task (see trackerTasks): after a save, a task's new title, start or due date is
   * copied to its row, and progress goes to 100 when the task is completed. Columns that come from a two-way Sheet are
   * written there too, as the person who saved (best effort; the next sync settles any difference).
   */
  async function followTaskFields(
    tenant: string,
    fields: Map<string, { title?: string; startDate?: string; dueDate?: string }>,
    completed: Map<string, boolean>,
    actor: Actor,
  ) {
    const ids = [...new Set([...fields.keys(), ...completed.keys()])]
    const byTracker = new Map<string, any[]>()
    for (let at = 0; at < ids.length; at += 200) {
      const found = await db
        .from('tenant_tracker_rows')
        .select('*')
        .eq('tenant_id', tenant)
        .in('task_id', ids.slice(at, at + 200))
      for (const row of found.error ? [] : found.data || [])
        byTracker.set(row.tracker_id, [...(byTracker.get(row.tracker_id) || []), row])
    }
    for (const [trackerId, rows] of byTracker) {
      const loaded = await db
        .from('tenant_trackers')
        .select('*')
        .eq('tenant_id', tenant)
        .eq('id', trackerId)
        .maybeSingle()
      const tracker = loaded.data
      if (!tracker || tracker.archived_at) continue
      const columns = columnsOf(tracker)
      if (!columns.some(column => column.taskField)) continue
      let changed = false
      const toSheet = new Map<string, { row: any; value: Cell }[]>()
      for (const row of rows) {
        const cells = rowCellsFromTask(columns, row.data || {}, fields.get(row.task_id), completed.get(row.task_id))
        if (!Object.keys(cells).length) continue
        const version = Number(row.version || 1)
        const saved = await db
          .from('tenant_tracker_rows')
          .update({
            data: mergeCells(row.data || {}, columns, cells),
            version: version + 1,
            updated_by: actor.id,
            updated_at: now(),
          })
          .eq('tenant_id', tenant)
          .eq('tracker_id', trackerId)
          .eq('id', row.id)
          .eq('version', version)
          .select('id')
        if (saved.error || !saved.data?.length) continue
        changed = true
        const byId = new Map(columns.map(column => [column.id, column]))
        await record(tenant, trackerId, row.id, actor as User, 'cells', {
          fromTask: true,
          cells: Object.keys(cells).map(columnId => ({
            columnId,
            name: byId.get(columnId)!.name,
            from: shown(byId.get(columnId)!, row.data?.[columnId]),
            to: shown(byId.get(columnId)!, cells[columnId]),
          })),
        })
        for (const [columnId, value] of Object.entries(cells))
          if (byId.get(columnId)?.synced && row.source_key)
            toSheet.set(columnId, [...(toSheet.get(columnId) || []), { row, value }])
      }
      if (toSheet.size) {
        const source = await sourceRow(tenant, trackerId)
        if (source?.mode === 'two_way')
          for (const [columnId, entries] of toSheet) {
            const column = columns.find(item => item.id === columnId)!
            await writeToSheet(tenant, source, column, entries, actor.id ? actor : null).catch(() => undefined)
          }
      }
      if (changed) await touch(tenant, trackerId)
    }
  }

  /**
   * A Checkbox cell that holds a subtask (a Site rollout step, or any cell linked to one) is ticked when the subtask is
   * completed and unticked when it is reopened. Columns that come from a two-way Sheet are written there too, as the
   * person who saved (best effort; the next sync settles any difference).
   */
  async function followCellTasks(tenant: string, completed: Map<string, boolean>, actor: Actor) {
    const ids = [...completed.keys()]
    const links: any[] = []
    for (let at = 0; at < ids.length; at += 200) {
      // Before schema v25 there is no links table, and nothing to follow.
      const found = await db
        .from('tenant_tracker_task_links')
        .select('*')
        .eq('tenant_id', tenant)
        .in('task_id', ids.slice(at, at + 200))
      if (found.error) return
      links.push(...(found.data || []).filter((link: any) => link.column_id))
    }
    const byTracker = new Map<string, any[]>()
    for (const link of links) byTracker.set(link.tracker_id, [...(byTracker.get(link.tracker_id) || []), link])
    for (const [trackerId, trackerLinks] of byTracker) {
      const loaded = await db
        .from('tenant_trackers')
        .select('*')
        .eq('tenant_id', tenant)
        .eq('id', trackerId)
        .maybeSingle()
      const tracker = loaded.data
      if (!tracker || tracker.archived_at) continue
      const columns = columnsOf(tracker)
      const byId = new Map(columns.map(column => [column.id, column]))
      const wanted = trackerLinks.filter(link => byId.get(link.column_id)?.type === 'checkbox')
      if (!wanted.length) continue
      const rowIds = [...new Set(wanted.map(link => String(link.row_id)))]
      const rows: any[] = []
      for (let at = 0; at < rowIds.length; at += 200) {
        const found = await db
          .from('tenant_tracker_rows')
          .select('*')
          .eq('tenant_id', tenant)
          .eq('tracker_id', trackerId)
          .in('id', rowIds.slice(at, at + 200))
        rows.push(...(found.error ? [] : found.data || []))
      }
      let changed = false
      const toSheet = new Map<string, { row: any; value: Cell }[]>()
      for (const row of rows) {
        const cells: Record<string, Cell> = {}
        for (const link of wanted)
          if (link.row_id === row.id) {
            const done = completed.get(String(link.task_id))
            if (done !== undefined && (row.data?.[link.column_id] === true) !== done) cells[link.column_id] = done
          }
        if (!Object.keys(cells).length) continue
        const version = Number(row.version || 1)
        const saved = await db
          .from('tenant_tracker_rows')
          .update({
            data: mergeCells(row.data || {}, columns, cells),
            version: version + 1,
            updated_by: actor.id,
            updated_at: now(),
          })
          .eq('tenant_id', tenant)
          .eq('tracker_id', trackerId)
          .eq('id', row.id)
          .eq('version', version)
          .select('id')
        if (saved.error || !saved.data?.length) continue
        changed = true
        await record(tenant, trackerId, row.id, actor as User, 'cells', {
          fromTask: true,
          cells: Object.keys(cells).map(columnId => ({
            columnId,
            name: byId.get(columnId)!.name,
            from: shown(byId.get(columnId)!, row.data?.[columnId]),
            to: shown(byId.get(columnId)!, cells[columnId]),
          })),
        })
        for (const [columnId, value] of Object.entries(cells))
          if (byId.get(columnId)?.synced && row.source_key)
            toSheet.set(columnId, [...(toSheet.get(columnId) || []), { row, value }])
      }
      if (toSheet.size) {
        const source = await sourceRow(tenant, trackerId)
        if (source?.mode === 'two_way')
          for (const [columnId, entries] of toSheet)
            await writeToSheet(tenant, source, byId.get(columnId)!, entries, actor.id ? actor : null).catch(
              () => undefined,
            )
      }
      if (changed) await touch(tenant, trackerId)
    }
  }

  /** Follows up a workspace save. Never throws: a failure here must not look like a failed save. */
  async function onWorkspaceSaved(tenant: string, before: any, after: any, actor: Actor | null) {
    if (!db || !tenant) return
    const changes = completionChanges(before, after)
    const fields = taskFieldChanges(before, after)
    if (fields.size || changes.size)
      await followTaskFields(
        tenant,
        fields,
        changes,
        actor ? { id: actor.id, name: actor.name } : { id: '', name: 'Automatic' },
      ).catch((error: any) => console.error('Updating tracker rows from their tasks failed:', error?.message || error))
    if (!changes.size) return
    await followCellTasks(
      tenant,
      changes,
      actor ? { id: actor.id, name: actor.name } : { id: '', name: 'Automatic' },
    ).catch((error: any) => console.error('Ticking tracker steps from their subtasks failed:', error?.message || error))
    const ids = [...changes.keys()]
    const touched = new Map<string, Set<string>>()
    const add = (trackerId: string, rowId: string) => {
      if (!touched.has(trackerId)) touched.set(trackerId, new Set())
      touched.get(trackerId)!.add(rowId)
    }
    for (let at = 0; at < ids.length; at += 200) {
      const chunk = ids.slice(at, at + 200)
      const direct = await db
        .from('tenant_tracker_rows')
        .select('id,tracker_id')
        .eq('tenant_id', tenant)
        .in('task_id', chunk)
      for (const row of direct.error ? [] : direct.data || []) add(row.tracker_id, row.id)
      // Before schema v25 there is no links table: only the rows' own tasks count.
      const linked = await db
        .from('tenant_tracker_task_links')
        .select('tracker_id,row_id')
        .eq('tenant_id', tenant)
        .in('task_id', chunk)
      for (const link of linked.error ? [] : linked.data || []) add(link.tracker_id, link.row_id)
    }
    if (!touched.size) return
    const statuses = Array.isArray(after?.taskSettings?.statuses) ? after.taskSettings.statuses : undefined
    const items = new Map<string, any>(
      (Array.isArray(after?.items) ? after.items : []).map((item: any) => [String(item?.id || ''), item]),
    )
    const closed = (taskId: string) => {
      const item = items.get(taskId)
      return item ? isClosedStatus(item.status, statuses) : undefined
    }
    const titles = new Map<string, string>([...items].map(([id, item]) => [id, String(item?.title || '')]))
    const who: Actor = actor ? { id: actor.id, name: actor.name } : { id: '', name: 'Automatic' }
    for (const [trackerId, rowIds] of touched) {
      try {
        await autoDoneTracker(tenant, trackerId, [...rowIds], changes, closed, titles, who)
      } catch (error: any) {
        console.error('Updating a tracker after a task was completed failed:', error?.message || error)
      }
    }
  }

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
  type GanttState = { sheetId: number; rowCount: number; shown: any[][]; fields: GanttFields; written: number }
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
  /**
   * Writes cells, one request per way Google should read them, and returns each range's text as the Sheet now shows
   * it (a date keeps the cell's own format), which becomes the baseline the next sync compares with.
   */
  async function writeCells(token: string, source: any, cells: { range: string; text: string; input: InputOption }[]) {
    const shown = new Map<string, string>()
    for (const input of ['RAW', 'USER_ENTERED'] as const) {
      const batch = cells.filter(cell => cell.input === input)
      if (!batch.length) continue
      const result = await sheetsGet(
        token,
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(source.spreadsheet_id)}/values:batchUpdate`,
        {
          method: 'POST',
          body: {
            valueInputOption: input,
            includeValuesInResponse: true,
            responseValueRenderOption: 'FORMATTED_VALUE',
            data: batch.map(cell => ({ range: cell.range, values: [[cell.text]] })),
          },
        },
      )
      batch.forEach((cell, at) => {
        shown.set(cell.range, String(result?.responses?.[at]?.updatedData?.values?.[0]?.[0] ?? cell.text))
      })
    }
    return shown
  }

  /** Adds rows that have a task name to the bottom of the Sheet tab. Returns row id → the row fields to store. */
  async function appendRowsToSheet(tenant: string, tracker: any, source: any, rows: any[], user: { id: string }) {
    const stored = new Map<string, Record<string, unknown>>()
    const candidates = rows.filter(row => !row.source_key)
    if (!candidates.length) return stored
    const { token, email } = await writeAccess(tenant, source, user)
    const grid = await readTab(token, source).catch(error => asAccount(email, error))
    const plan = planAppend({
      grid,
      keyHeader: source.key_header,
      headerMap: source.header_map || {},
      columns: columnsOf(tracker),
      rows: candidates.map(row => ({ id: row.id, cells: row.data || {} })),
      people: await peopleOf(tenant),
    })
    if (!plan.appends.length) return stored
    // The key goes on the row first, so a sync running meanwhile recognises the new Sheet row instead of adding it again.
    for (const entry of plan.appends)
      await db
        .from('tenant_tracker_rows')
        .update({ source_key: entry.key, source_values: entry.values, review: false })
        .eq('tenant_id', tenant)
        .eq('tracker_id', tracker.id)
        .eq('id', entry.id)
    try {
      const appended = await sheetsGet(
        token,
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(source.spreadsheet_id)}/values/${encodeURIComponent(tabRange(source.tab))}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
        { method: 'POST', body: { values: plan.appends.map(entry => entry.line) } },
      )
      const updatedRange = String(appended?.updates?.updatedRange || '')
      const first = Number(/^\$?[A-Z]+\$?(\d+)/.exec(updatedRange.slice(updatedRange.lastIndexOf('!') + 1))?.[1])
      if (!Number.isInteger(first)) throw new TrackerError('Google did not say where the rows were added.', 502)
      const typed = plan.appends.flatMap((entry, at) =>
        entry.typed.map(cell => ({
          range: `${tabRange(source.tab)}!${columnLetter(cell.column)}${first + at}`,
          text: cell.text,
          input: 'USER_ENTERED' as const,
        })),
      )
      const shown = typed.length ? await writeCells(token, source, typed) : new Map<string, string>()
      const headers = (grid[0] || []).map(value => String(value ?? '').trim())
      plan.appends.forEach((entry, at) => {
        const values = { ...entry.values }
        for (const cell of entry.typed) {
          const header = headers[cell.column]
          const text = shown.get(`${tabRange(source.tab)}!${columnLetter(cell.column)}${first + at}`)
          const mapped = Object.keys(values).find(name => name.toLowerCase() === header.toLowerCase())
          if (mapped && text !== undefined) values[mapped] = text
        }
        stored.set(entry.id, { source_key: entry.key, source_values: values, review: false })
      })
      for (const [rowId, fields] of stored)
        await db
          .from('tenant_tracker_rows')
          .update({ source_values: fields.source_values })
          .eq('tenant_id', tenant)
          .eq('tracker_id', tracker.id)
          .eq('id', rowId)
    } catch (error) {
      // Not in the Sheet after all: take the keys off again so the rows stay tracker-only.
      for (const entry of plan.appends)
        await db
          .from('tenant_tracker_rows')
          .update({ source_key: '', source_values: {} })
          .eq('tenant_id', tenant)
          .eq('tracker_id', tracker.id)
          .eq('id', entry.id)
      asAccount(email, error)
    }
    return stored
  }

  /**
   * Writes one row's edited Sheet columns to the Sheet, before the tracker saves them. A row that is not in the Sheet
   * yet is added once it has a task name. Returns the row fields to store with the edit (the new baseline).
   */
  async function writeRowToSheet(
    tenant: string,
    tracker: any,
    source: any,
    current: any,
    edits: Record<string, Cell>,
    data: Record<string, Cell>,
    overwrite: boolean,
    user: { id: string },
  ): Promise<Record<string, unknown>> {
    if (!current.source_key) {
      const added = await appendRowsToSheet(tenant, tracker, source, [{ ...current, data }], user)
      return added.get(current.id) || {}
    }
    const { token, email } = await writeAccess(tenant, source, user)
    const grid = await readTab(token, source).catch(error => asAccount(email, error))
    const columns = columnsOf(tracker)
    const plan = planCellWrites({
      grid,
      keyHeader: source.key_header,
      sourceKey: String(current.source_key),
      headerMap: source.header_map || {},
      columns,
      cells: edits,
      baseline: current.source_values || {},
      people: await peopleOf(tenant),
      overwrite,
    })
    if ('error' in plan)
      throw new TrackerError(
        plan.error === 'no_row'
          ? 'This row was not found in the Google Sheet. It may have been renamed or removed there; sync to see the Sheet as it is now.'
          : 'The key column is no longer in the Google Sheet. Reconnect the Sheet.',
        409,
        { row: rowOut(current, columns) },
      )
    if (plan.conflicts.length)
      throw new TrackerError(
        plan.conflicts.length === 1
          ? `${plan.conflicts[0].name} was changed in the Google Sheet since the last sync.`
          : `${plan.conflicts.map(conflict => conflict.name).join(', ')} were changed in the Google Sheet since the last sync.`,
        409,
        { conflicts: plan.conflicts, row: rowOut(current, columns) },
      )
    const ranges = plan.writes.map(write => ({
      header: write.header,
      range: `${tabRange(source.tab)}!${columnLetter(write.column)}${plan.row}`,
      text: write.text,
      input: write.input,
    }))
    const shown = ranges.length
      ? await writeCells(token, source, ranges).catch(error => asAccount(email, error))
      : new Map<string, string>()
    const values = { ...(current.source_values || {}), ...plan.values }
    for (const write of ranges) values[write.header] = shown.get(write.range) ?? write.text
    return { source_values: values }
  }

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
      const q = `mimeType='application/vnd.google-apps.spreadsheet' and trashed=false${words ? ` and name contains '${words}'` : ''}`
      const params = new URLSearchParams({
        q,
        corpora: 'allDrives',
        includeItemsFromAllDrives: 'true',
        supportsAllDrives: 'true',
        orderBy: 'modifiedTime desc',
        pageSize: '40',
        fields: 'files(id,name,modifiedTime,owners(displayName),shared,driveId)',
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
      if (mode === 'two_way' && !canWriteSheets(access.scope))
        throw new TrackerError(
          'Allow editing Google Sheets first, so tracker edits can be written to the Sheet.',
          403,
          {
            needsWrite: true,
          },
        )
      const meta = await sheetsGet(
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
      if (user.role === 'Viewer') throw new TrackerError('Viewers cannot make a Google Sheet from a tracker.', 403)
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
          projectId: tracker.project_id || undefined,
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
      if (user.role === 'Viewer') throw new TrackerError('Viewers cannot change the Google Sheet.', 403)
      if (!sheetHasGantt(tracker.template))
        throw new TrackerError(
          'Only trackers made from the Project timeline template have a Gantt chart in their Sheet.',
          409,
        )
      if (tracker.archived_at) throw new TrackerError('This tracker is archived. Restore it first.', 409)
      const source = await sourceRow(tenant, id)
      if (!source) throw new TrackerError('This tracker is not connected to a Google Sheet.', 404)
      const access = await googleFor(tenant, user.id)
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

  /** Marks rows as reviewed (made into tasks, or left as plain rows). */
  app.post(
    '/api/trackers/:id/rows/review',
    ...scope,
    route(async (req, res) => {
      const user = who(req),
        tenant = user.organizationId,
        id = idParam(req)
      await trackerRow(tenant, id, user)
      const ids = Array.isArray(req.body?.ids) ? [...new Set<string>(req.body.ids.map(String))] : []
      if (!ids.length || ids.length > TRACKER_LIMITS.rows || ids.some(value => !UUID.test(value)))
        throw new TrackerError('Choose the rows that were reviewed.')
      for (let at = 0; at < ids.length; at += TRACKER_LIMITS.importBatch) {
        const saved = await db
          .from('tenant_tracker_rows')
          .update({ review: false })
          .eq('tenant_id', tenant)
          .eq('tracker_id', id)
          .in('id', ids.slice(at, at + TRACKER_LIMITS.importBatch))
        sourceCheck(saved.error)
      }
      res.json({ reviewed: ids.length })
    }),
  )

  app.get(
    '/api/trackers',
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
      const visible = (r.data || []).filter((row: any) => !row.private || row.created_by === user.id)
      const counts = await Promise.all(visible.map((row: any) => rowCount(tenant, row.id)))
      res.json({
        trackers: visible.map((row: any, index: number) => trackerOut(row, user, counts[index])),
        limits: TRACKER_LIMITS,
      })
    }),
  )

  app.post(
    '/api/trackers',
    ...scope,
    route(async (req, res) => {
      const user = who(req),
        tenant = user.organizationId
      const body = req.body || {}
      const name = cleanName(body.name, 'tracker name', TRACKER_LIMITS.nameLength)
      const columns = normalizeColumns(body.columns ?? [{ name: 'Name', type: 'text' }])
      const state = await workspace(tenant)
      const links = validateLinks(state, body)
      const existing = await db
        .from('tenant_trackers')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenant)
      check(existing.error)
      if (Number(existing.count || 0) >= TRACKER_LIMITS.trackers)
        throw new TrackerError(`An account can have at most ${TRACKER_LIMITS.trackers} trackers.`, 409)
      const row = {
        tenant_id: tenant,
        id: randomUUID(),
        name,
        client_id: links.clientId || '',
        project_id: links.projectId || '',
        private: body.private === true,
        template: String(body.template || '').slice(0, 40),
        ...(typeof body.stepTasks === 'boolean' ? { step_tasks: body.stepTasks } : {}),
        columns,
        views: [],
        revision: 1,
        created_by: user.id,
        created_by_name: user.name,
        created_at: now(),
        updated_at: now(),
        archived_at: null,
      }
      let saved = await db.from('tenant_trackers').insert(row)
      // Before schema v35 there is no step_tasks column: the tracker is made without it (its template still decides).
      if (saved.error && 'step_tasks' in row) {
        const { step_tasks: _off, ...plain } = row as Record<string, unknown>
        saved = await db.from('tenant_trackers').insert(plain)
      }
      check(saved.error)
      await record(tenant, row.id, '', user, 'tracker_created', { name })
      res.status(201).json({ tracker: trackerOut(row, user, 0) })
    }),
  )

  // Task links: a row, or one cell of it, linked to any number of tasks and subtasks. The Action Center reads them
  // to say where a task came from. They have their own table, so the rest of Trackers works before it is applied.
  const LINK_LIMIT = 40
  const linkCheck = (error: any) => {
    if (error)
      throw new TrackerError(
        'Task links need database/migrations/schema-v25-tracker-task-links.sql. Apply it and try again.',
        503,
      )
  }
  const titleOf = (columns: TrackerColumn[], data: any) => {
    const column = columns.find(item => item.type === 'text')
    const value = column ? data?.[column.id] : ''
    return typeof value === 'string' && value ? value : 'Untitled row'
  }
  async function linksOut(tenant: string, trackers: any[], rowFilter?: string) {
    if (!trackers.length) return []
    const byTracker = new Map<string, any>(trackers.map(tracker => [tracker.id, tracker]))
    let query = db.from('tenant_tracker_task_links').select('*').eq('tenant_id', tenant)
    if (trackers.length === 1) query = query.eq('tracker_id', trackers[0].id)
    if (rowFilter) query = query.eq('row_id', rowFilter)
    const found = await query.order('created_at', { ascending: true }).limit(2000)
    linkCheck(found.error)
    const links = (found.data || []).filter((link: any) => byTracker.has(link.tracker_id))
    const rowIds = [...new Set<string>(links.map((link: any) => link.row_id))]
    const titles = new Map<string, string>()
    for (let at = 0; at < rowIds.length; at += 200) {
      const rows = await db
        .from('tenant_tracker_rows')
        .select('*')
        .eq('tenant_id', tenant)
        .in('id', rowIds.slice(at, at + 200))
      check(rows.error)
      for (const row of rows.data || [])
        titles.set(row.id, titleOf(columnsOf(byTracker.get(row.tracker_id) || {}), row.data))
    }
    return links
      .filter((link: any) => titles.has(link.row_id))
      .map((link: any) => {
        const tracker = byTracker.get(link.tracker_id),
          column = columnsOf(tracker).find(item => item.id === link.column_id)
        return {
          id: link.id,
          trackerId: link.tracker_id,
          trackerName: tracker.name,
          rowId: link.row_id,
          rowTitle: titles.get(link.row_id) || 'Untitled row',
          columnId: column ? column.id : '',
          columnName: column ? column.name : '',
          taskId: link.task_id,
          createdByName: link.created_by_name || '',
          createdAt: link.created_at,
        }
      })
  }

  app.get(
    '/api/trackers/task-links',
    ...scope,
    route(async (req, res) => {
      const user = who(req),
        tenant = user.organizationId
      const r = await db
        .from('tenant_trackers')
        .select('*')
        .eq('tenant_id', tenant)
        .limit(TRACKER_LIMITS.trackers + 100)
      check(r.error)
      const visible = (r.data || []).filter((row: any) => !row.private || row.created_by === user.id)
      res.json({ links: await linksOut(tenant, visible) })
    }),
  )

  app.get(
    '/api/trackers/:id/links',
    ...scope,
    route(async (req, res) => {
      const user = who(req),
        tenant = user.organizationId,
        id = idParam(req)
      const tracker = await trackerRow(tenant, id, user)
      res.json({ links: await linksOut(tenant, [tracker]) })
    }),
  )

  app.post(
    '/api/trackers/:id/links',
    ...scope,
    route(async (req, res) => {
      const user = who(req),
        tenant = user.organizationId,
        id = idParam(req)
      const tracker = await trackerRow(tenant, id, user)
      if (tracker.archived_at) throw new TrackerError('This tracker is archived. Restore it to change links.', 409)
      const rowId = String(req.body?.rowId ?? '')
      if (!UUID.test(rowId)) throw new TrackerError('Choose a row to link the task to.')
      const columnId = String(req.body?.columnId ?? '').trim()
      if (columnId && !columnsOf(tracker).some(column => column.id === columnId))
        throw new TrackerError('That column was not found in this tracker.')
      const state = await workspace(tenant)
      const taskId = taskIdOf(state, req.body?.taskId)
      if (!taskId) throw new TrackerError('Choose a task or subtask to link.')
      const row = await oneRow(tenant, id, rowId)
      if (!row) throw new TrackerError('That row was not found.', 404)
      const existing = await db
        .from('tenant_tracker_task_links')
        .select('*')
        .eq('tenant_id', tenant)
        .eq('tracker_id', id)
        .eq('row_id', rowId)
      linkCheck(existing.error)
      const here = existing.data || []
      if (here.some((link: any) => link.column_id === columnId && link.task_id === taskId))
        throw new TrackerError(
          columnId ? 'That task is already linked to this cell.' : 'That task is already linked to this row.',
          409,
        )
      if (here.length >= LINK_LIMIT) throw new TrackerError(`A row can have up to ${LINK_LIMIT} linked tasks.`)
      const made = {
        id: randomUUID(),
        tenant_id: tenant,
        tracker_id: id,
        row_id: rowId,
        column_id: columnId,
        task_id: taskId,
        created_by: user.id,
        created_by_name: user.name,
        created_at: now(),
      }
      const saved = await db.from('tenant_tracker_task_links').insert(made)
      linkCheck(saved.error)
      const title = ((state.items || []).find((item: any) => item.id === taskId) || {}).title || ''
      await record(tenant, id, rowId, user, 'subtask_linked', { taskId, title, columnId })
      await touch(tenant, id)
      const links = await linksOut(tenant, [tracker], rowId)
      res.status(201).json({ link: links.find((link: any) => link.id === made.id), links })
    }),
  )

  /** Many cell links at once, for subtasks made from a review (one subtask per chosen column). */
  app.post(
    '/api/trackers/:id/links/bulk',
    ...scope,
    route(async (req, res) => {
      const user = who(req),
        tenant = user.organizationId,
        id = idParam(req)
      const tracker = await trackerRow(tenant, id, user)
      if (tracker.archived_at) throw new TrackerError('This tracker is archived. Restore it to change links.', 409)
      const input = Array.isArray(req.body?.links) ? req.body.links : []
      if (!input.length || input.length > TRACKER_LIMITS.importBatch * 4)
        throw new TrackerError('Send between 1 and 2,000 links at a time.')
      const columns = new Set(columnsOf(tracker).map(column => column.id)),
        state = await workspace(tenant)
      const wanted = input.map((entry: any) => {
        const rowId = String(entry?.rowId ?? ''),
          columnId = String(entry?.columnId ?? '').trim()
        if (!UUID.test(rowId)) throw new TrackerError('Every link needs a row.')
        if (columnId && !columns.has(columnId))
          throw new TrackerError('A column in these links was not found in this tracker.')
        return { rowId, columnId, taskId: taskIdOf(state, entry?.taskId) }
      })
      const rowIds = [...new Set<string>(wanted.map((entry: any) => entry.rowId))]
      const found = await db
        .from('tenant_tracker_rows')
        .select('id')
        .eq('tenant_id', tenant)
        .eq('tracker_id', id)
        .in('id', rowIds)
      check(found.error)
      const known = new Set((found.data || []).map((row: any) => row.id))
      const have = await db.from('tenant_tracker_task_links').select('*').eq('tenant_id', tenant).eq('tracker_id', id)
      linkCheck(have.error)
      const taken = new Set((have.data || []).map((link: any) => `${link.row_id}|${link.column_id}|${link.task_id}`))
      const records = wanted
        .filter((entry: any) => {
          const key = `${entry.rowId}|${entry.columnId}|${entry.taskId}`
          if (!known.has(entry.rowId) || !entry.taskId || taken.has(key)) return false
          taken.add(key)
          return true
        })
        .map((entry: any) => ({
          id: randomUUID(),
          tenant_id: tenant,
          tracker_id: id,
          row_id: entry.rowId,
          column_id: entry.columnId,
          task_id: entry.taskId,
          created_by: user.id,
          created_by_name: user.name,
          created_at: now(),
        }))
      if (records.length) {
        const saved = await db.from('tenant_tracker_task_links').insert(records)
        linkCheck(saved.error)
        await touch(tenant, id)
      }
      res.json({ links: await linksOut(tenant, [tracker]) })
    }),
  )

  app.delete(
    '/api/trackers/:id/links/:linkId',
    ...scope,
    route(async (req, res) => {
      const user = who(req),
        tenant = user.organizationId,
        id = idParam(req)
      const linkId = String(req.params.linkId || '')
      if (!UUID.test(linkId)) throw new TrackerError('Link not found.', 404)
      const tracker = await trackerRow(tenant, id, user)
      if (tracker.archived_at) throw new TrackerError('This tracker is archived. Restore it to change links.', 409)
      const removed = await db
        .from('tenant_tracker_task_links')
        .delete()
        .eq('tenant_id', tenant)
        .eq('tracker_id', id)
        .eq('id', linkId)
        .select('*')
      linkCheck(removed.error)
      const gone = (removed.data || [])[0]
      if (gone) {
        await record(tenant, id, gone.row_id, user, 'subtask_unlinked', {
          taskId: gone.task_id,
          columnId: gone.column_id,
        })
        await touch(tenant, id)
      }
      res.json({ removed: gone ? 1 : 0 })
    }),
  )

  app.get(
    '/api/trackers/:id',
    ...scope,
    route(async (req, res) => {
      const user = who(req),
        id = idParam(req)
      const row = await trackerRow(user.organizationId, id, user)
      const source = await sourceRow(user.organizationId, id)
      // Only when done marks go to the Sheet: whether the person who connected it allowed editing.
      let canWrite: boolean | undefined
      if (source && autoDoneColumn(columnsOf(row))?.synced)
        canWrite = deps.googleAccess
          ? await deps
              .googleAccess(user.organizationId, source.connected_by)
              .then(access => canWriteSheets(access.scope))
              .catch(() => false)
          : false
      // Two-way: whether this person's own Google account may edit Sheets (their edits are written as them).
      let youCanWrite: boolean | undefined
      if (source?.mode === 'two_way')
        youCanWrite = deps.googleAccess
          ? await deps
              .googleAccess(user.organizationId, user.id)
              .then(access => canWriteSheets(access.scope))
              .catch(() => false)
          : false
      res.json({
        tracker: {
          ...trackerOut(row, user, await rowCount(user.organizationId, id)),
          source: source
            ? {
                ...sourceOut(source),
                ...(canWrite === undefined ? {} : { canWrite }),
                ...(youCanWrite === undefined ? {} : { youCanWrite }),
              }
            : null,
        },
      })
    }),
  )

  app.patch(
    '/api/trackers/:id',
    ...scope,
    route(async (req, res) => {
      const user = who(req),
        tenant = user.organizationId,
        id = idParam(req)
      const row = await trackerRow(tenant, id, user)
      const body = req.body || {},
        patch: Record<string, unknown> = {}
      if (body.name !== undefined) patch.name = cleanName(body.name, 'tracker name', TRACKER_LIMITS.nameLength)
      if (body.clientId !== undefined || body.clientIds !== undefined || body.projectId !== undefined) {
        const links = validateLinks(await workspace(tenant), body)
        if (links.clientId !== undefined) patch.client_id = links.clientId
        if (links.projectId !== undefined) patch.project_id = links.projectId
      }
      if (body.private !== undefined || body.archived !== undefined) {
        if (!manageable(user, row))
          throw new TrackerError(
            'Only the creator or an Administrator can change who sees a tracker or archive it.',
            403,
          )
        if (body.private !== undefined) patch.private = body.private === true
        if (body.archived !== undefined) patch.archived_at = body.archived === true ? now() : null
      }
      if (body.stepTasks !== undefined) patch.step_tasks = body.stepTasks === true
      if (!Object.keys(patch).length)
        return void res.json({ tracker: trackerOut(row, user, await rowCount(tenant, id)) })
      patch.updated_at = now()
      const saved = await db.from('tenant_trackers').update(patch).eq('tenant_id', tenant).eq('id', id).select('*')
      if (saved.error && 'step_tasks' in patch)
        throw new TrackerError(
          'Turning tasks for rows and steps on or off needs database/migrations/schema-v35-step-tasks.sql. Ask your administrator to apply it.',
          503,
        )
      check(saved.error)
      if (body.archived !== undefined)
        await record(tenant, id, '', user, body.archived === true ? 'tracker_archived' : 'tracker_restored', {})
      res.json({ tracker: trackerOut({ ...row, ...patch }, user, await rowCount(tenant, id)) })
    }),
  )

  app.delete(
    '/api/trackers/:id',
    ...scope,
    route(async (req, res) => {
      const user = who(req),
        tenant = user.organizationId,
        id = idParam(req)
      const row = await trackerRow(tenant, id, user)
      if (!manageable(user, row))
        throw new TrackerError('Only the creator or an Administrator can delete a tracker.', 403)
      if (!row.archived_at) throw new TrackerError('Archive the tracker first. Deleting is permanent.', 409)
      const removed = await db.from('tenant_trackers').delete().eq('tenant_id', tenant).eq('id', id)
      check(removed.error)
      // Rows go with it (foreign key); the history is removed explicitly because it is not tied to a row.
      await db.from('tenant_tracker_changes').delete().eq('tenant_id', tenant).eq('tracker_id', id)
      res.json({ ok: true })
    }),
  )

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
      const views = normalizeViews(row.views, columns)
      const tracker = await replaceTracker(tenant, row, { columns, views }, user)
      const kept = new Set(columns.map(column => column.id))
      const removed = before.filter(column => !kept.has(column.id)),
        added = columns.filter(column => !before.some(old => old.id === column.id))
      const renamed = columns.filter(column => before.some(old => old.id === column.id && old.name !== column.name))
      if (removed.length || added.length || renamed.length)
        await record(tenant, id, '', user, 'columns', {
          added: added.map(c => c.name),
          removed: removed.map(c => c.name),
          renamed: renamed.map(c => c.name),
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
      if (user.role === 'Viewer') throw new TrackerError('Viewers cannot highlight rows.', 403)
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

  // ---- rows ----
  app.get(
    '/api/trackers/:id/rows',
    ...scope,
    route(async (req, res) => {
      const user = who(req),
        tenant = user.organizationId,
        id = idParam(req)
      const tracker = await trackerRow(tenant, id, user)
      const offset = Math.max(0, Math.floor(Number(req.query.offset) || 0))
      const limit = Math.max(1, Math.min(PAGE, Math.floor(Number(req.query.limit) || 500)))
      const r = await db
        .from('tenant_tracker_rows')
        .select('*')
        .eq('tenant_id', tenant)
        .eq('tracker_id', id)
        .order('position')
        .order('created_at')
        .range(offset, offset + limit - 1)
      check(r.error)
      const columns = columnsOf(tracker)
      res.json({
        rows: (r.data || []).map((entry: any) => rowOut(entry, columns)),
        total: await rowCount(tenant, id),
        offset,
      })
    }),
  )

  app.post(
    '/api/trackers/:id/rows',
    ...scope,
    route(async (req, res) => {
      const user = who(req),
        tenant = user.organizationId,
        id = idParam(req)
      const tracker = await trackerRow(tenant, id, user)
      if (tracker.archived_at) throw new TrackerError('This tracker is archived. Restore it to add rows.', 409)
      const input = req.body?.rows
      if (!Array.isArray(input) || !input.length) throw new TrackerError('Add at least one row.')
      if (input.length > TRACKER_LIMITS.importBatch)
        throw new TrackerError(`Add at most ${TRACKER_LIMITS.importBatch} rows at a time.`)
      const columns = columnsOf(tracker)
      const state = input.some((entry: any) => entry?.taskId) ? await workspace(tenant) : {}
      const cleaned = input.map((entry: any, index: number) => ({
        ...cleanRowInput(columns, entry, input.length > 1 ? `Row ${index + 1}` : ''),
        taskId: taskIdOf(state, entry?.taskId),
      }))
      const total = await rowCount(tenant, id)
      if (total + cleaned.length > TRACKER_LIMITS.rows)
        throw new TrackerError(
          `A tracker can have at most ${TRACKER_LIMITS.rows.toLocaleString('en')} rows. This one has ${total.toLocaleString('en')}.`,
          409,
        )
      const last = await db
        .from('tenant_tracker_rows')
        .select('position')
        .eq('tenant_id', tenant)
        .eq('tracker_id', id)
        .order('position', { ascending: false })
        .limit(1)
      check(last.error)
      let position = Number(last.data?.[0]?.position ?? 0)
      const stamp = now()
      const records = cleaned.map(entry => ({
        tenant_id: tenant,
        tracker_id: id,
        id: randomUUID(),
        position: ++position,
        data: mergeCells({}, columns, entry.cells),
        secrets: mergeSecrets({}, columns, tenant, entry.secrets),
        task_id: entry.taskId,
        version: 1,
        created_by: user.id,
        updated_by: user.id,
        created_at: stamp,
        updated_at: stamp,
      }))
      const saved = await db.from('tenant_tracker_rows').insert(records)
      check(saved.error)
      if (records.length === 1) await record(tenant, id, records[0].id, user, 'row_created', {})
      else await record(tenant, id, '', user, 'rows_added', { count: records.length })
      // Two-way: rows that already have a task name go to the Sheet too. The rest go when they get one.
      let warning = ''
      const source = await sourceRow(tenant, id)
      if (source?.mode === 'two_way') {
        const added = await appendRowsToSheet(tenant, tracker, source, records, user).catch((error: unknown) => {
          warning = `The rows were added here but not to the Google Sheet: ${error instanceof Error ? error.message : 'the Sheet could not be updated.'}`
          return new Map<string, Record<string, unknown>>()
        })
        for (const entry of records) Object.assign(entry, added.get(entry.id) || {})
      }
      await touch(tenant, id)
      res.status(201).json({ rows: records.map(entry => rowOut(entry, columns)), ...(warning ? { warning } : {}) })
    }),
  )

  async function oneRow(tenant: string, trackerId: string, rowId: string) {
    if (!UUID.test(rowId)) throw new TrackerError('Row not found.', 404)
    const r = await db
      .from('tenant_tracker_rows')
      .select('*')
      .eq('tenant_id', tenant)
      .eq('tracker_id', trackerId)
      .eq('id', rowId)
      .maybeSingle()
    check(r.error)
    if (!r.data) throw new TrackerError('Row not found. It may have been deleted.', 404)
    return r.data
  }

  app.patch(
    '/api/trackers/:id/rows/:rowId',
    ...scope,
    route(async (req, res) => {
      const user = who(req),
        tenant = user.organizationId,
        id = idParam(req)
      const tracker = await trackerRow(tenant, id, user)
      if (tracker.archived_at) throw new TrackerError('This tracker is archived. Restore it to edit rows.', 409)
      const columns = columnsOf(tracker),
        byId = new Map(columns.map(column => [column.id, column]))
      const current = await oneRow(tenant, id, String(req.params.rowId))
      const body = req.body || {}
      if (!Number.isInteger(body.version)) throw new TrackerError('The row version is required.')
      if (body.version !== Number(current.version || 1))
        throw new TrackerError('Someone else changed this row. It was reloaded; review it and try again.', 409, {
          row: rowOut(current, columns),
        })
      const cleaned = cleanRowInput(columns, body, '')
      // Sheet columns: read-only for Sheet rows in one-way; in two-way the edit goes to the Sheet first.
      let sheetPatch: Record<string, unknown> = {}
      const sheetEdits = Object.keys(cleaned.cells).filter(
        columnId =>
          byId.get(columnId)?.synced &&
          JSON.stringify(current.data?.[columnId] ?? emptyOf(byId.get(columnId)!)) !==
            JSON.stringify(cleaned.cells[columnId]),
      )
      if (sheetEdits.length) {
        const source = await sourceRow(tenant, id)
        if (source?.mode === 'two_way')
          sheetPatch = await writeRowToSheet(
            tenant,
            tracker,
            source,
            current,
            Object.fromEntries(sheetEdits.map(columnId => [columnId, cleaned.cells[columnId]])),
            mergeCells(current.data || {}, columns, cleaned.cells),
            body.overwrite === true,
            user,
          )
        else if (current.source_key) {
          const locked = byId.get(sheetEdits[0])!
          throw new TrackerError(
            `${locked.name} comes from the connected Google Sheet. Change it in the Sheet; the tracker picks it up on the next sync.`,
            409,
          )
        }
      }
      let taskId = current.task_id || ''
      if (body.taskId !== undefined)
        taskId = body.taskId === null || body.taskId === '' ? '' : taskIdOf(await workspace(tenant), body.taskId)
      const data = mergeCells(current.data || {}, columns, cleaned.cells)
      const secrets = mergeSecrets(current.secrets || {}, columns, tenant, cleaned.secrets)
      const changed = Object.keys(cleaned.cells).filter(
        columnId =>
          JSON.stringify(current.data?.[columnId] ?? emptyOf(byId.get(columnId)!)) !==
          JSON.stringify(cleaned.cells[columnId]),
      )
      const secretsChanged = Object.keys(cleaned.secrets).filter(
        columnId =>
          Boolean(current.secrets?.[columnId]) !== Boolean(cleaned.secrets[columnId]) || cleaned.secrets[columnId],
      )
      if (!changed.length && !secretsChanged.length && taskId === (current.task_id || ''))
        return void res.json({ row: rowOut(current, columns) })
      const stamp = now()
      const saved = await db
        .from('tenant_tracker_rows')
        .update({
          data,
          secrets,
          task_id: taskId,
          version: body.version + 1,
          updated_by: user.id,
          updated_at: stamp,
          ...sheetPatch,
        })
        .eq('tenant_id', tenant)
        .eq('tracker_id', id)
        .eq('id', current.id)
        .eq('version', body.version)
        .select('id')
      check(saved.error)
      if (!saved.data?.length) {
        const latest = await oneRow(tenant, id, current.id)
        throw new TrackerError('Someone else changed this row. It was reloaded; review it and try again.', 409, {
          row: rowOut(latest, columns),
        })
      }
      const next = {
        ...current,
        data,
        secrets,
        task_id: taskId,
        version: body.version + 1,
        updated_at: stamp,
        ...sheetPatch,
      }
      if (changed.length)
        await record(tenant, id, current.id, user, 'cells', {
          cells: changed.map(columnId => ({
            columnId,
            name: byId.get(columnId)!.name,
            from: shown(byId.get(columnId)!, current.data?.[columnId]),
            to: shown(byId.get(columnId)!, cleaned.cells[columnId]),
          })),
        })
      if (secretsChanged.length)
        await record(tenant, id, current.id, user, 'secrets', {
          cells: secretsChanged.map(columnId => ({
            columnId,
            name: byId.get(columnId)!.name,
            action: cleaned.secrets[columnId] ? 'set' : 'cleared',
          })),
        })
      if (taskId !== (current.task_id || '')) {
        const title = taskId
          ? ((await workspace(tenant)).items || []).find((item: any) => item.id === taskId)?.title || ''
          : ''
        await record(tenant, id, current.id, user, taskId ? 'task_linked' : 'task_unlinked', { taskId, title })
      }
      await touch(tenant, id)
      res.json({ row: rowOut(next, columns) })
    }),
  )

  // Links many rows to their tasks at once, for example right after the tasks were created for an import.
  app.post(
    '/api/trackers/:id/rows/tasks',
    ...scope,
    route(async (req, res) => {
      const user = who(req),
        tenant = user.organizationId,
        id = idParam(req)
      const tracker = await trackerRow(tenant, id, user)
      if (tracker.archived_at) throw new TrackerError('This tracker is archived. Restore it to change rows.', 409)
      const input = Array.isArray(req.body?.links) ? req.body.links : []
      if (!input.length || input.length > TRACKER_LIMITS.importBatch)
        throw new TrackerError(`Link between 1 and ${TRACKER_LIMITS.importBatch} rows at a time.`)
      const state = await workspace(tenant)
      const wanted = new Map<string, string>()
      for (const entry of input) {
        const rowId = String(entry?.rowId ?? '')
        if (!UUID.test(rowId)) throw new TrackerError('Every link needs a row.')
        wanted.set(rowId, taskIdOf(state, entry?.taskId))
      }
      const found = await db
        .from('tenant_tracker_rows')
        .select('*')
        .eq('tenant_id', tenant)
        .eq('tracker_id', id)
        .in('id', [...wanted.keys()])
      check(found.error)
      const titles = new Map<string, string>((state.items || []).map((item: any) => [item.id, item.title || '']))
      const columns = columnsOf(tracker),
        stamp = now(),
        rows: TrackerRow[] = []
      for (const current of found.data || []) {
        const taskId = wanted.get(current.id) || ''
        if (taskId === (current.task_id || '')) {
          rows.push(rowOut(current, columns))
          continue
        }
        const version = Number(current.version || 1) + 1
        const saved = await db
          .from('tenant_tracker_rows')
          .update({ task_id: taskId, version, updated_by: user.id, updated_at: stamp })
          .eq('tenant_id', tenant)
          .eq('tracker_id', id)
          .eq('id', current.id)
        check(saved.error)
        await record(tenant, id, current.id, user, taskId ? 'task_linked' : 'task_unlinked', {
          taskId,
          title: titles.get(taskId) || '',
        })
        rows.push(rowOut({ ...current, task_id: taskId, version, updated_at: stamp }, columns))
      }
      if (rows.length) await touch(tenant, id)
      res.json({ rows })
    }),
  )

  app.post(
    '/api/trackers/:id/rows/delete',
    ...scope,
    route(async (req, res) => {
      const user = who(req),
        tenant = user.organizationId,
        id = idParam(req)
      const tracker = await trackerRow(tenant, id, user)
      if (tracker.archived_at) throw new TrackerError('This tracker is archived. Restore it to delete rows.', 409)
      const ids = Array.isArray(req.body?.ids) ? [...new Set<string>(req.body.ids.map(String))] : []
      if (!ids.length || ids.length > TRACKER_LIMITS.importBatch || ids.some(value => !UUID.test(value)))
        throw new TrackerError(`Choose between 1 and ${TRACKER_LIMITS.importBatch} rows to delete.`)
      const removed = await db
        .from('tenant_tracker_rows')
        .delete()
        .eq('tenant_id', tenant)
        .eq('tracker_id', id)
        .in('id', ids)
        .select('id')
      check(removed.error)
      // Links are best effort: before the links table exists there is nothing to clean up.
      if (removed.data?.length)
        await db
          .from('tenant_tracker_task_links')
          .delete()
          .eq('tenant_id', tenant)
          .eq('tracker_id', id)
          .in('row_id', ids)
      const count = removed.data?.length ?? 0
      if (count) {
        await record(tenant, id, ids.length === 1 ? ids[0] : '', user, 'rows_deleted', { count })
        await touch(tenant, id)
      }
      res.json({ deleted: count })
    }),
  )

  const revealLimit = rateLimit({
    windowMs: 60_000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many reveals. Wait a minute and try again.' },
  })
  app.post(
    '/api/trackers/:id/rows/:rowId/reveal',
    ...scope,
    revealLimit,
    route(async (req, res) => {
      const user = who(req),
        tenant = user.organizationId,
        id = idParam(req)
      const tracker = await trackerRow(tenant, id, user)
      const column = columnsOf(tracker).find(item => item.id === req.body?.columnId)
      if (!column || column.type !== 'secret') throw new TrackerError('That is not a Secret column.', 404)
      if (column.revealBy === 'admins' && user.role !== 'Administrator')
        throw new TrackerError('Only an Administrator can reveal this column.', 403)
      const current = await oneRow(tenant, id, String(req.params.rowId))
      const stored = current.secrets?.[column.id]
      if (!stored) throw new TrackerError('Nothing is stored in this cell.', 404)
      // Record first: if the record cannot be written, nothing is revealed.
      await record(tenant, id, current.id, user, 'reveal', { columnId: column.id, name: column.name }, true)
      const value = decryptSecret(stored, tenant, 'tracker-secret', key())
      res.json({ value, seconds: 30 })
    }),
  )

  app.get(
    '/api/trackers/:id/rows/:rowId/history',
    ...scope,
    route(async (req, res) => {
      const user = who(req),
        tenant = user.organizationId,
        id = idParam(req)
      await trackerRow(tenant, id, user)
      const rowId = String(req.params.rowId)
      if (!UUID.test(rowId)) throw new TrackerError('Row not found.', 404)
      const r = await db
        .from('tenant_tracker_changes')
        .select('id,actor_name,kind,detail,created_at')
        .eq('tenant_id', tenant)
        .eq('tracker_id', id)
        .eq('row_id', rowId)
        .order('created_at', { ascending: false })
        .limit(HISTORY)
      check(r.error)
      res.json({
        changes: (r.data || []).map((entry: any) => ({
          id: entry.id,
          actorName: entry.actor_name || '',
          kind: entry.kind,
          detail: entry.detail || {},
          at: entry.created_at,
        })),
      })
    }),
  )

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
    const visible = (r.data || []).filter(
      (row: any) => !row.archived_at && (!row.private || row.created_by === user.id),
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

  return { onWorkspaceSaved, trackersFor }
}

const emptyOf = (column: TrackerColumn): Cell =>
  column.type === 'number' ? null : column.type === 'checkbox' ? false : column.type === 'multiselect' ? [] : ''
