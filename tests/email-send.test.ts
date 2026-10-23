import assert from 'node:assert/strict'
import { test } from 'node:test'
import express from 'express'
import { registerOutbound } from '../server/integrations/gmail-outbound'
import { buildMessage, hasScope, messageIds, mimeWords, SEND_SCOPE, READ_SCOPE } from '../server/integrations/gmail-send'
import { IntegrationError } from '../server/integrations/tenant-integrations'
import { blockedAttachmentReason, extractAddress, parseRecipients, quoteReply, recipientSummary, replyRecipients, replySubject, splitAddresses } from '../src/emailCompose'

/** Minimal MIME reader for the messages this feature writes: unfolds headers and splits one level of multipart. */
function readMime(raw: Buffer) {
  const text = raw.toString('utf8')
  const split = (value: string) => { const at = value.indexOf('\r\n\r\n'); return { head: value.slice(0, at), body: value.slice(at + 4) } }
  const headers = (head: string) => {
    const result: Record<string, string> = {}
    for (const line of head.replace(/\r\n[ \t]+/g, ' ').split('\r\n')) { const at = line.indexOf(':'); result[line.slice(0, at).toLowerCase()] = line.slice(at + 1).trim() }
    return result
  }
  const top = split(text), topHeaders = headers(top.head)
  const boundary = /boundary="([^"]+)"/.exec(topHeaders['content-type'] || '')?.[1]
  const parts = boundary
    ? top.body.split(`--${boundary}`).slice(1, -1).map(part => { const p = split(part.replace(/^\r\n/, '')); return { headers: headers(p.head), body: p.body.replace(/\r\n$/, '') } })
    : [{ headers: topHeaders, body: top.body }]
  return { headers: topHeaders, parts, lines: text.split('\r\n') }
}
// Whitespace between two encoded words is not part of the text; anything else is kept.
const decodeWords = (value: string) => value.replace(/=\?UTF-8\?B\?([^?]+)\?=(?:\s+(?==\?UTF-8\?B\?))?/g, (_m, data) => Buffer.from(data, 'base64').toString('utf8'))
const bodyText = (part: { body: string }) => Buffer.from(part.body.replace(/\r\n/g, ''), 'base64').toString('utf8')

test('recipients are validated, de-duplicated and split from pasted lists', () => {
  assert.deepEqual(splitAddresses('Ana Cruz <ana@acme.com>, "Lee, Bo" <bo@acme.com>; kim@acme.com\nsam@acme.com'), ['ana@acme.com', 'bo@acme.com', 'kim@acme.com', 'sam@acme.com'])
  assert.equal(extractAddress('mailto:ana@acme.com'), 'ana@acme.com')
  assert.deepEqual(parseRecipients(['ana@acme.com', 'ANA@acme.com', 'not an address', 'a@b', 'x..y@acme.com']), { addresses: ['ana@acme.com'], invalid: ['not an address', 'a@b', 'x..y@acme.com'] })
  assert.deepEqual(parseRecipients('bad\r\nBcc: evil@x.com').invalid.length, 2, 'A line break cannot smuggle a second header into one address')
  assert.equal(replySubject('Quarterly review'), 'Re: Quarterly review');assert.equal(replySubject('RE: Quarterly review'), 'RE: Quarterly review')
  assert.equal(recipientSummary(['a@x.com']), 'a@x.com');assert.equal(recipientSummary(['a@x.com', 'b@x.com', 'c@x.com']), 'a@x.com and 2 others')
  assert.match(quoteReply('Ana <ana@acme.com>', '2026-10-23T01:00:00Z', 'Line one\nLine two'), /wrote:\n> Line one\n> Line two$/)
  assert.match(blockedAttachmentReason('setup.EXE'), /Gmail does not allow/);assert.equal(blockedAttachmentReason('signed DRF.pdf'), '');assert.equal(blockedAttachmentReason('exe'), '')
  assert.ok(hasScope(`${READ_SCOPE} ${SEND_SCOPE}`, SEND_SCOPE));assert.ok(!hasScope(READ_SCOPE, SEND_SCOPE))
  assert.deepEqual(messageIds('<a@x> junk <b@x>'), ['<a@x>', '<b@x>'])
})

