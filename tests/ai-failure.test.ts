import assert from 'node:assert/strict'
import test from 'node:test'
import { askJson, JSON_AGAIN } from '../server/ai/assistant-agent'
import {
  aiFailureKind,
  aiFailureRetryable,
  describeAiFailure,
  hideKeys,
  rejectsReasoning,
  retryOnce,
} from '../server/ai/ai-failure'
import { unanswered } from '../src/features/ai/ai'

const apiError = (status: number, message = '') =>
  Object.assign(new Error(message || `${status} status code`), { status })

test('each failure gets a reason the person can act on', () => {
  const kinds = (error: unknown) => aiFailureKind(error).kind
  assert.equal(kinds(apiError(429, '429 Resource has been exhausted (e.g. check quota).')), 'limited')
  assert.equal(kinds(apiError(503, '503 The model is overloaded. Please try again later.')), 'busy')
  assert.equal(kinds(apiError(500)), 'busy')
  // Gemini answers a bad key with 400.
  assert.equal(kinds(apiError(400, '400 API key not valid. Please pass a valid API key.')), 'key')
  assert.equal(kinds(apiError(401)), 'key')
  assert.equal(kinds(apiError(404, '404 models/gemini-9 is not found')), 'model')
  assert.equal(kinds(apiError(400, 'Request contains an invalid argument.')), 'refused')
  assert.equal(kinds(Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' })), 'slow')
  assert.equal(kinds(Object.assign(new Error('Connection error.'), { name: 'APIConnectionError' })), 'unreachable')
  assert.equal(kinds(new Error('Claude request failed (529). Check the saved key, model access and quota.')), 'busy')
  // The app's own errors, even when they carry a 502.
  assert.equal(
    kinds(Object.assign(new Error('The AI response was incomplete. Reduce the scope.'), { status: 502 })),
    'incomplete',
  )
  assert.equal(kinds(new Error('The model did not return valid JSON.')), 'unreadable')
  assert.equal(kinds(new Error('The assistant kept looking things up instead of answering.')), 'looping')
  assert.equal(kinds(new Error('something else')), 'other')
})

test('only failures that often pass are tried again', () => {
  assert.ok(aiFailureRetryable(apiError(503)))
  assert.ok(aiFailureRetryable(apiError(429)))
  assert.ok(!aiFailureRetryable(apiError(401)))
  assert.ok(!aiFailureRetryable(Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' })))
  assert.ok(!aiFailureRetryable(new Error('The model did not return valid JSON.')))
})

test('the log line names the cause and never a key', () => {
  const failure = describeAiFailure(apiError(400, 'API key not valid: AIzaSyA1234567890abcdefghijklmnop'))
  assert.equal(failure.kind, 'key')
  assert.match(failure.log, /BA Assistant request failed: key \(400\)/)
  assert.ok(!failure.log.includes('AIzaSy'))
  assert.match(failure.message, /rejected the saved key/)
  assert.equal(hideKeys('url?key=abc123&x=1 sk-abcdefghijklmnop'), 'url?key=[key]&x=1 [key]')
})

test('a busy provider is tried once more after a short wait', async () => {
  let calls = 0
  const waits: number[] = []
  const wait = async (ms: number) => void waits.push(ms)
  const answer = await retryOnce(async () => {
    calls += 1
    if (calls === 1) throw apiError(503)
    return 'ok'
  }, wait)
  assert.equal(answer, 'ok')
  assert.equal(calls, 2)
  assert.equal(waits.length, 1)

  // A bad key is not retried, and a second busy answer is the error.
  calls = 0
  await assert.rejects(
    retryOnce(async () => {
      calls += 1
      throw apiError(401)
    }, wait),
  )
  assert.equal(calls, 1)
  calls = 0
  await assert.rejects(
    retryOnce(async () => {
      calls += 1
      throw apiError(503)
    }, wait),
  )
  assert.equal(calls, 2)
})

test('answers that are not clean JSON are still read', async () => {
  // Plain words with no JSON become the message, with no second call.
  let calls = 0
  const plain = await askJson(
    async () => {
      calls += 1
      return 'Task created for BPI Partner Store Transactions.'
    },
    '',
    'ask',
  )
  assert.deepEqual(plain, { message: 'Task created for BPI Partner Store Transactions.' })
  assert.equal(calls, 1)

  // Broken JSON is asked for once more.
  const prompts: string[] = []
  const fixed = await askJson(
    async (_instructions, prompt) => {
      prompts.push(prompt)
      return prompts.length === 1 ? '{"message": "cut off' : '{"message":"done"}'
    },
    '',
    'ask',
  )
  assert.deepEqual(fixed, { message: 'done' })
  assert.equal(prompts[1], `ask${JSON_AGAIN}`)

  // Broken twice is an error.
  await assert.rejects(
    askJson(async () => '{"message": ', '', 'ask'),
    /valid JSON/,
  )
})

test('Try again finds the message that got no answer', () => {
  const at = '2026-11-14T00:00:00Z'
  const asked = { id: '1', role: 'user' as const, content: 'create task BPI', createdAt: at }
  const answered = { id: '2', role: 'assistant' as const, content: 'Done', createdAt: at }
  assert.equal(unanswered([asked]), asked)
  assert.equal(unanswered([asked, answered]), undefined)
  assert.equal(unanswered([]), undefined)
})

test('a Gemini model with no thinking settings is asked again without them; other errors are not', () => {
  assert.ok(rejectsReasoning(apiError(400, '400 Thinking is not supported for this model.')))
  assert.ok(rejectsReasoning(apiError(400, 'Unknown name "reasoning_effort"')))
  assert.ok(!rejectsReasoning(apiError(400, 'API key not valid')))
  assert.ok(!rejectsReasoning(apiError(503, 'thinking overloaded')))
})

test('an answer cut off by thinking is reported as incomplete, with where the tokens went in the log', () => {
  const failure = describeAiFailure(
    Object.assign(
      new Error(
        'The AI response was incomplete. Reduce the scope and try again. (finish: length, in 9000, out 0, thinking 8000)',
      ),
      { status: 502 },
    ),
  )
  assert.equal(failure.kind, 'incomplete')
  assert.match(failure.log, /finish: length, in 9000, out 0, thinking 8000/)
})
