/** Tokens one call used. `estimated` when the provider did not say and it is worked out from the text length. */
export type AiUsage = { input: number; output: number; estimated?: boolean }

const count = (value: unknown) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Math.round(Number(value)) : 0)
/** The provider's own count, or about four characters a token when it gives none. */
export function aiUsage(input: unknown, output: unknown, sent: string, received: string): AiUsage {
  if (count(input) || count(output)) return { input: count(input), output: count(output) }
  return { input: Math.ceil(sent.length / 4), output: Math.ceil(received.length / 4), estimated: true }
}
