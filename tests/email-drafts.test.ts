import assert from 'node:assert/strict'
import test from 'node:test'
import {
  cleanDraft,
  draftKey,
  draftPrefill,
  hasContent,
  MAX_DRAFTS,
  readDrafts,
  removeDraft,
  saveDraft,
  type SavedDraft,
} from '../src/features/email/emailDrafts'

function memory() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  }
}
const draft = (id: string, updatedAt: string, extra: Partial<SavedDraft> = {}): SavedDraft => ({
  id,
  updatedAt,
  to: 'client@example.com',
  cc: '',
  bcc: '',
  subject: `Subject ${id}`,
  message: 'Hello',
  taskIds: ['t1'],
  driveFiles: [],
  ...extra,
})

test('drafts are kept per person, newest first, at most three', () => {
  const store = memory()
  const key = draftKey({ id: 'u1', organizationId: 'org' })
  assert.equal(key, 'email-drafts:org:u1')
  for (const [index, at] of ['2026-11-13T01:00:00Z', '2026-11-13T02:00:00Z', '2026-11-13T03:00:00Z'].entries())
    assert.equal(saveDraft(store, key, draft(`d${index}`, at)), true)
  assert.deepEqual(
    readDrafts(store, key).map(item => item.id),
    ['d2', 'd1', 'd0'],
  )
  saveDraft(store, key, draft('d3', '2026-11-13T04:00:00Z'))
  assert.equal(readDrafts(store, key).length, MAX_DRAFTS, 'the oldest goes past the limit')
  // Saving the same draft again replaces it.
  saveDraft(store, key, draft('d1', '2026-11-13T05:00:00Z', { subject: 'Changed' }))
  const [first] = readDrafts(store, key)
  assert.deepEqual([first.id, first.subject], ['d1', 'Changed'])
  removeDraft(store, key, 'd1')
  assert.ok(!readDrafts(store, key).some(item => item.id === 'd1'))
  assert.deepEqual(readDrafts(store, 'email-drafts:org:u2'), [], 'another person sees none')
})

test('stored drafts are cleaned: unknown fields dropped, limits kept, broken storage ignored', () => {
  const cleaned = cleanDraft({
    id: 'x',
    updatedAt: '2026-11-13T00:00:00Z',
    to: 'a@b.c',
    subject: 's'.repeat(400),
    message: 'm',
    taskIds: ['t1', 5, ''],
    driveFiles: [{ taskId: 't1', fileId: 'f', name: 'n.pdf', size: '12' }, { nope: true }],
    evil: '<script>',
  }) as any
  assert.equal(cleaned.subject.length, 300)
  assert.deepEqual(cleaned.taskIds, ['t1'])
  assert.deepEqual(cleaned.driveFiles, [{ taskId: 't1', fileId: 'f', name: 'n.pdf', size: 12 }])
  assert.equal(cleaned.evil, undefined)
  assert.equal(cleanDraft({ subject: 'no id' }), null)
  const broken = { getItem: () => '{not json', setItem: () => {} }
  assert.deepEqual(readDrafts(broken, 'k'), [])
  const full = {
    getItem: () => '[]',
    setItem: () => {
      throw new Error('quota')
    },
  }
  assert.equal(saveDraft(full, 'k', draft('d', '2026-11-13T00:00:00Z')), false, 'a full browser says so')
})

test('a message that is only the signature is not a draft; files from the computer must be attached again', () => {
  const signature = '\n\n-- \nBea'
  const empty = { to: '', cc: '', bcc: '', subject: '', message: signature }
  assert.equal(hasContent(empty, signature), false)
  assert.equal(hasContent({ ...empty, subject: 'Hi' }, signature), true)
  assert.equal(hasContent({ ...empty, message: `Notes${signature}` }, signature), true)
  const prefill = draftPrefill(draft('d', '2026-11-13T00:00:00Z', { droppedUploads: ['COR.pdf'], replyToId: 'm1' }))
  assert.equal(prefill.replyToId, 'm1')
  assert.match(prefill.notice || '', /COR\.pdf/)
  assert.equal(draftPrefill(draft('d', '2026-11-13T00:00:00Z')).notice, undefined)
})
