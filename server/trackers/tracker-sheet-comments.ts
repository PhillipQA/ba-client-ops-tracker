/**
 * Cell comments with a tracker's Google Sheet or Excel file (see src/features/trackers/sheetComments.ts).
 *
 * Kept in tenant_tracker_changes, as the tracker's own comments are (no new table):
 * - kind "sheet_comment": a post brought from the Sheet (detail: columnId, threadId, postId, text, resolved, and the
 *   task comment it was copied to). Read-only in the tracker: it changes in the Sheet.
 * - kind "comment" with detail.sheet: a tracker comment and how far it got to the Sheet (pending, sent, failed).
 * - kind "sheet_out": a comment written on a task-linked cell (saved in the task) and sent to the Sheet.
 *
 * Nothing here fails a sync or a comment: problems are logged, or noted on the comment for a retry next sync.
 */
import { randomUUID } from 'node:crypto'
import { archivedWorkReason } from '../../src/features/tasks/lifecycle'
import {
  type KeptPost,
  type Outgoing,
  planSheetComments,
  postsFromSheets,
  type SheetCellIndex,
  type SheetPost,
  sheetCellIndex,
  sheetCommentText,
  taskCopyText,
} from '../../src/features/trackers/sheetComments'
import { tabRange } from '../../src/features/trackers/trackerSync'
import type { Deps, User } from './tracker-common'
import type { TrackerCore } from './tracker-core'
import type { TrackerSheetAccess } from './tracker-source'

export const SHEET_KINDS = { post: 'sheet_comment', out: 'sheet_out' } as const
/** How many tracker comments one sync sends to the Sheet; the rest go with the next. */
const PUSH_PER_SYNC = 20

type SheetState = {
  state: 'pending' | 'sent' | 'failed' | 'excel'
  text: string
  error?: string
  threadId?: string
  postId?: string
  /** It started its own thread in the Sheet (deleting it deletes the thread). */
  head?: boolean
}

