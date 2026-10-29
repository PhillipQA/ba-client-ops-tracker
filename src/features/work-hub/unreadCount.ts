// How many received emails and Discord messages are unread, for the badge on Work Hub. GitHub, GitLab and manual
// logs are never counted. The count reads only what Work Hub has already stored: it never starts a Gmail sync.
import { useEffect, useSyncExternalStore } from 'react'
import { useVisiblePolling } from '../../app/useVisiblePolling'
import type { AuthUser } from '../accounts/auth'
import { workHubSync } from './workHubSync'

export type UnreadSource = 'gmail' | 'discord'
export type UnreadCounts = { available: boolean; gmail: number; discord: number }
type Request = (url: string, init: RequestInit) => Promise<Response>

const NONE: UnreadCounts = { available: false, gmail: 0, discord: 0 }

export function createUnreadStore(options: { request?: Request } = {}) {
  const request = options.request || ((url, init) => fetch(url, init))
  let state = NONE,
    session = '',
    generation = 0
  let pending: Promise<void> | null = null,
    again = false
  const listeners = new Set<() => void>()
  const set = (next: UnreadCounts) => {
    if (next.available === state.available && next.gmail === state.gmail && next.discord === state.discord) return
    state = next
    for (const listener of listeners) listener()
  }
  /** Counts again. A count asked for while one is running runs once more afterwards, so none is missed. */
  const refresh = (): Promise<void> => {
    if (!session) return Promise.resolve()
    if (pending) {
      again = true
      return pending
    }
    const mine = generation
    pending = (async () => {
      try {
        const response = await request('/api/communications/unread', {
          credentials: 'same-origin',
          cache: 'no-store',
        })
        if (!response.ok || mine !== generation) return
        const data = await response.json()
        if (mine !== generation) return
        set({
          available: data.available === true,
          gmail: Math.max(0, Number(data.gmail) || 0),
          discord: Math.max(0, Number(data.discord) || 0),
        })
      } catch {
        // Offline or signed out: keep the last count; the next refresh tries again.
      } finally {
        pending = null
        if (again && mine === generation) {
          again = false
          void refresh()
        }
      }
    })()
    return pending
  }
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    refresh,
    /** Who is signed in. Another person, or nobody, starts from no count. */
    setSession(user: Pick<AuthUser, 'id' | 'organizationId' | 'status' | 'accountType' | 'modules'> | null) {
      const allowed = Boolean(
        user && user.status === 'Active' && user.accountType !== 'platform' && user.modules.includes('inbox'),
      )
      const next = allowed ? `${user!.organizationId || ''}:${user!.id}` : ''
      if (next === session) return
      session = next
      generation++
      pending = null
      again = false
      set(NONE)
      if (session) void refresh()
    },
    /** Changes the count at once, before the server confirms it (opening or marking messages). */
    adjust(source: UnreadSource, by: number) {
      if (!state.available) return
      set({ ...state, [source]: Math.max(0, state[source] + by) })
    },
    clear(source: UnreadSource) {
      if (!state.available) return
      set({ ...state, [source]: 0 })
    },
  }
}

export const unreadStore = createUnreadStore()

// A finished Gmail or Discord sync may have brought new messages: count again.
let syncedRevisions = ''
workHubSync.subscribe(() => {
  const { integrations } = workHubSync.getSnapshot()
  const key = `${integrations.gmail.revision}:${integrations.discord.revision}`
  if (key === syncedRevisions) return
  syncedRevisions = key
  void unreadStore.refresh()
})

export function useUnreadCounts() {
  return useSyncExternalStore(unreadStore.subscribe, unreadStore.getSnapshot, unreadStore.getSnapshot)
}

/**
 * Keeps the count for the signed-in person: counted at sign-in, after each sync, and every minute while the page is
 * in use (Discord messages arrive on their own).
 */
export function useUnreadPolling(user: AuthUser | null) {
  useEffect(() => {
    unreadStore.setSession(user)
  }, [user?.id, user?.organizationId, user?.status, user?.accountType, user?.modules?.join(',')])
  const enabled = Boolean(
    user && user.status === 'Active' && user.accountType !== 'platform' && user.modules.includes('inbox'),
  )
  useVisiblePolling(() => unreadStore.refresh(), {
    enabled,
    interval: 60_000,
    immediate: false,
    scope: user?.id,
  })
}

/** The badge text: up to 99, then 99+. */
export const badgeText = (count: number) => (count > 99 ? '99+' : String(count))
