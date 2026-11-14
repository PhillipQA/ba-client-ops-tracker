/**
 * Why a call to the AI provider failed: a reason a person can act on, a log line for the server (no keys), and
 * whether trying once more is worth it. The OpenAI SDK (OpenAI, Gemini, DeepSeek) puts the HTTP status on `status`;
 * the Claude path puts it in its message; timeouts and dropped connections show in the error's name.
 */
export type AiFailureKind =
  | 'limited'
  | 'busy'
  | 'key'
  | 'model'
  | 'refused'
  | 'slow'
  | 'unreachable'
  | 'unreadable'
  | 'incomplete'
  | 'looping'
  | 'other'

export const AI_FAILURE_MESSAGES: Record<AiFailureKind, string> = {
  limited:
    'The AI provider is limiting requests right now: too many at once, or the quota is used up. Wait a minute and try again. If it keeps happening, an admin should check the BA Assistant quota.',
  busy: 'The AI provider is busy right now. Try again in a moment.',
  key: 'The AI provider rejected the saved key. An admin should check the BA Assistant key.',
  model: 'The selected AI model is not available. An admin should check the BA Assistant model.',
  refused: 'The AI provider refused this request. Try a shorter message, or turn off Agent mode.',
  slow: 'The AI took too long to answer. Try again, or turn off Agent mode for a quicker answer.',
  unreachable: 'The app could not reach the AI provider. Try again in a moment.',
  unreadable: 'The AI answered in a form the app could not read. Try again.',
  incomplete: 'The AI stopped before finishing its answer. Try again, or ask a smaller question.',
  looping:
    'The assistant kept looking things up and ran out of time. Ask a more specific question, or turn off Agent mode.',
  other:
    'BA Assistant request failed. Check this account’s BA Assistant provider, key, selected model, quota, and connection.',
}

/** The HTTP status in an error, if it has one. */
function statusOf(error: any, text: string) {
  const status = Number(error?.status)
  if (Number.isInteger(status) && status >= 400) return status
  const named = /request failed \((\d{3})\)/i.exec(text)
  return named ? Number(named[1]) : 0
}

export function aiFailureKind(error: unknown): { kind: AiFailureKind; status: number } {
  const failure = error as any
  const text = String(failure?.message || '')
  const name = String(failure?.name || failure?.constructor?.name || '')
  const status = statusOf(failure, text)
  // The app's own errors first: some of them carry a 502 that is not the provider's.
  if (/kept looking things up/i.test(text)) return { kind: 'looping', status }
  if (/valid JSON|no assessment/i.test(text)) return { kind: 'unreadable', status }
  if (/incomplete|did not complete|returned no text/i.test(text)) return { kind: 'incomplete', status }
  if (/timeout|timed out|AbortError/i.test(name) || /timed out|timeout|aborted/i.test(text))
    return { kind: 'slow', status }
  if (/ConnectionError/i.test(name) || /fetch failed|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(text))
    return { kind: 'unreachable', status }
  if (status === 429) return { kind: 'limited', status }
  if (status >= 500) return { kind: 'busy', status }
  // Gemini answers a bad key with 400, so the words decide before the status.
  if (status === 401 || status === 403 || /api key|apikey|permission|unauthori[sz]ed/i.test(text))
    return { kind: 'key', status }
  if (status === 404 || (status === 400 && /model/i.test(text))) return { kind: 'model', status }
  if (status === 400 || status === 413) return { kind: 'refused', status }
  return { kind: 'other', status }
}

/** Failures that often pass on their own: worth one more try. */
export function aiFailureRetryable(error: unknown) {
  const { kind } = aiFailureKind(error)
  return kind === 'busy' || kind === 'limited' || kind === 'unreachable'
}

/** Keys that providers sometimes echo back in error text, hidden before anything is logged. */
export function hideKeys(text: string) {
  return text
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[key]')
    .replace(/sk-[A-Za-z0-9_-]{10,}/g, '[key]')
    .replace(/key=[^&\s"']+/gi, 'key=[key]')
}

/** The reason to show, and one line for the server log. */
export function describeAiFailure(error: unknown, where = 'BA Assistant') {
  const { kind, status } = aiFailureKind(error)
  const text = hideKeys(String((error as any)?.message || error || ''))
    .replace(/\s+/g, ' ')
    .slice(0, 300)
  return {
    kind,
    status,
    message: AI_FAILURE_MESSAGES[kind],
    log: `${where} request failed: ${kind}${status ? ` (${status})` : ''}${text ? `: ${text}` : ''}`,
  }
}

/** How long to wait before the one retry of a busy, rate-limited or unreachable provider. */
export const AI_RETRY_MS = 2000

/** Runs a call; when it fails in a way that often passes (busy, limited, unreachable), waits and tries once more. */
export async function retryOnce<T>(
  run: () => Promise<T>,
  wait = (ms: number) => new Promise(done => setTimeout(done, ms)),
) {
  try {
    return await run()
  } catch (error) {
    if (!aiFailureRetryable(error)) throw error
    await wait(AI_RETRY_MS)
    return run()
  }
}

/** Whether a provider error is about the thinking setting (a model that has none). */
export function rejectsReasoning(error: unknown) {
  const status = Number((error as any)?.status)
  return status === 400 && /reasoning|thinking/i.test(String((error as any)?.message || ''))
}
