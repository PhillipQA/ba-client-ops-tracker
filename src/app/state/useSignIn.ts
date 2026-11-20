/**
 * Signing in and out, and the signed-in person: their role, modules and what they may change.
 */
import { type View, PAGE_MODULES, navItems } from '../navigation'
import { workHubSync } from '../../features/work-hub/workHubSync'
import {
  type AuthUser,
  INTERNAL_ADMIN_PATH,
  login,
  loginInternalAdmin,
  loginWithGoogle,
  logout,
} from '../../features/accounts/auth'
import { waitForCloudSaves } from '../cloudStore'
import type { UserAccount, AppModule } from '../../shared/types'
import { normalizeInterfaceMode } from '../../features/settings/appearance'
import { seedStore } from '../store'
import { forgetBrowserCopies } from './browserCopies'
import type { UiState } from './useUiState'

export function useSignIn(ui: UiState) {
  const {
    setAuthUser,
    setCloudStatus,
    setCloudMessage,
    setView,
    setLoginBusy,
    setLoginError,
    setAuthChecking,
    logoutBusy,
    setLogoutBusy,
    authUser,
    setProfileOpen,
    setSelectedClientId,
    setSelectedProjectId,
    setNewExternalInquiryIds,
    setEditingRecord,
    setStore,
    store,
    today,
    selectedClientId,
    selectedProjectId,
    view,
    lifecycleSaving,
  } = ui
  /** After a sign-in, by password or with Google: open the person's first page. */
  const enterAs = (user: AuthUser) => {
    void workHubSync.setSession(user, true)
    setAuthUser(user)
    if (user.accountType === 'platform' && user.isPlatformAdmin) {
      setCloudStatus('synced')
      setCloudMessage('Internal Admin · control plane')
      setView('internal-admin')
    } else {
      setCloudStatus('checking')
      setCloudMessage('Checking cloud storage…')
      setView(
        user.role === 'Administrator' || user.modules.includes('action')
          ? 'action'
          : (user.modules[0] as View) || 'reports',
      )
    }
  }

  const handleLogin = async (account: string, username: string, password: string) => {
    setLoginBusy(true)
    setLoginError('')
    try {
      enterAs(await login(account, username, password))
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : 'Login failed.')
    } finally {
      setLoginBusy(false)
      setAuthChecking(false)
    }
  }

  /** Internal Admin, from its own page (/internal_admin). Once signed in, the app opens at its home. */
  const handleInternalLogin = async (username: string, password: string) => {
    setLoginBusy(true)
    setLoginError('')
    try {
      const user = await loginInternalAdmin(username, password)
      if (window.location.pathname.replace(/\/+$/, '') === INTERNAL_ADMIN_PATH)
        window.history.replaceState(null, '', '/')
      enterAs(user)
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : 'Login failed.')
    } finally {
      setLoginBusy(false)
      setAuthChecking(false)
    }
  }

  /** Sign in with Google. Answers the accounts to choose from when the email is registered in several. */
  const handleGoogleLogin = async (credential: string, account?: string) => {
    setLoginBusy(true)
    setLoginError('')
    try {
      const result = await loginWithGoogle(credential, account)
      if ('accounts' in result) return result.accounts
      enterAs(result.user)
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : 'Sign in with Google failed.')
    } finally {
      setLoginBusy(false)
      setAuthChecking(false)
    }
    return null
  }

  const handleLogout = async () => {
    if (logoutBusy) return
    setLogoutBusy(true)
    try {
      // Changes still being saved would be cut off by signing out (the save needs the session): wait for them, and
      // ask before losing any that cannot be saved.
      const saved = await Promise.race([
        waitForCloudSaves().then(
          () => true,
          () => false,
        ),
        new Promise<boolean>(resolve => window.setTimeout(() => resolve(false), 10_000)),
      ])
      if (
        !saved &&
        !window.confirm(
          'Your latest changes have not been saved yet. Sign out anyway? Changes that are not saved will be lost.',
        )
      )
        return
      const signedOut = authUser
      await logout()
      forgetBrowserCopies(signedOut)
      void workHubSync.setSession(null)
      setAuthUser(null)
      setProfileOpen(false)
      setSelectedClientId(null)
      setSelectedProjectId(null)
      setNewExternalInquiryIds([])
      setEditingRecord(null)
      setStore(seedStore())
      setLoginError('')
    } catch (error) {
      console.error('Sign out could not be confirmed:', error)
      window.alert(error instanceof Error ? error.message : 'Sign out could not be confirmed. Please try again.')
    } finally {
      setLogoutBusy(false)
    }
  }

  const accountCurrentUser = authUser
    ? store.accounts.find(account => account.id === authUser.id && account.status === 'Active')
    : null
  // Job roles (Settings › Roles) decide a non-Administrator's pages and what they can change; the server applies the
  // same rule to every request. Without a job role, the modules picked for them by hand stay.
  const roleModules = authUser?.role === 'Administrator' ? undefined : store.access?.modules
  const roleEdit = authUser?.role === 'Administrator' ? undefined : store.access?.editModules
  const roleViewer = Boolean(roleModules && roleEdit && !roleEdit.length)
  const currentUser: UserAccount | null = authUser
    ? {
        ...(accountCurrentUser ?? { ...authUser, passwordHash: '', createdAt: today }),
        role: roleViewer ? 'Viewer' : authUser.role,
        modules: roleModules
          ? authUser.organizationModules?.length
            ? roleModules.filter(module => authUser.organizationModules?.includes(module))
            : roleModules
          : authUser.modules,
        organizationId: authUser.organizationId,
        organizationName: authUser.organizationName,
        organizationSlug: authUser.organizationSlug,
        organizationModules: authUser.organizationModules || authUser.modules,
        isPlatformAdmin: authUser.isPlatformAdmin,
        accountType: authUser.accountType,
        accountKey: authUser.accountKey,
        interfaceMode: normalizeInterfaceMode(authUser.interfaceMode),
        lastLoginAt: authUser.lastLoginAt,
      }
    : null
  // Whether this person may change things on the page they are on: a job role can see a page without changing it.
  const canEditModule = (module: AppModule) => !roleEdit || roleEdit.includes(module)
  const pageModule: AppModule | null = selectedClientId
    ? 'clients'
    : selectedProjectId
      ? 'projects'
      : (PAGE_MODULES as Record<string, AppModule | undefined>)[view] || null
  const canWrite = Boolean(
    currentUser && currentUser.role !== 'Viewer' && !lifecycleSaving && (!pageModule || canEditModule(pageModule)),
  )
  const canManageAccounts = currentUser?.role === 'Administrator' && currentUser.accountType !== 'platform'
  const hasModule = (module: AppModule) => Boolean(currentUser && currentUser.modules.includes(module))
  // Tasks open from many pages, so this follows the task rights, not the page.
  const canWriteTasks = Boolean(
    currentUser &&
      currentUser.role !== 'Viewer' &&
      !lifecycleSaving &&
      ((hasModule('items') && canEditModule('items')) || (hasModule('inbox') && canEditModule('inbox'))),
  )
  // Account Managers are Viewers who may still ask the AI BA Assistant about their clients.
  // A Viewer by job role (an Account Manager, say) may still ask the AI BA Assistant.
  const canUseAI = Boolean(currentUser && (currentUser.role !== 'Viewer' || roleViewer) && hasModule('ai'))
  const visibleNavItems = currentUser
    ? navItems.filter(item => hasModule(item.id) && (item.id !== 'ai' || canUseAI))
    : []

  return {
    hasModule,
    canWriteTasks,
    currentUser,
    canManageAccounts,
    visibleNavItems,
    canWrite,
    canUseAI,
    handleLogin,
    handleInternalLogin,
    handleGoogleLogin,
    handleLogout,
  }
}

export type SignIn = ReturnType<typeof useSignIn>
