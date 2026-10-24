import { randomUUID } from 'node:crypto'
import type { Express, Request, Response, NextFunction } from 'express'
import { IntegrationError } from './tenant-integrations'
import { LifecycleError } from '../../src/features/tasks/lifecycle'
import {
  EMAIL_LIMITS,
  blockedAttachmentReason,
  formatBytes,
  parseRecipients,
  recipientSummary,
  replyRecipients,
} from '../../src/features/email/emailCompose'
import { buildMessage, hasScope, messageIds, SEND_SCOPE, type OutgoingAttachment } from './gmail-send'
import { driveName } from './google-drive'
import { createContactBook } from './gmail-contacts'

/**
 * Send an email from a person's own Gmail account, link it to tasks or subtasks, and keep a private copy in Work Hub.
 * The tracker never holds a draft: the browser waits out the undo window, then makes this one call.
 */
type Middleware = (req: Request, res: Response, next: NextFunction) => any
export type OutboundDeps = {
  db: any
  auth: Middleware[]
  guard: Middleware
  gmailGate: Middleware
  wrap: (fn: (req: Request, res: Response) => Promise<any>) => Middleware
  current: (req: Request) => any
  google: (url: string, init: RequestInit, timeout?: number) => Promise<any>
  settings: (tenantId: string, userId: string) => Promise<any>
  activeAccount: (tenantId: string) => Promise<{ row: any }>
  accessGrant: (req: Request) => Promise<{ token: string; scope: string }>
  own: (req: Request, id: string) => Promise<any>
  load: (tenantId: string) => Promise<any>
  commit: (tenantId: string, next: any, user: any, source: string, current: any) => Promise<any>
  inOrder: (tenantId: string, job: () => Promise<void>) => Promise<void>
  driveFile: (
    tenantId: string,
    taskId: string,
    fileId: string,
    maxBytes: number,
  ) => Promise<{ name: string; mimeType: string; bytes: Buffer }>
  now?: () => number
}

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me'
const REPLAY_MS = 15 * 60_000
const WINDOW_MS = 10 * 60_000
const MAX_SENDS_PER_WINDOW = 20
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/
const oneLine = (value: unknown) =>
  String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

class SendError extends IntegrationError {
  constructor(
    message: string,
    status = 400,
    public code?: string,
    public ambiguous = false,
  ) {
    super(message, status)
  }
}

