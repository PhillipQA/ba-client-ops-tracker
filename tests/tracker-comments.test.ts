import assert from 'node:assert/strict'
import test from 'node:test'
import {
  cleanCommentText,
  commentExcerpt,
  commentParts,
  insertMention,
  mentionChoices,
  mentionQuery,
  mentionsIn,
} from '../src/features/trackers/trackerComments'

const people = [
  { id: 'jun', name: 'Jun Perez' },
  { id: 'lea', name: 'Lea Cruz' },
  { id: 'leo', name: 'Leo Mari' },
  { id: 'ana', name: 'Ana Reyes' },
]

test('a comment is trimmed, and capped', () => {
  assert.equal(cleanCommentText('  hello\r\n\r\n\r\n\r\nthere  '), 'hello\n\nthere')
  assert.equal(cleanCommentText(null), '')
  assert.equal(cleanCommentText('x'.repeat(5000)).length, 2000)
})

test('only people picked, still named in the text and able to see the tracker are mentioned', () => {
  const text = 'Permit update? @Lea Cruz and (@Jun Perez) please check. mail@Ana Reyes'
  assert.deepEqual(mentionsIn(text, ['lea', 'jun', 'ana', 'ghost'], people, 'me'), ['jun', 'lea'])
  // Picked, then the name was deleted from the text.
  assert.deepEqual(mentionsIn('no names here', ['lea'], people, 'me'), [])
  // Named in the text but never picked: plain text, nobody is notified.
  assert.deepEqual(mentionsIn('@Lea Cruz', [], people, 'me'), [])
  // Nobody is notified about their own comment; a longer name is not a shorter one.
  assert.deepEqual(mentionsIn('@Lea Cruz', ['lea'], people, 'lea'), [])
  assert.deepEqual(mentionsIn('@Lea Cruzado', ['lea'], people, 'me'), [])
})

test('typing @ offers people, best matches first, and picking one puts the name in', () => {
  const text = 'Permit update? @le'
  const asking = mentionQuery(text, text.length)
  assert.deepEqual(asking, { query: 'le', start: 15 })
  assert.deepEqual(
    mentionChoices(people, 'le').map(person => person.id),
    ['lea', 'leo'],
  )
  assert.deepEqual(
    mentionChoices(people, 'cruz').map(person => person.id),
    ['lea'],
  )
  assert.equal(mentionChoices(people, '').length, 4)
  const next = insertMention(text, text.length, 15, 'Lea Cruz')
  assert.equal(next.text, 'Permit update? @Lea Cruz ')
  assert.equal(next.caret, next.text.length)
  // An email address is not a mention, and a mention ends at a new line.
  assert.equal(mentionQuery('mail me@x', 9), null)
  assert.equal(mentionQuery('@lea\nnext', 9), null)
  assert.equal(mentionQuery('no at sign', 5), null)
})

test('mentions are shown apart from the words around them', () => {
  assert.deepEqual(commentParts('Hi @Lea Cruz, see this', ['Lea Cruz', 'Lea']), [
    { text: 'Hi ', mention: false },
    { text: '@Lea Cruz', mention: true },
    { text: ', see this', mention: false },
  ])
  assert.deepEqual(commentParts('plain', ['Lea Cruz']), [{ text: 'plain', mention: false }])
  assert.equal(commentExcerpt(`a\n\nb ${'x'.repeat(200)}`).length, 140)
})
