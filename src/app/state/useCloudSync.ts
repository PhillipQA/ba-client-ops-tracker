/**
 * Keeping the workspace in step with the server: save conflicts, merged edits, recovery, signing in from a
 * stored session, and refreshing in the background.
 */
import { useVisiblePolling } from '../useVisiblePolling'
import { workspaceAutoRefreshAllowed } from '../activePolling'
import { useEffect } from 'react'
import { getAuthSession } from '../../features/accounts/auth'
import {
  pendingCloudEdits,
  type WorkspaceMerged,
  WORKSPACE_MERGED,
  loadCloudStore,
  resetCloudSession,
  queueCloudStoreSave,
  resolveSaveClash,
} from '../cloudStore'
import type { ClashChoice } from '../conflictChoice'
import { mergeWorkspace } from '../workspaceMerge'
import {
  organizationStorageKey,
  type Store,
  normalizeStore,
  seedStore,
  initialStore,
  STORE_SCHEMA_VERSION,
} from '../store'
import type { UiState } from './useUiState'
import { TASK_LAYOUTS } from '../../features/tasks/taskViews'

export function useCloudSync(ui: UiState) {
  const {
    authUser,
    storeRef,
    setSaveConflict,
    setCloudStatus,
    setCloudMessage,
    setStore,
    setRecoveringCloud,
    setLastCloudSync,
    resetToken,
    setAuthChecking,
    setAuthUser,
    setActionCenterScope,
    setClientLayout,
    setTaskLayout,
    setBoardGroup,
    setBoardShowSubtasks,
    setTaskCalendarDate,
    workspaceRefreshBusy,
    setRefreshingCloud,
    cloudStatus,
    view,
    selectedClientId,
    selectedProjectId,
  } = ui
  useEffect(() => {
    const onConflict = (event: Event) => {
      const message = (event as CustomEvent<string>).detail
      try {
        localStorage.setItem(
          `${organizationStorageKey(authUser?.organizationId)}:pending-edits`,
          JSON.stringify(pendingCloudEdits<Store>() || storeRef.current),
        )
      } catch {
        /* The on-screen draft remains available. */
      }
      setSaveConflict(message)
      setCloudStatus('error')
      setCloudMessage(message)
    }
    window.addEventListener('workspace-save-conflict', onConflict)
    return () => window.removeEventListener('workspace-save-conflict', onConflict)
  }, [authUser?.organizationId, setSaveConflict, setCloudMessage, setCloudStatus, storeRef])
  // A save merged changes made elsewhere (another person, tab or capture): show them, keeping edits made since.
  useEffect(() => {
    const onMerged = (event: Event) => {
      const detail = (event as CustomEvent<WorkspaceMerged>).detail
      const merged = mergeWorkspace(detail.saved as Store, storeRef.current, detail.data as Store)
      if (!merged.ok) {
        // The person changed the same field meanwhile. Their screen cannot show the other changes, and saving it as it
        // is would undo them: refuse, so saving stops and the Save conflict box appears (see cloudStore).
        detail.clash = merged.clash
        event.preventDefault()
        return
      }
      const next = normalizeStore(merged.data, seedStore())
      storeRef.current = next
      setStore(next)
      try {
        localStorage.setItem(organizationStorageKey(authUser?.organizationId), JSON.stringify(next))
      } catch {
        /* The workspace on screen is current; only the browser copy is behind. */
      }
    }
    window.addEventListener(WORKSPACE_MERGED, onMerged)
    return () => window.removeEventListener(WORKSPACE_MERGED, onMerged)
  }, [authUser?.organizationId, setStore, storeRef])

  const recoverCloud = async () => {
    setRecoveringCloud(true)
    try {
      const activePending = pendingCloudEdits<Store>()
      const pending = activePending
        ? JSON.stringify(activePending, null, 2)
        : localStorage.getItem(`${organizationStorageKey(authUser?.organizationId)}:pending-edits`) ||
          JSON.stringify(storeRef.current, null, 2)
      localStorage.setItem(`${organizationStorageKey(authUser?.organizationId)}:pending-edits`, pending)
      const url = URL.createObjectURL(new Blob([pending], { type: 'application/json' }))
      const link = document.createElement('a')
      link.href = url
      link.download = `pending-workspace-edits-${Date.now()}.json`
      link.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      const result = await loadCloudStore<Store>({ recover: true })
      if (!result.configured || !result.data)
        throw new Error('The latest workspace could not be loaded. Your pending edits are retained.')
      const next = normalizeStore(result.data, seedStore())
      storeRef.current = next
      setStore(next)
      localStorage.setItem(organizationStorageKey(authUser?.organizationId), JSON.stringify(next))
      localStorage.removeItem(`${organizationStorageKey(authUser?.organizationId)}:pending-edits`)
      setLastCloudSync(result.updatedAt || '')
      setSaveConflict('')
      setCloudStatus('synced')
      setCloudMessage('Latest workspace loaded. Reapply your edits from the downloaded copy.')
    } catch (error) {
      setCloudMessage(error instanceof Error ? error.message : 'Reload failed.')
    } finally {
      setRecoveringCloud(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    if (resetToken !== null) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search)
      setAuthChecking(false)
      return
    }
    void getAuthSession()
      .then(user => {
        if (!cancelled) setAuthUser(user)
      })
      .catch(error => {
        console.error(error)
      })
      .finally(() => {
        if (!cancelled) setAuthChecking(false)
      })
    return () => {
      cancelled = true
    }
  }, [setAuthChecking, setAuthUser])

  useEffect(() => {
    setActionCenterScope('mine')
  }, [authUser?.id, authUser?.organizationId, setActionCenterScope])

  useEffect(() => {
    if (!authUser) {
      setClientLayout('tiles')
      return
    }
    try {
      const saved = localStorage.getItem(`ba-client-layout:${authUser.organizationId}:${authUser.id}`)
      setClientLayout(saved === 'list' || saved === 'table' ? saved : 'tiles')
    } catch {
      setClientLayout('tiles')
    }
  }, [authUser?.id, authUser?.organizationId, setClientLayout])

  useEffect(() => {
    setTaskLayout('table')
    setBoardGroup('status')
    setBoardShowSubtasks(false)
    setTaskCalendarDate('due')
    if (!authUser) return
    try {
      const saved = JSON.parse(
        localStorage.getItem(`ba-task-view:${authUser.organizationId}:${authUser.id}`) || '{}',
      ) as { layout?: string; group?: string; subtasks?: boolean; calendarDate?: string }
      setTaskLayout(TASK_LAYOUTS.find(layout => layout === saved.layout) || 'table')
      setTaskCalendarDate(saved.calendarDate === 'followUp' ? 'followUp' : 'due')
      setBoardGroup(saved.group === 'waiting' ? 'waiting' : 'status')
      setBoardShowSubtasks(saved.subtasks === true)
    } catch {
      /* Defaults already applied. */
    }
  }, [authUser?.id, authUser?.organizationId, setBoardGroup, setTaskLayout, setBoardShowSubtasks, setTaskCalendarDate])

  useEffect(() => {
    resetCloudSession()
    setSaveConflict('')
    if (!authUser) return
    if (authUser.accountType === 'platform') {
      setStore(seedStore())
      setCloudStatus('synced')
      setCloudMessage('Internal Admin · control plane')
      setLastCloudSync('')
      return
    }
    let cancelled = false
    const connectCloud = async () => {
      setCloudStatus('checking')
      setCloudMessage('Checking cloud storage…')
      const tenantStorageKey = organizationStorageKey(authUser.organizationId)
      const cached = localStorage.getItem(tenantStorageKey)
      if (localStorage.getItem(`${tenantStorageKey}:pending-edits`))
        setSaveConflict(
          'A pending copy from a previous save conflict is available. Download it and reapply the needed edits to the latest workspace.',
        )
      if (cached) {
        try {
          setStore(normalizeStore(JSON.parse(cached), seedStore()))
        } catch {
          /* cloud load will replace invalid cache */
        }
      } else {
        setStore(seedStore())
      }
      try {
        const result = await loadCloudStore<Store>()
        if (cancelled) return
        if (!result.configured) {
          setCloudStatus('local')
          setCloudMessage('Local browser storage')
          return
        }
        if (result.data) {
          const sourceVersion = Number((result.data as Partial<Store>).schemaVersion || 0)
          const cloud = normalizeStore(result.data, initialStore())
          setStore(cloud)
          localStorage.setItem(tenantStorageKey, JSON.stringify(cloud))
          setLastCloudSync(result.updatedAt || new Date().toISOString())
          setCloudMessage('Database synced')
          setCloudStatus('synced')
          if (sourceVersion < STORE_SCHEMA_VERSION) {
            void queueCloudStoreSave(cloud).catch(error =>
              console.error('Could not save migrated tracker data:', error),
            )
          }
          return
        }
        const local = cached ? normalizeStore(JSON.parse(cached), seedStore()) : seedStore()
        const saved = await queueCloudStoreSave(local)
        if (cancelled) return
        setLastCloudSync(saved.updatedAt || new Date().toISOString())
        setCloudMessage('Database initialized from this browser')
        setCloudStatus('synced')
      } catch (error) {
        if (cancelled) return
        console.error(error)
        setCloudStatus('error')
        setCloudMessage('Cloud unavailable · using local cache')
      }
    }
    void connectCloud()
    return () => {
      cancelled = true
    }
  }, [authUser?.id, setCloudStatus, setStore, setSaveConflict, setCloudMessage, setLastCloudSync])

  const refreshWorkspace = async (manual = false, signal?: AbortSignal) => {
    if (!authUser || authUser.accountType === 'platform' || workspaceRefreshBusy.current) return
    workspaceRefreshBusy.current = true
    if (manual) setRefreshingCloud(true)
    try {
      const result = await loadCloudStore<Store>({ onlyIfChanged: !manual, signal })
      if (signal?.aborted || !result.configured) return
      if (result.data) {
        const refreshed = normalizeStore(result.data, seedStore())
        storeRef.current = refreshed
        setStore(refreshed)
        localStorage.setItem(organizationStorageKey(authUser.organizationId), JSON.stringify(refreshed))
        setLastCloudSync(result.updatedAt || new Date().toISOString())
        setCloudStatus('synced')
        setCloudMessage('Database synced')
      }
    } catch (error) {
      if (!signal?.aborted) {
        console.error('Workspace refresh failed:', error)
        if (manual) setCloudMessage(error instanceof Error ? error.message : 'Could not refresh the workspace.')
      }
    } finally {
      workspaceRefreshBusy.current = false
      if (manual) setRefreshingCloud(false)
    }
  }
  useVisiblePolling(signal => refreshWorkspace(false, signal), {
    enabled: Boolean(
      authUser &&
        authUser.accountType !== 'platform' &&
        (cloudStatus === 'synced' || cloudStatus === 'saving') &&
        workspaceAutoRefreshAllowed(view, selectedClientId, selectedProjectId),
    ),
    interval: 5 * 60_000,
    scope: `${authUser?.id}:${view}:${selectedClientId || ''}:${selectedProjectId || ''}`,
    events: ['dochub-updated'],
  })

  /**
   * Settles a save conflict for the one record it is about (Phase 4B): keep this browser's version or take the other
   * one. Returns the next clashing record, if any, for the next choice; otherwise saving resumes.
   */
  const settleConflict = async (choice: ClashChoice) => {
    const result = await resolveSaveClash<Store>(choice)
    if (!result.done) return result.next
    try {
      localStorage.removeItem(`${organizationStorageKey(authUser?.organizationId)}:pending-edits`)
    } catch {
      /* Nothing pending is kept. */
    }
    setSaveConflict('')
    setLastCloudSync(result.saved.updatedAt || new Date().toISOString())
    setCloudStatus('synced')
    setCloudMessage('Database synced')
    return undefined
  }

  return { recoverCloud, refreshWorkspace, settleConflict }
}

export type CloudSync = ReturnType<typeof useCloudSync>
