import type { Mentionable, RowComment } from './trackerComments'
import { requestJson, type HttpMethod } from '../../shared/http'
import type { TimelineSettings } from './timelineModel'
import type { SavedTemplate } from './trackerTemplates'
import type { Cell, SyncReport, Tracker, TrackerColumn, TrackerRow, TrackerSource, TrackerView } from './trackerModel'

/** An error from the trackers API. A 409 carries the current copy of whatever was edited, so the screen can reload it. */
export class TrackerApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: {
      tracker?: Tracker
      row?: TrackerRow
      needsGoogle?: boolean
      noAccess?: boolean
      /** The Google account behind the Sheet may not edit Sheets (two-way, done marks). */
      needsWrite?: boolean
      needsExcel?: boolean
      /** Two-way: cells changed in the Sheet since the last sync. */
      conflicts?: import('./trackerTwoWay').Conflict[]
    } = {},
  ) {
    super(message)
  }
}

const call = <T>(method: string, path: string, body?: unknown, signal?: AbortSignal) =>
  requestJson<T>(`/api/trackers${path}`, {
    method: method as HttpMethod,
    body,
    signal,
    noStore: true,
    bare: true,
    offline: 'The connection was interrupted. Check your connection and try again.',
    statusFallback: {
      403: 'You do not have access to Trackers.',
      404: 'That was not found. It may have been deleted.',
    },
    fallback: 'Trackers are unavailable right now. Try again in a moment.',
    error: (message, status, data) => new TrackerApiError(message, status, errorBody(data)),
  })

/**
 * The parts of a Trackers error the screens act on. Every field the server sends for the screen to react to must be
 * copied here, or the screen never sees it.
 */
export function errorBody(data: any): TrackerApiError['body'] {
  return {
    tracker: data?.tracker,
    row: data?.row,
    needsGoogle: Boolean(data?.needsGoogle),
    noAccess: Boolean(data?.noAccess),
    needsWrite: Boolean(data?.needsWrite),
    ...(Array.isArray(data?.conflicts) ? { conflicts: data.conflicts } : {}),
  }
}

/** What changing a column's type would do (applied: false), or what it did (applied: true). */
export type ConvertReport =
  | { applied: false; rows: number; filled: number; failed: number; samples: { row: number; value: string }[] }
  | { applied: true; tracker: Tracker; failed: number }
export type SheetFile = {
  id: string
  name: string
  modifiedTime: string
  owner: string
  shared: boolean
  sharedDrive: boolean
  /** An Excel file kept in Drive: followed one-way, read only. */
  excel?: boolean
}
export type SyncResult = {
  source: TrackerSource
  report: SyncReport | null
  skipped?: boolean
  /** Tasks the sync completed or reopened because their boxes were ticked or unticked in the Sheet. */
  tasks?: number
}
/** A task or subtask linked to a tracker row, or to one cell of it (columnId is empty for the whole row). */
export type TaskLink = {
  id: string
  trackerId: string
  trackerName: string
  rowId: string
  rowTitle: string
  columnId: string
  columnName: string
  taskId: string
  createdByName: string
  createdAt: string
}
export type TrackerChange = { id: string; actorName: string; kind: string; detail: any; at: string }
export type NewRow = { cells?: Record<string, Cell>; secrets?: Record<string, string | null>; taskId?: string }
export type RowPatch = {
  version: number
  cells?: Record<string, Cell>
  secrets?: Record<string, string | null>
  taskId?: string | null
  /** Two-way: write the edit to the Sheet even though the cell changed there since the last sync. */
  overwrite?: boolean
}