test('the message builder writes safe, readable MIME', () => {
  const pdf = Buffer.from('%PDF-1.7 fake pdf bytes ' + 'x'.repeat(200))
  const raw = buildMessage({
    from: { email: 'me@acme.com', name: 'José "JB" Cruz' }, to: ['ana@acme.com'], cc: ['kim@acme.com'], bcc: ['boss@acme.com'],
    subject: 'Signed DRF – Sorsogon City ✔\r\nBcc: evil@example.com', text: 'Hello Ana,\nPlease see the attached.\n— José',
    attachments: [{ name: 'DRF "final" – Sorsogon.pdf', mimeType: 'application/pdf', bytes: pdf }], inReplyTo: '<orig@mail.gmail.com>', references: ['<root@mail.gmail.com>', '<orig@mail.gmail.com>'],
    date: new Date('2026-10-23T01:02:03Z'),
  })
  const mime = readMime(raw)
  assert.equal(mime.headers['mime-version'], '1.0');assert.equal(mime.headers.date, 'Fri, 23 Oct 2026 01:02:03 GMT')
  assert.ok(!mime.lines.some(line => /^bcc: evil/i.test(line)), 'A line break in the subject cannot add a header')
  assert.equal(decodeWords(mime.headers.subject), 'Signed DRF – Sorsogon City ✔ Bcc: evil@example.com')
  assert.equal(mime.headers.to, 'ana@acme.com');assert.equal(mime.headers.cc, 'kim@acme.com');assert.equal(mime.headers.bcc, 'boss@acme.com')
  assert.equal(decodeWords(mime.headers.from), 'José "JB" Cruz <me@acme.com>')
  assert.equal(mime.headers['in-reply-to'], '<orig@mail.gmail.com>');assert.equal(mime.headers.references, '<root@mail.gmail.com> <orig@mail.gmail.com>')
  assert.ok(raw.every(byte => byte < 128), 'Everything on the wire is ASCII')
  assert.ok(mime.lines.every(line => line.length <= 998) && mime.lines.filter(line => !/^(--|[A-Za-z-]+:)/.test(line)).every(line => line.length <= 76), 'Lines stay short enough for every mail server')
  assert.equal(mime.parts.length, 2)
  assert.equal(bodyText(mime.parts[0]), 'Hello Ana,\r\nPlease see the attached.\r\n— José')
  assert.equal(mime.parts[1].headers['content-type'], 'application/pdf; name="DRF _final_ – Sorsogon.pdf"'.replace('–', '_'))
  assert.match(mime.parts[1].headers['content-disposition'], /^attachment; filename="DRF _final_ _ Sorsogon\.pdf"; filename\*=UTF-8''DRF%20_final_%20%E2%80%93%20Sorsogon\.pdf$/)
  assert.deepEqual(Buffer.from(mime.parts[1].body.replace(/\r\n/g, ''), 'base64'), pdf)
  // No attachments: a single text part, no multipart wrapper.
  const plain = readMime(buildMessage({ from: { email: 'me@acme.com' }, to: ['ana@acme.com'], subject: 'Hi', text: 'Plain' }))
  assert.equal(plain.parts.length, 1);assert.equal(plain.headers.from, 'me@acme.com');assert.match(plain.headers['content-type'], /^text\/plain; charset="UTF-8"$/)
  // Long non-ASCII subjects are split into encoded words of at most 75 characters, without cutting a character in half.
  const long = 'Réponse très détaillée — '.repeat(8), words = mimeWords(long)
  assert.ok(words.split('\r\n ').every(word => word.length <= 75));assert.equal(decodeWords(words.replace(/\r\n /g, ' ')).replace(/\s+/g, ' ').trim(), long.replace(/\s+/g, ' ').trim())
})

