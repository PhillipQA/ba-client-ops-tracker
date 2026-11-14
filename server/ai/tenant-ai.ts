import { createAiClient, IntegrationError } from '../integrations/tenant-integrations'
import { rejectsReasoning, retryOnce } from './ai-failure'
import { type AiUsage, aiUsage } from './ai-usage'

export type { AiUsage }

/** Shared generation adapter. Credentials and provider selection stay on the server. */
export async function runTenantAi(
  secret: string,
  config: unknown,
  instructions: string,
  input: string,
  timeout = 30000,
  maxTokens = 8000,
) {
  return (await runTenantAiMetered(secret, config, instructions, input, timeout, maxTokens)).text
}

/** The same call, with the tokens it used. A busy or unreachable provider is tried once more. */
export async function runTenantAiMetered(
  secret: string,
  config: unknown,
  instructions: string,
  input: string,
  timeout = 30000,
  maxTokens = 8000,
): Promise<{ text: string; usage: AiUsage }> {
  return retryOnce(() => callTenantAi(secret, config, instructions, input, timeout, maxTokens))
}

async function callTenantAi(
  secret: string,
  config: unknown,
  instructions: string,
  input: string,
  timeout: number,
  maxTokens: number,
): Promise<{ text: string; usage: AiUsage }> {
  const sent = instructions + input
  const ai = createAiClient(secret, config, timeout)
  if (ai.provider === 'anthropic') {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(timeout),
      headers: { 'Content-Type': 'application/json', 'x-api-key': secret, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: ai.model,
        max_tokens: maxTokens,
        system: instructions,
        messages: [{ role: 'user', content: input }],
      }),
    })
    if (!response.ok)
      throw new IntegrationError(
        `Claude request failed (${response.status}). Check the saved key, model access and quota.`,
        502,
      )
    const result: any = await response.json()
    if (result.stop_reason !== 'end_turn')
      throw new IntegrationError('Claude did not complete the document. Reduce the scope and try again.', 502)
    const text = result.content
      ?.filter((block: any) => block.type === 'text')
      .map((block: any) => block.text)
      .join('\n')
    if (!text) throw new IntegrationError('Claude returned no text. Try again.', 502)
    return { text: String(text), usage: aiUsage(result.usage?.input_tokens, result.usage?.output_tokens, sent, text) }
  }
  if (ai.provider === 'openai') {
    const response = await ai.client.responses.create({
      model: ai.model,
      instructions,
      input,
      max_output_tokens: maxTokens,
    })
    if (response.status !== 'completed' || !response.output_text)
      throw new IntegrationError('The AI response was incomplete. Reduce the scope and try again.', 502)
    return {
      text: response.output_text,
      usage: aiUsage(response.usage?.input_tokens, response.usage?.output_tokens, sent, response.output_text),
    }
  }
  // Gemini counts its thinking against max_tokens, and by default thinks with a budget about as large as the whole
  // cap: it can spend it all and return nothing (finish_reason "length"). Low thinking leaves room for the answer.
  const gemini = ai.provider === 'gemini'
  const ask = (thinking: boolean) =>
    ai.client.chat.completions.create({
      model: ai.model,
      max_tokens: gemini ? maxTokens + GEMINI_THINKING_ROOM : maxTokens,
      ...(thinking ? { reasoning_effort: GEMINI_REASONING } : {}),
      messages: [
        { role: 'system', content: instructions },
        { role: 'user', content: input },
      ],
    })
  let completion: Awaited<ReturnType<typeof ask>>
  try {
    completion = await ask(gemini)
  } catch (error) {
    // A Gemini model without thinking settings refuses the field: ask again without it.
    if (!gemini || !rejectsReasoning(error)) throw error
    completion = await ask(false)
  }
  const choice = completion.choices[0]
  const text = choice?.message?.content || ''
  // The finish reason and token counts go into the server log, to show where the budget went.
  if (!text || choice?.finish_reason !== 'stop')
    throw new IntegrationError(
      `The AI response was incomplete. Reduce the scope and try again. (finish: ${choice?.finish_reason || 'none'}, ${incompleteUsage(completion.usage)})`,
      502,
    )
  return { text, usage: aiUsage(completion.usage?.prompt_tokens, completion.usage?.completion_tokens, sent, text) }
}

/** Thinking level asked of Gemini: "low" is about 1,024 thinking tokens, enough for this app's questions. */
export const GEMINI_REASONING = 'low' as const
/** Extra room on Gemini's cap for that thinking, so the answer itself keeps the full max_tokens. */
export const GEMINI_THINKING_ROOM = 2048

/** Token counts for the server log of an incomplete answer: where the budget went. */
function incompleteUsage(usage: any) {
  if (!usage) return 'no usage'
  const total = Number(usage.total_tokens) || 0
  const parts = (Number(usage.prompt_tokens) || 0) + (Number(usage.completion_tokens) || 0)
  return `in ${usage.prompt_tokens ?? '?'}, out ${usage.completion_tokens ?? '?'}, thinking ${Math.max(0, total - parts)}`
}
