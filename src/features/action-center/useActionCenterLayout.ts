/**
 * The person's Action Center layout: their own (on the server, or in this browser until schema v40 is run), else their
 * role's starting layout, else the built-in one. Saving is immediate; a failed save keeps the layout in this browser.
 */
import { useCallback, useEffect, useState } from 'react'
import { type ActionCenterLayout, cleanLayout, layoutToShow } from '../../shared/actionCenterLayout'
import { HttpError, requestJson } from '../../shared/http'
import type { AppModule } from '../../shared/types'

export type RoleLayout = { id: string; name: string; layout: ActionCenterLayout } | null
type Loaded = { own: ActionCenterLayout | null; role: RoleLayout; stored: boolean }

const keyFor = (organizationId: string, userId: string) => `ba-action-center:${organizationId}:${userId}`
const readLocal = (key: string) => {
  try {
    return cleanLayout(JSON.parse(window.localStorage.getItem(key) || 'null')) ?? null
  } catch {
    return null
  }
}
const writeLocal = (key: string, layout: ActionCenterLayout | null) => {
  try {
    if (layout) window.localStorage.setItem(key, JSON.stringify(layout))
    else window.localStorage.removeItem(key)
  } catch {
    /* Private mode: the layout lasts until the page closes. */
  }
}

export function useActionCenterLayout(
  user: { id: string; organizationId?: string | null },
  canSee: (module: AppModule) => boolean,
) {
  const key = keyFor(String(user.organizationId || ''), user.id)
  const [loaded, setLoaded] = useState<Loaded>({ own: readLocal(key), role: null, stored: false })
  const [error, setError] = useState('')

  useEffect(() => {
    let live = true
    requestJson<Loaded>('/api/me/action-center', { noStore: true })
      .then(result => {
        if (!live) return
        const own = result.stored ? (cleanLayout(result.own) ?? null) : readLocal(key)
        setLoaded({ own, role: result.role || null, stored: Boolean(result.stored) })
      })
      .catch(() => {
        /* The built-in or browser layout stays. */
      })
    return () => {
      live = false
    }
  }, [key])

  /** Saves the person's own layout; null goes back to their role's (or the built-in) layout. */
  const save = useCallback(
    async (layout: ActionCenterLayout | null) => {
      setError('')
      setLoaded(current => ({ ...current, own: layout }))
      if (!loaded.stored) return writeLocal(key, layout)
      try {
        await requestJson('/api/me/action-center', { method: 'PUT', body: { layout } })
      } catch (failure) {
        writeLocal(key, layout)
        if (failure instanceof HttpError && failure.status === 503)
          setLoaded(current => ({ ...current, stored: false }))
        setError('Your layout is kept in this browser for now; it could not be saved to your account.')
      }
    },
    [key, loaded.stored],
  )

  /** An Administrator saves a layout as a role's starting layout (null takes it off). */
  const saveForRole = useCallback(async (roleId: string, layout: ActionCenterLayout | null) => {
    const result = await requestJson<{ role: RoleLayout }>(
      `/api/account/roles/${encodeURIComponent(roleId)}/action-center`,
      { method: 'PUT', body: { layout }, fallback: 'The role layout could not be saved.' },
    )
    setLoaded(current => ({ ...current, role: result.role ?? current.role }))
  }, [])

  return {
    layout: layoutToShow({ own: loaded.own, role: loaded.role?.layout }, canSee),
    own: loaded.own,
    role: loaded.role,
    stored: loaded.stored,
    error,
    save,
    saveForRole,
  }
}