// ---- the send route ----
type Calls = { sent: any[]; metadata: string[]; driveReads: string[]; commits: any[]; statusScope: string }
function harness(options: { scope?: string; gmail?: (url: URL, init: any) => any; failInsert?: any; existing?: any } = {}) {
  const rows: any[] = options.existing ? [options.existing] : []
  const calls: Calls = { sent: [], metadata: [], driveReads: [], commits: [], statusScope: options.scope ?? `${READ_SCOPE} ${SEND_SCOPE}` }
  let state: any = {
    clients: [{ id: 'c1', name: 'Acme' }], projects: [{ id: 'p1', name: 'Rollout' }], activity: [],
    items: [
      { id: 't1', title: 'Sorsogon City', clientId: 'c1', projectId: 'p1', driveFiles: [{ id: 'f1', name: 'signed DRF.pdf', size: 40, mimeType: 'application/pdf' }, { id: 'f2', name: 'setup.exe', size: 10, mimeType: 'application/octet-stream' }, { id: 'big', name: 'huge.pdf', size: 20 * 1024 * 1024, mimeType: 'application/pdf' }] },
      { id: 's1', title: 'DRF Creation', parentTaskId: 't1', clientId: 'c1', projectId: 'p1' },
    ],
  }
  class Query {
    conditions: ((x: any) => boolean)[] = []; action = 'read'; value: any
    select() { return this }
    eq(key: string, value: any) { this.conditions.push(x => x[key] === value); return this }
    insert(value: any) { this.action = 'insert'; this.value = value; return this }
    update(value: any) { this.action = 'update'; this.value = value; return this }
    maybeSingle() { return this.run(true) }
    single() { return this.run(true) }
    then(resolve: any, reject: any) { return this.run(false).then(resolve, reject) }
    async run(single: boolean) {
      if (this.action === 'insert') {
        if (options.failInsert) return { data: null, error: options.failInsert }
        if (rows.some(x => x.external_id === this.value.external_id)) return { data: null, error: { code: '23505' } }
        const row = { id: `row-${rows.length + 1}`, ...this.value }; rows.push(row); return { data: row, error: null }
      }
      const found = rows.filter(x => this.conditions.every(c => c(x)))
      if (this.action === 'update') { for (const row of found) Object.assign(row, this.value); return { data: null, error: null } }
      return { data: single ? found[0] || null : found, error: null }
    }
  }
  const app = express(); app.use(express.json({ limit: '30mb' }))
  app.use((req: any, _res: any, next: any) => { req.authUser = { id: String(req.headers['x-user'] || 'u1'), organizationId: 't', name: 'José Cruz', role: String(req.headers['x-role'] || 'Contributor') }; next() })
  const pass = (_req: any, _res: any, next: any) => next()
  const googleCalls: string[] = []
  const gmailDefault = (url: URL, init: any) => {
    if (url.pathname.endsWith('/messages/send')) { const body = JSON.parse(init.body); calls.sent.push({ ...body, mime: readMime(Buffer.from(body.raw, 'base64url')), rawBytes: Buffer.from(body.raw, 'base64url') }); return { id: `sent-${calls.sent.length}`, threadId: body.threadId || `thread-${calls.sent.length}` } }
    calls.metadata.push(url.pathname); return { id: 'orig', threadId: 'thread-orig', payload: { headers: [{ name: 'Message-Id', value: '<orig@mail.gmail.com>' }, { name: 'References', value: '<root@mail.gmail.com>' }] } }
  }
  registerOutbound(app as any, {
    db: { from: () => new Query() }, auth: [pass], guard: pass, gmailGate: pass, wrap: (fn: any) => async (req: any, res: any) => { try { await fn(req, res) } catch (e: any) { res.status(e instanceof IntegrationError ? e.status : 503).json({ error: e.message }) } },
    current: (req: any) => req.authUser,
    google: async (url: string, init: any) => { googleCalls.push(url); return (options.gmail || gmailDefault)(new URL(url), init) },
    settings: async () => ({ gmail_email: 'me@acme.com', gmail_refresh_token: 'x', gmail_config_revision: 'v1' }),
    activeAccount: async () => ({ row: { revision: 'v1' } }),
    accessGrant: async () => ({ token: 'gmail-access', scope: calls.statusScope }),
    own: async (_req: any, id: string) => { if (id !== 'mail-1') throw new IntegrationError('Communication not found.', 404); return { id, source: 'Gmail', external_id: 'orig' } },
    load: async () => ({ data: state }), commit: async (_t: string, next: any, _u: any, source: string) => { calls.commits.push(source); state = next },
    inOrder: async (_t: string, job: () => Promise<void>) => job(),
    driveFile: async (_t: string, taskId: string, fileId: string, max: number) => { calls.driveReads.push(`${taskId}:${fileId}`); const bytes = Buffer.from('%PDF-1.7 signed'); if (bytes.length > max) throw new IntegrationError('This file is too large.', 413); return { name: 'signed DRF.pdf', mimeType: 'application/pdf', bytes } },
  })
  return { app, rows, calls, googleCalls, getState: () => state }
}
async function serve(h: ReturnType<typeof harness>, run: (ask: (path: string, body?: any, headers?: Record<string, string>) => Promise<{ status: number; body: any }>) => Promise<void>) {
  const server = h.app.listen(0)
  try {
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port')
    const ask = async (path: string, body?: any, headers: Record<string, string> = {}) => {
      const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
      return { status: response.status, body: await response.json() }
    }
    await run(ask)
  } finally { server.close() }
}
const valid = (extra: any = {}) => ({ requestId: `req-${Math.random().toString(36).slice(2)}-0123456789`, to: 'Ana <ana@acme.com>', cc: 'kim@acme.com', subject: 'Signed DRF', message: 'Please find the signed DRF.', taskIds: ['s1', 't1'], driveFiles: [{ taskId: 't1', fileId: 'f1' }], ...extra })

