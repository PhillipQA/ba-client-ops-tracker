import { useEffect, useRef, useState } from 'react'
import { requestJson } from '../shared/http'
import { workspaceAutoRefreshAllowed } from './activePolling'
import { workHubSync } from '../features/work-hub/workHubSync'
import { badgeText, useUnreadCounts, useUnreadPolling } from '../features/work-hub/unreadCount'
import RequirementsTraceability from '../features/requirements/RequirementsTraceability'
import Trackers from '../features/trackers/Trackers'
import { ClosedStatusContext } from '../features/tasks/openWork'
import { WorkflowLabelsContext } from '../shared/ui/Chips'
import { EmailComposerHost } from '../features/email/EmailComposer'
import NotificationCenter from '../features/notifications/NotificationCenter'
import AssistantWatch from '../features/ai/AssistantWatch'
import TimerChip from '../features/tasks/TimerChip'
import TaskDock, { useTaskDock } from '../features/tasks/TaskDock'
import RecordEditDialog from '../features/tasks/RecordEditDialog'
import LifecycleControls from '../features/tasks/LifecycleControls'
import { isArchived } from '../features/tasks/lifecycle'
import AppTour from '../features/onboarding/AppTour'
import { tourSteps, tourStorageKey, type TourView } from '../features/onboarding/tourSteps'
import CloseWithSubtasksDialog from '../features/tasks/CloseWithSubtasksDialog'
import {
  Building2,
  CircleDot,
  Compass,
  Pencil,
  Plus,
  RefreshCw,
  ShieldCheck,
  LogOut,
  UserRound,
  LockKeyhole,
  Sparkles,
  PanelLeftClose,
  PanelLeftOpen,
  Users,
} from 'lucide-react'
import DocumentCreation from '../features/documents/DocumentCreation'
import InternalAdmin from '../features/admin/InternalAdmin'
import { ResetPassword } from '../features/accounts/PasswordRecovery'
import { loadCloudStore } from './cloudStore'
import CustomReports from '../features/reports/custom/CustomReports'
import Settings from '../features/settings/Settings'
import '../features/work-hub/communications.css'
import '../features/integrations/github.css'
import AccountUsers from '../features/accounts/AccountUsers'
import ThemePreferences from '../features/settings/ThemePreferences'
import { themeForContext } from '../features/settings/theme'
import { normalizeInterfaceMode } from '../features/settings/appearance'
import { AuthSplash, InternalAdminLogin, LoginScreen } from './AuthScreens'
import { INTERNAL_ADMIN_PATH } from '../features/accounts/auth'
import { Modal } from './Modal'
import { ProfileModal } from './ProfileModal'
import { type Store, isTaskClosed, normalizeStore, seedStore } from './store'
import { ActivityForm } from '../features/action-center/ActionCenterParts'
import { ClientDetail, ClientForm, ProjectDetail, ProjectForm } from '../features/clients/ClientViews'
import { TaskEditForm, TaskForm } from '../features/tasks/TaskForms'
import MoveToSeedsDialog from '../features/seeds/MoveToSeedsDialog'
import { useAppState } from './useAppState'
import { isSeedsView, labels, sidebarItems } from './navigation'
import { SeedsSyncPage, SeedsTabs } from '../features/seeds/SeedsPage'
import { VIEW_PATHS, opensElsewhere } from './routes'
import { ActionCenterPage } from '../features/action-center/ActionCenterPage'
import { ClientsPage } from '../features/clients/ClientsPage'
import { ProjectsPage } from '../features/clients/ProjectsPage'
import { InboxPage } from '../features/inbox/InboxPage'
import { TasksPage } from '../features/tasks/TasksPage'
import { AiPage } from '../features/ai/AiPage'
function App() {
  const appState = useAppState()
  const {
    acceptAccountUsers,
    applyCommentMutation,
    applyEvidenceMutation,
    applyTimeEntryMutation,
    authChecking,
    authUser,
    canManageAccounts,
    canUseAI,
    canWrite,
    canWriteTasks,
    closedStatus,
    cloudMessage,
    cloudStatus,
    createTrackerTasks,
    moveTrackerTasks,
    updateTrackerTasks,
    currentUser,
    deleteTask,
    documentLaunch,
    editingActivity,
    editingRecord,
    editingTask,
    movingToSeeds,
    setMovingToSeeds,
    moveWorkToSeeds,
    handleLogin,
    handleInternalLogin,
    handleGoogleLogin,
    handleLogout,
    handleNotificationAction,
    handleReadAllNotifications,
    hasModule,
    hubSyncing,
    lastCloudSync,
    loginBusy,
    loginError,
    logoutBusy,
    modal,
    navCollapsed,
    notificationBusy,
    openNotification,
    openRtms,
    openSubtaskCreator,
    openTaskEditor,
    pageActive,
    persist,
    profileOpen,
    railTip,
    recoverCloud,
    recoveringCloud,
    refreshNotifications,
    refreshWorkspace,
    refreshingCloud,
    reorderSubtasks,
    resetToken,
    resolveItem,
    closeRequest,
    rtmContext,
    saveActivity,
    saveConflict,
    saveLifecycleRecord,
    saveOwnPreferences,
    saveRtms,
    saveTaskEdit,
    selectedClient,
    selectedClientId,
    selectedProject,
    selectedProjectClientId,
    selectedProjectId,
    setAiClientId,
    setAiProjectId,
    setAiPrompt,
    setAuthUser,
    setEditingActivityId,
    setEditingRecord,
    setEditingTaskId,
    setLoginError,
    setModal,
    setProfileOpen,
    setResetToken,
    setRtmContext,
    setSelectedClientId,
    setSelectedProjectClientId,
    setSelectedProjectId,
    setStore,
    setTaskPreset,
    setView,
    store,
    taskEditSaving,
    taskPreset,
    today,
    toggleNav,
    updateOwnProfile,
    updateTaskStatus,
    view,
    visibleNavItems,
  } = appState
  useUnreadPolling(authUser)
  const unread = useUnreadCounts()
  const unreadTotal = unread.available ? unread.gmail + unread.discord : 0
  const unreadTitle = [
    unread.gmail ? `${unread.gmail} unread email${unread.gmail === 1 ? '' : 's'}` : '',
    unread.discord ? `${unread.discord} unread Discord message${unread.discord === 1 ? '' : 's'}` : '',
  ]
    .filter(Boolean)
    .join(', ')

  // Minimized task windows (their own dock, bottom left; email drafts have theirs, bottom right). Up to four.
  const taskDock = useTaskDock(`ba.taskDock:${currentUser?.organizationId || ''}:${currentUser?.id || ''}`)
  const taskDirty = useRef<() => boolean>(() => false)
  /** Puts the open task aside on the dock. Unsaved changes would be dropped, so the person is asked first. */
  const minimizeTask = () => {
    if (!editingTask) return true
    if (
      taskDirty.current() &&
      !window.confirm('This task has changes you have not saved. Minimizing drops them. Minimize anyway?')
    )
      return false
    const problem = taskDock.add(editingTask.id)
    if (problem) {
      window.alert(problem)
      return false
    }
    setModal(null)
    setEditingTaskId(null)
    return true
  }
  // A task opened from anywhere is no longer minimized.
  const openTaskId = modal === 'taskEdit' ? editingTask?.id : undefined
  useEffect(() => {
    if (openTaskId && taskDock.docked.includes(openTaskId)) taskDock.remove(openTaskId)
  }, [openTaskId])
  /** Opens a minimized task; a task open now is minimized in its place. */
  const openDockedTask = (id: string) => {
    taskDock.remove(id)
    if (modal === 'taskEdit' && editingTask && editingTask.id !== id && !minimizeTask()) {
      taskDock.add(id)
      return
    }
    openTaskEditor(id)
  }

  // Guided tour: starts by itself at a person's first sign-in in this browser, and from Tour in the top bar.
  const [tourOpen, setTourOpen] = useState(false)
  const tourKey = tourStorageKey(currentUser?.organizationId, currentUser?.id)
  const inWorkspace = Boolean(currentUser && currentUser.accountType !== 'platform')
  useEffect(() => {
    if (!inWorkspace) return setTourOpen(false)
    let seen = true
    try {
      seen = localStorage.getItem(tourKey) === '1'
    } catch {
      /* No browser storage: no automatic tour; Tour still works. */
    }
    if (seen) return
    const timer = window.setTimeout(() => setTourOpen(true), 800)
    return () => window.clearTimeout(timer)
  }, [tourKey, inWorkspace])
  const closeTour = () => {
    setTourOpen(false)
    try {
      localStorage.setItem(tourKey, '1')
    } catch {
      /* Shown again next time; nothing else depends on it. */
    }
  }
  const tourNavigate = (next: TourView) => {
    setView(next)
    setSelectedClientId(null)
    setSelectedProjectId(null)
  }

  if (resetToken !== null)
    return (
      <ResetPassword
        token={resetToken}
        onBack={() => {
          setResetToken(null)
          setAuthUser(null)
          setLoginError('')
        }}
      />
    )
  if (authChecking) return <AuthSplash />
  if (!authUser || !currentUser)
    // Internal Admin signs in only on its own page; the workspace sign-in does not know that account.
    return window.location.pathname.replace(/\/+$/, '') === INTERNAL_ADMIN_PATH ? (
      <InternalAdminLogin busy={loginBusy} error={loginError} onLogin={handleInternalLogin} />
    ) : (
      <LoginScreen busy={loginBusy} error={loginError} onLogin={handleLogin} onGoogleLogin={handleGoogleLogin} />
    )

  const currentTheme = themeForContext(currentUser)

  return (
    <ClosedStatusContext.Provider value={closedStatus}>
      <WorkflowLabelsContext.Provider value={store.taskSettings.labels}>
        <div
          className={`app-shell ui-refresh theme-${currentTheme}${navCollapsed ? ' nav-collapsed' : ''}`}
          data-theme={currentTheme}
          data-interface-mode={normalizeInterfaceMode(currentUser.interfaceMode) || undefined}
        >
          <aside className="sidebar" aria-label="Main menu">
            <div className="brand">
              <img className="brand-logo" src="/client-ops-logo.png" alt="Client Ops Tracker" />
              <img className="brand-icon" src="/ba-app-icon.png" alt="" />
              <button
                type="button"
                className="sidebar-toggle"
                aria-label={navCollapsed ? 'Expand menu' : 'Collapse menu'}
                aria-expanded={!navCollapsed}
                aria-controls="app-menu"
                onClick={toggleNav}
                {...railTip.bind('Expand menu')}
              >
                {navCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
              </button>
            </div>
            <nav id="app-menu">
              {sidebarItems(visibleNavItems).map(({ id, label, icon: Icon, seeds }) => (
                <button
                  key={id}
                  data-tour={seeds ? 'nav-seeds' : `nav-${id}`}
                  className={(seeds ? isSeedsView(view) : view === id) ? 'nav-button active' : 'nav-button'}
                  aria-current={(seeds ? isSeedsView(view) : view === id) ? 'page' : undefined}
                  {...railTip.bind(id === 'inbox' && unreadTotal > 0 ? `${label} · ${unreadTitle}` : label)}
                  onClick={event => {
                    // Ctrl/⌘-click or Shift-click opens the page in a new tab, as a link would.
                    if (opensElsewhere(event)) return void window.open(VIEW_PATHS[id], '_blank', 'noopener')
                    setView(id)
                    if (id === 'requirements') setRtmContext({})
                    setSelectedClientId(null)
                    setSelectedProjectId(null)
                  }}
                  onAuxClick={event => {
                    if (event.button !== 1) return
                    event.preventDefault()
                    window.open(VIEW_PATHS[id], '_blank', 'noopener')
                  }}
                >
                  <Icon size={18} />
                  <span>{label}</span>
                  {id === 'inbox' && unreadTotal > 0 && (
                    <b className="nav-unread" title={unreadTitle} aria-label={unreadTitle}>
                      {badgeText(unreadTotal)}
                    </b>
                  )}
                </button>
              ))}
              {currentUser.accountType !== 'platform' && (
                <>
                  {canManageAccounts && (
                    <button
                      data-tour="nav-users"
                      className={view === 'users' ? 'nav-button active' : 'nav-button'}
                      aria-current={view === 'users' ? 'page' : undefined}
                      {...railTip.bind('Users & Permissions')}
                      onClick={() => {
                        setView('users')
                        setSelectedClientId(null)
                        setSelectedProjectId(null)
                      }}
                    >
                      <Users size={18} />
                      <span>Users &amp; Permissions</span>
                    </button>
                  )}
                  <button
                    className={view === 'themes' ? 'nav-button active' : 'nav-button'}
                    aria-current={view === 'themes' ? 'page' : undefined}
                    {...railTip.bind('My Themes')}
                    onClick={() => {
                      setView('themes')
                      setSelectedClientId(null)
                      setSelectedProjectId(null)
                    }}
                  >
                    <Sparkles size={18} />
                    <span>My Themes</span>
                  </button>
                </>
              )}
            </nav>
            {currentUser.isPlatformAdmin && currentUser.accountType === 'platform' && (
              <div className="platform-admin-nav">
                <button
                  className={view === 'internal-admin' ? 'nav-button active' : 'nav-button'}
                  aria-current={view === 'internal-admin' ? 'page' : undefined}
                  {...railTip.bind('BXI-Core Admin')}
                  onClick={() => {
                    setView('internal-admin')
                    setSelectedClientId(null)
                    setSelectedProjectId(null)
                  }}
                >
                  <ShieldCheck size={18} />
                  <span>BXI-Core Admin</span>
                </button>
              </div>
            )}
            <div className="sidebar-footer">
              {currentUser.organizationName && (
                <div className="workspace-chip" {...railTip.bind(currentUser.organizationName)}>
                  <Building2 size={14} />
                  <span>{currentUser.organizationName}</span>
                </div>
              )}
              {currentUser.accountType === 'platform' ? (
                <div
                  className="session-card platform-session-card"
                  {...railTip.bind(`${currentUser.name} · Platform Admin`)}
                >
                  <div className="session-avatar">
                    <ShieldCheck size={17} />
                  </div>
                  <div>
                    <strong>{currentUser.name}</strong>
                    <span>internal_admin · Platform Admin</span>
                  </div>
                </div>
              ) : (
                <button
                  data-tour="profile"
                  className="session-card session-card-button"
                  type="button"
                  onClick={() => setProfileOpen(true)}
                  title={navCollapsed ? undefined : 'Edit your profile'}
                  {...railTip.bind(`${currentUser.name} · ${currentUser.role} · My profile`)}
                >
                  <div className="session-avatar">
                    <UserRound size={17} />
                  </div>
                  <div>
                    <strong>{currentUser.name}</strong>
                    <span>{currentUser.role} · My profile</span>
                  </div>
                  <Pencil size={14} />
                </button>
              )}
              <button
                className="nav-button signout-button"
                type="button"
                disabled={logoutBusy}
                {...railTip.bind('Sign out')}
                onClick={() => void handleLogout()}
              >
                <LogOut size={18} />
                <span>{logoutBusy ? 'Signing out…' : 'Sign out'}</span>
              </button>
              <div
                className={`local-note storage-${cloudStatus}`}
                title={navCollapsed ? undefined : lastCloudSync ? `Last cloud sync: ${lastCloudSync}` : undefined}
                {...railTip.bind(lastCloudSync ? `${cloudMessage} · last sync ${lastCloudSync}` : cloudMessage)}
              >
                <CircleDot size={12} /> <span>{cloudMessage}</span>
              </div>
            </div>
          </aside>
          {railTip.tip}

          <main>
            {saveConflict && (
              <div className="panel" role="alert">
                <strong>Save conflict — your edits are kept locally.</strong>
                <p>{saveConflict}</p>
                <p>
                  Download your pending workspace copy and reload, then reapply your edits to the current records. Open
                  editors stay open for reference; reopen them before saving.
                </p>
                <button className="secondary" disabled={recoveringCloud} onClick={() => void recoverCloud()}>
                  {recoveringCloud ? 'Reloading…' : 'Download edits and reload latest'}
                </button>
              </div>
            )}
            <header className="topbar">
              <div>
                <p className="eyebrow">
                  {currentUser.accountType === 'platform' ? 'BXI-CORE PLATFORM' : 'BA CLIENT OPERATIONS'}
                </p>
                <div className="record-title-line">
                  <h1>
                    {selectedProject ? selectedProject.name : selectedClient ? selectedClient.name : labels[view]}
                  </h1>
                  {canWrite &&
                    ((selectedClient && hasModule('clients')) || (selectedProject && hasModule('projects'))) && (
                      <button
                        className="secondary record-title-edit"
                        onClick={() =>
                          setEditingRecord(
                            selectedProject
                              ? { kind: 'projects', id: selectedProject.id }
                              : { kind: 'clients', id: selectedClient!.id },
                          )
                        }
                      >
                        <Pencil size={16} />
                        {selectedProject ? 'Edit project' : 'Edit client'}
                      </button>
                    )}
                </div>
              </div>
              <div className="top-actions">
                {currentUser.accountType !== 'platform' && (
                  <button
                    className="secondary"
                    disabled={
                      refreshingCloud ||
                      hubSyncing ||
                      cloudStatus === 'checking' ||
                      cloudStatus === 'saving' ||
                      Boolean(saveConflict)
                    }
                    onClick={() => {
                      void refreshWorkspace(true)
                      void workHubSync.syncAll()
                    }}
                    title="Fetch the latest workspace and sync all connected Work Hub integrations"
                    data-tour="refresh"
                  >
                    <RefreshCw size={16} />
                    {refreshingCloud || hubSyncing ? 'Refreshing…' : 'Refresh now'}
                  </button>
                )}
                {currentUser.accountType !== 'platform' && appState.hasModule('action') && (
                  <AssistantWatch
                    key={`${currentUser.organizationId}:${currentUser.id}`}
                    app={appState}
                    currentUser={currentUser}
                  />
                )}
                {currentUser.accountType !== 'platform' && (
                  <NotificationCenter
                    notifications={store.notifications}
                    clients={store.clients}
                    projects={store.projects}
                    isAdmin={currentUser.role === 'Administrator'}
                    busy={notificationBusy}
                    onOpen={openNotification}
                    onAction={handleNotificationAction}
                    onReadAll={handleReadAllNotifications}
                    onRefresh={() => void refreshNotifications()}
                    onSnooze={notification => {
                      if (!notification.trackerId || !notification.trackerRowId || !notification.trackerReminderId)
                        return
                      void requestJson(`/api/trackers/${encodeURIComponent(notification.trackerId)}/reminders/snooze`, {
                        method: 'POST',
                        body: { rowId: notification.trackerRowId, reminderId: notification.trackerReminderId, days: 1 },
                        fallback: 'The reminder could not be snoozed.',
                      })
                        .then(() => handleNotificationAction(notification, 'dismiss'))
                        .catch(error =>
                          window.alert(error instanceof Error ? error.message : 'The reminder could not be snoozed.'),
                        )
                    }}
                  />
                )}
                {currentUser.accountType !== 'platform' && (
                  <button
                    type="button"
                    className="secondary"
                    data-tour="tour"
                    title="A short guided tour: what to set up first and where things are"
                    onClick={() => setTourOpen(true)}
                  >
                    <Compass size={16} /> Tour
                  </button>
                )}
              </div>
            </header>

            {!visibleNavItems.length &&
              view !== 'themes' &&
              view !== 'users' &&
              currentUser.accountType !== 'platform' && (
                <section className="page-stack">
                  <div className="panel no-access-panel">
                    <LockKeyhole size={24} />
                    <div>
                      <h2>No modules assigned</h2>
                      <p>
                        Your account is active, but an Administrator has not assigned any modules yet. You can still
                        open My profile or sign out.
                      </p>
                    </div>
                  </div>
                </section>
              )}

            {!selectedClient &&
              !selectedProject &&
              view === 'internal-admin' &&
              currentUser.isPlatformAdmin &&
              currentUser.accountType === 'platform' && (
                <InternalAdmin
                  mustChangePassword={Boolean(authUser.mustChangePassword)}
                  recoveryEmail={authUser.email}
                  onRecoveryEmailChange={email => setAuthUser({ ...authUser, email })}
                />
              )}

            {!selectedClient && !selectedProject && view === 'action' && hasModule('action') && (
              <ActionCenterPage app={appState} currentUser={currentUser} />
            )}

            {!selectedClient && !selectedProject && isSeedsView(view) && <SeedsTabs app={appState} />}

            {!selectedClient && !selectedProject && view === 'seeds' && <SeedsSyncPage app={appState} />}

            {!selectedClient && !selectedProject && view === 'clients' && hasModule('clients') && (
              <ClientsPage app={appState} />
            )}

            {!selectedClient && !selectedProject && view === 'projects' && hasModule('projects') && (
              <ProjectsPage app={appState} />
            )}

            {!selectedClient && !selectedProject && view === 'inbox' && hasModule('inbox') && (
              <InboxPage app={appState} currentUser={currentUser} />
            )}

            {!selectedClient && !selectedProject && view === 'items' && hasModule('items') && (
              <TasksPage app={appState} />
            )}

            {!selectedClient && !selectedProject && view === 'requirements' && hasModule('requirements') && (
              <RequirementsTraceability
                key={`${authUser?.organizationId}:${authUser?.id}:${rtmContext.clientId || ''}:${rtmContext.projectId || ''}`}
                store={store}
                canEdit={canWrite}
                canLink={canWrite && canWriteTasks && hasModule('items')}
                canOverride={currentUser?.role === 'Administrator'}
                context={rtmContext}
                onSave={saveRtms}
                onOpenTask={canWriteTasks && hasModule('items') ? openTaskEditor : undefined}
              />
            )}
            {!selectedClient && !selectedProject && view === 'trackers' && hasModule('trackers') && (
              <Trackers
                key={`${authUser?.organizationId}:${authUser?.id}`}
                isAdmin={currentUser?.role === 'Administrator'}
                canCreate={canWrite}
                items={store.items}
                clients={store.clients}
                projects={store.projects}
                accounts={store.accounts}
                today={today}
                onOpenTask={canWriteTasks && hasModule('items') ? openTaskEditor : undefined}
                isTaskClosed={status => isTaskClosed(status, store.taskSettings)}
                onCreateTasks={canWriteTasks && hasModule('items') ? createTrackerTasks : undefined}
                onUpdateTasks={canWriteTasks && hasModule('items') ? updateTrackerTasks : undefined}
                onMoveTasks={canWriteTasks && hasModule('items') ? moveTrackerTasks : undefined}
                onTasksChanged={() => refreshWorkspace(false)}
                currentUserId={currentUser?.id}
              />
            )}
            {hasModule('documents') && (
              <div
                className="document-retained"
                hidden={Boolean(selectedClient || selectedProject || view !== 'documents')}
              >
                <DocumentCreation
                  key={`${authUser?.organizationId}:${authUser?.id}`}
                  clients={store.clients}
                  projects={store.projects}
                  accounts={store.accounts}
                  items={store.items}
                  launch={documentLaunch}
                  canGenerate={canWrite}
                  canUseInbox={hasModule('inbox')}
                  draftKey={`${authUser?.organizationId}:${authUser?.id}`}
                  active={pageActive && !selectedClient && !selectedProject && view === 'documents'}
                />
              </div>
            )}

            {!selectedClient && !selectedProject && view === 'reports' && hasModule('reports') && (
              <CustomReports
                canUseTrackers={hasModule('trackers')}
                canExplore={hasModule('explorer')}
                canAskJarvis={
                  hasModule('ai') &&
                  (currentUser.role !== 'Viewer' || Boolean((currentUser as { askAi?: boolean }).askAi))
                }
                canUseInbox={hasModule('inbox')}
                clients={store.clients}
                projects={store.projects}
                items={store.items}
                planner={store.planner}
                taskSettings={store.taskSettings}
                accounts={store.accounts}
                workEvents={store.workEvents}
                currentUser={currentUser}
              />
            )}

            {!selectedClient && !selectedProject && view === 'users' && canManageAccounts && (
              <AccountUsers currentUser={currentUser} onChanged={acceptAccountUsers} />
            )}
            {!selectedClient && !selectedProject && view === 'themes' && currentUser.accountType !== 'platform' && (
              <ThemePreferences user={currentUser} onSave={saveOwnPreferences} />
            )}

            {!selectedClient && !selectedProject && view === 'settings' && hasModule('settings') && (
              <Settings
                key={`${currentUser.organizationId}:${currentUser.id}`}
                currentUser={currentUser}
                clients={store.clients}
                projects={store.projects}
              />
            )}

            {!selectedClient && !selectedProject && view === 'ai' && hasModule('ai') && (
              <AiPage app={appState} currentUser={currentUser} />
            )}

            {selectedClient && (
              <ClientDetail
                onOpenRtms={hasModule('requirements') ? () => openRtms(selectedClient.id) : undefined}
                controls={
                  <LifecycleControls
                    key={selectedClient.id}
                    kind="clients"
                    record={selectedClient}
                    store={store}
                    canEdit={canWrite && hasModule('clients') && !selectedClient.accessLimited}
                    onSave={record => saveLifecycleRecord('clients', record)}
                  />
                }
                client={selectedClient}
                store={store}
                onBack={() => setSelectedClientId(null)}
                onOpenProject={(projectId, clientId) => {
                  setSelectedClientId(null)
                  setSelectedProjectClientId(clientId)
                  setSelectedProjectId(projectId)
                }}
                onAddTask={clientId => {
                  setTaskPreset({ clientId, type: 'Task' })
                  setModal('item')
                }}
                onAskAI={(clientId, projectId = '') => {
                  setAiClientId(clientId)
                  setAiProjectId(projectId)
                  setAiPrompt('')
                  setSelectedClientId(null)
                  setView('ai')
                }}
                canUseAI={canUseAI}
                canWrite={canWriteTasks}
              />
            )}

            {selectedProject && (
              <ProjectDetail
                onOpenRtms={
                  hasModule('requirements')
                    ? () => openRtms(selectedProjectClientId || undefined, selectedProject.id)
                    : undefined
                }
                controls={
                  <LifecycleControls
                    key={selectedProject.id}
                    kind="projects"
                    record={selectedProject}
                    store={store}
                    canEdit={canWrite && hasModule('projects') && !selectedProject.accessLimited}
                    onSave={record => saveLifecycleRecord('projects', record)}
                  />
                }
                project={selectedProject}
                clientContextId={selectedProjectClientId}
                store={store}
                setStore={persist}
                onBack={() => {
                  const clientId = selectedProjectClientId
                  setSelectedProjectId(null)
                  setSelectedProjectClientId(null)
                  if (clientId) setSelectedClientId(clientId)
                }}
                onAddTask={() => {
                  setTaskPreset({
                    clientId: selectedProjectClientId || undefined,
                    projectId: selectedProject.id,
                    type: 'Task',
                  })
                  setModal('item')
                }}
                onCreateSubtask={openSubtaskCreator}
                onReorderSubtasks={reorderSubtasks}
                onStatusChange={updateTaskStatus}
                onResolve={resolveItem}
                onEditTask={openTaskEditor}
                onDeleteTask={deleteTask}
                canWrite={canWrite}
                canEditTasks={canWriteTasks}
              />
            )}
          </main>

          {modal && (canWrite || ((modal === 'item' || modal === 'taskEdit') && canWriteTasks)) && (
            <Modal
              title={
                modal === 'item'
                  ? taskPreset?.parentTaskId
                    ? 'Add subtask'
                    : taskPreset?.type === 'Inquiry'
                      ? 'Capture inquiry'
                      : 'Add task'
                  : modal === 'taskEdit'
                    ? 'Edit task'
                    : modal === 'client'
                      ? 'Add client'
                      : modal === 'project'
                        ? 'Add project'
                        : editingActivity
                          ? 'Edit activity'
                          : 'Add activity'
              }
              closeDisabled={modal === 'taskEdit' && taskEditSaving}
              onMinimize={modal === 'taskEdit' && editingTask ? () => void minimizeTask() : undefined}
              onClose={() => {
                setModal(null)
                setEditingActivityId(null)
                setEditingTaskId(null)
                setTaskPreset(null)
              }}
            >
              {modal === 'item' && (
                <TaskForm
                  canLinkRtm={hasModule('requirements') && hasModule('items')}
                  store={store}
                  preset={taskPreset}
                  onSubmit={item => {
                    const parent = item.parentTaskId
                      ? store.items.find(candidate => candidate.id === item.parentTaskId)
                      : undefined
                    persist({
                      ...store,
                      items: [item, ...store.items],
                      activity: [
                        {
                          id: crypto.randomUUID(),
                          clientId: item.clientId,
                          projectId: item.projectId,
                          date: item.dateRaised,
                          text: parent
                            ? `Created subtask under ${parent.title}: ${item.title}`
                            : `Created ${item.type.toLowerCase()} task: ${item.title}`,
                        },
                        ...store.activity,
                      ],
                    })
                    setModal(null)
                    setTaskPreset(null)
                  }}
                />
              )}
              {modal === 'taskEdit' && editingTask && (
                <TaskEditForm
                  autoRefreshDocuments={workspaceAutoRefreshAllowed(view, selectedClientId, selectedProjectId)}
                  canLinkRtm={hasModule('requirements') && hasModule('items')}
                  store={store}
                  item={editingTask}
                  onSubmit={saveTaskEdit}
                  onDelete={deleteTask}
                  onEvidenceMutation={applyEvidenceMutation}
                  onCommentMutation={applyCommentMutation}
                  onTimeEntryMutation={applyTimeEntryMutation}
                  currentUser={currentUser}
                  today={today}
                  dirtyCheck={taskDirty}
                  onMoveToSeeds={
                    currentUser.role === 'Administrator' && store.seeds?.cutoverAt
                      ? () => {
                          setModal(null)
                          setEditingTaskId(null)
                          setMovingToSeeds({ taskId: editingTask.id })
                        }
                      : undefined
                  }
                />
              )}
              {modal === 'client' && (
                <ClientForm
                  onSubmit={client => {
                    persist({ ...store, clients: [...store.clients, client] })
                    setModal(null)
                  }}
                />
              )}
              {modal === 'project' && (
                <ProjectForm
                  onSubmit={project => {
                    persist({ ...store, projects: [...store.projects, project] })
                    setModal(null)
                  }}
                />
              )}
              {modal === 'activity' && (
                <ActivityForm
                  clients={store.clients}
                  projects={store.projects}
                  initial={editingActivity}
                  onSubmit={saveActivity}
                />
              )}
            </Modal>
          )}
          {movingToSeeds && currentUser.role === 'Administrator' && (
            <MoveToSeedsDialog
              items={store.items}
              projects={store.projects}
              clients={store.clients}
              taskId={movingToSeeds.taskId}
              fromProjectId={movingToSeeds.fromProjectId}
              isClosed={status => isTaskClosed(status, store.taskSettings)}
              onMove={moveWorkToSeeds}
              onClose={() => setMovingToSeeds(null)}
            />
          )}
          {editingRecord &&
            currentUser.role !== 'Viewer' &&
            hasModule(editingRecord.kind) &&
            (() => {
              const record = store[editingRecord.kind].find(row => row.id === editingRecord.id)
              return record ? (
                <RecordEditDialog
                  key={`${editingRecord.kind}:${record.id}`}
                  kind={editingRecord.kind}
                  record={record}
                  canRenameClient={currentUser.role === 'Administrator'}
                  onClose={() => setEditingRecord(null)}
                  onSave={updated => saveLifecycleRecord(editingRecord.kind, updated)}
                />
              ) : null
            })()}
          {closeRequest && <CloseWithSubtasksDialog request={closeRequest} />}
          {tourOpen && inWorkspace && (
            <AppTour
              steps={tourSteps({
                isAdmin: canManageAccounts,
                modules: currentUser.modules,
                canWrite: currentUser.role !== 'Viewer',
              })}
              onNavigate={tourNavigate}
              onClose={closeTour}
            />
          )}
          {profileOpen && currentUser.accountType !== 'platform' && (
            <ProfileModal user={currentUser} onClose={() => setProfileOpen(false)} onSave={updateOwnProfile} />
          )}
          {currentUser.accountType !== 'platform' && canWriteTasks && (
            <TaskDock docked={taskDock.docked} items={store.items} onOpen={openDockedTask} onRemove={taskDock.remove} />
          )}
          <TimerChip
            key={`timers:${currentUser.organizationId}:${currentUser.id}`}
            enabled={currentUser.accountType !== 'platform' && currentUser.role !== 'Viewer'}
            items={store.items}
            onOpenTask={appState.openTaskEditor}
          />
          <EmailComposerHost
            enabled={hasModule('inbox') && currentUser.role !== 'Viewer'}
            items={store.items}
            clients={store.clients}
            projects={store.projects}
            accounts={store.accounts}
            currentUser={currentUser}
            onSent={async () => {
              const result = await loadCloudStore<Store>()
              if (result.data) setStore(normalizeStore(result.data, seedStore()))
            }}
          />
        </div>
      </WorkflowLabelsContext.Provider>
    </ClosedStatusContext.Provider>
  )
}

export default App
