import assert from 'node:assert/strict'
import test from 'node:test'
import {
  inlineImages,
  isRichSignature,
  RICH_MARK,
  sanitizeSignature,
  signatureHtml,
  signatureText,
  storeSignature,
} from '../src/features/email/signatureHtml'
import { buildMessage } from '../server/integrations/gmail-send'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

test('a formatted signature keeps its formatting and loses everything unsafe', () => {
  const clean = sanitizeSignature(
    [
      '<div onclick="steal()" class="x"><b>Phillip Val R. Cabalo</b></div>',
      '<div>Business Analyst</div>',
      '<span style="color: rgb(0, 0, 255); font-weight: bold; position: fixed; background-image: url(x)">iRipple Inc.</span>',
      '<font color="#660066" face="Arial" size="2">2305-B East Tower</font>',
      '<span style="background-color:#ffff00">highlight</span>',
      '<script>alert(1)</script><style>p{}</style>',
      '<a href="javascript:alert(1)">bad</a> <a href="https://iripple.com" onmouseover="x()">site</a>',
      `<img src="data:image/png;base64,${PNG}" width="120" onerror="x()" alt="iRipple">`,
      '<img src="https://tracker.example/pixel.gif">',
      '<iframe src="https://evil.example"></iframe>',
    ].join(''),
  )
  assert.match(clean, /<b>Phillip Val R\. Cabalo<\/b>/)
  assert.match(clean, /<span style="color:rgb\(0, 0, 255\);font-weight:bold">iRipple Inc\.<\/span>/)
  assert.match(clean, /<span style="color:#660066;font-family:Arial;font-size:13px">2305-B East Tower<\/span>/)
  assert.match(clean, /background-color:#ffff00/)
  assert.match(clean, /<a href="https:\/\/iripple\.com" target="_blank" rel="noopener noreferrer">site<\/a>/)
  assert.match(
    clean,
    new RegExp(`<img src="data:image/png;base64,${PNG.replace(/[+/=]/g, '\\$&')}" alt="iRipple" width="120">`),
  )
  for (const gone of [
    'onclick',
    'onerror',
    'onmouseover',
    'script',
    'alert',
    'javascript',
    'iframe',
    'pixel.gif',
    'class=',
    'position',
    'url(',
  ])
    assert.ok(!clean.includes(gone), gone)
  assert.ok(clean.includes('bad'), 'the text of a dropped link stays')
  assert.equal(sanitizeSignature(clean), clean, 'cleaning again changes nothing')
  assert.equal(sanitizeSignature('<b>open <i>tags'), '<b>open <i>tags</i></b>', 'open tags are closed')
  assert.equal(sanitizeSignature('a < b & "c" <notatag'), 'a &lt; b &amp; &quot;c&quot; &lt;notatag')
})

test('stored signatures: formatted behind a mark, plain ones still work, text version for plain emails', () => {
  const stored = storeSignature('<div><b>Bea</b></div><div>Business Analyst<br>iRipple Inc.</div>')
  assert.ok(isRichSignature(stored) && stored.startsWith(RICH_MARK))
  assert.equal(signatureHtml(stored), '<div><b>Bea</b></div><div>Business Analyst<br>iRipple Inc.</div>')
  assert.equal(signatureText(signatureHtml(stored)), 'Bea\nBusiness Analyst\niRipple Inc.')
  assert.equal(storeSignature('<div><br></div>'), '', 'an empty box is no signature')
  // One kept as plain text before formatting existed.
  assert.equal(signatureHtml('Bea <bea@x.com>\nBA'), 'Bea &lt;bea@x.com&gt;<br>BA')
  assert.equal(signatureHtml(`${RICH_MARK}<script>x</script><b>ok</b>`), '<b>ok</b>', 'cleaned again when read')
})

test('pictures travel with the email and show in place', () => {
  const html = sanitizeSignature(`<div>iRipple</div><img src="data:image/png;base64,${PNG}" alt="logo">`)
  const placed = inlineImages(html, index => `sig${index + 1}@ba`)
  assert.match(placed.html, /<img src="cid:sig1@ba" alt="logo">/)
  assert.deepEqual(placed.images, [{ cid: 'sig1@ba', mimeType: 'image/png', data: PNG }])
  const raw = buildMessage({
    from: { email: 'bea@x.com' },
    to: ['client@y.com'],
    subject: 'Hello',
    text: 'Hi\n\n-- \niRipple',
    html: `<html><body>Hi<br>${placed.html}</body></html>`,
    inline: placed.images.map(image => ({ ...image, bytes: Buffer.from(image.data, 'base64') })),
    attachments: [{ name: 'a.txt', mimeType: 'text/plain', bytes: Buffer.from('x') }],
  }).toString('utf8')
  assert.match(raw, /Content-Type: multipart\/mixed/)
  assert.match(raw, /Content-Type: multipart\/alternative/)
  assert.match(raw, /Content-Type: multipart\/related/)
  assert.match(raw, /Content-ID: <sig1@ba>/)
  assert.match(raw, /Content-Disposition: inline; filename="image1\.png"/)
  assert.ok(
    raw.indexOf('multipart/related') > raw.indexOf('text/plain'),
    'plain text first, then the HTML with its pictures',
  )
  // Without HTML nothing changes: a plain email as before.
  const plain = buildMessage({ from: { email: 'a@x.com' }, to: ['b@y.com'], subject: 's', text: 't' }).toString('utf8')
  assert.ok(!plain.includes('multipart'))
})