test('status reports whether sending is allowed', async () => {
  const withSend = harness()
  await serve(withSend, async ask => {
    const status = await ask('/api/communications/send/status')
    assert.deepEqual(status.body, { writer: true, available: true, connected: true, canSend: true, reconnectRequired: false, email: 'me@acme.com', message: '' })
    assert.equal((await ask('/api/communications/send/status', undefined, { 'x-role': 'Viewer' })).body.writer, false)
  })
  const readOnly = harness({ scope: READ_SCOPE })
  await serve(readOnly, async ask => assert.equal((await ask('/api/communications/send/status')).body.canSend, false))
})

test('a document email goes out from the person’s Gmail, with its attachments, and is linked to the subtask', async () => {
  const h = harness()
  await serve(h, async ask => {
    const png = Buffer.from('PNG-bytes!')
    const result = await ask('/api/communications/send', valid({ uploads: [{ name: 'photo.png', mimeType: 'image/png', data: png.toString('base64') }] }))
    assert.equal(result.status, 200, JSON.stringify(result.body));assert.equal(result.body.ok, true);assert.equal(result.body.attachments, 2)
    assert.equal(h.calls.sent.length, 1)
    const mime = h.calls.sent[0].mime
    assert.equal(decodeWords(mime.headers.from), 'José Cruz <me@acme.com>');assert.equal(mime.headers.to, 'ana@acme.com');assert.equal(mime.headers.cc, 'kim@acme.com')
    assert.equal(bodyText(mime.parts[0]), 'Please find the signed DRF.')
    assert.deepEqual(mime.parts.slice(1).map((p: any) => /name="([^"]+)"/.exec(p.headers['content-type'])?.[1]), ['photo.png', 'signed DRF.pdf'])
    assert.deepEqual(Buffer.from(mime.parts[1].body.replace(/\r\n/g, ''), 'base64'), png)
    assert.deepEqual(h.calls.driveReads, ['t1:f1'], 'The Drive file is read on the server, not sent through the browser')
    // A private copy is kept in Work Hub, marked as sent and linked to every chosen task.
    assert.equal(h.rows.length, 1)
    assert.deepEqual({ source: h.rows[0].source, status: h.rows[0].status, labels: h.rows[0].source_labels, task: h.rows[0].linked_task_id, tasks: h.rows[0].linked_task_ids, thread: h.rows[0].thread_id, client: h.rows[0].client_id }, { source: 'Gmail', status: 'Resolved', labels: ['SENT'], task: 's1', tasks: ['s1', 't1'], thread: 'thread-1', client: 'c1' })
    assert.equal(h.rows[0].sender, 'José Cruz <me@acme.com>');assert.equal(h.rows[0].external_id, 'sent-1');assert.deepEqual(h.rows[0].attachments.map((a: any) => a.name), ['photo.png', 'signed DRF.pdf'])
    // The team sees that the email went out, but never its text.
    assert.equal(h.calls.commits.length, 1);assert.equal(h.calls.commits[0], 'email-sent')
    const note = h.getState().activity[0]
    assert.match(note.text, /^Emailed ana@acme\.com and 1 other “Signed DRF” with 2 attachments for subtask "DRF Creation" \(\+1 more linked\)$/)
    assert.ok(!JSON.stringify(h.getState()).includes('Please find'), 'The message text stays private')
    assert.equal(note.clientId, 'c1')
  })
})

