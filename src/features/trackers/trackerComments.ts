/**
 * Comments on a tracker row: a short conversation on the row it is about. A comment can @mention people who can see
 * the tracker; they get a notification. Comments are kept with the tracker's history (kind "comment") and are never
 * written to a connected Google Sheet.
 *
 * Pure helpers, shared by the app, the server and the tests.
 */
export type RowComment = {
  id: string
  authorId: string
  authorName: string
  text: string
  /** The ids of the people mentioned. */
  mentions: string[]
  at: string
  editedAt?: string
  /** Set when the comment is on one cell of the row: that cell's column. */
  columnId?: string
}
export type Mentionable = { id: string; name: string }

/** cellsListed: how many cell comments a tracker sends to the grid for its corners and tooltips. */
export const COMMENT_LIMITS = { chars: 2000, mentions: 10, perRow: 200, cellsListed: 3000 }

/** The comment as typed, trimmed and capped; empty when there is nothing to post. */
export const cleanCommentText = (raw: unknown) =>
  String(raw ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, COMMENT_LIMITS.chars)

/** Whether "@Name" stands in the text as a mention: at the start or after a space, not inside another word. */
function hasMention(text: string, name: string) {
  const lower = text.toLowerCase(),
    wanted = `@${name.toLowerCase()}`
  let from = 0
  for (;;) {
    const at = lower.indexOf(wanted, from)
    if (at < 0) return false
    const before = at === 0 ? ' ' : lower[at - 1],
      after = lower[at + wanted.length] ?? ' '
    if (/\s|[(\[]/.test(before) && !/[a-z0-9_]/.test(after)) return true
    from = at + 1
  }
}

/**
 * The people a comment mentions: those asked for whose "@Name" is still in the text and who may be mentioned.
 * The author is never notified about their own comment.
 */
export function mentionsIn(text: string, asked: unknown, people: Mentionable[], authorId: string): string[] {
  const wanted = new Set(Array.isArray(asked) ? asked.map(String) : [])
  return people
    .filter(person => wanted.has(person.id) && person.id !== authorId && person.name && hasMention(text, person.name))
    .map(person => person.id)
    .slice(0, COMMENT_LIMITS.mentions)
}

/** The "@…" being typed at the caret, if any: what to search people by, and where it starts. */
export function mentionQuery(text: string, caret: number): { query: string; start: number } | null {
  const upTo = text.slice(0, caret)
  const at = upTo.lastIndexOf('@')
  if (at < 0 || (at > 0 && !/\s|[(\[]/.test(upTo[at - 1]))) return null
  const query = upTo.slice(at + 1)
  // A mention is a name: it ends at a line break, and is not searched for after a long run of words.
  if (query.includes('\n') || query.length > 40 || query.split(' ').length > 4) return null
  return { query, start: at }
}

/** People matching what was typed after "@", best matches first. */
export function mentionChoices(people: Mentionable[], query: string, count = 6): Mentionable[] {
  const wanted = query.trim().toLowerCase()
  const scored = people
    .map(person => {
      const name = person.name.toLowerCase()
      const score = !wanted
        ? 2
        : name.startsWith(wanted)
          ? 0
          : name.split(/\s+/).some(word => word.startsWith(wanted))
            ? 1
            : name.includes(wanted)
              ? 2
              : -1
      return { person, score }
    })
    .filter(item => item.score >= 0)
  return scored
    .sort((a, b) => a.score - b.score || a.person.name.localeCompare(b.person.name))
    .slice(0, count)
    .map(item => item.person)
}

/** Puts the chosen person's "@Name " in place of the "@…" being typed. */
export function insertMention(text: string, caret: number, start: number, name: string) {
  const inserted = `@${name} `
  return { text: text.slice(0, start) + inserted + text.slice(caret), caret: start + inserted.length }
}

/** The comment split into plain words and mentions, for showing mentions in colour. */
export function commentParts(text: string, names: string[]): { text: string; mention: boolean }[] {
  const sorted = [...new Set(names.filter(Boolean))].sort((a, b) => b.length - a.length)
  const parts: { text: string; mention: boolean }[] = []
  let rest = text
  while (rest) {
    let found: { at: number; name: string } | null = null
    for (const name of sorted) {
      const at = rest.toLowerCase().indexOf(`@${name.toLowerCase()}`)
      if (at >= 0 && (!found || at < found.at)) found = { at, name }
    }
    if (!found) {
      parts.push({ text: rest, mention: false })
      break
    }
    if (found.at > 0) parts.push({ text: rest.slice(0, found.at), mention: false })
    parts.push({ text: rest.slice(found.at, found.at + found.name.length + 1), mention: true })
    rest = rest.slice(found.at + found.name.length + 1)
  }
  return parts
}

/** A notification's short quote of the comment. */
export const commentExcerpt = (text: string, chars = 140) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > chars ? `${flat.slice(0, chars - 1).trimEnd()}…` : flat
}
