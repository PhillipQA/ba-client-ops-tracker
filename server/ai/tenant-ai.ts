import { createAiClient, IntegrationError } from '../integrations/tenant-integrations'
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

/** The same call, with the tokens it used. */
export async function runTenantAiMetered(
  secret: string,
  config: unknown,
  instructions: string,
  input: string,
  timeout = 30000,
  maxTokens = 8000,
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
  const completion = await ai.client.chat.completions.create({
    model: ai.model,
    max_tokens: maxTokens,
    messages: [
      { role: 'system', content: instructions },
      { role: 'user', content: input },
    ],
  })
  if (completion.choices[0]?.finish_reason !== 'stop' || !completion.choices[0]?.message?.content)
    throw new IntegrationError('The AI response was incomplete. Reduce the scope and try again.', 502)
  const text = completion.choices[0].message.content
  return { text, usage: aiUsage(completion.usage?.prompt_tokens, completion.usage?.completion_tokens, sent, text) }
}
