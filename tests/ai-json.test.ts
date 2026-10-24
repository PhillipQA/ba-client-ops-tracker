import test from 'node:test'
import assert from 'node:assert/strict'
import { AI_JSON_RETRY_NOTE, AiJsonError, parseAiJson, runAiJson } from '../server/ai/parse-ai-json'

const doc = { sections: [{ id: 'summary', blocks: [{ type: 'paragraph', text: 'Hello' }] }], gaps: [], conflicts: [] }

test('valid JSON is returned exactly as JSON.parse would', () => {
  assert.deepEqual(parseAiJson(JSON.stringify(doc)), doc)
  assert.deepEqual(parseAiJson('[{"a":1},{"b":2}]'), [{ a: 1 }, { b: 2 }])
})

test('code fences and surrounding prose are removed', () => {
  assert.deepEqual(parseAiJson('```json\n' + JSON.stringify(doc) + '\n```'), doc)
  assert.deepEqual(
    parseAiJson('Here is the document:\n```\n' + JSON.stringify(doc) + '\n```\nLet me know if you need changes.'),
    doc,
  )
  assert.deepEqual(parseAiJson('﻿  ' + JSON.stringify(doc) + '  '), doc)
})

test('raw line breaks and tabs inside strings are repaired', () => {
  const reply = '{"text":"1. Open the screen\n2. Enter the code\r\n3.\tConfirm","other":"ok"}'
  assert.deepEqual(parseAiJson(reply), { text: '1. Open the screen\n2. Enter the code\n3.\tConfirm', other: 'ok' })
})

test('trailing commas are removed', () => {
  assert.deepEqual(parseAiJson('{"a":["x","y",],"b":{"c":1,},}'), { a: ['x', 'y'], b: { c: 1 } })
})

test('unescaped double quotes inside strings are escaped', () => {
  const reply =
    '{"rows":[["Below minimum","Show "Minimum redemption is 200 points." on the cashier screen"],["Other","ok"]],"gaps":[]}'
  assert.deepEqual(parseAiJson(reply), {
    rows: [
      ['Below minimum', 'Show "Minimum redemption is 200 points." on the cashier screen'],
      ['Other', 'ok'],
    ],
    gaps: [],
  })
})

test('escaped characters that are already valid are left alone', () => {
  const reply = '{"a":"line\\nbreak and \\"quoted\\" text","b":"back\\\\slash"}'
  assert.deepEqual(parseAiJson(reply), { a: 'line\nbreak and "quoted" text', b: 'back\\slash' })
})

test('unrecoverable replies raise an error that carries no document text', () => {
  const secret = 'CONFIDENTIAL-SOURCE-TEXT'
  assert.throws(
    () => parseAiJson(`I cannot do that. ${secret}`),
    (e: unknown) => e instanceof AiJsonError && !JSON.stringify(e).includes(secret) && !e.message.includes(secret),
  )
  assert.throws(() => parseAiJson('{"sections":[{"id":"summary","blocks":['), AiJsonError)
})

test('an unreadable reply is asked for once more, with a reminder', async () => {
  const calls: string[] = []
  const result = await runAiJson(
    async note => {
      calls.push(note)
      return calls.length === 1 ? 'not json {' : JSON.stringify(doc)
    },
    () => new Error('failed'),
  )
  assert.deepEqual(result, doc)
  assert.deepEqual(calls, ['', AI_JSON_RETRY_NOTE])
})

test('a readable first reply is not retried', async () => {
  let calls = 0
  assert.deepEqual(
    await runAiJson(
      async () => {
        calls++
        return JSON.stringify(doc)
      },
      () => new Error('failed'),
    ),
    doc,
  )
  assert.equal(calls, 1)
})

test('two unreadable replies raise the supplied error and stop', async () => {
  let calls = 0
  await assert.rejects(
    runAiJson(
      async () => {
        calls++
        return 'still not json'
      },
      () => new Error('both unreadable'),
    ),
    /both unreadable/,
  )
  assert.equal(calls, 2)
})

test('provider errors are not retried', async () => {
  let calls = 0
  await assert.rejects(
    runAiJson(
      async () => {
        calls++
        throw new Error('quota exceeded')
      },
      () => new Error('unreadable'),
    ),
    /quota exceeded/,
  )
  assert.equal(calls, 1)
})
