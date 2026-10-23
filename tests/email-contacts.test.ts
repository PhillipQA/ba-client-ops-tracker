import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createContactBook } from '../server/integrations/gmail-contacts'
import { applySuggestion, cleanName, currentToken, isAutomaticAddress, matchPeople } from '../src/emailSuggest'
import { splitMailboxes } from '../src/emailCompose'

test('names and addresses are read from a pasted list', () => {
  assert.deepEqual(splitMailboxes('"Cruz, Ana" <ana@acme.com>, kim@acme.com; Bo \\"B\\" <bo@x.com>'), [
    { name: 'Cruz, Ana', email: 'ana@acme.com' }, { name: '', email: 'kim@acme.com' }, { name: 'Bo "B"', email: 'bo@x.com' },
  ])
  assert.equal(cleanName('  Ana\r\nCruz <script> ', 'ana@acme.com'), 'Ana Cruz script', 'A name is one clean line')
  assert.equal(cleanName('ANA@acme.com', 'ana@acme.com'), '', 'A name that is only the address is not a name')
  assert.ok(isAutomaticAddress('no-reply@acme.com') && isAutomaticAddress('DoNotReply@acme.com') && isAutomaticAddress('mailer-daemon@x.com') && !isAutomaticAddress('ana@acme.com') && !isAutomaticAddress('reply@acme.com'))
})

test('typing a name finds people, and choosing one fills in only the piece being typed', () => {
  const token = currentToken('ana@acme.com, ki, bo@x.com', 16)
  assert.deepEqual(token, { start: 13, end: 16, text: 'ki' })
  assert.deepEqual(applySuggestion('ana@acme.com, ki, bo@x.com', token, 'kim@acme.com'), { value: 'ana@acme.com, kim@acme.com, bo@x.com', caret: 28 })
  assert.deepEqual(applySuggestion('ki', { start: 0, end: 2 }, 'kim@acme.com'), { value: 'kim@acme.com, ', caret: 14 })
  assert.equal(currentToken('', 0).text, '');assert.equal(currentToken('a@b.co;  x', 10).text, 'x')

  const people = [
    { email: 'kim.lee@acme.com', name: 'Kim Lee', count: 2 }, { email: 'akim@other.com', name: '', count: 9 },
    { email: 'sam@acme.com', name: 'Sam Reyes', count: 5 }, { email: 'KIM.LEE@acme.com', name: 'Duplicate', count: 1 }, { email: 'bad address', name: 'Kim Bad' },
  ]
  // A match at the start of a word comes first, then the most emailed. Duplicates and invalid addresses never appear.
  assert.deepEqual(matchPeople(people, 'kim').map(p => p.email), ['kim.lee@acme.com', 'akim@other.com'])
  assert.deepEqual(matchPeople(people, 'lee kim').map(p => p.email), ['kim.lee@acme.com'], 'Every word typed must match')
  assert.deepEqual(matchPeople(people, 'acme', { exclude: ['SAM@acme.com'] }).map(p => p.email), ['kim.lee@acme.com'], 'People already on the line are not suggested again')
  assert.deepEqual(matchPeople(people, '', { limit: 1 }).map(p => p.email), ['akim@other.com'], 'With nothing typed, the most emailed come first')
})

// ---- the contact book ----
// An old list is still used while it refreshes in the background, so the refresh finishes after the answer.
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)) }
function setup(options: { sent?: Record<string, { to?: string; cc?: string; bcc?: string; at?: number }>; received?: { sender: string; received_at: string; source_labels?: string[] }[]; failList?: boolean } = {}) {
  const calls = { list: 0, metadata: 0, db: 0, token: 0 }
  let time = Date.UTC(2026, 9, 23)
  const sent = options.sent || {}
  const db = { from: () => {
    const query: any = { select: () => query, eq: () => query, order: () => query, limit: () => query, then: (resolve: any) => { calls.db++; resolve({ data: options.received || [], error: null }) } }
    return query
  } }
  const google = async (url: string) => {
    const parsed = new URL(url)
    if (parsed.pathname.endsWith('/messages')) {
      calls.list++
      if (options.failList) throw new Error('Gmail is down')
      assert.equal(parsed.searchParams.get('labelIds'), 'SENT')
      return { messages: Object.keys(sent).map(id => ({ id })) }
    }
    calls.metadata++
    assert.deepEqual(parsed.searchParams.getAll('metadataHeaders'), ['To', 'Cc', 'Bcc'], 'Only the address headers are read')
    const message = sent[decodeURIComponent(parsed.pathname.split('/').pop() || '')]
    const headers = (['to', 'cc', 'bcc'] as const).filter(name => message[name]).map(name => ({ name: name[0].toUpperCase() + name.slice(1), value: message[name] }))
    return { id: 'x', internalDate: String(message.at ?? time), payload: { headers } }
  }
  const book = createContactBook({ db, google, now: () => time })
  const user = { organizationId: 't', id: 'u1' }
  const token = async () => { calls.token++; return 'access' }
  return { book, user, token, calls, advance: (ms: number) => { time += ms } }
}

