/** What the list widgets show, kept apart from the components so it can be tested on its own. */
import type { DocHubDocument } from '../documents/dochub'

export type Email = {
  id: string
  source: string
  subject: string
  sender: string
  received_at: string
  read_at?: string | null
  client_id?: string | null
}

/** Unread first, then newest. */
export function emailsToShow(items: Email[], count = 6) {
  return [...items]
    .sort(
      (a, b) =>
        Number(b.read_at === null) - Number(a.read_at === null) ||
        new Date(b.received_at).getTime() - new Date(a.received_at).getTime(),
    )
    .slice(0, count)
}

const AWAITING = ['SENT', 'VIEWED', 'PARTIALLY_SIGNED']

/** Documents out for signature, the oldest first: those have waited longest. */
export function awaitingSignature(documents: DocHubDocument[]) {
  return documents
    .filter(doc => AWAITING.includes(String(doc.status || '').toUpperCase()))
    .sort((a, b) => new Date(a.updatedAt || a.createdAt).getTime() - new Date(b.updatedAt || b.createdAt).getTime())
}