export function trackerSheetComments(deps: Deps, core: TrackerCore, sheetAccess: TrackerSheetAccess) {
  const { db, now, columnsOf } = core
  const { sourceRow, googleFor, canWriteSheets, sourceIsExcel, sheetsGet, openWorkbook, readTab, allRows } = sheetAccess

  const changes = () => db.from('tenant_tracker_changes')
  const log = (what: string, error: any) => console.error(`Sheet comments: ${what} failed:`, error?.message || error)

  /** The tab's comment threads, from the Sheets API. */
  async function sheetPosts(token: string, source: any) {
    const params = new URLSearchParams({
      commentsViewMode: 'COMMENTS_VIEW_MODE_INCLUDED',
      ranges: tabRange(source.tab),
      fields: 'comments,sheets(properties(sheetId,title),commentAnchors)',
    })
    const data = await sheetsGet(
      token,
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(source.spreadsheet_id)}?${params}`,
    )
    return postsFromSheets(data, source.tab)
  }

  async function records(tenant: string, trackerId: string, kinds: string[]) {
    const r = await changes()
      .select('id,row_id,actor_id,actor_name,kind,detail,created_at')
      .eq('tenant_id', tenant)
      .eq('tracker_id', trackerId)
      .in('kind', kinds)
      .limit(10000)
    if (r.error) throw r.error
    return r.data || []
  }
  const keptOf = (rows: any[]): KeptPost[] =>
    rows
      .filter(row => row.kind === SHEET_KINDS.post && row.detail?.postId)
      .map(row => ({
        recordId: row.id,
        postId: String(row.detail.postId),
        rowId: row.row_id,
        columnId: String(row.detail.columnId || ''),
        text: String(row.detail.text || ''),
        updatedAt: String(row.detail.updatedAt || ''),
        resolved: Boolean(row.detail.resolved),
      }))
  const outgoingOf = (rows: any[]): (Outgoing & { row: any })[] =>
    rows
      .filter(row => row.kind !== SHEET_KINDS.post && row.detail?.columnId && row.detail?.sheet?.text)
      .map(row => ({
        recordId: row.id,
        rowId: row.row_id,
        columnId: String(row.detail.columnId),
        sheetText: String(row.detail.sheet.text),
        linked: Boolean(row.detail.sheet.postId),
        row,
      }))
  const setSheet = async (row: any, sheet: SheetState) => {
    const saved = await changes()
      .update({ detail: { ...row.detail, sheet } })
      .eq('tenant_id', row.tenant_id || '')
      .eq('id', row.id)
    if (saved.error) throw saved.error
  }

  async function batch(token: string, source: any, requests: unknown[]) {
    const result = await sheetsGet(
      token,
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(source.spreadsheet_id)}:batchUpdate`,
      { method: 'POST', body: { requests } },
    )
    if (result?.commentUpdateState === 'ALL_FAILED_UNKNOWN_REASON')
      throw new Error('Google Sheets did not save the comment.')
    return result
  }

  /**
   * Sends tracker comments still waiting to the Sheet: a reply on the cell's open thread, or a new comment. A comment on
   * a cell the Sheet does not have (a row or column the Sheet does not follow) stays in the tracker.
   */
  async function push(
    tenant: string,
    tracker: any,
    source: any,
    token: string,
    sheetId: number,
    index: SheetCellIndex,
    posts: SheetPost[],
    waiting: any[],
  ) {
    if (!waiting.length) return 0
    const rows = new Map((await allRows(tenant, tracker.id)).map(row => [row.id, row]))
    let sent = 0
    for (const record of waiting.slice(0, PUSH_PER_SYNC)) {
      const row = rows.get(record.row_id)
      const rowIndex = row?.source_key ? index.rowOfKey.get(row.source_key) : undefined
      const columnIndex = index.columnOf.get(String(record.detail.columnId))
      const sheet: SheetState = { ...record.detail.sheet }
      const keep = { ...record, tenant_id: tenant }
      if (rowIndex === undefined || columnIndex === undefined) {
        await setSheet(keep, { ...sheet, state: 'failed', error: 'This cell is not in the Google Sheet.' })
        continue
      }
      const open = posts
        .filter(post => post.rowIndex === rowIndex && post.columnIndex === columnIndex && !post.resolved)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
      try {
        await batch(token, source, [
          open
            ? { addCommentReply: { commentId: open.threadId, post: { content: sheet.text } } }
            : { insertComment: { content: sheet.text, coordinate: { sheetId, rowIndex, columnIndex } } },
        ])
        await setSheet(keep, { ...sheet, state: 'sent', error: undefined })
        sent += 1
      } catch (error: any) {
        await setSheet(keep, {
          ...sheet,
          state: 'failed',
          error: String(error?.message || 'Google Sheets did not save the comment.').slice(0, 300),
        })
      }
    }
    return sent
  }

  /** The Task or Subtask in each tracker cell: the row's Task in the first column, linked Subtasks elsewhere. */
  async function cellTasks(tenant: string, tracker: any) {
    const first = columnsOf(tracker)[0]?.id || ''
    const map = new Map<string, string>()
    for (const row of await allRows(tenant, tracker.id)) if (row.task_id) map.set(`${row.id}|${first}`, row.task_id)
    const links = await db
      .from('tenant_tracker_task_links')
      .select('row_id,column_id,task_id')
      .eq('tenant_id', tenant)
      .eq('tracker_id', tracker.id)
    for (const link of links.data || [])
      if (link.column_id && !map.has(`${link.row_id}|${link.column_id}`))
        map.set(`${link.row_id}|${link.column_id}`, link.task_id)
    return map
  }

  /** New Sheet comments on task cells go into the tasks' Comments, once. Returns record id → task comment id. */
  async function copyToTasks(
    tenant: string,
    user: User,
    found: { recordId: string; taskId: string; post: SheetPost }[],
  ) {
    const copied = new Map<string, string>()
    if (!found.length || !deps.commit) return copied
    for (let attempt = 0; attempt < 2; attempt++) {
      const current = await deps.load(tenant)
      const data = current.data
      if (!data) return copied
      const items = Array.isArray(data.items) ? data.items : []
      const byTask = new Map<string, any[]>()
      copied.clear()
      for (const entry of found) {
        const task = items.find((item: any) => String(item?.id) === entry.taskId)
        if (!task || archivedWorkReason(data, task)) continue
        const comment = {
          id: randomUUID(),
          text: taskCopyText(entry.post.author, entry.post.text),
          createdAt: entry.post.createdAt || now(),
          createdBy: '',
          createdByName: entry.post.author,
          kind: 'User',
        }
        byTask.set(entry.taskId, [...(byTask.get(entry.taskId) || []), comment])
        copied.set(entry.recordId, comment.id)
      }
      if (!byTask.size) return copied
      const next = {
        ...data,
        items: items.map((item: any) =>
          byTask.has(String(item?.id))
            ? {
                ...item,
                comments: [
                  ...(Array.isArray(item.comments) ? item.comments : []),
                  ...byTask.get(String(item.id))!,
                ].slice(-500),
              }
            : item,
        ),
      }
      try {
        await deps.commit(tenant, next, user, 'sheet-comments', data)
        return copied
      } catch (error) {
        if (attempt === 1) throw error
      }
    }
    return copied
  }

  /**
   * After a sync has read the tab (grid): brings the tab's comments to the tracker's cells, and sends waiting tracker
   * comments to the Sheet when the connection may edit it. Excel files are only read.
   */
  async function syncComments(input: {
    tenant: string
    tracker: any
    source: any
    grid: string[][]
    token: string
    scope: unknown
    excel: boolean
    user: User
  }) {
    const { tenant, tracker, source, grid, token, scope, excel, user } = input
    const index = sheetCellIndex(grid, source.key_header, source.header_map || {})
    let read = excel
      ? {
          sheetId: null as number | null,
          posts: (await openWorkbook(token, scope, source.spreadsheet_id)).book.comments(source.tab),
        }
      : await sheetPosts(token, source)
    let stored = await records(tenant, tracker.id, ['comment', SHEET_KINDS.post, SHEET_KINDS.out])
    // Tracker comments waiting for the Sheet go first, so this sync already recognises them there.
    if (!excel && read.sheetId !== null && canWriteSheets(scope)) {
      const waiting = stored.filter(
        row =>
          row.kind !== SHEET_KINDS.post &&
          row.detail?.columnId &&
          (row.detail?.sheet?.state === 'pending' || row.detail?.sheet?.state === 'failed') &&
          row.detail?.sheet?.error !== 'This cell is not in the Google Sheet.',
      )
      if (await push(tenant, tracker, source, token, read.sheetId, index, read.posts, waiting)) {
        read = await sheetPosts(token, source)
        stored = await records(tenant, tracker.id, ['comment', SHEET_KINDS.post, SHEET_KINDS.out])
      }
    }
    const rows = await allRows(tenant, tracker.id)
    const plan = planSheetComments({
      posts: read.posts,
      index,
      rowsByKey: new Map(rows.filter(row => row.source_key).map(row => [String(row.source_key), row.id])),
      kept: keptOf(stored),
      outgoing: outgoingOf(stored),
    })
    const stamp = now()
    const detailOf = (post: SheetPost & { columnId: string }) => ({
      columnId: post.columnId,
      threadId: post.threadId,
      postId: post.postId,
      head: post.head,
      text: post.text,
      createdAt: post.createdAt || stamp,
      updatedAt: post.updatedAt,
      resolved: post.resolved,
      excel,
    })
    const inserted = plan.inserts.map(post => ({
      id: randomUUID(),
      tenant_id: tenant,
      tracker_id: tracker.id,
      row_id: post.rowId,
      actor_id: '',
      actor_name: post.author,
      kind: SHEET_KINDS.post,
      detail: detailOf(post),
      created_at: post.createdAt || stamp,
      post,
    }))
    if (inserted.length) {
      const saved = await changes().insert(inserted.map(({ post, ...record }) => record))
      if (saved.error) throw saved.error
    }
    const byId = new Map(stored.map(row => [row.id, row]))
    for (const update of plan.updates) {
      const old = byId.get(update.recordId)
      const saved = await changes()
        .update({
          row_id: update.post.rowId,
          actor_name: update.post.author,
          detail: { ...old?.detail, ...detailOf(update.post) },
        })
        .eq('tenant_id', tenant)
        .eq('id', update.recordId)
      if (saved.error) throw saved.error
    }
    if (plan.deletes.length) {
      const saved = await changes().delete().eq('tenant_id', tenant).in('id', plan.deletes)
      if (saved.error) throw saved.error
    }
    for (const link of plan.links) {
      const row = byId.get(link.recordId)
      if (row)
        await setSheet(
          { ...row, tenant_id: tenant },
          {
            ...row.detail.sheet,
            state: 'sent',
            error: undefined,
            threadId: link.threadId,
            postId: link.postId,
            head: link.head,
          },
        )
    }
    // New, open Sheet comments on task cells are copied into the task once.
    const fresh = inserted.filter(record => !record.post.resolved)
    if (fresh.length) {
      const tasks = await cellTasks(tenant, tracker)
      const found = fresh.flatMap(record => {
        const taskId = tasks.get(`${record.row_id}|${record.post.columnId}`)
        return taskId ? [{ recordId: record.id, taskId, post: record.post }] : []
      })
      const copied = await copyToTasks(tenant, user, found).catch(error => {
        log('copying Sheet comments into tasks', error)
        return new Map<string, string>()
      })
      for (const record of inserted) {
        const taskCommentId = copied.get(record.id)
        if (!taskCommentId) continue
        const taskId = found.find(entry => entry.recordId === record.id)?.taskId
        await changes()
          .update({ detail: { ...record.detail, taskId, taskCommentId } })
          .eq('tenant_id', tenant)
          .eq('id', record.id)
      }
    }
    return {
      added: plan.inserts.length,
      updated: plan.updates.length,
      removed: plan.deletes.length,
      skipped: plan.skipped,
    }
  }

  /** The Sheet a tracker comment can go to now: Google Sheet, connection may edit it. Null otherwise. */
  async function writable(tenant: string, trackerId: string) {
    const source = await sourceRow(tenant, trackerId)
    if (!source) return null
    const access = await googleFor(tenant, source.connected_by)
    if (await sourceIsExcel(access.token, source)) return { source, access, excel: true }
    if (!canWriteSheets(access.scope)) return null
    return { source, access, excel: false }
  }

  /**
   * Right after a comment is written on a synced cell: send it to the Sheet now. Leaves it waiting (for the next sync)
   * when Google cannot be reached. Never throws.
   */
  async function sendNow(tenant: string, tracker: any, recordId: string) {
    try {
      const target = await writable(tenant, tracker.id)
      const record = (await records(tenant, tracker.id, ['comment', SHEET_KINDS.out])).find(row => row.id === recordId)
      if (!record?.detail?.sheet) return
      if (!target) return
      if (target.excel)
        return void (await setSheet({ ...record, tenant_id: tenant }, { ...record.detail.sheet, state: 'excel' }))
      const grid = await readTab(target.access.token, target.source)
      const index = sheetCellIndex(grid, target.source.key_header, target.source.header_map || {})
      const read = await sheetPosts(target.access.token, target.source)
      if (read.sheetId === null) return
      await push(tenant, tracker, target.source, target.access.token, read.sheetId, index, read.posts, [record])
    } catch (error) {
      log('sending a comment to the Sheet', error)
    }
  }

  /** A tracker comment already in the Sheet was edited or deleted in the tracker: the Sheet follows. Never throws. */
  async function followEdit(tenant: string, trackerId: string, record: any, change: { text: string } | 'deleted') {
    const sheet = record?.detail?.sheet
    if (!sheet?.threadId || !sheet?.postId) return
    try {
      const target = await writable(tenant, trackerId)
      if (!target || target.excel) return
      if (change === 'deleted')
        await batch(
          target.access.token,
          target.source,
          sheet.head
            ? [{ deleteComment: { commentId: sheet.threadId } }]
            : [{ deleteCommentReply: { commentId: sheet.threadId, postId: sheet.postId } }],
        )
      else {
        const text = sheetCommentText(record.actor_name, change.text)
        await batch(target.access.token, target.source, [
          { updateCommentPost: { commentId: sheet.threadId, postId: sheet.postId, content: text } },
        ])
        await setSheet(
          { ...record, tenant_id: tenant, detail: { ...record.detail, text: change.text } },
          { ...sheet, text },
        )
      }
    } catch (error) {
      log(change === 'deleted' ? 'deleting a comment in the Sheet' : 'editing a comment in the Sheet', error)
    }
  }

  return { syncComments, sendNow, followEdit, writable }
}

export type TrackerSheetComments = ReturnType<typeof trackerSheetComments>
