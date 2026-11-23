/**
 * Your saved Tasks views: kept on the server with your preferences (so they follow you to any browser), or in this
 * browser when the server has nowhere to keep them (a database without schema v40).
 */
import { useCallback, useEffect, useState } from 'react'
import { cleanSavedViews, type SavedTaskView } from './taskViews'

const localKey = (scope: string) => `ba-task-views:${scope}`

function readLocal(scope: string) {
  try {
    return cleanSavedViews(JSON.parse(localStorage.getItem(localKey(scope)) || '[]'))
  } catch {
    return []
  }
}
function writeLocal(scope: string, views: SavedTaskView[]) {
  try {
    localStorage.setItem(localKey(scope), JSON.stringify(views))
  } catch {
    /* Storage blocked: the views last for this visit. */
  }
}

/** `scope` is the account and person ('' when no one is signed in). */
export function useSavedTaskViews(scope: string) {
  const [views, setViews] = useState<SavedTaskView[]>([])
  const [onServer, setOnServer] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!scope) {
      setViews([])
      return
    }
    let live = true
    fetch('/api/me/task-views', { credentials: 'same-origin' })
      .then(response => (response.ok ? response.json() : Promise.reject(new Error('unavailable'))))
      .then((body: { views?: unknown; stored?: boolean }) => {
        if (!live) return
        if (body.stored === false) {
          setOnServer(false)
          setViews(readLocal(scope))
        } else {
          setOnServer(true)
          setViews(cleanSavedViews(body.views))
        }
      })
      .catch(() => {
        if (!live) return
        setOnServer(false)
        setViews(readLocal(scope))
      })
    return () => {
      live = false
    }
  }, [scope])

  /** Saves the whole list; on failure the previous list comes back and the error is shown. */
  const save = useCallback(
    async (next: SavedTaskView[]) => {
      const clean = cleanSavedViews(next)
      const before = views
      setViews(clean)
      setError('')
      if (!onServer) {
        writeLocal(scope, clean)
        return true
      }
      try {
        const response = await fetch('/api/me/task-views', {
          method: 'PUT',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ views: clean }),
        })
        const body = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(body.error || 'Your views could not be saved.')
        setViews(cleanSavedViews(body.views))
        return true
      } catch (failure) {
        setViews(before)
        setError(failure instanceof Error ? failure.message : 'Your views could not be saved.')
        return false
      }
    },
    [views, onServer, scope],
  )

  return { views, save, onServer, error }
}