test('clicking twice or retrying never sends the same email twice', async () => {
  const h = harness()
  await serve(h, async ask => {
    const body = valid()
    const [a, b] = await Promise.all([ask('/api/communications/send', body), ask('/api/communications/send', body)])
    assert.equal(a.status, 200);assert.equal(b.status, 200);assert.equal(a.body.id, b.body.id)
    assert.equal(h.calls.sent.length, 1, 'One request reference, one email')
    assert.equal((await ask('/api/communications/send', body)).body.id, a.body.id, 'A later retry gets the same answer')
    assert.equal(h.calls.sent.length, 1);assert.equal(h.rows.length, 1)
    assert.equal((await ask('/api/communications/send', { ...body, requestId: 'short' })).status, 400, 'A missing or malformed reference is refused')
    assert.equal((await ask('/api/communications/send', valid())).status, 200);assert.equal(h.calls.sent.length, 2, 'A new compose is a new email')
  })
})

test('an email that is not ready is refused before anything is sent', async () => {
  const h = harness()
  await serve(h, async ask => {
    const refuse = async (extra: any, status: number, pattern: RegExp, headers?: Record<string, string>) => {
      const result = await ask('/api/communications/send', valid(extra), headers)
      assert.equal(result.status, status, JSON.stringify(result.body));assert.match(result.body.error, pattern)
    }
    await refuse({ to: '' }, 400, /at least one recipient/)
    await refuse({ to: 'ana@acme.com, nobody' }, 400, /not valid email addresses: nobody/)
    await refuse({ subject: '  ' }, 400, /Enter a subject/)
    await refuse({ message: '', driveFiles: [] }, 400, /Write a message or attach a file/)
    await refuse({ taskIds: [] }, 400, /Link the email to a task or subtask/)
    await refuse({ taskIds: ['gone'] }, 404, /no longer exists/)
    await refuse({ driveFiles: [{ taskId: 't1', fileId: 'nope' }] }, 404, /no longer saved/)
    await refuse({ driveFiles: [{ taskId: 't1', fileId: 'f2' }] }, 400, /does not allow “\.exe”/)
    await refuse({ driveFiles: [{ taskId: 't1', fileId: 'big' }] }, 413, /does not fit/)
    await refuse({ uploads: [{ name: 'run.js', mimeType: 'text/javascript', data: 'QQ==' }] }, 400, /does not allow “\.js”/)
    await refuse({ uploads: [{ name: 'a.pdf', mimeType: 'application/pdf', data: 'not base64!' }] }, 400, /could not be read/)
    await refuse({ uploads: [{ name: 'a.pdf', mimeType: 'application/pdf', data: Buffer.alloc(13 * 1024 * 1024, 1).toString('base64') }] }, 413, /does not fit/)
    await refuse({ to: Array.from({ length: 26 }, (_x, i) => `p${i}@acme.com`) }, 400, /at most 25 recipients/)
    await refuse({}, 403, /cannot send email/, { 'x-role': 'Viewer' })
    assert.equal(h.calls.sent.length, 0, 'Nothing reached Gmail')
    assert.equal(h.rows.length, 0)
  })
  const readOnly = harness({ scope: READ_SCOPE })
  await serve(readOnly, async ask => {
    const result = await ask('/api/communications/send', valid())
    assert.equal(result.status, 403);assert.equal(result.body.code, 'SEND_SCOPE_REQUIRED');assert.equal(readOnly.calls.sent.length, 0)
    assert.equal(readOnly.calls.driveReads.length, 0, 'No file is downloaded when sending is not allowed')
  })
})

