import type { AppState, SignedInUser } from '../../app/useAppState'
import { DashboardActionTable, DashboardActivityTimeline, Metric } from './ActionCenterParts'
import { AlertTriangle, CalendarDays, ChevronRight, Inbox, Plus, Settings2, Sparkles, Users } from 'lucide-react'
import { canBrowseTeamActionCenter, type ActionCenterScopeSelection } from './actionCenterScope'
import GoogleCalendarPanel from '../integrations/GoogleCalendarPanel'
import ClientSelect from '../../shared/ui/SearchSelect'
import { isClosedProject } from '../tasks/lifecycle'
import { useState } from 'react'
import { isBeforeSeedsWork } from '../../shared/seeds'
import { type SourceFilter, SourceFilterSelect, sourceMatches } from '../seeds/SeedsPage'
import { MorningBrief } from './MorningBrief'

/** Action Center screen. It reads the app state; see app/useAppState. */
export function ActionCenterPage({ app, currentUser }: { app: AppState; currentUser: SignedInUser }) {
  const {
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
    assessDashboardAI,
    canEditActionItem,
    canUseAI,
    canWrite,
    dashboardAiBusy,
    dashboardAiError,
    dashboardAiPrompt,
    dashboardAiResult,
    hasModule,
    openActivityModal,
    openDashboardAiResult,
    openTaskEditor,
    openTrackerLink,
    resolvedActionCenterScope,
    setActionCenterScope,
    setActivityRange,
    setAiClientId,
    setAiProjectId,
    setDashboardAiError,
    setDashboardAiPrompt,
    setDashboardAiResult,
    setView,
    store,
    todayActivities,
    todayFollowUps,
    toggleActivityDone,
    trackerLinks,
    weekActivities,
    weekFollowUps,
  } = app
  // Once Seeds is on: show the work From Seeds or Before Seeds (or all), like the Tasks page.
  const [folder, setFolder] = useState<SourceFilter>('seeds')
  const shownActionItems = store.seeds?.cutoverAt
    ? actionItems.filter(item =>
        sourceMatches(folder, { beforeSeeds: isBeforeSeedsWork(item, store.projects, store.clients) }),
      )
    : actionItems
  return (
    <section className="page-stack dashboard-stack">
      <MorningBrief key={`${currentUser.organizationId}:${currentUser.id}`} app={app} currentUser={currentUser} />

      <div className="metric-grid dashboard-metrics">
        <Metric
          title="Needs attention"
          value={actionCenterWorkItems.length}
          detail={`Across ${actionCenterClientCount} client${actionCenterClientCount === 1 ? '' : 's'}`}
          icon={<AlertTriangle size={18} />}
        />
        <Metric
          title={actionCenterWaitingTitle}
          value={actionCenterWaitingDev.length}
          detail={`${actionCenterWaitingDevOverdue} overdue`}
          icon={<Settings2 size={18} />}
        />
        <Metric
          title="Activities today"
          value={todayActivities.length + todayFollowUps.length}
          detail={`${todayActivities.filter(item => item.source === 'Google Calendar').length} meetings · ${todayActivities.filter(item => item.source === 'Local').length} tracker activities · ${todayFollowUps.length} follow-ups`}
          icon={<CalendarDays size={18} />}
        />
        <Metric
          title="Open inquiries"
          value={actionCenterInquiryCount}
          detail="Need classification"
          icon={<Inbox size={18} />}
        />
      </div>

      <div className="panel planner-panel dashboard-panel">
        <div className="panel-heading planner-heading dashboard-panel-heading">
          <div>
            <h2>Activities</h2>
            <p>
              Shared tracker activities and legacy calendar copies, plus follow-ups for{' '}
              {resolvedActionCenterScope.kind === 'all'
                ? 'all users'
                : resolvedActionCenterScope.kind === 'user'
                  ? actionCenterUsers.find(account => account.id === resolvedActionCenterScope.userId)?.name ||
                    'the selected user'
                  : 'you'}
              .
            </p>
          </div>
          <div className="planner-actions dashboard-tabs">
            <button
              className={activityRange === 'today' ? 'secondary active-tab' : 'secondary'}
              onClick={() => setActivityRange('today')}
            >
              Today
            </button>
            <button
              className={activityRange === 'week' ? 'secondary active-tab' : 'secondary'}
              onClick={() => setActivityRange('week')}
            >
              This Week
            </button>
            {currentUser.role !== 'Viewer' && canBrowseTeamActionCenter(currentUser.role) && (
              <label className="action-center-scope">
                <Users size={15} />
                <span>Work view</span>
                <select
                  aria-label="Action Center work view"
                  value={actionCenterScope}
                  onChange={event => setActionCenterScope(event.target.value as ActionCenterScopeSelection)}
                >
                  <option value="mine">My Action Center</option>
                  <option value="all">View all users</option>
                  {actionCenterUsers
                    .filter(account => account.id !== currentUser.id)
                    .map(account => (
                      <option key={account.id} value={`user:${account.id}`}>
                        View {account.name}
                      </option>
                    ))}
                </select>
              </label>
            )}
            {canWrite && (
              <button className="secondary" onClick={() => openActivityModal()}>
                <Plus size={16} /> Add activity
              </button>
            )}
          </div>
        </div>
        <div className="activity-legend">
          <span>Legacy calendar copies = shared</span>
          <span>Tracker = shared, local only</span>
          <span>Follow-up = assigned task/subtask</span>
          <span>Week = Sunday–Saturday</span>
          {actionCenterScope === 'all' && <span>All users includes unassigned work</span>}
        </div>
        <DashboardActivityTimeline
          mode={activityRange}
          items={activityRange === 'today' ? todayActivities : weekActivities}
          followUps={activityRange === 'today' ? todayFollowUps : weekFollowUps}
          trackerLinks={trackerLinks}
          onOpenTracker={openTrackerLink}
          allItems={store.items}
          accounts={store.accounts}
          clients={store.clients}
          projects={store.projects}
          onEdit={openActivityModal}
          onToggle={toggleActivityDone}
          onEditTask={openTaskEditor}
          canEdit={canWrite}
          canEditTask={canEditActionItem}
        />
      </div>

      <GoogleCalendarPanel key={`${currentUser.organizationId}:${currentUser.id}`} />

      {canUseAI && (
        <div className="panel dashboard-panel dashboard-ai-card">
          <div className="panel-heading dashboard-panel-heading">
            <div>
              <div className="ai-title-line">
                <Sparkles size={18} />
                <h2>AI BA Assistant</h2>
              </div>
              <p>Drop a client inquiry, meeting note, or problem here and let AI organize the next steps.</p>
            </div>
            <button className="secondary" onClick={() => setView('ai')}>
              Open full assistant <ChevronRight size={16} />
            </button>
          </div>
          <form className="dashboard-ai-body" onSubmit={assessDashboardAI}>
            <div className="dashboard-ai-context">
              <label>
                Client
                <ClientSelect
                  clients={store.clients}
                  value={aiClientId}
                  onChange={value => {
                    setAiClientId(value)
                    setAiProjectId('')
                    setDashboardAiResult(null)
                    setDashboardAiError('')
                  }}
                  extra={[{ value: '', label: 'General / all clients' }]}
                />
              </label>
              <label>
                Project
                <select
                  value={aiProjectId}
                  onChange={e => {
                    setAiProjectId(e.target.value)
                    setDashboardAiResult(null)
                    setDashboardAiError('')
                  }}
                >
                  <option value="">All projects</option>
                  {store.projects
                    .filter(project => !isClosedProject(project) || project.id === aiProjectId)
                    .map(project => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                      </option>
                    ))}
                </select>
              </label>
            </div>
            <textarea
              value={dashboardAiPrompt}
              onChange={e => setDashboardAiPrompt(e.target.value)}
              rows={3}
              placeholder="Example: Client says search should support @gmail but it does not. Assess what I should do next."
            />
            <div className="dashboard-ai-footer">
              <span>Suggestions only — nothing is saved to tracker records until you approve it.</span>
              <button className="primary" disabled={dashboardAiBusy || !dashboardAiPrompt.trim()}>
                <Sparkles size={16} /> {dashboardAiBusy ? 'Assessing…' : 'Assess with AI'}
              </button>
            </div>
            {dashboardAiError && <div className="dashboard-ai-error">{dashboardAiError}</div>}
            {dashboardAiResult && (
              <div className="dashboard-ai-result">
                <div className="dashboard-ai-result-head">
                  <strong>AI assessment</strong>
                  <span>{dashboardAiResult.wordCount} words</span>
                </div>
                <textarea
                  className="dashboard-ai-result-box"
                  readOnly
                  rows={5}
                  value={
                    dashboardAiResult.wordCount >= 200
                      ? `${dashboardAiResult.message.trim().split(/\s+/).slice(0, 200).join(' ')}${dashboardAiResult.wordCount > 200 ? '…' : ''}`
                      : dashboardAiResult.message
                  }
                />
                {dashboardAiResult.wordCount >= 200 && (
                  <div className="dashboard-ai-result-footer">
                    <span>Showing the first 200 words here.</span>
                    <button className="secondary" type="button" onClick={openDashboardAiResult}>
                      View in AI BA Assistant <ChevronRight size={16} />
                    </button>
                  </div>
                )}
              </div>
            )}
          </form>
        </div>
      )}

      <div className="panel dashboard-panel action-center-panel">
        <div className="panel-heading dashboard-panel-heading">
          <div>
            <h2>{actionCenterScopeLabel}</h2>
            <p>
              Open tasks and subtasks for the selected user view.{' '}
              {resolvedActionCenterScope.kind === 'all' ? 'Unassigned work is included.' : ''}
            </p>
          </div>
          <div className="dashboard-panel-actions">
            <SourceFilterSelect app={app} value={folder} onChange={setFolder} />
            {hasModule('items') && (
              <button className="secondary" onClick={() => setView('items')}>
                View all tasks
              </button>
            )}
          </div>
        </div>
        <DashboardActionTable
          key={`${actionCenterScope}:${folder}`}
          items={shownActionItems}
          accounts={store.accounts}
          clients={store.clients}
          projects={store.projects}
          planner={store.planner}
          trackerLinks={trackerLinks}
          onOpenTracker={openTrackerLink}
        />
      </div>
    </section>
  )
}
