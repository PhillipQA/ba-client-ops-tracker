import { workspaceAutoRefreshAllowed } from './activePolling'
import { workHubSync } from './workHubSync'
import RequirementsTraceability from './RequirementsTraceability'
import Trackers from './Trackers'
import { ClosedStatusContext } from './openWork'
import { EmailComposerHost } from './EmailComposer'
import NotificationCenter from './NotificationCenter'
import RecordEditDialog from './RecordEditDialog'
import LifecycleControls from './LifecycleControls'
import { isArchived } from './lifecycle'
import { Building2, CircleDot, Pencil, Plus, RefreshCw, ShieldCheck, LogOut, UserRound, LockKeyhole, Sparkles, PanelLeftClose, PanelLeftOpen, Users } from 'lucide-react'
import DocumentCreation from './DocumentCreation'
import InternalAdmin from './InternalAdmin'
import { ResetPassword } from './PasswordRecovery'
import { loadCloudStore } from './cloudStore'
import Reports from './Reports'
import Settings from './Settings'
import './communications.css'
import './github.css'
import AccountUsers from './AccountUsers'
import ThemePreferences from './ThemePreferences'
import { themeForContext } from './theme'
import { normalizeInterfaceMode } from './appearance'
import { AuthSplash, LoginScreen } from './app/AuthScreens'
import { Modal } from './app/Modal'
import { ProfileModal } from './app/ProfileModal'
import { type Store, isTaskClosed, normalizeStore, seedStore } from './app/store'
import { ActivityForm } from './features/action-center/ActionCenterParts'
import { ClientDetail, ClientForm, ProjectDetail, ProjectForm } from './features/clients/ClientViews'
import { TaskEditForm, TaskForm } from './features/tasks/TaskForms'
import { useAppState } from './app/useAppState'
import { labels } from './app/navigation'
import { ActionCenterPage } from './features/action-center/ActionCenterPage'
import { ClientsPage } from './features/clients/ClientsPage'
import { ProjectsPage } from './features/clients/ProjectsPage'
import { InboxPage } from './features/inbox/InboxPage'
import { TasksPage } from './features/tasks/TasksPage'
import { AiPage } from './features/ai/AiPage'
function App() {
  const appState = useAppState()
  const {
    acceptAccountUsers,
    actionCenterClientCount,
    actionCenterInquiryCount,
    actionCenterScope,
    actionCenterScopeLabel,
    actionCenterUsers,
    actionCenterWaitingDev,
    actionCenterWaitingDevOverdue,
    actionCenterWaitingTitle,
    actionCenterWorkItems,
    actionItems,
    activityRange,
    aiClientId,
    aiProjectId,
    aiPrompt,
    applyAISuggestion,
    applyCommentMutation,
    applyEvidenceMutation,
    applyTimeEntryMutation,
    archivedInquiryItems,
    assessDashboardAI,
    authChecking,
    authUser,
    boardGroup,
    boardShowSubtasks,
    canEditActionItem,
    canManageAccounts,
    canUseAI,
    canWrite,
    canWriteTasks,
    chooseClientLayout,
    chooseTaskView,
    clientArchiveFilter,
    clientLayout,
    clientName,
    clientSearch,
    clientSort,
    closedStatus,
    cloudMessage,
    cloudStatus,
    convertInquiry,
    createTrackerTasks,
    currentUser,
    dashboardAiBusy,
    dashboardAiError,
    dashboardAiPrompt,
    dashboardAiResult,
    deleteTask,
    documentLaunch,
    editingActivity,
    editingRecord,
    editingTask,
    filteredTasks,
    handleLogin,
    handleLogout,
    handleNotificationAction,
    handleReadAllNotifications,
    hasModule,
    hubSyncing,
    inquiryItems,
    lastCloudSync,
    loginBusy,
    loginError,
    logoutBusy,
    modal,
    navCollapsed,
    newExternalInquiryCount,
    newExternalInquiryIds,
    notificationBusy,
    openActivityModal,
    openDashboardAiResult,
    openInquiryCount,
    openItems,
    openNotification,
    openRtms,
    openSubtaskCreator,
    openTaskEditor,
    openTrackerLink,
    pageActive,
    persist,
    profileOpen,
    projectArchiveFilter,
    projectName,
    query,
    railTip,
    recoverCloud,
    recoveringCloud,
    refreshNotifications,
    refreshWorkspace,
    refreshingCloud,
    reorderSubtasks,
    resetToken,
    resolveItem,
    resolvedActionCenterScope,
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
    setActionCenterScope,
    setActivityRange,
    setAiClientId,
    setAiProjectId,
    setAiPrompt,
    setAuthUser,
    setClientArchiveFilter,
    setClientSearch,
    setClientSort,
    setDashboardAiError,
    setDashboardAiPrompt,
    setDashboardAiResult,
    setEditingActivityId,
    setEditingRecord,
    setEditingTaskId,
    setLoginError,
    setModal,
    setNewExternalInquiryIds,
    setProfileOpen,
    setProjectArchiveFilter,
    setQuery,
    setResetToken,
    setRtmContext,
    setSelectedClientId,
    setSelectedProjectClientId,
    setSelectedProjectId,
    setStore,
    setTaskClientFilter,
    setTaskDateFilter,
    setTaskPreset,
    setTaskProjectFilter,
    setTaskStatusFilter,
    setView,
    setWaitingFilter,
    store,
    taskClientFilter,
    taskDateFilter,
    taskEditSaving,
    taskLayout,
    taskPreset,
    taskProjectFilter,
    taskStatusFilter,
    today,
    todayActivities,
    todayFollowUps,
    toggleActivityDone,
    toggleNav,
    trackerLinks,
    updateOwnProfile,
    updateTaskStatus,
    updateTaskWaitingOn,
    view,
    visibleClients,
    visibleNavItems,
    waitingFilter,
    weekActivities,
    weekFollowUps,
  } = appState

  if (resetToken !== null) return <ResetPassword token={resetToken} onBack={() => { setResetToken(null); setAuthUser(null); setLoginError('') }} />
  if (authChecking) return <AuthSplash />
  if (!authUser || !currentUser) return <LoginScreen busy={loginBusy} error={loginError} onLogin={handleLogin} />

  const currentTheme = themeForContext(currentUser)

  return (
    <ClosedStatusContext.Provider value={closedStatus}>
    <div className={`app-shell ui-refresh theme-${currentTheme}${navCollapsed ? ' nav-collapsed' : ''}`} data-theme={currentTheme} data-interface-mode={normalizeInterfaceMode(currentUser.interfaceMode) || undefined}>
      <aside className="sidebar" aria-label="Main menu">
        <div className="brand">
          <img className="brand-logo" src="/client-ops-logo.png" alt="Client Ops Tracker" />
          <img className="brand-icon" src="/ba-app-icon.png" alt="" />
          <button type="button" className="sidebar-toggle" aria-label={navCollapsed ? 'Expand menu' : 'Collapse menu'} aria-expanded={!navCollapsed} aria-controls="app-menu" onClick={toggleNav} {...railTip.bind('Expand menu')}>
            {navCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
          </button>
        </div>
        <nav id="app-menu">
          {visibleNavItems.map(({ id, label, icon: Icon }) => (
            <button key={id} className={view === id ? 'nav-button active' : 'nav-button'} aria-current={view === id ? 'page' : undefined} {...railTip.bind(id === 'inbox' && inquiryItems.length > 0 ? `${label} · ${newExternalInquiryCount > 0 ? `${newExternalInquiryCount} new` : `${openInquiryCount} open`}` : label)} onClick={() => { setView(id); if (id === 'requirements') setRtmContext({}); setSelectedClientId(null); setSelectedProjectId(null) }}>
              <Icon size={18} /><span>{label}</span>{id === 'inbox' && inquiryItems.length > 0 && <b className={newExternalInquiryCount > 0 ? 'has-new' : ''} title={newExternalInquiryCount > 0 ? `${newExternalInquiryCount} new external inquiry${newExternalInquiryCount === 1 ? '' : 'ies'}` : `${inquiryItems.length} open inquiries`}>{newExternalInquiryCount > 0 ? newExternalInquiryCount : openInquiryCount}</b>}
            </button>
          ))}
          {currentUser.accountType !== 'platform' && <>
            {canManageAccounts && <button className={view === 'users' ? 'nav-button active' : 'nav-button'} aria-current={view === 'users' ? 'page' : undefined} {...railTip.bind('Users & Permissions')} onClick={() => { setView('users'); setSelectedClientId(null); setSelectedProjectId(null) }}><Users size={18} /><span>Users &amp; Permissions</span></button>}
            <button className={view === 'themes' ? 'nav-button active' : 'nav-button'} aria-current={view === 'themes' ? 'page' : undefined} {...railTip.bind('My Themes')} onClick={() => { setView('themes'); setSelectedClientId(null); setSelectedProjectId(null) }}><Sparkles size={18} /><span>My Themes</span></button>
          </>}
        </nav>
        {currentUser.isPlatformAdmin && currentUser.accountType === 'platform' && <div className="platform-admin-nav"><button className={view === 'internal-admin' ? 'nav-button active' : 'nav-button'} aria-current={view === 'internal-admin' ? 'page' : undefined} {...railTip.bind('BXI-Core Admin')} onClick={() => { setView('internal-admin'); setSelectedClientId(null); setSelectedProjectId(null) }}><ShieldCheck size={18} /><span>BXI-Core Admin</span></button></div>}
        <div className="sidebar-footer">
          {currentUser.organizationName && <div className="workspace-chip" {...railTip.bind(currentUser.organizationName)}><Building2 size={14} /><span>{currentUser.organizationName}</span></div>}
          {currentUser.accountType === 'platform' ? <div className="session-card platform-session-card" {...railTip.bind(`${currentUser.name} · Platform Admin`)}>
            <div className="session-avatar"><ShieldCheck size={17} /></div><div><strong>{currentUser.name}</strong><span>internal_admin · Platform Admin</span></div>
          </div> : <button className="session-card session-card-button" type="button" onClick={() => setProfileOpen(true)} title={navCollapsed ? undefined : 'Edit your profile'} {...railTip.bind(`${currentUser.name} · ${currentUser.role} · My profile`)}>
            <div className="session-avatar"><UserRound size={17} /></div><div><strong>{currentUser.name}</strong><span>{currentUser.role} · My profile</span></div><Pencil size={14} />
          </button>}
          <button className="nav-button signout-button" type="button" disabled={logoutBusy} {...railTip.bind('Sign out')} onClick={() => void handleLogout()}><LogOut size={18} /><span>{logoutBusy ? 'Signing out…' : 'Sign out'}</span></button>
          <div className={`local-note storage-${cloudStatus}`} title={navCollapsed ? undefined : lastCloudSync ? `Last cloud sync: ${lastCloudSync}` : undefined} {...railTip.bind(lastCloudSync ? `${cloudMessage} · last sync ${lastCloudSync}` : cloudMessage)}><CircleDot size={12} /> <span>{cloudMessage}</span></div>
        </div>
      </aside>
      {railTip.tip}

      <main>
        {saveConflict && <div className="panel" role="alert"><strong>Save conflict — your edits are kept locally.</strong><p>{saveConflict}</p><p>Download your pending workspace copy and reload, then reapply your edits to the current records. Open editors stay open for reference; reopen them before saving.</p><button className="secondary" disabled={recoveringCloud} onClick={() => void recoverCloud()}>{recoveringCloud ? 'Reloading…' : 'Download edits and reload latest'}</button></div>}
        <header className="topbar">
          <div><p className="eyebrow">{currentUser.accountType === 'platform' ? 'BXI-CORE PLATFORM' : 'BA CLIENT OPERATIONS'}</p><div className="record-title-line"><h1>{selectedProject ? selectedProject.name : selectedClient ? selectedClient.name : labels[view]}</h1>{canWrite && ((selectedClient && hasModule('clients')) || (selectedProject && hasModule('projects'))) && <button className="secondary record-title-edit" onClick={() => setEditingRecord(selectedProject ? { kind: 'projects', id: selectedProject.id } : { kind: 'clients', id: selectedClient!.id })}><Pencil size={16} />{selectedProject ? 'Edit project' : 'Edit client'}</button>}</div></div>
          <div className="top-actions">
            {currentUser.accountType !== 'platform' && <button className="secondary" disabled={refreshingCloud || hubSyncing || cloudStatus === 'checking' || cloudStatus === 'saving' || Boolean(saveConflict)} onClick={() => { void refreshWorkspace(true); void workHubSync.syncAll() }} title="Fetch the latest workspace and sync all connected Work Hub integrations"><RefreshCw size={16} />{refreshingCloud || hubSyncing ? 'Refreshing…' : 'Refresh now'}</button>}
            {currentUser.accountType !== 'platform' && <NotificationCenter notifications={store.notifications} clients={store.clients} projects={store.projects} isAdmin={currentUser.role === 'Administrator'} busy={notificationBusy} onOpen={openNotification} onAction={handleNotificationAction} onReadAll={handleReadAllNotifications} onRefresh={() => void refreshNotifications()} />}
            <span className="top-role-pill">{view === 'internal-admin' && currentUser.accountType === 'platform' ? 'Platform Admin' : currentUser.role}</span>
            {view !== 'internal-admin' && canWrite && hasModule('clients') && <button className="secondary" onClick={() => setModal('client')}><Users size={17} /> Add client</button>}
            {view !== 'internal-admin' && canWrite && !isArchived(selectedClient || undefined) && !isArchived(selectedProject || undefined) && !isArchived(store.clients.find(client => client.id === selectedProjectClientId)) && (hasModule('items') || hasModule('inbox')) && <button className="primary" onClick={() => {
              if (selectedClient) setTaskPreset({ clientId: selectedClient.id, type: 'Task' })
              else if (selectedProject) setTaskPreset({ clientId: selectedProjectClientId || undefined, projectId: selectedProject.id, type: 'Task' })
              else setTaskPreset(null)
              setModal('item')
            }}><Plus size={18} /> Add task</button>}
          </div>
        </header>

        {!visibleNavItems.length && view !== 'themes' && view !== 'users' && currentUser.accountType !== 'platform' && <section className="page-stack"><div className="panel no-access-panel"><LockKeyhole size={24} /><div><h2>No modules assigned</h2><p>Your account is active, but an Administrator has not assigned any modules yet. You can still open My profile or sign out.</p></div></div></section>}

        {!selectedClient && !selectedProject && view === 'internal-admin' && currentUser.isPlatformAdmin && currentUser.accountType === 'platform' && <InternalAdmin mustChangePassword={Boolean(authUser.mustChangePassword)} recoveryEmail={authUser.email} onRecoveryEmailChange={(email) => setAuthUser({ ...authUser, email })} />}

        {!selectedClient && !selectedProject && view === 'action' && hasModule('action') && <ActionCenterPage app={appState} currentUser={currentUser} />}

        {!selectedClient && !selectedProject && view === 'clients' && hasModule('clients') && <ClientsPage app={appState} />}

        {!selectedClient && !selectedProject && view === 'projects' && hasModule('projects') && <ProjectsPage app={appState} />}

        {!selectedClient && !selectedProject && view === 'inbox' && hasModule('inbox') && <InboxPage app={appState} currentUser={currentUser} />}

        {!selectedClient && !selectedProject && view === 'items' && hasModule('items') && <TasksPage app={appState} />}

        {!selectedClient && !selectedProject && view === 'requirements' && hasModule('requirements') && <RequirementsTraceability key={`${authUser?.organizationId}:${authUser?.id}:${rtmContext.clientId || ''}:${rtmContext.projectId || ''}`} store={store} canEdit={canWrite} canLink={canWrite && hasModule('items')} canOverride={currentUser?.role === 'Administrator'} context={rtmContext} onSave={saveRtms} onOpenTask={canWriteTasks && hasModule('items') ? openTaskEditor : undefined} />}
        {!selectedClient && !selectedProject && view === 'trackers' && hasModule('trackers') && <Trackers key={`${authUser?.organizationId}:${authUser?.id}`} isAdmin={currentUser?.role === 'Administrator'} canCreate={canWrite} items={store.items} clients={store.clients} projects={store.projects} accounts={store.accounts} today={today} onOpenTask={canWriteTasks && hasModule('items') ? openTaskEditor : undefined} isTaskClosed={(status) => isTaskClosed(status, store.taskSettings)} onCreateTasks={canWriteTasks && hasModule('items') ? createTrackerTasks : undefined} />}
        {hasModule('documents') && <div className="document-retained" hidden={Boolean(selectedClient || selectedProject || view !== 'documents')}><DocumentCreation key={`${authUser?.organizationId}:${authUser?.id}`} clients={store.clients} projects={store.projects} accounts={store.accounts} items={store.items} launch={documentLaunch} canGenerate={canWrite} draftKey={`${authUser?.organizationId}:${authUser?.id}`} active={pageActive && !selectedClient && !selectedProject && view === 'documents'} /></div>}

        {!selectedClient && !selectedProject && view === 'reports' && hasModule('reports') && <Reports clients={store.clients} projects={store.projects} items={store.items} planner={store.planner} taskSettings={store.taskSettings} accounts={store.accounts} workEvents={store.workEvents} currentUser={currentUser} />}

        {!selectedClient && !selectedProject && view === 'users' && canManageAccounts && <AccountUsers currentUser={currentUser} onChanged={acceptAccountUsers} />}
        {!selectedClient && !selectedProject && view === 'themes' && currentUser.accountType !== 'platform' && <ThemePreferences user={currentUser} onSave={saveOwnPreferences} />}

        {!selectedClient && !selectedProject && view === 'settings' && hasModule('settings') && <Settings key={`${currentUser.organizationId}:${currentUser.id}`} currentUser={currentUser} />}

        {!selectedClient && !selectedProject && view === 'ai' && hasModule('ai') && <AiPage app={appState} currentUser={currentUser} />}

        {selectedClient && <ClientDetail onOpenRtms={hasModule('requirements') ? () => openRtms(selectedClient.id) : undefined} controls={<LifecycleControls key={selectedClient.id} kind="clients" record={selectedClient} store={store} canEdit={canWrite && hasModule('clients')} onSave={record => saveLifecycleRecord('clients', record)} />} client={selectedClient} store={store} onBack={() => setSelectedClientId(null)} onOpenProject={(projectId, clientId) => { setSelectedClientId(null); setSelectedProjectClientId(clientId); setSelectedProjectId(projectId) }} onAddTask={(clientId) => { setTaskPreset({ clientId, type: 'Task' }); setModal('item') }} onAskAI={(clientId, projectId = '') => { setAiClientId(clientId); setAiProjectId(projectId); setAiPrompt(''); setSelectedClientId(null); setView('ai') }} canUseAI={canUseAI} canWrite={canWriteTasks} />}

        {selectedProject && <ProjectDetail onOpenRtms={hasModule('requirements') ? () => openRtms(selectedProjectClientId || undefined, selectedProject.id) : undefined} controls={<LifecycleControls key={selectedProject.id} kind="projects" record={selectedProject} store={store} canEdit={canWrite && hasModule('projects')} onSave={record => saveLifecycleRecord('projects', record)} />} project={selectedProject} clientContextId={selectedProjectClientId} store={store} setStore={persist} onBack={() => { const clientId = selectedProjectClientId; setSelectedProjectId(null); setSelectedProjectClientId(null); if (clientId) setSelectedClientId(clientId) }} onAddTask={() => { setTaskPreset({ clientId: selectedProjectClientId || undefined, projectId: selectedProject.id, type: 'Task' }); setModal('item') }} onCreateSubtask={openSubtaskCreator} onReorderSubtasks={reorderSubtasks} onStatusChange={updateTaskStatus} onResolve={resolveItem} onEditTask={openTaskEditor} onDeleteTask={deleteTask} canWrite={canWrite} canEditTasks={canWriteTasks} />}
      </main>

      {modal && canWrite && <Modal title={modal === 'item' ? (taskPreset?.parentTaskId ? 'Add subtask' : taskPreset?.type === 'Inquiry' ? 'Capture inquiry' : 'Add task') : modal === 'taskEdit' ? 'Edit task' : modal === 'client' ? 'Add client' : modal === 'project' ? 'Add project' : editingActivity ? 'Edit activity' : 'Add activity'} closeDisabled={modal === 'taskEdit' && taskEditSaving} onClose={() => { setModal(null); setEditingActivityId(null); setEditingTaskId(null); setTaskPreset(null) }}>
        {modal === 'item' && <TaskForm canLinkRtm={hasModule('requirements') && hasModule('items')} store={store} preset={taskPreset} onSubmit={(item) => { const parent = item.parentTaskId ? store.items.find((candidate) => candidate.id === item.parentTaskId) : undefined; persist({ ...store, items: [item, ...store.items], activity: [{ id: crypto.randomUUID(), clientId: item.clientId, projectId: item.projectId, date: item.dateRaised, text: parent ? `Created subtask under ${parent.title}: ${item.title}` : `Created ${item.type.toLowerCase()} task: ${item.title}` }, ...store.activity] }); setModal(null); setTaskPreset(null) }} />}
        {modal === 'taskEdit' && editingTask && <TaskEditForm autoRefreshDocuments={workspaceAutoRefreshAllowed(view, selectedClientId, selectedProjectId)} canLinkRtm={hasModule('requirements') && hasModule('items')} store={store} item={editingTask} onSubmit={saveTaskEdit} onDelete={deleteTask} onEvidenceMutation={applyEvidenceMutation} onCommentMutation={applyCommentMutation} onTimeEntryMutation={applyTimeEntryMutation} currentUser={currentUser} today={today} />}
        {modal === 'client' && <ClientForm onSubmit={(client) => { persist({ ...store, clients: [...store.clients, client] }); setModal(null) }} />}
        {modal === 'project' && <ProjectForm onSubmit={(project) => { persist({ ...store, projects: [...store.projects, project] }); setModal(null) }} />}
        {modal === 'activity' && <ActivityForm clients={store.clients} projects={store.projects} initial={editingActivity} onSubmit={saveActivity} />}
      </Modal>}
      {editingRecord && currentUser.role !== 'Viewer' && hasModule(editingRecord.kind) && (() => {
        const record = store[editingRecord.kind].find(row => row.id === editingRecord.id)
        return record ? <RecordEditDialog key={`${editingRecord.kind}:${record.id}`} kind={editingRecord.kind} record={record} canRenameClient={currentUser.role === 'Administrator'} onClose={() => setEditingRecord(null)} onSave={updated => saveLifecycleRecord(editingRecord.kind, updated)} /> : null
      })()}
      {profileOpen && currentUser.accountType !== 'platform' && <ProfileModal user={currentUser} onClose={() => setProfileOpen(false)} onSave={updateOwnProfile} />}
      <EmailComposerHost enabled={hasModule('inbox') && currentUser.role !== 'Viewer'} items={store.items} clients={store.clients} projects={store.projects} accounts={store.accounts} currentUser={currentUser} onSent={async () => { const result = await loadCloudStore<Store>(); if (result.data) setStore(normalizeStore(result.data, seedStore())) }} />
    </div>
    </ClosedStatusContext.Provider>
  )
}

export default App
