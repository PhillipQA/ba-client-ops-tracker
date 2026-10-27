import { isValidEmail } from './emailCompose'

/**
 * @mentions in an email message, like Outlook: typing "@Rob" suggests people, choosing one writes "@Robertson" in the
 * message and adds them to To. The sent email links each mention to the person's address. Pure helpers, shared by the
 * browser and the server.
 */
export type Mention = { name: string; email: string }

export const MENTION_LIMITS = { mentions: 50, name: 80, typed: 40 } as const

/**
 * The "@…" being typed at the cursor, if any: an @ at the start or after a space, bracket or line break, followed by
 * up to 40 characters on the same line (spaces allowed, so "@Ana Re" still searches). Returns where it starts.
 */
export function mentionToken(value: string, caret: number): { start: number; end: number; text: string } | null {
  const at = Math.max(0, Math.min(caret, value.length))
  const before = value.slice(0, at)
  const sign = before.lastIndexOf('@')
  if (sign < 0) return null
  const typed = before.slice(sign + 1)
  if (typed.length > MENTION_LIMITS.typed || /[\n@]/.test(typed) || /\s\s/.test(typed) || /^\s/.test(typed)) return null
  if (sign > 0 && !/[\s([{"']/.test(before[sign - 1])) return null
  return { start: sign, end: at, text: typed.trim() }
}

/** A display name that is safe to put after the @: one line, no @ or brackets. Falls back to the address's name part. */
export function mentionName(name: string, email: string) {
  const clean = String(name || '')
    .replace(/[\u0000-\u001f\u007f@<>[\]"]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MENTION_LIMITS.name)
  return clean || email.split('@')[0]
}

/** Writes "@Name " where the mention was being typed. */
export function applyMention(value: string, token: { start: number; end: number }, name: string) {
  const after = value.slice(token.end).replace(/^ /, '')
  // No space before punctuation that already follows: "@Robertson, please".
  const text = /^[,.;:!?)\]]/.test(after) ? `@${name}` : `@${name} `
  return { value: value.slice(0, token.start) + text + after, caret: token.start + text.length }
}

/** Mentions still in the message, once each, valid ones only. A mention deleted from the text no longer counts. */
export function activeMentions(text: string, mentions: Mention[]): Mention[] {
  const seen = new Set<string>()
  return mentions.filter(mention => {
    const name = mentionName(mention.name, mention.email)
    const key = `${name.toLowerCase()}|${mention.email.toLowerCase()}`
    if (seen.has(key) || !isValidEmail(mention.email) || !text.includes(`@${name}`)) return false
    seen.add(key)
    return true
  })
}

/** Cleans mentions sent by the browser: a list of { name, email } with valid addresses, capped. */
export function cleanMentions(raw: unknown): Mention[] {
  if (!Array.isArray(raw)) return []
  return raw
    .slice(0, MENTION_LIMITS.mentions)
    .filter((entry: any) => entry && typeof entry.email === 'string' && isValidEmail(entry.email.trim()))
    .map((entry: any) => {
      const email = entry.email.trim()
      return { email, name: mentionName(typeof entry.name === 'string' ? entry.name : '', email) }
    })
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

/**
 * The HTML version of a plain-text message: the text exactly as written (escaped, line breaks kept), with each
 * mention as a blue link to the person's address. Longer names are matched first, so "@Ana Reyes" wins over "@Ana".
 */
export function mentionHtml(text: string, mentions: Mention[]): string {
  const active = activeMentions(text, mentions).sort((a, b) => b.name.length - a.name.length)
  const pieces: string[] = []
  let rest = text
  while (rest) {
    let best: { at: number; mention: Mention; label: string } | null = null
    for (const mention of active) {
      const label = `@${mentionName(mention.name, mention.email)}`
      const at = rest.indexOf(label)
      if (at >= 0 && (!best || at < best.at)) best = { at, mention, label }
    }
    if (!best) {
      pieces.push(escapeHtml(rest))
      break
    }
    pieces.push(escapeHtml(rest.slice(0, best.at)))
    pieces.push(
      `<a href="mailto:${escapeHtml(best.mention.email)}" style="color:#1a73e8;text-decoration:none">${escapeHtml(best.label)}</a>`,
    )
    rest = rest.slice(best.at + best.label.length)
  }
  const body = pieces.join('').replace(/\r\n|\r|\n/g, '<br>\r\n')
  return `<!doctype html><html><body><div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;white-space:normal">${body}</div></body></html>`
}
