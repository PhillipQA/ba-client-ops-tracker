/**
 * Notifications, the page address (back and forward), and the person's own preferences and profile.
 */
import { rememberTrackerRow } from '../../features/trackers/trackerNav'
import { SEEDS_PAGES } from '../navigation'
import { pathForRoute, atRoute, routeFromLocation } from '../routes'
import { useVisiblePolling } from '../useVisiblePolling'
import { workspaceAutoRefreshAllowed } from '../activePolling'
import { useEffect, useRef } from 'react'
import { getAuthSession } from '../../features/accounts/auth'
import { waitForCloudSaves } from '../cloudStore'
import { settingsRequest } from '../../features/settings/settingsRequest'
import { updateNotification, markAllNotificationsRead } from '../../features/notifications/notifications'
import type { AppNotification, UserAccount } from '../../shared/types'
import type { AppTheme } from '../../features/settings/theme'
import type { InterfaceMode } from '../../features/settings/appearance'
import { normalizeAccount, organizationStorageKey, seedStore } from '../store'
import type { UiState } from './useUiState'
import type { WorkspaceSave } from './useWorkspaceSave'
import type { SignIn } from './useSignIn'

export function useAccountAndRoutes(ui: UiState, saving: WorkspaceSave, signIn: SignIn) {
  const {
    notificationBusy,
    setNotificationBusy,
    authUser,
    setModal,
    setSelectedClientId,
    setSelectedProjectId,
    setDocumentLaunch,
    setView,
    storeRef,
    setEditingTaskId,
    view,
    selectedClientId,
    selectedProjectId,
    selectedProjectClientId,
    setSelectedProjectClientId,
    setStore,
    setAuthUser,
    setProfileOpen,
  } = ui
  const { acceptNotificationPayload } = saving
  const { hasModule, canWriteTasks, currentUser, canManageAccounts, visibleNavItems } = signIn
  const handleNotificationAction = async (notification: AppNotification, action: 'read' | 'unread' | 'dismiss') => {
    if (notificationBusy) return
    setNotificationBusy(true)
    try {
      const result = await updateNotification(notification.id, action)
      acceptNotificationPayload(result.notifications, result.updatedAt)
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Notification could not be updated.')
    } finally {
      setNotificationBusy(false)
    }
  }

  const handleReadAllNotifications = async () => {
    if (notificationBusy) return
    setNotificationBusy(true)
    try {
      const result = await markAllNotificationsRead()
      acceptNotificationPayload(result.notifications, result.updatedAt)
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Notifications could not be updated.')
    } finally {
      setNotificationBusy(false)
    }
  }

  useEffect(() => {
    const open = (event: Event) => {
      const detail = (event as CustomEvent).detail
      if (!authUser?.modules?.includes('documents') || !detail?.taskId) return
      setModal(null)
      setSelectedClientId(null)
      setSelectedProjectId(null)
      setDocumentLaunch({ ...detail, nonce: Date.now() })
      setView('documents')
    }
    window.addEventListener('dochub-create', open)
    return () => window.removeEventListener('dochub-create', open)
  }, [authUser?.id, setModal, setView, setSelectedProjectId, setDocumentLaunch, setSelectedClientId])
  const openNotification = (notification: AppNotification) => {
    if (!notification.readAt) void handleNotificationAction(notification, 'read')
    // A mention in a tracker row's comments opens that row.
    if (notification.trackerId && hasModule('trackers')) {
      rememberTrackerRow(notification.trackerId, notification.trackerRowId || '')
      setSelectedClientId(null)
      setSelectedProjectId(null)
      setView('trackers')
      return
    }
    const item = notification.taskId
      ? storeRef.current.items.find(candidate => candidate.id === notification.taskId)
      : undefined
    if (!item) {
      if (notification.documentId && hasModule('documents')) {
        setSelectedClientId(null)
        setSelectedProjectId(null)
        setView('documents')
      }
      return
    }
    setSelectedClientId(null)
    setSelectedProjectId(null)
    setView(hasModule('items') ? 'items' : 'inbox')
    if (canWriteTasks) {
      setEditingTaskId(item.id)
      setModal('taskEdit')
    }
  }

  // Real addresses: the page on screen is written to the address bar, and Back/Forward bring pages back.
  // The first write after signing in, and redirects away from a page the person cannot open, replace the address
  // instead of adding to the history, so Back never lands on a page that would only redirect again.
  const firstRouteWrite = useRef(true)
  const redirectingRoute = useRef(false)
  useEffect(() => {
    if (!currentUser) return
    const target = pathForRoute({
      view,
      clientId: selectedClientId,
      projectId: selectedProjectId,
      projectClientId: selectedProjectClientId,
    })
    const { pathname, search } = window.location
    if (!atRoute(pathname, search, target)) {
      try {
        if (firstRouteWrite.current || redirectingRoute.current) window.history.replaceState(null, '', target)
        else window.history.pushState(null, '', target)
      } catch {
        /* The page still shows; only the address is not updated. */
      }
      redirectingRoute.current = false
    }
    firstRouteWrite.current = false
  }, [currentUser?.id, view, selectedClientId, selectedProjectId, selectedProjectClientId])
  useEffect(() => {
    const onPop = () => {
      const route = routeFromLocation(window.location.pathname, window.location.search)
      setView(route?.view || 'action')
      setSelectedClientId(route?.clientId ?? null)
      setSelectedProjectId(route?.projectId ?? null)
      setSelectedProjectClientId(route?.projectClientId ?? null)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [setSelectedClientId, setSelectedProjectId, setSelectedProjectClientId, setView])

  useEffect(() => {
    if (!currentUser) return
    if (currentUser.accountType === 'platform' && currentUser.isPlatformAdmin) {
      if (view !== 'internal-admin') {
        redirectingRoute.current = true
        setSelectedClientId(null)
        setSelectedProjectId(null)
        setView('internal-admin')
      }
      return
    }
    if (view === 'themes' || (view === 'users' && canManageAccounts)) return
    if (view === 'seeds' && visibleNavItems.some(item => SEEDS_PAGES.includes(item.id))) return
    if (!visibleNavItems.length) {
      redirectingRoute.current = true
      setView('themes')
      return
    }
    if (!visibleNavItems.some(item => item.id === view)) {
      redirectingRoute.current = true
      setSelectedClientId(null)
      setSelectedProjectId(null)
      setView(visibleNavItems[0].id)
    }
  }, [
    currentUser?.id,
    currentUser?.role,
    currentUser?.accountType,
    currentUser?.modules.join('|'),
    view,
    setView,
    setSelectedProjectId,
    setSelectedClientId,
  ])

  const acceptAccountUsers = (users: UserAccount[]) => {
    const current = storeRef.current
    const accounts = users
      .map((account, index) => normalizeAccount(account, index))
      .filter((account): account is UserAccount => Boolean(account))
    const next = { ...current, accounts }
    storeRef.current = next
    setStore(next)
    localStorage.setItem(organizationStorageKey(authUser?.organizationId), JSON.stringify(next))
  }

  const saveOwnPreferences = async (patch: {
    name?: string
    email?: string
    phone?: string
    theme?: AppTheme
    interfaceMode?: InterfaceMode | null
    clientId?: string
    clientTheme?: AppTheme | null
    newPassword?: string
    currentPassword?: string
  }) => {
    await waitForCloudSaves()
    const result = await settingsRequest('/api/account/profile', 'PATCH', patch)
    const accounts = storeRef.current.accounts
    acceptAccountUsers(
      accounts.map(account => (account.id === result.user.id ? { ...account, ...result.user } : account)),
    )
    if (patch.newPassword) setAuthUser(await getAuthSession())
    // Take only the profile fields. The response's role and modules are the stored account's, not the session's
    // (an Administrator gets every module the account has), so copying them hid pages such as Data explorer
    // until the page was reloaded.
    else
      setAuthUser(current => {
        if (!current || current.id !== result.user.id) return current
        const { name, email, phone, theme, interfaceMode, clientThemes } = result.user
        return {
          ...current,
          ...(name !== undefined && { name }),
          ...(email !== undefined && { email }),
          ...(phone !== undefined && { phone }),
          ...(theme !== undefined && { theme }),
          ...(interfaceMode !== undefined && { interfaceMode }),
          ...(clientThemes !== undefined && { clientThemes }),
        }
      })
  }

  const updateOwnProfile = async (profile: {
    name: string
    email: string
    phone: string
    theme: AppTheme
    newPassword?: string
    currentPassword?: string
  }) => {
    try {
      await saveOwnPreferences(profile)
      return profile.newPassword ? 'Password changed. Sign in with your new password.' : 'Profile updated.'
    } catch (error) {
      return error instanceof Error ? error.message : 'Profile save failed.'
    }
  }

  // Active pages recheck the session; every server action still verifies permissions.
  useVisiblePolling(
    async signal => {
      const session = await getAuthSession()
      if (signal.aborted) return
      setAuthUser(session)
      if (!session) {
        setStore(seedStore())
        setProfileOpen(false)
        setSelectedClientId(null)
        setSelectedProjectId(null)
      }
    },
    {
      enabled: Boolean(authUser && workspaceAutoRefreshAllowed(view, selectedClientId, selectedProjectId)),
      interval: 60_000,
      immediate: false,
      scope: `${authUser?.id}:${view}`,
    },
  )

  return {
    acceptAccountUsers,
    handleNotificationAction,
    handleReadAllNotifications,
    openNotification,
    saveOwnPreferences,
    updateOwnProfile,
  }
}

export type AccountAndRoutes = ReturnType<typeof useAccountAndRoutes>
