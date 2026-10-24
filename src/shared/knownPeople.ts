import type { Client, UserAccount } from './types'
import type { Suggestion } from './ui/RecipientInput'

/**
 * People whose email address the tracker already knows: client contacts and active teammates.
 * Used by the email composer and by Document Creation, so both suggest the same people.
 */
export function knownPeople({
  clients,
  accounts,
  leaveOut,
}: {
  clients: Client[]
  accounts?: UserAccount[]
  leaveOut?: { id?: string; email?: string }
}): Suggestion[] {
  const skip = (leaveOut?.email || '').trim().toLowerCase()
  const customers: Suggestion[] = clients
    .filter(client => client.email?.trim() && !client.archived)
    .map(client => ({
      email: client.email.trim(),
      name: (client.contact || client.name || '').trim(),
      hint: client.contact ? `Client · ${client.name}` : 'Client',
    }))
  const team: Suggestion[] = (accounts || [])
    .filter(
      account =>
        account.status === 'Active' &&
        account.email?.trim() &&
        account.id !== leaveOut?.id &&
        account.email.trim().toLowerCase() !== skip,
    )
    .map(account => ({ email: account.email.trim(), name: String(account.name || '').trim(), hint: 'Teammate' }))
  return [...customers, ...team]
}
