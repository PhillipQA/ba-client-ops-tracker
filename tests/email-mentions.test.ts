import test from 'node:test'
import assert from 'node:assert/strict'
import {
  activeMentions,
  applyMention,
  cleanMentions,
  mentionHtml,
  mentionName,
  mentionToken,
} from '../src/features/email/emailMentions'
import { buildMessage } from '../server/integrations/gmail-send'

test('an @ starts a mention at the start of a word, not inside an address', () => {
  assert.deepEqual(mentionToken('Hi @Rob', 7), { start: 3, end: 7, text: 'Rob' })
  assert.deepEqual(mentionToken('@', 1), { start: 0, end: 1, text: '' })
  assert.deepEqual(mentionToken('Hi @Ana Re', 10), { start: 3, end: 10, text: 'Ana Re' })
  assert.equal(mentionToken('mail ana@acme.com', 17), null, 'inside an email address')
  assert.equal(mentionToken('Hi @Rob\nthere', 13), null, 'a new line ends it')
  assert.equal(mentionToken('Hi @ Rob', 8), null, 'a space right after @ is not a mention')
})

test('choosing a person writes @Name and the cursor goes after it', () => {
  const token = mentionToken('Hi sir @Rob, please', 11)!
  const result = applyMention('Hi sir @Rob, please', token, 'Robertson')
  assert.equal(result.value, 'Hi sir @Robertson, please', 'no space before the comma that follows')
  assert.equal(result.caret, 'Hi sir @Robertson'.length)
  assert.equal(applyMention('Hi @Ro', mentionToken('Hi @Ro', 6)!, 'Robertson').value, 'Hi @Robertson ')
  assert.equal(mentionName('', 'mate@acme.com'), 'mate', 'no name: the address before the @')
  assert.equal(mentionName('Ana <x> @Reyes', 'a@b.co'), 'Ana x Reyes')
})

test('only mentions still in the message are sent, once each, with valid addresses', () => {
  const text = 'Hi @Robertson, reach out to @Mate.'
  const list = [
    { name: 'Robertson', email: 'rob@acme.com' },
    { name: 'Robertson', email: 'rob@acme.com' },
    { name: 'Mate', email: 'mate@acme.com' },
    { name: 'Removed', email: 'gone@acme.com' },
  ]
  assert.deepEqual(
    activeMentions(text, list).map(mention => mention.email),
    ['rob@acme.com', 'mate@acme.com'],
  )
  assert.deepEqual(cleanMentions([{ name: 'A', email: 'not-an-address' }, { email: ' b@acme.com ' }, 'x']), [
    { email: 'b@acme.com', name: 'b' },
  ])
})

test('the HTML keeps the text exactly, escapes it, and links each mention', () => {
  const text = 'Hi sir @Robertson, if <mail> sending is required,\nreach out to Sir @Mate & co.'
  const html = mentionHtml(text, [
    { name: 'Robertson', email: 'rob@acme.com' },
    { name: 'Mate', email: 'mate@acme.com' },
  ])
  assert.match(html, /<a href="mailto:rob@acme.com"[^>]*>@Robertson<\/a>/)
  assert.match(html, /<a href="mailto:mate@acme.com"[^>]*>@Mate<\/a> &amp; co\./)
  assert.match(html, /&lt;mail&gt;/, 'typed text cannot become HTML')
  assert.match(html, /required,<br>/)
  // The longer name wins when one name starts another.
  const both = mentionHtml('@Ana Reyes and @Ana', [
    { name: 'Ana', email: 'ana@x.co' },
    { name: 'Ana Reyes', email: 'reyes@x.co' },
  ])
  assert.match(both, /mailto:reyes@x\.co[^>]*>@Ana Reyes<\/a> and <a href="mailto:ana@x\.co"[^>]*>@Ana<\/a>/)
})

test('an email with mentions carries plain text and HTML as alternatives, with or without attachments', () => {
  const decode = (raw: Buffer) => raw.toString('utf8')
  const base = {
    from: { email: 'me@acme.com', name: 'Me' },
    to: ['rob@acme.com'],
    subject: 'Hi',
    text: 'Hi @Robertson',
    html: mentionHtml('Hi @Robertson', [{ name: 'Robertson', email: 'rob@acme.com' }]),
  }
  const plain = decode(buildMessage(base))
  assert.match(plain, /Content-Type: multipart\/alternative; boundary="=_ba_alt_/)
  assert.ok(plain.indexOf('text/plain') < plain.indexOf('text/html'), 'plain text first, HTML preferred last')
  const withFile = decode(
    buildMessage({ ...base, attachments: [{ name: 'a.txt', mimeType: 'text/plain', bytes: Buffer.from('x') }] }),
  )
  assert.match(withFile, /multipart\/mixed[\s\S]*multipart\/alternative[\s\S]*text\/html[\s\S]*name="a\.txt"/)
  const noHtml = decode(buildMessage({ ...base, html: undefined }))
  assert.doesNotMatch(noHtml, /text\/html|multipart\/alternative/, 'no mentions: plain text as before')
})
