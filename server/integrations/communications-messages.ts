/**
 * Routes for Work Hub messages: the list, a thread, attachments, sources settings, manual messages, and read
 * or unread.
 */
import { attachmentDisposition } from './gmail-content'
import type { Express } from 'express'
import { IntegrationError } from './tenant-integrations'
import { visibleTaskIds } from '../services/visibility'
import {
  CALLBACK,
  type CommunicationsDeps,
  missingReadColumn,
  origin,
  requireText,
  UNREAD_SOURCES,
} from './communications-common'
import type { CommunicationsCore } from './communications-core'

export function messageRoutes(app: Express, deps: CommunicationsDeps, comms: CommunicationsCore) {
  const { auth, guard, wrap, current, db, own, gmailGate, gmailAttachment, settings, account, gmailBackfillCooldowns } =
    comms
  app.get(
    '/api/communications',
    ...auth,
    guard,
    wrap(async (req, res) => {
      const user = current(req)
      // The person's own emails linked to some tasks (DRF creation shows the task's email). Newest first, at most 20.
      if (req.query.taskIds !== undefined) {
        const ids = [
          ...new Set(
            String(req.query.taskIds)
              .split(',')
              .map(id => id.trim())
              .filter(Boolean),
          ),
        ]
        if (!ids.length || ids.length > 50 || ids.some(id => id.length > 128))
          throw new IntegrationError('Choose up to 50 tasks.')
        const state = await deps.load(user.organizationId)
        // With per-person visibility on, tasks outside this person's clients and projects are not asked about.
        const visible = visibleTaskIds(state?.data, user)
        if (visible) ids.splice(0, ids.length, ...ids.filter(id => visible.has(id)))
        if (!ids.length) return void res.json({ items: [] })
        // family=1: also the parent task and the subtasks, so a file on a subtask can answer the task's email.
        if (req.query.family === '1') {
          const all: any[] = (Array.isArray(state?.data?.items) ? state.data.items : []).filter(
            (item: any) => !visible || visible.has(String(item?.id || '')),
          )
          const asked = new Set(ids)
          for (const item of all) {
            const id = String(item?.id || ''),
              parent = String(item?.parentTaskId || '')
            if (asked.has(id) && parent) ids.push(parent)
            if (parent && asked.has(parent)) ids.push(id)
          }
          ids.splice(0, ids.length, ...[...new Set(ids)].slice(0, 100))
        }
        const linked = (query: any) =>
          query
            .eq('tenant_id', user.organizationId)
            .eq('owner_user_id', user.id)
            .order('received_at', { ascending: false })
            .limit(20)
        const [latest, any] = await Promise.all([
          linked(db.from('user_communications').select('*').in('linked_task_id', ids)),
          linked(db.from('user_communications').select('*').overlaps('linked_task_ids', ids)),
        ])
        if (latest.error) throw latest.error
        const byId = new Map<string, any>()
        // A database before linked_task_ids still answers by the latest linked task.
        for (const row of [...(latest.data || []), ...(any.error ? [] : any.data || [])]) byId.set(row.id, row)
        const items = [...byId.values()]
          .sort((a, b) => new Date(b.received_at).getTime() - new Date(a.received_at).getTime())
          .slice(0, 20)
        res.json({ items })
        return
      }
      // Keep the old response for older clients while the new Hub uses bounded pages.
      const paginated = req.query.page !== undefined || req.query.pageSize !== undefined
      const page = Number(req.query.page ?? 1),
        pageSize = Number(req.query.pageSize ?? 10)
      const tab = String(req.query.tab ?? 'All'),
        label = String(req.query.label ?? '')
      if (
        !Number.isSafeInteger(page) ||
        page < 1 ||
        page > 1000000 ||
        ![5, 10, 15].includes(pageSize) ||
        !['All', 'Gmail', 'Discord', 'Manual', 'Archived'].includes(tab) ||
        label.length > 128
      )
        throw new IntegrationError('Choose a valid communication view and page.')
      const filtered = (head = false) => {
        let query = db
          .from('user_communications')
          .select('*', paginated ? { count: 'exact', head } : {})
          .eq('tenant_id', user.organizationId)
          .eq('owner_user_id', user.id)
        if (paginated) {
          query =
            tab === 'Archived' || req.query.archived === 'true'
              ? query.eq('status', 'Archived')
              : query.neq('status', 'Archived')
          if (['Gmail', 'Discord', 'Manual'].includes(tab)) query = query.eq('source', tab)
          if (tab === 'Gmail' && label) query = query.contains('source_labels', [label])
        }
        return query
      }
      const query = filtered().order('received_at', { ascending: false }).order('id', { ascending: false })
      const { data, count, error } = await (paginated
        ? query.range((page - 1) * pageSize, page * pageSize - 1)
        : query.limit(200))
      // PostgREST can return 416 when the last item on a page was archived.
      if (paginated && error?.code === 'PGRST103') {
        const latest = await filtered(true)
        if (latest.error) throw latest.error
        res.json({ items: [], total: latest.count || 0, page, pageSize })
        return
      }
      if (error) throw error
      res.json({ items: data || [], ...(paginated ? { total: count || 0, page, pageSize } : {}) })
    }),
  )
  app.get(
    '/api/communications/:id/thread',
    ...auth,
    guard,
    wrap(async (req, res) => {
      const selected = await own(req, String(req.params.id)),
        user = current(req)
      const page = Number(req.query.page ?? 1),
        pageSize = 50
      if (!Number.isSafeInteger(page) || page < 1 || page > 1000000)
        throw new IntegrationError('Choose a valid thread page.')
      if (!selected.thread_id) {
        res.json({ items: [selected], total: 1 })
        return
      }
      const { data, count, error } = await db
        .from('user_communications')
        .select('*', { count: 'exact' })
        .eq('tenant_id', user.organizationId)
        .eq('owner_user_id', user.id)
        .eq('source', selected.source)
        .eq('thread_id', selected.thread_id)
        .order('received_at', { ascending: true })
        .order('id', { ascending: true })
        .range((page - 1) * pageSize, page * pageSize - 1)
      if (error) throw error
      res.json({ items: data || [], total: count || 0 })
    }),
  )
  // Attachments are streamed from Gmail on request and never written to the database or disk.
  app.get(
    '/api/communications/:id/attachments/:index',
    ...auth,
    guard,
    gmailGate,
    wrap(async (req, res) => {
      const { name, mimeType, file } = await gmailAttachment(
        req,
        await own(req, String(req.params.id)),
        Number(req.params.index),
      )
      res.setHeader('Content-Type', mimeType)
      res.setHeader('Content-Disposition', attachmentDisposition(name))
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'")
      res.setHeader('Content-Length', String(file.length))
      res.end(file)
    }),
  )
  app.get(
    '/api/communications/settings',
    ...auth,
    guard,
    wrap(async (req, res) => {
      const user = current(req),
        row = await settings(user.organizationId, user.id),
        config = await account(user.organizationId)
      const enabled = Boolean(config?.platform_enabled && config?.account_enabled && config?.encrypted_config)
      const connected = Boolean(row?.gmail_refresh_token && row.gmail_config_revision === config?.revision)
      res.json({
        discordUserId: row?.discord_user_id || '',
        captureMentions: row?.discord_capture_mentions ?? true,
        gmailEmail: connected ? row.gmail_email || '' : '',
        gmailLabels: row?.gmail_labels || [],
        gmailLabelCatalog: row?.gmail_label_catalog || [],
        gmailConnected: connected,
        gmailReconnectRequired: Boolean(row?.gmail_refresh_token && !connected),
        gmailAvailable: enabled,
        gmailPlatformEnabled: Boolean(config?.platform_enabled),
        callbackUrl: `${origin(req)}${CALLBACK}`,
      })
    }),
  )
  app.put(
    '/api/communications/settings',
    ...auth,
    guard,
    wrap(async (req, res) => {
      const user = current(req),
        id = String(req.body?.discordUserId || '').trim()
      if (id && !/^\d{15,22}$/.test(id)) throw new IntegrationError('Enter a valid Discord user ID.')
      const labels = req.body?.gmailLabels
      if (
        !Array.isArray(labels) ||
        labels.length > 30 ||
        labels.some((x: any) => typeof x !== 'string' || x.length > 128)
      )
        throw new IntegrationError('Choose up to 30 Gmail labels.')
      const previous = await settings(user.organizationId, user.id)
      const { error } = await db.from('user_communication_settings').upsert(
        {
          tenant_id: user.organizationId,
          user_id: user.id,
          discord_user_id: id || null,
          discord_capture_mentions: req.body?.captureMentions !== false,
          gmail_labels: [...new Set(labels)],
          gmail_email: previous?.gmail_email || null,
          gmail_refresh_token: previous?.gmail_refresh_token || null,
          gmail_label_catalog: previous?.gmail_label_catalog || [],
          gmail_sync_state:
            JSON.stringify([...(previous?.gmail_labels || [])].sort()) === JSON.stringify([...labels].sort())
              ? previous?.gmail_sync_state || {}
              : {},
          gmail_config_revision: previous?.gmail_config_revision || null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'tenant_id,user_id' },
      )
      if (error)
        throw new IntegrationError(
          error.code === '23505'
            ? 'This Discord account is already linked to another user in this workspace.'
            : 'Could not save communication settings.',
          error.code === '23505' ? 409 : 503,
        )
      if (JSON.stringify([...(previous?.gmail_labels || [])].sort()) !== JSON.stringify([...labels].sort()))
        gmailBackfillCooldowns.delete(`${user.organizationId}:${user.id}`)
      res.json({ saved: true })
    }),
  )
  app.post(
    '/api/communications',
    ...auth,
    guard,
    wrap(async (req, res) => {
      if (current(req).role === 'Viewer')
        throw new IntegrationError('Viewer accounts cannot create communications.', 403)
      const subject = requireText(req.body?.subject, 'Subject', 200),
        body = requireText(req.body?.body, 'Message', 30000)
      if (!subject && !body) throw new IntegrationError('Enter a subject or message.')
      const { data, error } = await db
        .from('user_communications')
        .insert({
          tenant_id: current(req).organizationId,
          owner_user_id: current(req).id,
          source: 'Manual',
          subject,
          body,
          sender: current(req).name,
        })
        .select('*')
        .single()
      if (error) throw error
      res.status(201).json({ item: data })
    }),
  )
  app.patch(
    '/api/communications/:id',
    ...auth,
    guard,
    wrap(async (req, res) => {
      await own(req, req.params.id)
      const status = String(req.body?.status || '')
      if (!['New', 'Open', 'Resolved', 'Archived'].includes(status)) throw new IntegrationError('Invalid status.')
      const { data, error } = await db
        .from('user_communications')
        .update({ status })
        .eq('id', req.params.id)
        .eq('tenant_id', current(req).organizationId)
        .eq('owner_user_id', current(req).id)
        .select('*')
        .single()
      if (error) throw error
      res.json({ item: data })
    }),
  )
  // Unread email and Discord messages, for the badge on Work Hub. Archived messages are not counted.
  app.get(
    '/api/communications/unread',
    ...auth,
    guard,
    wrap(async (req, res) => {
      const user = current(req)
      const counts: Record<string, number> = {}
      for (const source of UNREAD_SOURCES) {
        const { count, error } = await db
          .from('user_communications')
          .select('id', { count: 'exact', head: true })
          .eq('tenant_id', user.organizationId)
          .eq('owner_user_id', user.id)
          .eq('source', source)
          .neq('status', 'Archived')
          .is('read_at', null)
        if (missingReadColumn(error)) {
          res.json({ available: false, gmail: 0, discord: 0 })
          return
        }
        if (error) throw error
        counts[source] = count || 0
      }
      res.json({ available: true, gmail: counts.Gmail, discord: counts.Discord })
    }),
  )
  // Opening a message marks it, and the rest of its conversation, as read. It can be marked unread again.
  app.patch(
    '/api/communications/:id/read',
    ...auth,
    guard,
    wrap(async (req, res) => {
      const message = await own(req, String(req.params.id)),
        user = current(req)
      if (typeof req.body?.read !== 'boolean') throw new IntegrationError('Say whether the message is read.')
      if (!('read_at' in message))
        throw new IntegrationError(
          'Read and unread are unavailable. Check the database connection; a new database needs database/schema.sql.',
          503,
        )
      const readAt = req.body.read ? new Date().toISOString() : null
      let query = db
        .from('user_communications')
        .update({ read_at: readAt })
        .eq('tenant_id', user.organizationId)
        .eq('owner_user_id', user.id)
      query =
        req.body.read && message.thread_id
          ? query.eq('source', message.source).eq('thread_id', message.thread_id).is('read_at', null)
          : query.eq('id', message.id)
      const { error } = await query
      if (error) throw error
      res.json({ id: message.id, read_at: readAt })
    }),
  )
  app.post(
    '/api/communications/read-all',
    ...auth,
    guard,
    wrap(async (req, res) => {
      const user = current(req),
        source = String(req.body?.source || '')
      if (!(UNREAD_SOURCES as readonly string[]).includes(source))
        throw new IntegrationError('Choose Gmail or Discord.')
      const { error } = await db
        .from('user_communications')
        .update({ read_at: new Date().toISOString() })
        .eq('tenant_id', user.organizationId)
        .eq('owner_user_id', user.id)
        .eq('source', source)
        .neq('status', 'Archived')
        .is('read_at', null)
      if (missingReadColumn(error))
        throw new IntegrationError(
          'Read and unread are unavailable. Check the database connection; a new database needs database/schema.sql.',
          503,
        )
      if (error) throw error
      res.json({ ok: true })
    }),
  )
}
