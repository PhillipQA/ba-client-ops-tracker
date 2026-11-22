/** GIT Tracker part 3 in the browser: add a Work Hub ticket to a GIT Tracker, retry it, list and remove tickets. */
import { type HttpMethod, requestJson } from '../../shared/http'
import type { GitTicketEntry } from './gitTicketModel'

/** What a refresh changed: ticket rows brought up to date with their tickets. */
export type GitRefreshResult = { tickets: number; rows: number; cells: number; trackers: number; needsUpgrade?: boolean }

export type GitTicketOptions = {
  /** GIT Trackers the ticket can be added to. */
  trackers: { id: string; name: string }[]
  /** The GIT Trackers it is in already. */
  entries: GitTicketEntry[]
  /** Where its work goes: the repository's mapping, or null when it is not mapped yet. */
  mapping: { clientId: string; projectId: string } | null
  repository: string
  canAdd: boolean
}

const call = <T>(url: string, method: HttpMethod = 'GET', body?: unknown) =>
  requestJson<T>(url, {
    method,
    body,
    noStore: true,
    bare: true,
    offline: 'The connection was interrupted. Check your connection and try again.',
    statusFallback: { 403: 'You do not have access to Trackers.' },
    fallback: 'GIT Trackers are unavailable right now. Try again in a moment.',
  })

export const gitTicketsApi = {
  options: (provider: 'gitlab' | 'github', ticketId: string) =>
    call<GitTicketOptions>(`/api/tracker-git/tickets/${provider}/${encodeURIComponent(ticketId)}`),
  add: (trackerId: string, provider: 'gitlab' | 'github', ticketId: string) =>
    call<{ entry: GitTicketEntry }>(`/api/trackers/${trackerId}/git-tickets`, 'POST', { provider, ticketId }),
  retry: (trackerId: string, entryId: string) =>
    call<{ entry: GitTicketEntry }>(`/api/trackers/${trackerId}/git-tickets/${entryId}/retry`, 'POST', {}),
  list: (trackerId: string) => call<{ entries: GitTicketEntry[] }>(`/api/trackers/${trackerId}/git-tickets`),
  remove: (trackerId: string, entryId: string) =>
    call<{ removed: boolean; rows: number }>(`/api/trackers/${trackerId}/git-tickets/${entryId}`, 'DELETE'),
  /** Refresh in a GIT Tracker: its ticket rows only. */
  refresh: (trackerId: string) =>
    call<GitRefreshResult>(`/api/trackers/${trackerId}/git-tickets/refresh`, 'POST', {}),
  /** Every GIT Tracker of the workspace (after sign-in, or a Work Hub sync of one provider). */
  refreshAll: (provider?: 'gitlab' | 'github') =>
    call<GitRefreshResult>('/api/tracker-git/refresh', 'POST', provider ? { provider } : {}),
  follow: (trackerId: string, entryId: string, change: { follows?: boolean; unpin?: string[] | 'all' }) =>
    call<{ entry: GitTicketEntry; refreshed: GitRefreshResult | null }>(
      `/api/trackers/${trackerId}/git-tickets/${entryId}`,
      'PATCH',
      change,
    ),
}

/** What a refresh did, in one line ('' when nothing changed). */
export function refreshText(result: GitRefreshResult) {
  if (result.needsUpgrade)
    return 'Rows can’t follow their tickets until the database is updated (schema v45). Ask your administrator.'
  if (!result.rows) return ''
  return `Updated ${result.cells} cell${result.cells === 1 ? '' : 's'} in ${result.rows} row${result.rows === 1 ? '' : 's'} from GitLab and GitHub.`
}

/** How an entry's status reads. */
export function entryStatusText(entry: Pick<GitTicketEntry, 'status' | 'workCount'>) {
  if (entry.status === 'Completed')
    return entry.workCount ? `Added · ${entry.workCount} Task${entry.workCount === 1 ? '' : 's'}` : 'Added'
  if (entry.status === 'Failed') return 'Failed'
  return 'Adding…'
}
