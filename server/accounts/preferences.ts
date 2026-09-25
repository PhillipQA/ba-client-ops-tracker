import { normalizeInterfaceMode } from '../../src/appearance'

// Workspace snapshots can be stale in another user's tab. Only the authenticated
// profile endpoint owns interface-mode changes, including restoring legacy mode.
export function preserveInterfaceModes(current: any[], incoming: any[]) {
  const accounts = new Map(current.map(account => [String(account.id), account]))
  return incoming.map(account => ({
    ...account,
    interfaceMode: normalizeInterfaceMode(accounts.get(String(account.id))?.interfaceMode),
  }))
}