export const trackerApi = {
  list: (signal?: AbortSignal) => call<{ trackers: Tracker[] }>('GET', '', undefined, signal),
  create: (body: {
    name: string
    columns: unknown[]
    template?: string
    clientId?: string
    clientIds?: string[]
    projectId?: string
    projectIds?: string[]
    private?: boolean
    stepTasks?: boolean
  }) => call<{ tracker: Tracker }>('POST', '', body),
  get: (id: string, signal?: AbortSignal) => call<{ tracker: Tracker }>('GET', `/${id}`, undefined, signal),
  update: (
    id: string,
    body: {
      name?: string
      clientId?: string
      clientIds?: string[]
      projectId?: string
      /** Several projects, the default first. */
      projectIds?: string[]
      private?: boolean
      archived?: boolean
      stepTasks?: boolean
      /** New Seeds projects of its clients become rows (see seedsRows). */
      seedsRows?: boolean
      /** People added by hand (account ids); the creator or an Administrator only. */
      members?: string[]
    },
  ) => call<{ tracker: Tracker }>('PATCH', `/${id}`, body),
  remove: (id: string) => call<{ ok: true }>('DELETE', `/${id}`),
  saveColumns: (id: string, columns: TrackerColumn[], revision: number) =>
    call<{ tracker: Tracker }>('PUT', `/${id}/columns`, { columns, revision }),
  saveViews: (id: string, views: TrackerView[], revision: number) =>
    call<{ tracker: Tracker }>('PUT', `/${id}/views`, { views, revision }),
  /** Gives rows a highlight colour, or clears it with ''. */
  highlightRows: (id: string, ids: string[], color: string) =>
    call<{ ids: string[]; color: string }>('PUT', `/${id}/rows/highlight`, { ids, color }),
  saveTimeline: (id: string, timeline: TimelineSettings) =>
    call<{ timeline: TimelineSettings }>('PUT', `/${id}/timeline`, { timeline }),
  rows: (id: string, offset: number, limit: number, signal?: AbortSignal) =>
    call<{ rows: TrackerRow[]; total: number; offset: number }>(
      'GET',
      `/${id}/rows?offset=${offset}&limit=${limit}`,
      undefined,
      signal,
    ),
  addRows: (id: string, rows: NewRow[]) =>
    call<{ rows: TrackerRow[]; warning?: string }>('POST', `/${id}/rows`, { rows }),
  updateRow: (id: string, rowId: string, patch: RowPatch) =>
    call<{ row: TrackerRow }>('PATCH', `/${id}/rows/${rowId}`, patch),
  linkRowTasks: (id: string, links: { rowId: string; taskId: string }[]) =>
    call<{ rows: TrackerRow[] }>('POST', `/${id}/rows/tasks`, { links }),
  deleteRows: (id: string, ids: string[]) => call<{ deleted: number }>('POST', `/${id}/rows/delete`, { ids }),
  reveal: (id: string, rowId: string, columnId: string) =>
    call<{ value: string; seconds: number }>('POST', `/${id}/rows/${rowId}/reveal`, { columnId }),
  convertColumn: (
    id: string,
    columnId: string,
    body: { type: string; revision: number; confirm: boolean; clearUnfit?: boolean },
  ) => call<ConvertReport>('POST', `/${id}/columns/${columnId}/convert`, body),
  moveRows: (id: string, ids: string[], before: string | 'start' | null) =>
    call<{ moved: number; positions: Record<string, number> }>('POST', `/${id}/rows/move`, { ids, before }),
  links: (id: string, signal?: AbortSignal) => call<{ links: TaskLink[] }>('GET', `/${id}/links`, undefined, signal),
  addLink: (id: string, body: { rowId: string; taskId: string; columnId?: string }) =>
    call<{ link: TaskLink; links: TaskLink[] }>('POST', `/${id}/links`, body),
  removeLink: (id: string, linkId: string) => call<{ removed: number }>('DELETE', `/${id}/links/${linkId}`),
  /** Every link in every tracker this person can see, for the Action Center. */
  allLinks: (signal?: AbortSignal) => call<{ links: TaskLink[] }>('GET', '/task-links', undefined, signal),
  // Connected Google Sheets
  sheetsStatus: () =>
    call<{ available: boolean; connected: boolean; canWrite?: boolean; canReadExcel?: boolean; email: string }>(
      'GET',
      '/sheets/status',
    ),
  sheetFiles: (q: string) => call<{ files: SheetFile[] }>('GET', `/sheets/files?q=${encodeURIComponent(q)}`),
  sheetTabs: (sheet: string) =>
    call<{ id: string; name: string; excel?: boolean; tabs: { title: string; rows: number; columns: number }[] }>(
      'GET',
      `/sheets/${encodeURIComponent(sheet)}/tabs`,
    ),
  sheetValues: (sheet: string, tab: string) =>
    call<{ grid: string[][]; truncated: boolean }>(
      'GET',
      `/sheets/${encodeURIComponent(sheet)}/values?tab=${encodeURIComponent(tab)}`,
    ),
  connectSource: (
    id: string,
    body: {
      spreadsheetId: string
      spreadsheetName: string
      tab: string
      keyHeader: string
      headerMap: Record<string, string>
    },
  ) => call<SyncResult & { tracker: Tracker; adopted?: number }>('POST', `/${id}/source`, body),
  /** Makes a new Google Sheet from the tracker and connects it two-way. */
  createSheet: (id: string, title: string) =>
    call<
      SyncResult & {
        tracker: Tracker
        url: string
        rows: number
        emptyRows: number
        gantt: boolean
        /** The account Drive's folders it was made in; empty when it went to the person's own Drive. */
        folder?: string[]
      }
    >('POST', `/${id}/source/create`, { title }),
  /** Adds a Gantt chart tab to the connected Sheet, or draws it again. */
  addGantt: (id: string) => call<{ url: string; replaced: boolean }>('POST', `/${id}/source/gantt`, {}),
  syncSource: (id: string, force: boolean) => call<SyncResult>('POST', `/${id}/source/sync`, { force }),
  reconnectSource: (id: string) => call<SyncResult>('POST', `/${id}/source/reconnect`, {}),
  setSourceMode: (id: string, mode: 'one_way' | 'two_way') =>
    call<{ source: TrackerSource }>('POST', `/${id}/source/mode`, { mode }),
  disconnectSource: (id: string) => call<{ tracker: Tracker }>('DELETE', `/${id}/source`),
  reviewed: (id: string, ids: string[]) => call<{ reviewed: number }>('POST', `/${id}/rows/review`, { ids }),
  bulkLinks: (id: string, links: { rowId: string; columnId: string; taskId: string }[]) =>
    call<{ links: TaskLink[] }>('POST', `/${id}/links/bulk`, { links }),
  history: (id: string, rowId: string, signal?: AbortSignal) =>
    call<{ changes: TrackerChange[] }>('GET', `/${id}/rows/${rowId}/history`, undefined, signal),
  /** Rows whose done mark did not reach the Sheet. No ids means every such row. */
  comments: (id: string, rowId: string, signal?: AbortSignal) =>
    call<{ comments: RowComment[]; mentionable: Mentionable[] }>(
      'GET',
      `/${id}/rows/${rowId}/comments`,
      undefined,
      signal,
    ),
  addComment: (id: string, rowId: string, body: { text: string; mentions: string[] }) =>
    call<{ comment: RowComment }>('POST', `/${id}/rows/${rowId}/comments`, body),
  editComment: (id: string, commentId: string, body: { text: string; mentions: string[] }) =>
    call<{ comment: RowComment }>('PATCH', `/${id}/comments/${commentId}`, body),
  deleteComment: (id: string, commentId: string) => call<{ deleted: true }>('DELETE', `/${id}/comments/${commentId}`),
  commentCounts: (id: string, signal?: AbortSignal) =>
    call<{ counts: Record<string, number> }>('GET', `/${id}/comment-counts`, undefined, signal),
  retrySheetIssues: (id: string, ids: string[] = []) =>
    call<{ written: number; failed: number }>('POST', `/${id}/sheet-issues/retry`, { ids }),
  dismissSheetIssues: (id: string, ids: string[] = []) =>
    call<{ dismissed: number }>('POST', `/${id}/sheet-issues/dismiss`, { ids }),
}

