import assert from 'node:assert/strict'
import test from 'node:test'
import { splitQuoted } from '../src/features/email/quotedText'

test('a reply keeps its new text and folds the quoted thread', () => {
  const body = `noted on this ms. abbey\n\nRegards,\nAllen\n\nOn Thu, Nov 12, 2026 at 3:11 PM Abegail Atuli <abegail.atuli@primergrp.com>\nwrote:\n\n> Hello @Allen,\n>\n> Please see the attached copy.`
  const split = splitQuoted(body)
  assert.equal(split.main, 'noted on this ms. abbey\n\nRegards,\nAllen')
  assert.match(split.quoted, /^On Thu, Nov 12/)
})

test('Gmail wraps the "wrote:" line; Outlook uses From/Sent; a body with nothing new is not folded', () => {
  assert.equal(
    splitQuoted('Thanks!\nOn Wed, Nov 11, 2026 at 2:53 PM Phillip Val R. Cabalo <\npcabalo@iripple.com> wrote:\n> hi')
      .main,
    'Thanks!',
  )
  assert.equal(splitQuoted('Ok\n\nFrom: Ana <a@x.com>\nSent: Monday\nTo: me\n\nOld').main, 'Ok')
  assert.deepEqual(splitQuoted('> only a quote\n> here'), { main: '> only a quote\n> here', quoted: '' })
  assert.deepEqual(splitQuoted('Plain message'), { main: 'Plain message', quoted: '' })
})
