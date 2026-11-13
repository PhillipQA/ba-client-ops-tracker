import assert from 'node:assert/strict'
import test from 'node:test'
import {
  cleanVoiceLang,
  dictationProblem,
  joinDictation,
  pickVoice,
  SPEAK_LIMIT,
  speakable,
} from '../src/features/ai/voice'

test('an answer is read aloud without its markdown, links or addresses', () => {
  const answer = [
    '## Today',
    '',
    '- **Late**: 3 days overdue, see [the task](https://example.com/t/1)',
    '- Reply to Juan `today`',
    '',
    'More at https://example.com/report?x=1',
    '```',
    'code that should not be read',
    '```',
  ].join('\n')
  const spoken = speakable(answer)
  assert.equal(spoken, 'Today. Late: 3 days overdue, see the task. Reply to Juan today. More at.')
  assert.doesNotMatch(spoken, /[*#`\[\]]|https?:/)
  assert.equal(speakable(''), '')
  assert.equal(speakable(null), '')
})

test('a long answer is read up to a sentence end', () => {
  const long = Array.from({ length: 80 }, (_, index) => `Sentence number ${index} is here.`).join(' ')
  const spoken = speakable(long)
  assert.ok(spoken.length <= SPEAK_LIMIT)
  assert.ok(spoken.endsWith('.'), 'It stops at the end of a sentence')
  assert.ok(speakable('word '.repeat(400)).length <= SPEAK_LIMIT)
})

test('what is said is added to what was typed', () => {
  assert.equal(joinDictation('', '  what is  due today '), 'what is due today')
  assert.equal(joinDictation('For Goldwing: ', 'what is due'), 'For Goldwing: what is due')
  assert.equal(joinDictation('Typed only', ''), 'Typed only')
  assert.equal(joinDictation('', ''), '')
})

test('the voice and the language follow the person’s choice', () => {
  assert.equal(cleanVoiceLang('fil-PH'), 'fil-PH')
  assert.equal(cleanVoiceLang('xx'), 'en-PH')
  assert.equal(cleanVoiceLang(null), 'en-PH')
  const voices = [
    { name: 'US', lang: 'en-US' },
    { name: 'PH online', lang: 'en-PH' },
    { name: 'PH local', lang: 'en_PH', localService: true },
    { name: 'Tagalog', lang: 'tl-PH' },
  ]
  assert.equal(pickVoice(voices, 'en-PH')?.name, 'PH local', 'One on the device is preferred')
  assert.equal(pickVoice(voices, 'fil-PH')?.name, 'Tagalog')
  assert.equal(pickVoice(voices.slice(0, 1), 'en-PH')?.name, 'US', 'Same language, another country')
  assert.equal(pickVoice(voices.slice(0, 1), 'fil-PH'), undefined, 'The browser’s default then reads it')
})

test('a stopped dictation says why only when the person can do something about it', () => {
  assert.match(dictationProblem('not-allowed'), /microphone is blocked/)
  assert.match(dictationProblem('network'), /internet/)
  assert.equal(dictationProblem('no-speech'), '')
  assert.equal(dictationProblem('aborted'), '')
})
