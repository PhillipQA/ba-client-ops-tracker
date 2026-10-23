import type { Suggestion } from './RecipientInput'

/**
 * People this person has emailed or who emailed them, from the server's list.
 * Always safe to call: a failure, an unconnected Gmail or a signed-out page just returns nobody.
 */
export async function searchContacts(query: string, signal?: AbortSignal): Promise<{ people: Suggestion[]; partial?: boolean }> {
  const response = await fetch(`/api/communications/contacts?q=${encodeURIComponent(query)}`, { credentials: 'same-origin', signal })
  if (!response.ok) return { people: [] }
  const result = await response.json().catch(() => ({}))
  return { people: Array.isArray(result.people) ? result.people : [], partial: Boolean(result.partial) }
}
