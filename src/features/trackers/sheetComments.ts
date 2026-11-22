/**
 * Comments between a tracker and the Google Sheet or Excel file it follows (Phase 2 of cell comments).
 *
 * - Sheet → tracker, on every sync: each comment and reply on a cell of the synced tab lands on the matching tracker
 *   cell (by the row's key and the column's header), as a "sheet_comment" change. Edited posts are updated, deleted
 *   ones removed, resolved threads hidden. Excel files are read the same way, but never written to.
 * - Tracker → Google Sheet: a comment written on a cell of a synced row is posted to that cell in the Sheet (a reply
 *   when the cell already has an open thread), as the Google account that connected the Sheet, with the writer's name
 *   in front. The next sync recognises it by its cell and text, so it is never brought back as a new comment.
 * - A Sheet comment on a cell with a Task or Subtask is also added once to that task's Comments.
 *
 * Pure helpers, shared by the server and the tests.
 */
import { headerKey, sheetRowKeys } from './trackerSync'

/** One post of a Sheet comment thread (the first post, or a reply), placed on the tab's grid. */
export type SheetPost = {
  threadId: string
  postId: string
  /** The thread's first post. */
  head: boolean
  rowIndex: number
  columnIndex: number
  author: string
  /** Written by the Google account the tracker reads with. */
  me: boolean
  text: string
  createdAt: string
  updatedAt: string
  resolved: boolean
}

/**
 * Where the tab's rows and columns land in the tracker: the key of each grid row (as the sync keys rows) and the column
 * each grid column follows. Built the way planSync reads the grid: row 1 is the header row; empty rows are skipped.
 */
export function sheetCellIndex(grid: string[][], keyHeader: string, headerMap: Record<string, string>) {
  const [rawHeaders = [], ...body] = grid
  const headers = rawHeaders.map(value => String(value ?? '').trim())
  const keyIndex = headers.findIndex(header => header && headerKey(header) === headerKey(keyHeader))
  const columnAt = new Map<number, string>()
  const mapped = new Map(Object.entries(headerMap).map(([header, columnId]) => [headerKey(header), columnId]))
  const seen = new Set<string>()
  headers.forEach((header, index) => {
    const key = headerKey(header)
    if (!header || seen.has(key)) return
    seen.add(key)
    const columnId = mapped.get(key)
    if (columnId) columnAt.set(index, columnId)
  })
  const keyAtRow = new Map<number, string>()
  const rowOfKey = new Map<string, number>()
  if (keyIndex < 0) return { keyAtRow, rowOfKey, columnAt, columnOf: new Map<string, number>() }
  const lines = body
    .map((line, at) => ({ at: at + 1, values: headers.map((_, index) => String(line?.[index] ?? '')) }))
    .filter(line => line.values.some(value => value.trim() && !/^false$/i.test(value.trim())))
  const keys = sheetRowKeys(lines.map(line => line.values[keyIndex]))
  lines.forEach((line, at) => {
    keyAtRow.set(line.at, keys[at])
    rowOfKey.set(keys[at], line.at)
  })
  return { keyAtRow, rowOfKey, columnAt, columnOf: new Map([...columnAt].map(([index, id]) => [id, index])) }
}
export type SheetCellIndex = ReturnType<typeof sheetCellIndex>

/** The Sheets API's comments (spreadsheets.get with comments included) for one tab, as posts. */
export function postsFromSheets(data: any, tab: string): { sheetId: number | null; posts: SheetPost[] } {
  const sheet = (Array.isArray(data?.sheets) ? data.sheets : []).find(
    (item: any) => String(item?.properties?.title ?? '') === tab,
  )
  if (!sheet) return { sheetId: null, posts: [] }
  const sheetId = Number(sheet.properties.sheetId ?? 0)
  const anchors = new Map<string, any>()
  for (const anchor of Array.isArray(sheet.commentAnchors) ? sheet.commentAnchors : [])
    if (anchor?.anchorId && Number(anchor.range?.sheetId ?? sheetId) === sheetId)
      anchors.set(String(anchor.anchorId), anchor.range)
  const posts: SheetPost[] = []
  for (const thread of Array.isArray(data?.comments) ? data.comments : []) {
    const range = anchors.get(String(thread?.anchorId ?? ''))
    if (!range || !thread?.commentId || !thread.headPost) continue
    const place = { rowIndex: Number(range.startRowIndex ?? 0), columnIndex: Number(range.startColumnIndex ?? 0) }
    const resolved = Boolean(thread.status) && thread.status !== 'OPEN'
    const all = [thread.headPost, ...(Array.isArray(thread.replies) ? thread.replies : [])]
    all.forEach((post: any, at: number) => {
      const text = String(post?.content ?? '').trim()
      if (!post?.postId || !text) return // a resolve or reopen without words
      posts.push({
        threadId: String(thread.commentId),
        postId: String(post.postId),
        head: at === 0,
        ...place,
        author: String(post.author?.displayName || 'Someone'),
        me: post.author?.me === true,
        text,
        createdAt: String(post.createTime || ''),
        updatedAt: String(post.updateTime || post.createTime || ''),
        resolved,
      })
    })
  }
  return { sheetId, posts }
}

