import assert from 'node:assert/strict'
import { afterEach, mock, test } from 'node:test'
import { outbox, UNDO_SECONDS, type EmailDraft } from '../src/features/email/emailOutbox'

const draft = (extra: Partial<EmailDraft> = {}): EmailDraft => ({
  to: 'Ana <ana@acme.com>, kim@acme.com', cc: '', bcc: '', subject: 'Signed DRF', message: 'Attached.', taskIds: ['s1'],
  driveFiles: [{ taskId: 't1', fileId: 'f1', name: 'signed DRF.pdf', size: 1200 }], uploads: [{ name: 'photo.png', mimeType: 'image/png', size: 4, data: 'UE5HIQ==' }], ...extra,
})
const originalFetch = globalThis.fetch
afterEach(() => { outbox.reset(); mock.timers.reset(); globalThis.fetch = originalFetch })
function fakeServer(respond: (body: any, call: number) => { status: number; body: any } | Error) {
  const calls: any[] = []
  globalThis.fetch = (async (_url: any, init: any) => {
    const body = JSON.parse(init.body); calls.push(body)
    const reply = respond(body, calls.length)
    if (reply instanceof Error) throw reply
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return calls
}
// Response bodies resolve on the real event loop, which the mocked timers leave alone.
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)) }

test('an email waits out the undo window and nothing leaves before it ends', async () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 0 })
  const calls = fakeServer(() => ({ status: 200, body: { ok: true } }))
  const sent: string[] = []; outbox.onSent(entry => sent.push(entry.summary))
  const id = outbox.queue(draft())
  assert.equal(UNDO_SECONDS, 10)
  assert.deepEqual(outbox.snapshot().map(e => [e.phase, e.secondsLeft, e.summary]), [['waiting', 10, 'ana@acme.com and 1 other']])
  mock.timers.tick(4000); await settle()
  assert.equal(outbox.snapshot()[0].secondsLeft, 6, 'The countdown follows the clock')
  mock.timers.tick(5500); await settle()
  assert.equal(calls.length, 0, 'Still waiting at 9.5 seconds')
  mock.timers.tick(600); await settle()
  assert.equal(calls.length, 1, 'One send call once the window has passed')
  assert.equal(outbox.snapshot()[0].phase, 'sent')
  // Only references go to the server for Drive files; the bytes never pass through the browser.
  assert.deepEqual(calls[0].driveFiles, [{ taskId: 't1', fileId: 'f1' }])
  assert.deepEqual({ to: calls[0].to, subject: calls[0].subject, taskIds: calls[0].taskIds, upload: calls[0].uploads[0].name }, { to: 'Ana <ana@acme.com>, kim@acme.com', subject: 'Signed DRF', taskIds: ['s1'], upload: 'photo.png' })
  assert.match(calls[0].requestId, /^[A-Za-z0-9_-]{16,64}$/)
  assert.deepEqual(sent, ['ana@acme.com and 1 other'])
  mock.timers.tick(8500); await settle()
  assert.deepEqual(outbox.snapshot(), [], 'The confirmation clears itself')
  assert.equal(outbox.dismiss(id), undefined)
})

test('undo cancels the email and hands the draft back untouched', async () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 0 })
  const calls = fakeServer(() => ({ status: 200, body: { ok: true } }))
  const original = draft({ subject: 'Wrong attachment' }), id = outbox.queue(original)
  mock.timers.tick(7000); await settle()
  assert.deepEqual(outbox.undo(id), original)
  assert.deepEqual(outbox.snapshot(), [])
  mock.timers.tick(30000); await settle()
  assert.equal(calls.length, 0, 'An undone email is never sent')
  assert.equal(outbox.undo('missing'), null)
})

test('send now skips the wait, and a sending email cannot be undone', async () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 0 })
  let release: (value: any) => void = () => {}
  const calls: any[] = []
  globalThis.fetch = (async (_url: any, init: any) => { calls.push(JSON.parse(init.body)); return new Promise(resolve => { release = resolve }) }) as typeof fetch
  const id = outbox.queue(draft())
  outbox.sendNow(id); outbox.sendNow(id); await settle()
  assert.equal(calls.length, 1, 'Pressing twice sends once');assert.equal(outbox.snapshot()[0].phase, 'sending')
  assert.equal(outbox.undo(id), null, 'Too late to take it back')
  mock.timers.tick(20000); await settle()
  assert.equal(calls.length, 1, 'The countdown does not send it a second time')
  release(new Response(JSON.stringify({ ok: true, warning: 'A copy could not be saved.' }), { status: 200, headers: { 'content-type': 'application/json' } })); await settle()
  assert.deepEqual([outbox.snapshot()[0].phase, outbox.snapshot()[0].warning], ['sent', 'A copy could not be saved.'])
})

test('a refused email can be edited, and a dropped connection is retried safely with the same reference', async () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 0 })
  const calls = fakeServer((_body, call) => call === 1 ? { status: 403, body: { error: 'Allow sending first.', code: 'SEND_SCOPE_REQUIRED' } } : call === 2 ? new Error('offline') : { status: 200, body: { ok: true } })
  const first = outbox.queue(draft()); mock.timers.tick(10500); await settle()
  let entry = outbox.snapshot()[0]
  assert.deepEqual([entry.phase, entry.error, entry.code], ['failed', 'Allow sending first.', 'SEND_SCOPE_REQUIRED'])
  assert.deepEqual(outbox.undo(first)?.subject, 'Signed DRF', 'A failed email can be taken back to edit')
  const second = outbox.queue(draft()); mock.timers.tick(10500); await settle()
  entry = outbox.snapshot()[0]
  assert.deepEqual([entry.phase, entry.code], ['failed', 'NETWORK'])
  outbox.retry(second); await settle()
  assert.equal(calls.length, 3);assert.equal(calls[2].requestId, calls[1].requestId, 'The retry carries the same reference, so the server never sends twice')
  assert.equal(outbox.snapshot()[0].phase, 'sent')
})
