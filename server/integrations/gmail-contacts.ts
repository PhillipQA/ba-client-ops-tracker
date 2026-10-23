import { isValidEmail, splitMailboxes } from '../../src/emailCompose'
import { cleanName, isAutomaticAddress, matchPeople, type RankedPerson } from '../../src/emailSuggest'

/**
 * The people a person has written to or heard from, for type-ahead in the email composer.
 * Built from the mailbox they already connected (their Gmail Sent folder and the emails saved in Work Hub), so it needs
 * no extra Google permission. It is private to that person, kept only in server memory, and rebuilt when it gets old.
 */
type Contact = RankedPerson & { count: number; last: number; sent: number }
type Book = { mailbox: string; at: number; people: Map<string, Contact>; scan?: Promise<void>; sentFailedAt?: number }

export type ContactBookDeps = {
  db: any
  google: (url: string, init: RequestInit, timeout?: number) => Promise<any>
  now?: () => number
}

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me'
const TTL_MS = 10 * 60_000
const RETRY_MS = 2 * 60_000
const WAIT_MS = 4000
const SENT_MESSAGES = 120
const RECEIVED_ROWS = 500
const MAX_PEOPLE = 3000
const MAX_BOOKS = 500
const WORKERS = 6
const SCAN_BUDGET_MS = 25_000

export function createContactBook(deps: ContactBookDeps) {
  const clock = () => (deps.now ? deps.now() : Date.now())
  const books = new Map<string, Book>()
  const keyOf = (tenantId: string, userId: string) => `${tenantId}:${userId}`

  function add(book: Book, mailbox: string, raw: { name: string; email: string }, when: number, kind: 'sent' | 'received') {
    const email = raw.email.trim()
    const key = email.toLowerCase()
    if (!isValidEmail(email) || key === mailbox || isAutomaticAddress(email)) return
    let person = book.people.get(key)
    if (!person) {
      if (book.people.size >= MAX_PEOPLE) return
      person = { email, name: '', count: 0, last: 0, sent: 0 }
      book.people.set(key, person)
    }
    const name = cleanName(raw.name, email)
    if (name && (!person.name || when >= person.last)) person.name = name
    if (kind === 'sent') { person.count++; person.sent++ }
    person.last = Math.max(person.last, when)
  }

  async function receivedSenders(book: Book, tenantId: string, userId: string) {
    const { data, error } = await deps.db.from('user_communications').select('sender,received_at,source_labels')
      .eq('tenant_id', tenantId).eq('owner_user_id', userId).eq('source', 'Gmail').order('received_at', { ascending: false }).limit(RECEIVED_ROWS)
    if (error) return
    for (const row of data || []) {
      // A saved copy of an email the person sent has their own address as the sender.
      if (Array.isArray(row.source_labels) && row.source_labels.includes('SENT')) continue
      const when = Date.parse(String(row.received_at || '')) || 0
      for (const entry of splitMailboxes(String(row.sender || '')).slice(0, 1)) add(book, book.mailbox, entry, when, 'received')
    }
  }

  async function sentRecipients(book: Book, token: string) {
    const headers = { Authorization: `Bearer ${token}` }
    const started = clock()
    const list = await deps.google(`${GMAIL}/messages?${new URLSearchParams({ labelIds: 'SENT', maxResults: String(SENT_MESSAGES) })}`, { headers })
    const ids: string[] = (list.messages || []).map((message: any) => String(message.id)).filter(Boolean)
    let next = 0
    const worker = async () => {
      while (next < ids.length && clock() - started < SCAN_BUDGET_MS) {
        const id = ids[next++]
        let detail: any
        try {
          detail = await deps.google(`${GMAIL}/messages/${encodeURIComponent(id)}?${new URLSearchParams([['format', 'metadata'], ['metadataHeaders', 'To'], ['metadataHeaders', 'Cc'], ['metadataHeaders', 'Bcc']])}`, { headers })
        } catch { continue }
        const when = Number(detail?.internalDate) || 0
        for (const header of detail?.payload?.headers || []) {
          if (!['to', 'cc', 'bcc'].includes(String(header.name).toLowerCase())) continue
          for (const entry of splitMailboxes(String(header.value || ''))) add(book, book.mailbox, entry, when, 'sent')
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(WORKERS, ids.length) }, worker))
  }

  /** The book for this person, rebuilt when it is old, a different mailbox was connected, or a build is still running. */
  function ensure(tenantId: string, userId: string, mailbox: string, token: () => Promise<string>) {
    const key = keyOf(tenantId, userId), now = clock()
    let book = books.get(key)
    if (book && book.mailbox !== mailbox) { books.delete(key); book = undefined }
    const stale = !book || now - book.at > (book.sentFailedAt ? RETRY_MS : TTL_MS)
    if (!book) {
      if (books.size >= MAX_BOOKS) { const oldest = [...books.entries()].sort((a, b) => a[1].at - b[1].at)[0]; if (oldest) books.delete(oldest[0]) }
      book = { mailbox, at: now, people: new Map() }
      books.set(key, book)
    }
    if (stale && !book.scan) {
      const target = book
      target.at = now
      target.scan = (async () => {
        // Rebuild into a fresh table so a failed rebuild never empties what was already known.
        const fresh: Book = { mailbox, at: now, people: new Map() }
        let sentFailed = false
        try { await receivedSenders(fresh, tenantId, userId) } catch { /* Work Hub copies are optional. */ }
        try { await sentRecipients(fresh, await token()) } catch { sentFailed = true }
        if (sentFailed && target.people.size) for (const [email, person] of target.people) if (!fresh.people.has(email)) fresh.people.set(email, person)
        target.people = fresh.people
        target.sentFailedAt = sentFailed ? clock() : undefined
        target.at = clock()
      })().finally(() => { target.scan = undefined })
    }
    return book
  }

  return {
    /** People matching what was typed. Waits a few seconds for a first build, then answers with what is known so far. */
    async search(user: { organizationId: string; id: string }, mailbox: string, token: () => Promise<string>, query: string, limit = 8) {
      const book = ensure(user.organizationId, user.id, mailbox.toLowerCase(), token)
      if (book.scan && !book.people.size) {
        let timer: ReturnType<typeof setTimeout> | undefined
        await Promise.race([book.scan.then(() => true, () => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), WAIT_MS) })])
        if (timer) clearTimeout(timer)
      }
      const people = matchPeople([...book.people.values()], query, { limit }).map(person => ({
        email: person.email, name: person.name,
        hint: person.sent ? (person.sent === 1 ? 'Emailed once' : `Emailed ${person.sent} times`) : 'Wrote to you',
      }))
      // Still building for the first time: the person can ask again in a moment.
      return { people, partial: Boolean(book.scan && !book.people.size) }
    },
    /** Add the people an email just went to, so they show up without waiting for the next rebuild. */
    remember(user: { organizationId: string; id: string }, mailbox: string, addresses: string[]) {
      const book = books.get(keyOf(user.organizationId, user.id))
      if (!book || book.mailbox !== mailbox.toLowerCase()) return
      const when = clock()
      for (const address of addresses) add(book, book.mailbox, { name: '', email: address }, when, 'sent')
    },
    forget(user: { organizationId: string; id: string }) { books.delete(keyOf(user.organizationId, user.id)) },
    size: () => books.size,
  }
}
