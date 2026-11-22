// Comments on tracker rows, with @mentions. Kept in tenant_tracker_changes as kind "comment" (no new table), so they
// live and die with the tracker. A mention adds a notification for that person, best effort: the comment is saved
// even when the notification cannot be. See src/features/trackers/trackerComments.ts.
import { randomUUID } from 'node:crypto'
import type { Express } from 'express'
import rateLimit from 'express-rate-limit'
import {
  cleanCommentText,
  COMMENT_LIMITS,
  commentExcerpt,
  mentionsIn,
  type Mentionable,
  type RowComment,
} from '../../src/features/trackers/trackerComments'
import { TrackerError } from '../../src/features/trackers/trackerModel'
import { rowTitle } from '../../src/features/trackers/trackerQuery'
import { type Deps, type User, UUID } from './tracker-common'
import type { TrackerCore } from './tracker-core'

const KIND = 'comment'

export function trackerCommentRoutes(app: Express, deps: Deps, core: TrackerCore) {
  const { scope, route, who, idParam, trackerRow, db, check, workspace, trackerVisibleIn, oneRow, now, columnsOf } =
    core
  const limit = rateLimit({
    windowMs: 60_000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: req => `${who(req).organizationId}:${who(req).id}`,
    message: { error: 'Too many comments in a minute. Wait a moment and try again.' },
  })
  const out = (entry: any): RowComment => ({
    id: entry.id,
    authorId: entry.actor_id || '',
    authorName: entry.actor_name || '',
    text: String(entry.detail?.text || ''),
    mentions: Array.isArray(entry.detail?.mentions) ? entry.detail.mentions.map(String) : [],
    at: entry.created_at,
    ...(entry.detail?.editedAt ? { editedAt: String(entry.detail.editedAt) } : {}),
    ...(entry.detail?.columnId ? { columnId: String(entry.detail.columnId) } : {}),
  })
  /** A comment on one cell names its column; it must be one of the tracker's. '' is a comment on the whole row. */
  const columnOf = (tracker: any, raw: unknown) => {
    const columnId = typeof raw === 'string' ? raw.trim() : ''
    if (!columnId) return ''
    if (!columnsOf(tracker).some((column: any) => column.id === columnId))
      throw new TrackerError('That column is no longer in this tracker.', 404)
    return columnId
  }
  /** Active people who can see this tracker: the ones a comment may mention. */
  function mentionable(state: any, tracker: any): Mentionable[] {
    return (Array.isArray(state?.accounts) ? state.accounts : [])
      .filter((account: any) => account?.status === 'Active' && account.id)
      .filter((account: any) => !tracker.private || tracker.created_by === account.id)
      .filter((account: any) =>
        trackerVisibleIn(state, {
          id: String(account.id),
          name: String(account.name || account.username || ''),
          role: String(account.role || ''),
          organizationId: String(tracker.tenant_id || ''),
        })(tracker),
      )
      .map((account: any) => ({ id: String(account.id), name: String(account.name || account.username || '') }))
      .filter((person: Mentionable) => person.name)
  }
  const commentsOf = async (tenant: string, trackerId: string, rowId: string) => {
    const r = await db
      .from('tenant_tracker_changes')
      .select('id,actor_id,actor_name,kind,detail,created_at')
      .eq('tenant_id', tenant)
      .eq('tracker_id', trackerId)
      .eq('row_id', rowId)
      .eq('kind', KIND)
      .order('created_at', { ascending: true })
      .limit(COMMENT_LIMITS.perRow)
    check(r.error)
    return (r.data || []).map(out)
  }
  /** A notification for each person mentioned. Never fails the comment. */
  async function notifyMentions(user: User, tracker: any, row: any, comment: RowComment) {
    if (!comment.mentions.length || !deps.commit) return
    const title = rowTitle(columnsOf(tracker), core.rowOut(row, columnsOf(tracker))) || 'a row'
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const current = await deps.load(user.organizationId)
        if (!current.data) return
        const existing = Array.isArray(current.data.notifications) ? current.data.notifications : []
        const added = comment.mentions
          .filter(id => !existing.some((item: any) => item?.dedupeKey === `tracker-mention:${comment.id}:${id}`))
          .map(id => ({
            id: randomUUID(),
            dedupeKey: `tracker-mention:${comment.id}:${id}`,
            recipientUserId: id,
            createdAt: comment.at,
            type: 'comment_added',
            scope: 'personal',
            severity: 'info',
            title: `${user.name} mentioned you in ${tracker.name}`,
            message: `${title}: ${commentExcerpt(comment.text)}`,
            trackerId: tracker.id,
            trackerRowId: row.id,
            actorUserId: user.id,
            actorName: user.name,
          }))
        if (!added.length) return
        await deps.commit(
          user.organizationId,
          { ...current.data, notifications: [...added, ...existing] },
          user,
          'tracker-mention',
          current.data,
        )
        return
      } catch {
        /* Someone saved at the same moment: read again and try once more, then give up quietly. */
      }
    }
  }
  const commentEntry = async (tenant: string, trackerId: string, commentId: string) => {
    if (!UUID.test(commentId)) throw new TrackerError('Comment not found.', 404)
    const r = await db
      .from('tenant_tracker_changes')
      .select('id,actor_id,actor_name,kind,detail,created_at,row_id')
      .eq('tenant_id', tenant)
      .eq('tracker_id', trackerId)
      .eq('id', commentId)
      .eq('kind', KIND)
      .maybeSingle()
    check(r.error)
    if (!r.data) throw new TrackerError('Comment not found. It may have been deleted.', 404)
    return r.data
  }

  app.get(
    '/api/trackers/:id/rows/:rowId/comments',
    ...scope,
    route(async (req, res) => {
      const user = who(req),
        tenant = user.organizationId,
        id = idParam(req)
      const tracker = await trackerRow(tenant, id, user)
      const rowId = String(req.params.rowId)
      if (!UUID.test(rowId)) throw new TrackerError('Row not found.', 404)
      res.json({
        comments: await commentsOf(tenant, id, rowId),
        mentionable: mentionable(await workspace(tenant), tracker).filter(person => person.id !== user.id),
      })
    }),
  )
  // How many comments each row has, for the count shown in the grid.
  app.get(
    '/api/trackers/:id/comment-counts',
    ...scope,
    route(async (req, res) => {
      const user = who(req),
        tenant = user.organizationId,
        id = idParam(req)
      await trackerRow(tenant, id, user)
      const r = await db
        .from('tenant_tracker_changes')
        .select('id,row_id,actor_id,actor_name,detail,created_at')
        .eq('tenant_id', tenant)
        .eq('tracker_id', id)
        .eq('kind', KIND)
        .order('created_at', { ascending: true })
        .limit(5000)
      check(r.error)
      const counts: Record<string, number> = {}
      // Comments on single cells, for the corner and the hover tooltip in the grid.
      const cells: (RowComment & { rowId: string })[] = []
      for (const entry of r.data || []) {
        if (!entry.row_id) continue
        counts[entry.row_id] = (counts[entry.row_id] || 0) + 1
        if (entry.detail?.columnId && cells.length < COMMENT_LIMITS.cellsListed)
          cells.push({ ...out(entry), rowId: entry.row_id })
      }
      res.json({ counts, cells })
    }),
  )
  app.post(
    '/api/trackers/:id/rows/:rowId/comments',
    ...scope,
    limit,
    route(async (req, res) => {
      const user = who(req),
        tenant = user.organizationId,
        id = idParam(req)
      const tracker = await trackerRow(tenant, id, user)
      const row = await oneRow(tenant, id, String(req.params.rowId))
      const text = cleanCommentText(req.body?.text)
      if (!text) throw new TrackerError('Write a comment first.')
      if ((await commentsOf(tenant, id, row.id)).length >= COMMENT_LIMITS.perRow)
        throw new TrackerError(`A row can have at most ${COMMENT_LIMITS.perRow} comments.`)
      const mentions = mentionsIn(text, req.body?.mentions, mentionable(await workspace(tenant), tracker), user.id)
      const columnId = columnOf(tracker, req.body?.columnId)
      const entry = {
        id: randomUUID(),
        tenant_id: tenant,
        tracker_id: id,
        row_id: row.id,
        actor_id: user.id,
        actor_name: user.name,
        kind: KIND,
        detail: columnId ? { text, mentions, columnId } : { text, mentions },
        created_at: now(),
      }
      check((await db.from('tenant_tracker_changes').insert(entry)).error)
      const comment = out(entry)
      await notifyMentions(user, tracker, row, comment)
      res.status(201).json({ comment })
    }),
  )
  // Your own comment: change its words. People newly mentioned are notified; nobody is notified twice.
  app.patch(
    '/api/trackers/:id/comments/:commentId',
    ...scope,
    limit,
    route(async (req, res) => {
      const user = who(req),
        tenant = user.organizationId,
        id = idParam(req)
      const tracker = await trackerRow(tenant, id, user)
      const entry = await commentEntry(tenant, id, String(req.params.commentId))
      if (entry.actor_id !== user.id) throw new TrackerError('You can only edit your own comments.', 403)
      const text = cleanCommentText(req.body?.text)
      if (!text) throw new TrackerError('A comment cannot be empty. Delete it instead.')
      const mentions = mentionsIn(text, req.body?.mentions, mentionable(await workspace(tenant), tracker), user.id)
      // A cell comment stays on its cell.
      const detail = {
        text,
        mentions,
        editedAt: now(),
        ...(entry.detail?.columnId ? { columnId: String(entry.detail.columnId) } : {}),
      }
      check(
        (await db.from('tenant_tracker_changes').update({ detail }).eq('tenant_id', tenant).eq('id', entry.id)).error,
      )
      const comment = out({ ...entry, detail })
      const row = await oneRow(tenant, id, entry.row_id).catch(() => null)
      if (row) await notifyMentions(user, tracker, row, comment)
      res.json({ comment })
    }),
  )
  // Your own comment, or any comment for an Administrator.
  app.delete(
    '/api/trackers/:id/comments/:commentId',
    ...scope,
    limit,
    route(async (req, res) => {
      const user = who(req),
        tenant = user.organizationId,
        id = idParam(req)
      await trackerRow(tenant, id, user)
      const entry = await commentEntry(tenant, id, String(req.params.commentId))
      if (entry.actor_id !== user.id && user.role !== 'Administrator')
        throw new TrackerError('You can only delete your own comments.', 403)
      check((await db.from('tenant_tracker_changes').delete().eq('tenant_id', tenant).eq('id', entry.id)).error)
      res.json({ deleted: true })
    }),
  )
}