/** What a tracker comment says in the Sheet: the writer's name in front, since the post is the connector's. */
export const sheetCommentText = (author: string, text: string) => `${author || 'Someone'}: ${text}`.slice(0, 2000)

/** A Sheet post kept on a tracker cell. */
export type KeptPost = {
  recordId: string
  postId: string
  rowId: string
  columnId: string
  text: string
  updatedAt: string
  resolved: boolean
}
/** A tracker comment sent to the Sheet, waiting to be recognised there. */
export type Outgoing = { recordId: string; rowId: string; columnId: string; sheetText: string; linked: boolean }

export type CommentSyncPlan = {
  inserts: (SheetPost & { rowId: string; columnId: string })[]
  updates: { recordId: string; post: SheetPost & { rowId: string; columnId: string } }[]
  deletes: string[]
  /** Tracker comments found in the Sheet: they keep the Sheet's ids, for edits and deletes later. */
  links: { recordId: string; threadId: string; postId: string; head: boolean }[]
  /** Posts on cells the tracker does not have (a row or column it does not follow). */
  skipped: number
}

const same = (a: string, b: string) => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim()

/** How the tracker's copy of the Sheet's comments changes after a sync. */
export function planSheetComments(input: {
  posts: SheetPost[]
  index: SheetCellIndex
  /** Tracker rows by their Sheet key. */
  rowsByKey: ReadonlyMap<string, string>
  kept: KeptPost[]
  outgoing: Outgoing[]
}): CommentSyncPlan {
  const plan: CommentSyncPlan = { inserts: [], updates: [], deletes: [], links: [], skipped: 0 }
  const kept = new Map(input.kept.map(post => [post.postId, post]))
  const waiting = input.outgoing.filter(item => !item.linked)
  const seen = new Set<string>()
  for (const post of input.posts) {
    const key = input.index.keyAtRow.get(post.rowIndex)
    const rowId = key === undefined ? undefined : input.rowsByKey.get(key)
    const columnId = input.index.columnAt.get(post.columnIndex)
    if (!rowId || !columnId) {
      plan.skipped += 1
      continue
    }
    const placed = { ...post, rowId, columnId }
    const old = kept.get(post.postId)
    if (old) {
      seen.add(post.postId)
      if (
        old.text !== post.text ||
        old.updatedAt !== post.updatedAt ||
        old.resolved !== post.resolved ||
        old.rowId !== rowId ||
        old.columnId !== columnId
      )
        plan.updates.push({ recordId: old.recordId, post: placed })
      continue
    }
    // Written from the tracker: link it, never bring it back as a new comment.
    const mine = waiting.findIndex(
      item => item.rowId === rowId && item.columnId === columnId && same(item.sheetText, post.text),
    )
    if (mine >= 0) {
      plan.links.push({
        recordId: waiting[mine].recordId,
        threadId: post.threadId,
        postId: post.postId,
        head: post.head,
      })
      waiting.splice(mine, 1)
      continue
    }
    plan.inserts.push(placed)
  }
  for (const post of input.kept) if (!seen.has(post.postId)) plan.deletes.push(post.recordId)
  return plan
}

/** A Sheet comment as it is added to a task's Comments. */
export const taskCopyText = (author: string, text: string) => `${author} in the Google Sheet: ${text}`.slice(0, 2000)