export function registerOutbound(app: Express, deps: OutboundDeps) {
  const { auth, guard, gmailGate, wrap, current } = deps
  const clock = () => (deps.now ? deps.now() : Date.now())
  const replays = new Map<string, { at: number; promise: Promise<any> }>()
  const recent = new Map<string, number[]>()
  const contacts = createContactBook({ db: deps.db, google: deps.google, now: deps.now })

  /**
   * Type-ahead for the To, Cc and Bcc lines: people this person has emailed (their Gmail Sent folder) or who emailed them.
   * Private to the caller. An empty search warms the list while the composer is open.
   */
  app.get(
    '/api/communications/contacts',
    ...auth,
    guard,
    gmailGate,
    wrap(async (req, res) => {
      const user = current(req)
      res.setHeader('Cache-Control', 'no-store')
      let mailbox = ''
      try {
        const config = await deps.activeAccount(user.organizationId)
        const row = await deps.settings(user.organizationId, user.id)
        if (row?.gmail_refresh_token && row.gmail_config_revision === config.row.revision)
          mailbox = String(row.gmail_email || '')
      } catch (error) {
        if (!(error instanceof IntegrationError)) throw error
      }
      // Disconnected: nothing is suggested, and nothing about the old mailbox is kept.
      if (!mailbox) {
        contacts.forget(user)
        res.json({ people: [], partial: false })
        return
      }
      res.json(
        await contacts.search(
          user,
          mailbox,
          async () => (await deps.accessGrant(req)).token,
          String(req.query.q ?? '').slice(0, 100),
        ),
      )
    }),
  )

  /**
   * Who a reply to this message should go to: the sender, with everyone else on the email copied.
   * Read from Gmail when the person clicks Reply, so it also works for emails that were saved earlier.
   */
  app.get(
    '/api/communications/:id/reply-recipients',
    ...auth,
    guard,
    gmailGate,
    wrap(async (req, res) => {
      const user = current(req)
      const original = await deps.own(req, String(req.params.id))
      if (original.source !== 'Gmail' || !original.external_id)
        throw new SendError('Only Gmail messages can be replied to.')
      const row = await deps.settings(user.organizationId, user.id)
      const { token } = await deps.accessGrant(req)
      const wanted = ['From', 'Reply-To', 'To', 'Cc', 'Delivered-To']
      let meta: any
      try {
        meta = await deps.google(
          `${GMAIL}/messages/${encodeURIComponent(original.external_id)}?${new URLSearchParams([['format', 'metadata'], ...wanted.map(name => ['metadataHeaders', name])])}`,
          { headers: { Authorization: `Bearer ${token}` } },
        )
      } catch (error) {
        if ((error as any)?.upstreamStatus === 404)
          throw new SendError(
            'The original email is no longer in Gmail, so its other recipients cannot be read.',
            404,
            'REPLY_UNAVAILABLE',
          )
        throw error
      }
      const found = (name: string) =>
        (meta.payload?.headers || [])
          .filter((x: any) => String(x.name).toLowerCase() === name)
          .map((x: any) => String(x.value || ''))
      // Delivered-To is the mailbox that received it, which covers an alias the person uses besides the connected address.
      const mine = [String(row?.gmail_email || ''), ...found('delivered-to')]
      res.setHeader('Cache-Control', 'no-store')
      res.json(
        replyRecipients(
          {
            from: found('from').join(','),
            replyTo: found('reply-to').join(','),
            to: found('to').join(','),
            cc: found('cc').join(','),
          },
          mine,
        ),
      )
    }),
  )

  /** What the composer needs to know before it opens: is Gmail connected, and was sending allowed. */
  app.get(
    '/api/communications/send/status',
    ...auth,
    guard,
    gmailGate,
    wrap(async (req, res) => {
      const user = current(req)
      const status = {
        writer: user.role !== 'Viewer',
        available: false,
        connected: false,
        canSend: false,
        reconnectRequired: false,
        email: '',
        message: '',
      }
      try {
        const config = await deps.activeAccount(user.organizationId)
        status.available = true
        const row = await deps.settings(user.organizationId, user.id)
        status.connected = Boolean(row?.gmail_refresh_token && row.gmail_config_revision === config.row.revision)
        status.reconnectRequired = Boolean(row?.gmail_refresh_token) && !status.connected
        if (status.connected) {
          status.email = String(row.gmail_email || '')
          status.canSend = hasScope((await deps.accessGrant(req)).scope, SEND_SCOPE)
        }
      } catch (error) {
        if (!(error instanceof IntegrationError)) throw error
        status.message = error.message
      }
      res.setHeader('Cache-Control', 'no-store')
      res.json(status)
    }),
  )

  app.post('/api/communications/send', ...auth, guard, gmailGate, async (req, res) => {
    try {
      const user = current(req),
        tenantId = user.organizationId
      if (user.role === 'Viewer') throw new SendError('Viewer accounts cannot send email.', 403)
      const requestId = String(req.body?.requestId || '')
      if (!/^[A-Za-z0-9_-]{16,64}$/.test(requestId))
        throw new SendError('This send request has no reference. Reload the page and try again.')
      const now = clock()
      for (const [key, entry] of replays) if (now - entry.at > REPLAY_MS) replays.delete(key)
      const key = `${tenantId}:${user.id}:${requestId}`
      let entry = replays.get(key)
      if (!entry) {
        const userKey = `${tenantId}:${user.id}`
        const lately = (recent.get(userKey) || []).filter(at => now - at < WINDOW_MS)
        if (lately.length >= MAX_SENDS_PER_WINDOW)
          throw new SendError('You have sent many emails in a short time. Wait a few minutes, then try again.', 429)
        recent.set(userKey, [...lately, now])
        const promise = send(req, user, tenantId, req.body || {})
        entry = { at: now, promise }
        replays.set(key, entry)
        // A failure that definitely did not send can be retried. An unconfirmed one keeps its answer so it is not repeated blindly.
        promise.catch(error => {
          if (!(error as SendError).ambiguous) replays.delete(key)
        })
      }
      res.setHeader('Cache-Control', 'no-store')
      res.json(await entry.promise)
    } catch (error) {
      const known = error instanceof IntegrationError
      res.status(known ? error.status : 503).json({
        error: known ? error.message : 'Email could not be sent right now.',
        ...(error instanceof SendError && error.code ? { code: error.code } : {}),
      })
    }
  })

  async function send(req: Request, user: any, tenantId: string, body: any) {
    // 1. Check everything that can be checked before touching Gmail or Drive.
    const to = parseRecipients(body.to),
      cc = parseRecipients(body.cc),
      bcc = parseRecipients(body.bcc)
    const invalid = [...to.invalid, ...cc.invalid, ...bcc.invalid]
    if (invalid.length) throw new SendError(`These are not valid email addresses: ${invalid.slice(0, 3).join(', ')}.`)
    if (!to.addresses.length) throw new SendError('Add at least one recipient.')
    const everyone = new Set([...to.addresses, ...cc.addresses, ...bcc.addresses].map(x => x.toLowerCase()))
    if (everyone.size > EMAIL_LIMITS.recipients)
      throw new SendError(`An email can go to at most ${EMAIL_LIMITS.recipients} recipients.`)
    const subject = oneLine(body.subject),
      text = typeof body.message === 'string' ? body.message.replace(/\r\n?/g, '\n').trim() : ''
    if (!subject) throw new SendError('Enter a subject.')
    if (subject.length > EMAIL_LIMITS.subject)
      throw new SendError(`The subject can be up to ${EMAIL_LIMITS.subject} characters.`)
    if (text.length > EMAIL_LIMITS.body)
      throw new SendError(`The message can be up to ${EMAIL_LIMITS.body.toLocaleString()} characters.`)
    const taskIds = [
      ...new Set(
        (Array.isArray(body.taskIds) ? body.taskIds : []).filter(
          (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= 100,
        ),
      ),
    ] as string[]
    if (!taskIds.length) throw new SendError('Link the email to a task or subtask first.')
    if (taskIds.length > EMAIL_LIMITS.taskLinks)
      throw new SendError(`An email can be linked to at most ${EMAIL_LIMITS.taskLinks} tasks.`)
    const driveRefs = (Array.isArray(body.driveFiles) ? body.driveFiles : []).filter(
      (x: any) => x && typeof x.taskId === 'string' && typeof x.fileId === 'string',
    )
    const uploads = Array.isArray(body.uploads) ? body.uploads : []
    if (driveRefs.length + uploads.length > EMAIL_LIMITS.attachments)
      throw new SendError(`An email can have at most ${EMAIL_LIMITS.attachments} attachments.`)
    if (!text && !driveRefs.length && !uploads.length) throw new SendError('Write a message or attach a file.')

    const state = (await deps.load(tenantId)).data
    if (!state) throw new SendError('Workspace data is unavailable.', 503)
    const items: any[] = Array.isArray(state.items) ? state.items : []
    const tasks = taskIds.map(id => items.find(item => item?.id === id))
    if (tasks.some(task => !task))
      throw new SendError('A linked task or subtask no longer exists. Choose it again.', 404)

    // 2. Gmail must be connected with permission to send.
    let grant: { token: string; scope: string }
    try {
      grant = await deps.accessGrant(req)
    } catch (error) {
      if ((error as any)?.upstreamStatus === 400 || (error as any)?.upstreamStatus === 401)
        throw new SendError(
          'Gmail access was revoked or has expired. Reconnect Gmail in Work Hub → My integration settings.',
          409,
          'RECONNECT_REQUIRED',
        )
      throw error
    }
    if (!hasScope(grant.scope, SEND_SCOPE))
      throw new SendError(
        'Sending email from the tracker needs your permission. Allow sending, then try again.',
        403,
        'SEND_SCOPE_REQUIRED',
      )
    const row = await deps.settings(tenantId, user.id)
    const fromEmail = String(row?.gmail_email || '')
    if (!fromEmail) throw new SendError('Connect your Gmail account first.', 409, 'RECONNECT_REQUIRED')

    // 3. Gather attachments: uploads from the computer first, then Drive files saved on tasks.
    const attachments: OutgoingAttachment[] = []
    let remaining: number = EMAIL_LIMITS.attachmentBytes
    const tooLarge = (name: string) =>
      new SendError(
        `“${name}” does not fit. Attachments can total ${formatBytes(EMAIL_LIMITS.attachmentBytes)} so the email stays under Gmail's 25 MB limit.`,
        413,
      )
    for (const upload of uploads) {
      const name = driveName(String(upload?.name || '').replace(/[\\/]/g, '_'), '').slice(0, 180)
      const data = String(upload?.data || '')
      if (!name || !data || !BASE64.test(data))
        throw new SendError('An attached file could not be read. Remove it and attach it again.')
      const blocked = blockedAttachmentReason(name)
      if (blocked) throw new SendError(blocked)
      const bytes = Buffer.from(data, 'base64')
      if (!bytes.length) throw new SendError(`“${name}” is empty.`)
      if (bytes.length > remaining) throw tooLarge(name)
      remaining -= bytes.length
      attachments.push({ name, mimeType: String(upload?.mimeType || 'application/octet-stream'), bytes })
    }
    const seenDrive = new Set<string>()
    for (const ref of driveRefs) {
      if (seenDrive.has(ref.fileId)) continue
      seenDrive.add(ref.fileId)
      const owner = items.find(item => item?.id === ref.taskId)
      const listed = (Array.isArray(owner?.driveFiles) ? owner.driveFiles : []).find(
        (file: any) => file.id === ref.fileId,
      )
      if (!listed)
        throw new SendError('A selected Drive file is no longer saved on its task. Remove it and choose it again.', 404)
      const blocked = blockedAttachmentReason(String(listed.name))
      if (blocked) throw new SendError(blocked)
      if (Number(listed.size) > remaining) throw tooLarge(String(listed.name))
      let file
      try {
        file = await deps.driveFile(tenantId, ref.taskId, ref.fileId, remaining)
      } catch (error) {
        if (error instanceof IntegrationError && error.status === 413) throw tooLarge(String(listed.name))
        throw error
      }
      remaining -= file.bytes.length
      attachments.push({ name: String(listed.name || file.name), mimeType: file.mimeType, bytes: file.bytes })
    }

    // 4. A reply keeps the Gmail conversation: same thread id and the original's message id.
    const headers = { Authorization: `Bearer ${grant.token}` }
    let threadId = '',
      inReplyTo = '',
      references: string[] = []
    if (body.replyToId) {
      const original = await deps.own(req, String(body.replyToId))
      if (original.source !== 'Gmail' || !original.external_id)
        throw new SendError('Only Gmail messages can be replied to.')
      try {
        const meta = await deps.google(
          `${GMAIL}/messages/${encodeURIComponent(original.external_id)}?${new URLSearchParams([
            ['format', 'metadata'],
            ['metadataHeaders', 'Message-ID'],
            ['metadataHeaders', 'References'],
          ])}`,
          { headers },
        )
        const header = (name: string) =>
          String((meta.payload?.headers || []).find((x: any) => String(x.name).toLowerCase() === name)?.value || '')
        const own = messageIds(header('message-id'), 1)
        threadId = String(meta.threadId || '')
        if (own[0]) {
          inReplyTo = own[0]
          references = [...messageIds(header('references'), 19), own[0]]
        }
      } catch (error) {
        if ((error as any)?.upstreamStatus === 404)
          throw new SendError(
            'The original email is no longer in Gmail, so the reply cannot be added to its conversation. Send it as a new email instead.',
            409,
            'REPLY_UNAVAILABLE',
          )
        throw error
      }
    }

    // 5. Send. From here on, never report a failure unless Gmail confirmed that it did not send.
    const raw = buildMessage({
      from: { email: fromEmail, name: String(user.name || '') },
      to: to.addresses,
      cc: cc.addresses,
      bcc: bcc.addresses,
      subject,
      text,
      attachments,
      inReplyTo,
      references,
    })
    let sent: any
    try {
      sent = await deps.google(
        `${GMAIL}/messages/send`,
        {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ raw: raw.toString('base64url'), ...(threadId ? { threadId } : {}) }),
        },
        120000,
      )
    } catch (error) {
      if (!(error instanceof IntegrationError))
        throw new SendError(
          'Could not confirm that Gmail sent the email. Check your Gmail Sent folder before sending it again.',
          504,
          'UNCONFIRMED',
          true,
        )
      const status = (error as any).upstreamStatus
      if (status === 401)
        throw new SendError(
          'Gmail access was revoked or has expired. Reconnect Gmail in Work Hub → My integration settings.',
          409,
          'RECONNECT_REQUIRED',
        )
      if (status === 403 && /scope|permission|insufficient/i.test(error.message))
        throw new SendError(
          'Sending email from the tracker needs your permission. Allow sending, then try again.',
          403,
          'SEND_SCOPE_REQUIRED',
        )
      if (status === 400 || status === 413) throw new SendError(`Gmail did not accept the email: ${error.message}`, 400)
      if (error.status === 429) throw new SendError(error.message, 429)
      // A server-side Gmail failure may still have delivered the message.
      throw new SendError(
        `Gmail reported a problem: ${error.message} Check your Gmail Sent folder before sending it again.`,
        502,
        'UNCONFIRMED',
        true,
      )
    }

    // 6. The email is out. Record it; problems here become warnings, never failures.
    contacts.remember(user, fromEmail, [...to.addresses, ...cc.addresses, ...bcc.addresses])
    const warnings: string[] = []
    const first = tasks[0]
    const sentAt = new Date().toISOString()
    const record = {
      tenant_id: tenantId,
      owner_user_id: user.id,
      source: 'Gmail',
      external_id: String(sent.id || ''),
      thread_id: String(sent.threadId || threadId || ''),
      subject,
      body: text.slice(0, EMAIL_LIMITS.body),
      sender: `${oneLine(user.name) || fromEmail} <${fromEmail}>`.slice(0, 500),
      source_label: 'SENT',
      source_labels: ['SENT'],
      attachments: attachments.map(file => ({
        name: file.name,
        partId: '',
        mimeType: file.mimeType,
        size: file.bytes.length,
      })),
      client_id: first.clientId || null,
      project_id: first.projectId || null,
      status: 'Resolved',
      linked_task_id: taskIds[0],
      received_at: sentAt,
    }
    let item: any = null
    try {
      const inserted = await deps.db.from('user_communications').insert(record).select('*').single()
      if (!inserted.error) item = inserted.data
      else if (inserted.error.code === '23505') {
        // A Gmail sync stored the sent message first. Keep that row and add the links to it.
        const found = await deps.db
          .from('user_communications')
          .select('*')
          .eq('tenant_id', tenantId)
          .eq('owner_user_id', user.id)
          .eq('source', 'Gmail')
          .eq('external_id', record.external_id)
          .maybeSingle()
        item = found.data || null
        if (item)
          await deps.db
            .from('user_communications')
            .update({ linked_task_id: taskIds[0] })
            .eq('id', item.id)
            .eq('tenant_id', tenantId)
            .eq('owner_user_id', user.id)
      }
    } catch {
      /* Reported below. */
    }
    if (item) {
      try {
        const ids = [
          ...new Set([
            ...(Array.isArray(item.linked_task_ids) ? item.linked_task_ids : []),
            ...(item.linked_task_id ? [item.linked_task_id] : []),
            ...taskIds,
          ]),
        ].slice(-200)
        const updated = await deps.db
          .from('user_communications')
          .update({ linked_task_ids: ids })
          .eq('id', item.id)
          .eq('tenant_id', tenantId)
          .eq('owner_user_id', user.id)
        if (!updated.error) item = { ...item, linked_task_ids: ids }
      } catch {
        /* Older schema: the single linked task still works. */
      }
    } else warnings.push('The email was sent, but a copy could not be saved in Work Hub.')

    try {
      // Blind copies stay out of the shared note.
      const note = `Emailed ${recipientSummary([...to.addresses, ...cc.addresses])} “${subject.slice(0, 80)}”${attachments.length ? ` with ${attachments.length} attachment${attachments.length === 1 ? '' : 's'}` : ''} for ${first.parentTaskId ? 'subtask' : 'task'} "${oneLine(first.title).slice(0, 80)}"${taskIds.length > 1 ? ` (+${taskIds.length - 1} more linked)` : ''}`
      await deps.inOrder(tenantId, async () => {
        for (let attempt = 0; ; attempt++) {
          const latest = (await deps.load(tenantId)).data
          if (!latest || !latest.items?.some((x: any) => x.id === first.id)) return
          const activity = {
            id: randomUUID(),
            clientId: first.clientId || undefined,
            projectId: first.projectId || undefined,
            date: sentAt.slice(0, 10),
            text: note.slice(0, 300),
          }
          try {
            await deps.commit(
              tenantId,
              { ...latest, activity: [activity, ...(latest.activity || [])] },
              user,
              'email-sent',
              latest,
            )
            return
          } catch (error) {
            if (!(error instanceof LifecycleError) || attempt >= 2) throw error
          }
        }
      })
    } catch {
      warnings.push('The email was sent, but the activity note could not be added to the task.')
    }

    return {
      ok: true,
      id: String(sent.id || ''),
      threadId: String(sent.threadId || threadId || ''),
      to: to.addresses,
      attachments: attachments.length,
      item,
      ...(warnings.length ? { warning: warnings.join(' ') } : {}),
    }
  }
  return {}
}