/** Loads every row, one page at a time. */
export async function loadAllRows(id: string, signal?: AbortSignal): Promise<TrackerRow[]> {
  const rows: TrackerRow[] = []
  const page = 1000
  for (;;) {
    const result = await trackerApi.rows(id, rows.length, page, signal)
    rows.push(...result.rows)
    if (!result.rows.length || rows.length >= result.total) return rows
  }
}

// --- Templates the account keeps (see server/trackers/tracker-templates.ts) ---

export type TemplateBody = {
  name?: string
  about?: string
  columns?: unknown[]
  shared?: boolean
  hidden?: boolean
  /** The built-in template this account copy replaces. */
  templateKey?: string
  stepTasks?: boolean
  revision?: number
}
const templateCall = <T>(method: string, path: string, body?: unknown, signal?: AbortSignal) =>
  requestJson<T>(`/api/tracker-templates${path}`, {
    method: method as HttpMethod,
    body,
    signal,
    noStore: true,
    bare: true,
    offline: 'The connection was interrupted. Check your connection and try again.',
    statusFallback: { 403: 'You do not have access to Trackers.', 404: 'That template was not found.' },
    fallback: 'Tracker templates are unavailable right now. Try again in a moment.',
    error: (message, status, data) => new TemplateApiError(message, status, (data || {}) as TemplateApiError['body']),
  })
export class TemplateApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: { needsUpgrade?: boolean; template?: SavedTemplate } = {},
  ) {
    super(message)
  }
}
export const templateApi = {
  list: (signal?: AbortSignal) => templateCall<{ templates: SavedTemplate[] }>('GET', '', undefined, signal),
  create: (body: TemplateBody) => templateCall<{ template: SavedTemplate }>('POST', '', body),
  update: (id: string, body: TemplateBody) => templateCall<{ template: SavedTemplate }>('PATCH', `/${id}`, body),
  remove: (id: string) => templateCall<{ deleted: true }>('DELETE', `/${id}`),
}
