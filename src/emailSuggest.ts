import { isValidEmail } from './emailCompose'

/**
 * Type-ahead for the To, Cc and Bcc lines. Pure helpers, shared by the browser and the server
 * so both rank and match people the same way.
 */
export type Person = { email: string; name: string }
/** A person plus what is known about how often they were emailed. */
export type RankedPerson = Person & { count?: number; last?: number; hint?: string }

/** Addresses nobody writes to: automatic senders. They are never suggested. */
const AUTOMATIC = /^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer-daemon|postmaster|bounces?(?:[-+_.].*)?)@/i
export const isAutomaticAddress = (email: string) => AUTOMATIC.test(email.trim())

/** A display name that is safe to show and store: one line, no brackets or quotes, not just the address again. */
export function cleanName(name: unknown, email: string): string {
  const text = String(name ?? '').replace(/[\u0000-\u001f\u007f<>"]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)
  return text.toLowerCase() === email.toLowerCase() ? '' : text
}

/** Where the cursor is in a list like "ana@acme.com, ki|": the piece being typed, and where it starts and ends. */
export function currentToken(value: string, caret: number): { start: number; end: number; text: string } {
  const at = Math.max(0, Math.min(caret, value.length))
  const before = value.slice(0, at), after = value.slice(at)
  const start = Math.max(before.lastIndexOf(','), before.lastIndexOf(';'), before.lastIndexOf('\n')) + 1
  const stop = after.search(/[,;\n]/)
  const end = stop === -1 ? value.length : at + stop
  return { start, end, text: value.slice(start, end).trim() }
}

/** Put a chosen address where the piece was being typed, followed by ", " so the next person can be typed straight away. */
export function applySuggestion(value: string, token: { start: number; end: number }, email: string): { value: string; caret: number } {
  const before = value.slice(0, token.start).replace(/\s+$/, ''), after = value.slice(token.end).replace(/^\s*[,;]?\s*/, '')
  const lead = before ? `${before.replace(/[,;]$/, '')}, ` : ''
  const next = `${lead}${email}, ${after}`
  return { value: next, caret: lead.length + email.length + 2 }
}

/** What matches the typed text: every word typed must appear in the name or address, with matches at the start of a word first. With keepOrder the list is only filtered, so a ranking made elsewhere (the server's) is kept. */
export function matchPeople<T extends RankedPerson>(people: T[], query: string, options: { exclude?: Iterable<string>; limit?: number; keepOrder?: boolean } = {}): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const skip = new Set(Array.from(options.exclude || [], address => address.toLowerCase()))
  const startsWord = (haystack: string, word: string) => haystack.startsWith(word) || haystack.includes(` ${word}`) || haystack.includes(`.${word}`) || haystack.includes(`-${word}`) || haystack.includes(`_${word}`) || haystack.includes(`@${word}`)
  const seen = new Set<string>()
  const scored: { person: T; rank: number }[] = []
  for (const person of people) {
    const key = person.email.toLowerCase()
    if (skip.has(key) || seen.has(key) || !isValidEmail(person.email)) continue
    const haystack = `${person.name} ${person.email}`.toLowerCase()
    if (!words.every(word => haystack.includes(word))) continue
    seen.add(key)
    scored.push({ person, rank: words.every(word => startsWord(haystack, word)) ? 0 : 1 })
  }
  if (options.keepOrder) return scored.slice(0, options.limit ?? 8).map(entry => entry.person)
  scored.sort((a, b) => a.rank - b.rank || (b.person.count || 0) - (a.person.count || 0) || (b.person.last || 0) - (a.person.last || 0) || a.person.email.localeCompare(b.person.email))
  return scored.slice(0, options.limit ?? 8).map(entry => entry.person)
}