test('a reply stays in the same Gmail conversation', async () => {
  const h = harness()
  await serve(h, async ask => {
    const result = await ask('/api/communications/send', valid({ replyToId: 'mail-1', subject: 'Re: Signed DRF', driveFiles: [] }))
    assert.equal(result.status, 200, JSON.stringify(result.body))
    assert.equal(h.calls.sent[0].threadId, 'thread-orig')
    const headers = h.calls.sent[0].mime.headers
    assert.equal(headers['in-reply-to'], '<orig@mail.gmail.com>');assert.equal(headers.references, '<root@mail.gmail.com> <orig@mail.gmail.com>')
    assert.equal(h.rows[0].thread_id, 'thread-orig', 'The copy joins the received messages in the thread view')
    assert.equal((await ask('/api/communications/send', valid({ replyToId: 'someone-elses' }))).status, 404, 'Only your own messages can be replied to')
  })
  const gone = harness({ gmail: (url: URL) => { if (url.pathname.endsWith('/send')) throw new Error('must not send'); throw Object.assign(new IntegrationError('Not Found', 502), { upstreamStatus: 404 }) } })
  await serve(gone, async ask => {
    const result = await ask('/api/communications/send', valid({ replyToId: 'mail-1' }))
    assert.equal(result.status, 409);assert.equal(result.body.code, 'REPLY_UNAVAILABLE');assert.equal(gone.calls.sent.length, 0)
  })
})

test('Gmail problems are explained, and an unconfirmed send is never repeated blindly', async () => {
  let mode: 'reject' | 'timeout' | 'ok' = 'reject'
  const h = harness({ gmail: (url: URL, init: any) => {
    if (mode === 'reject') throw Object.assign(new IntegrationError('Invalid To header', 502), { upstreamStatus: 400 })
    if (mode === 'timeout') throw new Error('The operation was aborted due to timeout')
    return { id: 'sent-ok', threadId: 'thread-ok', echo: JSON.parse(init.body).raw.length }
  } })
  await serve(h, async ask => {
    const one = valid()
    const rejected = await ask('/api/communications/send', one)
    assert.equal(rejected.status, 400);assert.match(rejected.body.error, /Gmail did not accept the email: Invalid To header/)
    mode = 'ok'
    assert.equal((await ask('/api/communications/send', one)).status, 200, 'A refusal by Gmail can be retried with the same reference')
    mode = 'timeout'
    const unsure = valid(), first = await ask('/api/communications/send', unsure)
    assert.equal(first.status, 504);assert.equal(first.body.code, 'UNCONFIRMED');assert.match(first.body.error, /Check your Gmail Sent folder/)
    mode = 'ok'
    const again = await ask('/api/communications/send', unsure)
    assert.equal(again.status, 504, 'The same reference does not send again after an unconfirmed attempt')
    assert.equal((await ask('/api/communications/send', valid())).status, 200)
  })
})

test('a sent email stays reported as sent when saving the copy or the activity note fails', async () => {
  const h = harness({ failInsert: { code: '500', message: 'db down' } })
  await serve(h, async ask => {
    const result = await ask('/api/communications/send', valid())
    assert.equal(result.status, 200);assert.equal(result.body.ok, true);assert.match(result.body.warning, /copy could not be saved in Work Hub/)
    assert.equal(h.calls.sent.length, 1)
  })
  // A Gmail sync may have stored the sent message first: the links go onto that row instead of a duplicate.
  const existing = { id: 'row-existing', tenant_id: 't', owner_user_id: 'u1', source: 'Gmail', external_id: 'sent-1', thread_id: 'thread-1', subject: 'Signed DRF', status: 'New', source_labels: ['SENT'] }
  const synced = harness({ existing })
  await serve(synced, async ask => {
    const result = await ask('/api/communications/send', valid())
    assert.equal(result.status, 200);assert.equal(result.body.warning, undefined)
    assert.equal(synced.rows.length, 1);assert.deepEqual(synced.rows[0].linked_task_ids, ['s1', 't1']);assert.equal(synced.rows[0].linked_task_id, 's1')
  })
})