test('people come from the Sent folder and from emails received, ranked by how often they were emailed', async () => {
  const t = setup({
    sent: {
      m1: { to: 'Ana Cruz <ana@acme.com>', cc: 'kim@acme.com', at: Date.UTC(2026, 9, 1) },
      m2: { to: '"Cruz, Ana" <ana@acme.com>, me@acme.com', at: Date.UTC(2026, 9, 10) },
      m3: { to: 'ana@acme.com', bcc: 'boss@acme.com, no-reply@acme.com' },
    },
    received: [
      { sender: 'Sam Reyes <sam@acme.com>', received_at: '2026-10-20T00:00:00Z' },
      { sender: 'Kim Lee <kim@acme.com>', received_at: '2026-10-22T00:00:00Z' },
      { sender: 'José <me@acme.com>', received_at: '2026-10-22T00:00:00Z', source_labels: ['SENT'] },
      { sender: 'Newsletter <news@shop.com>', received_at: '2026-10-21T00:00:00Z' },
    ],
  })
  const everyone = await t.book.search(t.user, 'me@acme.com', t.token, '')
  assert.deepEqual(everyone.people.map(p => [p.email, p.name, p.hint]), [
    ['ana@acme.com', 'Cruz, Ana', 'Emailed 3 times'], ['boss@acme.com', '', 'Emailed once'], ['kim@acme.com', 'Kim Lee', 'Emailed once'],
    ['news@shop.com', 'Newsletter', 'Wrote to you'], ['sam@acme.com', 'Sam Reyes', 'Wrote to you'],
  ], 'Most emailed first; you and automatic senders are left out')
  assert.equal(everyone.partial, false)
  assert.deepEqual((await t.book.search(t.user, 'me@acme.com', t.token, 'kim')).people.map(p => p.email), ['kim@acme.com'])
  assert.deepEqual((await t.book.search(t.user, 'me@acme.com', t.token, 'cruz')).people.map(p => p.email), ['ana@acme.com'], 'A name from a later email is found by its words')
  // Everything after the first search comes from memory.
  assert.deepEqual([t.calls.list, t.calls.metadata, t.calls.db, t.calls.token], [1, 3, 1, 1])
})

test('the list is kept for ten minutes, refreshed after that, and updated when an email is sent', async () => {
  const t = setup({ sent: { m1: { to: 'ana@acme.com' } } })
  await t.book.search(t.user, 'me@acme.com', t.token, 'a')
  t.advance(9 * 60_000);await t.book.search(t.user, 'me@acme.com', t.token, 'a')
  assert.equal(t.calls.list, 1)
  // A person just emailed shows up straight away, without another scan.
  t.book.remember(t.user, 'me@acme.com', ['new.person@acme.com', 'ANA@acme.com', 'me@acme.com', 'not an address'])
  const after = await t.book.search(t.user, 'me@acme.com', t.token, '')
  assert.deepEqual(after.people.map(p => [p.email, p.hint]), [['ana@acme.com', 'Emailed 2 times'], ['new.person@acme.com', 'Emailed once']])
  assert.equal(t.calls.list, 1)
  t.advance(2 * 60_000);await t.book.search(t.user, 'me@acme.com', t.token, 'a');await settle()
  assert.equal(t.calls.list, 2, 'After ten minutes the Sent folder is read again')
  // Another person, or the same person with a different mailbox connected, never sees this list.
  assert.deepEqual((await t.book.search({ organizationId: 't', id: 'u2' }, 'other@acme.com', t.token, '')).people.map(p => p.email), ['ana@acme.com'], 'Built from their own mailbox')
  assert.equal(t.calls.list, 3)
  t.book.remember(t.user, 'someone-else@acme.com', ['leak@acme.com'])
  assert.ok(!(await t.book.search(t.user, 'me@acme.com', t.token, 'leak')).people.length, 'A different mailbox cannot add to this list')
  t.book.forget(t.user);assert.equal(t.book.size(), 1)
})

test('when Gmail cannot be read, saved emails still give suggestions and the Sent folder is tried again soon', async () => {
  const t = setup({ failList: true, received: [{ sender: 'Sam Reyes <sam@acme.com>', received_at: '2026-10-20T00:00:00Z' }] })
  assert.deepEqual((await t.book.search(t.user, 'me@acme.com', t.token, 'sam')).people.map(p => p.email), ['sam@acme.com'])
  assert.equal(t.calls.list, 1)
  t.advance(60_000);await t.book.search(t.user, 'me@acme.com', t.token, 'sam');await settle()
  assert.equal(t.calls.list, 1, 'Not retried within two minutes')
  t.advance(90_000);await t.book.search(t.user, 'me@acme.com', t.token, 'sam');await settle()
  assert.equal(t.calls.list, 2, 'Retried after two minutes')
  // Without a usable token the same fallback applies.
  const noToken = setup({ received: [{ sender: 'Sam <sam@acme.com>', received_at: '2026-10-20T00:00:00Z' }], sent: {} })
  assert.deepEqual((await noToken.book.search(noToken.user, 'me@acme.com', async () => { throw new Error('revoked') }, 'sam')).people.map(p => p.email), ['sam@acme.com'])
})

test('a first build that is still running is reported as partial, and one build serves everyone waiting', async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  let lists = 0
  const book = createContactBook({
    db: { from: () => { const q: any = { select: () => q, eq: () => q, order: () => q, limit: () => q, then: (r: any) => r({ data: [], error: null }) }; return q } },
    google: async (url: string) => { if (new URL(url).pathname.endsWith('/messages')) { lists++; await gate; return { messages: [{ id: 'a' }] } } return { internalDate: '1', payload: { headers: [{ name: 'To', value: 'ana@acme.com' }] } } },
  })
  const user = { organizationId: 't', id: 'u1' }, token = async () => 't'
  const first = book.search(user, 'me@acme.com', token, 'ana'), second = book.search(user, 'me@acme.com', token, 'ana')
  release()
  const [a, b] = await Promise.all([first, second])
  assert.deepEqual([a.people.map(p => p.email), b.people.map(p => p.email), lists], [['ana@acme.com'], ['ana@acme.com'], 1])
})
