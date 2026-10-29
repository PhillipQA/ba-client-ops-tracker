import { HttpError, requestJson, type HttpMethod } from '../../../shared/http'
import type { ReportDefinition, ReportItem } from './reportModel'

const call = <T>(method: HttpMethod, path: string, body?: unknown, signal?: AbortSignal) =>
  requestJson<T>(`/api/reports/custom${path}`, {
    method,
    body,
    signal,
    noStore: true,
    bare: true,
    offline: 'The connection was interrupted. Check your connection and try again.',
    statusFallback: {
      403: 'You do not have access to Reports.',
      404: 'That report was not found. It may have been deleted.',
    },
    fallback: 'Custom reports are unavailable right now. Try again in a moment.',
  })

export type ReportPatch = {
  name?: string
  description?: string
  folderId?: string
  shared?: boolean
  hidden?: boolean
  position?: number
  definition?: ReportDefinition
  revision?: number
}

export const reportApi = {
  list: (signal?: AbortSignal) => call<{ items: ReportItem[] }>('GET', '', undefined, signal),
  create: (body: {
    kind: 'report' | 'folder' | 'template'
    name: string
    description?: string
    folderId?: string
    shared?: boolean
    hidden?: boolean
    /** Templates: the suggested template this account copy replaces. */
    templateKey?: string
    position?: number
    definition?: ReportDefinition
  }) => call<{ item: ReportItem }>('POST', '', body),
  update: (id: string, patch: ReportPatch) => call<{ item: ReportItem }>('PATCH', `/${id}`, patch),
  remove: (id: string) => call<{ deleted: true }>('DELETE', `/${id}`),
}

/** Whether an error means the database upgrade for custom reports is missing. */
export const needsUpgrade = (error: unknown) => error instanceof HttpError && Boolean(error.body?.needsUpgrade)
/** A save refused because someone else saved first; the error carries their copy. */
export const conflictItem = (error: unknown): ReportItem | null =>
  error instanceof HttpError && error.status === 409 && error.body?.item ? (error.body.item as ReportItem) : null