test('a reply goes to the sender and copies everyone else on the email, never you', () => {
  const me = ['me@acme.com']
  // The usual case: the sender gets the reply, the other people are copied.
  assert.deepEqual(replyRecipients({ from: 'Ana Cruz <ana@acme.com>', to: 'me@acme.com, Kim <kim@acme.com>', cc: 'sam@acme.com' }, me), { to: ['ana@acme.com'], cc: ['kim@acme.com', 'sam@acme.com'] })
  // Your own address is left out in any case, and an address listed twice is copied once.
  assert.deepEqual(replyRecipients({ from: 'ana@acme.com', to: 'ME@Acme.com, kim@acme.com', cc: 'KIM@acme.com, ana@acme.com' }, me), { to: ['ana@acme.com'], cc: ['kim@acme.com'] })
  // A display name with a comma in it stays one person.
  assert.deepEqual(replyRecipients({ from: '"Cruz, Ana" <ana@acme.com>', to: '"Lee, Bo" <bo@acme.com>, me@acme.com' }, me), { to: ['ana@acme.com'], cc: ['bo@acme.com'] })
  // Reply-To wins over From.
  assert.deepEqual(replyRecipients({ from: 'ana@acme.com', replyTo: 'support@acme.com', to: 'me@acme.com' }, me), { to: ['support@acme.com'], cc: [] })
  // A Reply-To that points back at you falls back to the sender.
  assert.deepEqual(replyRecipients({ from: 'list@acme.com', replyTo: 'me@acme.com', to: 'team@acme.com' }, me), { to: ['list@acme.com'], cc: ['team@acme.com'] })
  // Another address of yours (an alias the email was delivered to) is also left out.
  assert.deepEqual(replyRecipients({ from: 'ana@acme.com', to: 'jose@alias.com, kim@acme.com' }, [...me, 'jose@alias.com']), { to: ['ana@acme.com'], cc: ['kim@acme.com'] })
  // An email you wrote yourself is answered by the people you sent it to.
  assert.deepEqual(replyRecipients({ from: 'José <me@acme.com>', to: 'ana@acme.com, kim@acme.com', cc: 'sam@acme.com' }, me), { to: ['ana@acme.com', 'kim@acme.com'], cc: ['sam@acme.com'] })
  // Nothing usable is lost or invented: bad addresses are dropped, a note to yourself leaves nobody, and a lone Cc is promoted.
  assert.deepEqual(replyRecipients({ from: 'ana@acme.com', to: 'undisclosed-recipients:;, not an address' }, me), { to: ['ana@acme.com'], cc: [] })
  assert.deepEqual(replyRecipients({ from: 'me@acme.com', to: 'me@acme.com' }, me), { to: [], cc: [] })
  assert.deepEqual(replyRecipients({ from: 'me@acme.com', to: '', cc: 'kim@acme.com' }, me), { to: ['kim@acme.com'], cc: [] })
  assert.deepEqual(replyRecipients({}, me), { to: [], cc: [] })
})

test('the reply recipients are read from Gmail for an email that was saved earlier', async () => {
  const asked: string[] = []
  const h = harness({
    gmail: (url: URL) => {
      asked.push(url.search)
      return { id: 'orig', threadId: 'thread-orig', payload: { headers: [
        { name: 'From', value: 'Ana Cruz <ana@acme.com>' }, { name: 'To', value: 'José <me@acme.com>, kim@acme.com' }, { name: 'Cc', value: 'sam@acme.com' },
        { name: 'Delivered-To', value: 'me@acme.com' }, { name: 'Bcc', value: 'secret@acme.com' },
      ] } }
    },
  })
  await serve(h, async ask => {
    const result = await ask('/api/communications/mail-1/reply-recipients')
    assert.equal(result.status, 200, JSON.stringify(result.body))
    assert.deepEqual(result.body, { to: ['ana@acme.com'], cc: ['kim@acme.com', 'sam@acme.com'] })
    // Only the address headers are requested, and nothing is sent or saved.
    const query = new URLSearchParams(asked[0])
    assert.equal(query.get('format'), 'metadata');assert.deepEqual(query.getAll('metadataHeaders'), ['From', 'Reply-To', 'To', 'Cc', 'Delivered-To'])
    assert.equal(h.calls.sent.length, 0);assert.equal(h.rows.length, 0)
    // Another person's message cannot be probed.
    assert.equal((await ask('/api/communications/someone-elses/reply-recipients')).status, 404)
  })
  const gone = harness({ gmail: () => { throw Object.assign(new IntegrationError('Not Found', 502), { upstreamStatus: 404 }) } })
  await serve(gone, async ask => {
    const result = await ask('/api/communications/mail-1/reply-recipients')
    assert.equal(result.status, 404);assert.match(result.body.error, /no longer in Gmail/)
  })
})
