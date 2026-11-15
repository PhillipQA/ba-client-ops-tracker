/**
 * Dependencies on the Timeline: a row's Predecessor cell names the rows it waits for, by their WBS / No. (or by their
 * title when the tracker has no such column), as in a project schedule sheet: "1.2", "5.1 & 3.9", "2.1+2d" (two
 * working days of lag). A row starts on the working day after its predecessors end.
 *
 * The text stays the source of truth, so links travel to a connected Google Sheet unchanged.
 * Pure functions, shared by the Timeline and the tests. Days are whole day numbers, as in timelineModel.
 */
import { addWorkingDays, dayNumber, isWeekend, workingDays } from './timelineModel'
import type { TrackerColumn, TrackerRow } from './trackerModel'

export type DependencyFields = { predecessorId: string; keyId: string; titleId: string }

/** The Predecessor column, and the column rows are referred to by. Undefined when the tracker has no Predecessor column. */
export function dependencyFields(columns: TrackerColumn[]): DependencyFields | undefined {
  const predecessor = columns.find(
    column =>
      column.type === 'text' &&
      /^(predecessors?|depends on|dependenc(y|ies)|after|waits for|blocked by)$/i.test(column.name.trim()),
  )
  if (!predecessor) return undefined
  const key = columns.find(
    column =>
      column.type === 'text' &&
      column.id !== predecessor.id &&
      /^(wbs|#|no\.?|id|task no\.?|item)$/i.test(column.name.trim()),
  )
  const title = columns.find(column => column.type === 'text' && column.id !== predecessor.id && column.id !== key?.id)
  return { predecessorId: predecessor.id, keyId: key?.id || '', titleId: title?.id || '' }
}

export type PredecessorRef = { ref: string; lag: number }

/** "5.1 & 3.9+2d" → [{ref:'5.1',lag:0},{ref:'3.9',lag:2}]. Lag is in working days and may be negative ("-1d"). */
export function parsePredecessors(text: unknown): PredecessorRef[] {
  if (typeof text !== 'string') return []
  const refs: PredecessorRef[] = []
  for (const part of text.split(/\s*(?:&|,|;|\band\b|\n)\s*/i)) {
    const piece = part.trim()
    if (!piece) continue
    const lag = /^(.*?)\s*([+-])\s*(\d{1,3})\s*d(?:ays?)?$/i.exec(piece)
    const ref = (lag ? lag[1] : piece).trim()
    if (!ref) continue
    refs.push({ ref, lag: lag ? Number(lag[3]) * (lag[2] === '-' ? -1 : 1) : 0 })
    if (refs.length >= 10) break
  }
  return refs
}

export type Link = { from: string; to: string; lag: number }
export type Links = {
  /** Every link: `to` waits for `from`. */
  all: Link[]
  /** By the row that waits. */
  into: Map<string, Link[]>
  /** By the row that is waited for. */
  outOf: Map<string, Link[]>
  /** References that match no row, by the row that names them. */
  unknown: Map<string, string[]>
}

const keyOf = (value: unknown) => (typeof value === 'string' ? value.trim().toLowerCase() : '')

/** The links between the rows given. A row cannot wait for itself; a reference to no row is reported, not guessed. */
export function buildLinks(rows: TrackerRow[], fields: DependencyFields | undefined): Links {
  const links: Links = { all: [], into: new Map(), outOf: new Map(), unknown: new Map() }
  if (!fields) return links
  const byKey = new Map<string, string>()
  for (const row of rows) {
    const key = keyOf(fields.keyId ? row.cells[fields.keyId] : ''),
      title = keyOf(fields.titleId ? row.cells[fields.titleId] : '')
    // The number wins over a title that happens to read the same; the first row with a name keeps it.
    if (key && !byKey.has(key)) byKey.set(key, row.id)
    if (title && !byKey.has(title)) byKey.set(title, row.id)
  }
  for (const row of rows) {
    const seen = new Set<string>()
    for (const { ref, lag } of parsePredecessors(row.cells[fields.predecessorId])) {
      const from = byKey.get(ref.toLowerCase())
      if (!from) {
        links.unknown.set(row.id, [...(links.unknown.get(row.id) || []), ref])
        continue
      }
      if (from === row.id || seen.has(from)) continue
      seen.add(from)
      const link = { from, to: row.id, lag }
      links.all.push(link)
      links.into.set(row.id, [...(links.into.get(row.id) || []), link])
      links.outOf.set(from, [...(links.outOf.get(from) || []), link])
    }
  }
  return links
}

export type Dates = { start: number; end: number }
/** Each row's start and end as day numbers; rows without both are left out. */
export function rowDates(rows: TrackerRow[], startId: string, endId: string): Map<string, Dates> {
  const dates = new Map<string, Dates>()
  for (const row of rows) {
    const start = dayNumber(row.cells[startId])
    const end = endId ? dayNumber(row.cells[endId]) : start
    if (start !== null) dates.set(row.id, { start, end: end !== null && end >= start ? end : start })
  }
  return dates
}

/** The earliest day a row may start after a predecessor that ends on `end`: the next working day, plus the lag. */
export const earliestStart = (end: number, lag: number) => {
  const next = addWorkingDays(end + 1, 0)
  if (lag >= 0) return addWorkingDays(next, lag)
  let day = next
  for (let left = -lag; left > 0; ) {
    day--
    if (!isWeekend(day)) left--
  }
  return day
}

/**
 * The rows that must move when one row's dates change: every row down the chain that would now start before a
 * predecessor is finished is pushed later, keeping its length in working days. Rows are only ever pushed later;
 * a row that still has room (slack) stays. A loop in the links stops the push instead of going round forever.
 */
export function cascade(dates: Map<string, Dates>, links: Links, moved: string, next: Dates): Map<string, Dates> {
  const now = new Map(dates)
  now.set(moved, next)
  const changed = new Map<string, Dates>()
  const queue = [moved]
  let guard = 0
  while (queue.length && guard++ < 5000) {
    const from = queue.shift()!
    for (const link of links.outOf.get(from) || []) {
      if (link.to === moved) continue
      const current = now.get(link.to)
      if (!current) continue
      // The row waits for all its predecessors: the latest of them decides.
      let needed = current.start
      for (const into of links.into.get(link.to) || []) {
        const before = now.get(into.from)
        if (before) needed = Math.max(needed, earliestStart(before.end, into.lag))
      }
      if (needed <= current.start) continue
      const length = Math.max(1, workingDays(current.start, current.end))
      const pushed = { start: needed, end: addWorkingDays(needed, length - 1) }
      now.set(link.to, pushed)
      changed.set(link.to, pushed)
      queue.push(link.to)
    }
  }
  return changed
}

/** Rows that start before one of their predecessors has finished. */
export function conflicts(dates: Map<string, Dates>, links: Links): Set<string> {
  const early = new Set<string>()
  for (const link of links.all) {
    const from = dates.get(link.from),
      to = dates.get(link.to)
    if (from && to && to.start < earliestStart(from.end, link.lag)) early.add(link.to)
  }
  return early
}

/**
 * The critical path: the chain of linked rows that decides the last end date. From the row that ends last, back
 * through the predecessor that ends latest each time. A slip anywhere on it moves the end. Empty when nothing is linked.
 */
export function criticalPath(dates: Map<string, Dates>, links: Links): Set<string> {
  const path = new Set<string>()
  if (!links.all.length) return path
  const linked = [...dates.keys()].filter(id => links.into.has(id) || links.outOf.has(id))
  let at = linked.sort((a, b) => dates.get(b)!.end - dates.get(a)!.end)[0]
  while (at && !path.has(at)) {
    path.add(at)
    const before = (links.into.get(at) || []).filter(link => dates.has(link.from))
    at = before.sort((a, b) => dates.get(b.from)!.end - dates.get(a.from)!.end)[0]?.from
  }
  return path
}

/** The last end date among the rows, with some of them moved. */
export function lastEnd(dates: Map<string, Dates>, moved: Map<string, Dates> = new Map()) {
  let last: number | null = null
  for (const [id, own] of dates) {
    const end = (moved.get(id) || own).end
    if (last === null || end > last) last = end
  }
  return last
}
