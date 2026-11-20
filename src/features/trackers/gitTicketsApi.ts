/** GIT Tracker part 3 in the browser: add a Work Hub ticket to a GIT Tracker, retry it, list and remove tickets. */
import { type HttpMethod, requestJson } from '../../shared/http'
import type { GitTicketEntry } from './gitTicketModel'

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
}

/** How an entry's status reads. */
export function entryStatusText(entry: Pick<GitTicketEntry, 'status' | 'workCount'>) {
  if (entry.status === 'Completed')
    return entry.workCount ? `Added · ${entry.workCount} Task${entry.workCount === 1 ? '' : 's'}` : 'Added'
  if (entry.status === 'Failed') return 'Failed'
  return 'Adding…'
}
