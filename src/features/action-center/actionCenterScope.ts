import type { UserAccount, WorkItem } from '../../shared/types'

export type ActionCenterScopeSelection = 'mine' | 'all' | `user:${string}`
export type ResolvedActionCenterScope = { kind: 'mine' | 'all' | 'user'; userId?: string }
type ActionCenterAccount = Pick<UserAccount, 'id' | 'name' | 'role' | 'status'>

export function canBrowseTeamActionCenter(role: string) {
  return role === 'Administrator' || role === 'Contributor'
}

export function trackedActionCenterUsers(accounts: ActionCenterAccount[]) {
  return accounts.filter((account) => account.status === 'Active' && (account.role === 'Administrator' || account.role === 'Contributor'))
}

export function resolveActionCenterScope(selection: ActionCenterScopeSelection, currentUserId: string, currentRole: string, accounts: ActionCenterAccount[]): ResolvedActionCenterScope {
  if (!canBrowseTeamActionCenter(currentRole)) return { kind: 'mine', userId: currentUserId }
  if (selection === 'all') return { kind: 'all' }
  if (selection.startsWith('user:')) {
    const selectedId = selection.slice('user:'.length)
    const selectedUser = trackedActionCenterUsers(accounts).find((account) => account.id === selectedId)
    if (selectedUser) return { kind: selectedId === currentUserId ? 'mine' : 'user', userId: selectedId }
  }
  return { kind: 'mine', userId: currentUserId }
}

export function itemMatchesActionCenterScope(item: Pick<WorkItem, 'assignedToUserId'>, scope: ResolvedActionCenterScope) {
  return scope.kind === 'all' || Boolean(scope.userId && item.assignedToUserId === scope.userId)
}
