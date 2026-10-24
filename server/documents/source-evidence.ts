import { IntegrationError } from '../integrations/tenant-integrations'

export type SourceEvidence = { sourceId: string; quote: string }
const normalized = (text: string) => text.replace(/\s+/g, ' ').trim()
export function validateEvidence(
  value: unknown,
  sources: { id: string; text: string }[],
  label: string,
): SourceEvidence[] {
  if (!Array.isArray(value) || !value.length || value.length > 20)
    throw new IntegrationError(`${label} needs source excerpts. Regenerate the requirement map.`, 422)
  return value.map(entry => {
    const source = sources.find(source => source.id === entry?.sourceId)
    if (
      !source ||
      typeof entry.quote !== 'string' ||
      !entry.quote.trim() ||
      entry.quote.length > 4000 ||
      !normalized(source.text).includes(normalized(entry.quote))
    ) {
      throw new IntegrationError(
        `${label} contains an unknown source or an excerpt not found in that source. Regenerate it.`,
        422,
      )
    }
    return { sourceId: source.id, quote: entry.quote.trim() }
  })
}
