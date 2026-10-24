import type { Cell, Tracker, TrackerColumn, TrackerRow, TrackerView } from './trackerModel'

/** An error from the trackers API. A 409 carries the current copy of whatever was edited, so the screen can reload it. */
export class TrackerApiError extends Error {
  constructor(message: string, public status: number, public body: { tracker?: Tracker; row?: TrackerRow } = {}) { super(message) }
}

async function call<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response
  try {
    response = await fetch(`/api/trackers${path}`, {
      method, signal, credentials: 'same-origin', cache: 'no-store',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw error
    throw new TrackerApiError('The connection was interrupted. Check your connection and try again.', 0)
  }
  const text = await response.text()
  let data: any = {}
  try { data = text ? JSON.parse(text) : {} } catch { /* A proxy can answer with HTML. */ }
  if (!response.ok) {
    const fallback = response.status === 403 ? 'You do not have access to Trackers.' : response.status === 404 ? 'That was not found. It may have been deleted.' : 'Trackers are unavailable right now. Try again in a moment.'
    throw new TrackerApiError(typeof data?.error === 'string' && data.error ? data.error : fallback, response.status, { tracker: data?.tracker, row: data?.row })
  }
  return data as T
}

/** What changing a column's type would do (applied: false), or what it did (applied: true). */
export type ConvertReport = { applied: false; rows: number; filled: number; failed: number; samples: { row: number; value: string }[] } | { applied: true; tracker: Tracker; failed: number }
/** A task or subtask linked to a tracker row, or to one cell of it (columnId is empty for the whole row). */
export type TaskLink = { id: string; trackerId: string; trackerName: string; rowId: string; rowTitle: string; columnId: string; columnName: string; taskId: string; createdByName: string; createdAt: string }
export type TrackerChange = { id: string; actorName: string; kind: string; detail: any; at: string }
export type NewRow = { cells?: Record<string, Cell>; secrets?: Record<string, string | null>; taskId?: string }
export type RowPatch = { version: number; cells?: Record<string, Cell>; secrets?: Record<string, string | null>; taskId?: string | null }

export const trackerApi = {
  list: (signal?: AbortSignal) => call<{ trackers: Tracker[] }>('GET', '', undefined, signal),
  create: (body: { name: string; columns: unknown[]; template?: string; clientId?: string; clientIds?: string[]; projectId?: string; private?: boolean }) => call<{ tracker: Tracker }>('POST', '', body),
  get: (id: string, signal?: AbortSignal) => call<{ tracker: Tracker }>('GET', `/${id}`, undefined, signal),
  update: (id: string, body: { name?: string; clientId?: string; clientIds?: string[]; projectId?: string; private?: boolean; archived?: boolean }) => call<{ tracker: Tracker }>('PATCH', `/${id}`, body),
  remove: (id: string) => call<{ ok: true }>('DELETE', `/${id}`),
  saveColumns: (id: string, columns: TrackerColumn[], revision: number) => call<{ tracker: Tracker }>('PUT', `/${id}/columns`, { columns, revision }),
  saveViews: (id: string, views: TrackerView[], revision: number) => call<{ tracker: Tracker }>('PUT', `/${id}/views`, { views, revision }),
  rows: (id: string, offset: number, limit: number, signal?: AbortSignal) => call<{ rows: TrackerRow[]; total: number; offset: number }>('GET', `/${id}/rows?offset=${offset}&limit=${limit}`, undefined, signal),
  addRows: (id: string, rows: NewRow[]) => call<{ rows: TrackerRow[] }>('POST', `/${id}/rows`, { rows }),
  updateRow: (id: string, rowId: string, patch: RowPatch) => call<{ row: TrackerRow }>('PATCH', `/${id}/rows/${rowId}`, patch),
  linkRowTasks: (id: string, links: { rowId: string; taskId: string }[]) => call<{ rows: TrackerRow[] }>('POST', `/${id}/rows/tasks`, { links }),
  deleteRows: (id: string, ids: string[]) => call<{ deleted: number }>('POST', `/${id}/rows/delete`, { ids }),
  reveal: (id: string, rowId: string, columnId: string) => call<{ value: string; seconds: number }>('POST', `/${id}/rows/${rowId}/reveal`, { columnId }),
  convertColumn: (id: string, columnId: string, body: { type: string; revision: number; confirm: boolean; clearUnfit?: boolean }) => call<ConvertReport>('POST', `/${id}/columns/${columnId}/convert`, body),
  moveRows: (id: string, ids: string[], before: string | 'start' | null) => call<{ moved: number; positions: Record<string, number> }>('POST', `/${id}/rows/move`, { ids, before }),
  links: (id: string, signal?: AbortSignal) => call<{ links: TaskLink[] }>('GET', `/${id}/links`, undefined, signal),
  addLink: (id: string, body: { rowId: string; taskId: string; columnId?: string }) => call<{ link: TaskLink; links: TaskLink[] }>('POST', `/${id}/links`, body),
  removeLink: (id: string, linkId: string) => call<{ removed: number }>('DELETE', `/${id}/links/${linkId}`),
  /** Every link in every tracker this person can see, for the Action Center. */
  allLinks: (signal?: AbortSignal) => call<{ links: TaskLink[] }>('GET', '/task-links', undefined, signal),
  history: (id: string, rowId: string, signal?: AbortSignal) => call<{ changes: TrackerChange[] }>('GET', `/${id}/rows/${rowId}/history`, undefined, signal),
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
