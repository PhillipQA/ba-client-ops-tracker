/** Whether the left menu is collapsed to icons. It is a per-browser preference, so it is remembered here and nowhere else. */
export const SIDEBAR_COLLAPSED_KEY = 'ba.sidebar.collapsed'

type Store = Pick<Storage, 'getItem' | 'setItem'>

function browserStorage(): Store | null {
  try { return typeof window === 'undefined' ? null : window.localStorage } catch { return null }
}

export function readSidebarCollapsed(storage: Store | null = browserStorage()): boolean {
  try { return storage?.getItem(SIDEBAR_COLLAPSED_KEY) === '1' } catch { return false }
}

export function writeSidebarCollapsed(collapsed: boolean, storage: Store | null = browserStorage()): void {
  try { storage?.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0') } catch { /* A blocked or full store only means the choice is not remembered. */ }
}
