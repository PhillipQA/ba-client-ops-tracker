import type { AppState, SignedInUser } from '../../app/useAppState'
import WorkHub from '../work-hub/WorkHub'
import { loadCloudStore } from '../../app/cloudStore'
import { isTaskClosed, normalizeStore, seedStore, type Store } from '../../app/store'
import { CheckCircle2, Inbox, Plus, Sparkles } from 'lucide-react'
import { FilterBar } from '../tasks/TaskTable'
import { isWaitingOnDone, waitingOnOptions } from '../tasks/waitingOn'
import { Empty, InquirySourceBadge, PriorityChip, StatusChip } from '../../shared/ui/Chips'
import { niceDate } from '../../shared/dates'
import { docHubLabels } from '../documents/dochub'

/** Inbox screen. It reads the app state; see app/useAppState. */
export function InboxPage({ app, currentUser }: { app: AppState; currentUser: SignedInUser }) {
  const {
    archivedInquiryItems,
    canUseAI,
    canWrite,
    clientName,
    convertInquiry,
    inquiryItems,
    newExternalInquiryCount,
    newExternalInquiryIds,
    projectName,
    query,
    resolveItem,
    setAiClientId,
    setAiProjectId,
    setAiPrompt,
    setModal,
    setNewExternalInquiryIds,
    setQuery,
    setStore,
    setTaskPreset,
    setView,
    setWaitingFilter,
    store,
    waitingFilter,
  } = app
  return (
    <section className="page-stack">
      <WorkHub
        key={`${currentUser.organizationId}:${currentUser.id}`}
        tasks={store.items}
        taskSettings={store.taskSettings}
        clients={store.clients}
        projects={store.projects}
        accounts={store.accounts}
        currentUser={currentUser}
        onTaskCreated={async () => {
          const result = await loadCloudStore<Store>()
          if (result.data) setStore(normalizeStore(result.data, seedStore()))
        }}
      />
      <details className="work-hub-shared-inquiries">
        <summary>Existing shared inquiries</summary>
        <div className="callout">
          <Inbox size={22} />
          <div>
            <strong>Capture first, classify later.</strong>
            <p>
              Client questions can stay here until you know whether they should become a requirement, issue, decision,
              or simply be answered.
            </p>
          </div>
        </div>
        <div className="panel">
          <div className="panel-heading">
            <div>
              <h2>Existing shared inquiries</h2>
              <p>Continue managing inquiries created in the earlier shared workspace workflow.</p>
            </div>
            <div className="inquiry-heading-actions">
              {newExternalInquiryCount > 0 && (
                <button className="secondary" type="button" onClick={() => setNewExternalInquiryIds([])}>
                  {newExternalInquiryCount} new · Mark seen
                </button>
              )}
              {canWrite && (
                <button
                  className="primary"
                  onClick={() => {
                    setTaskPreset({ type: 'Inquiry' })
                    setModal('item')
                  }}
                >
                  <Plus size={18} /> Capture inquiry
                </button>
              )}
            </div>
          </div>
          <FilterBar
            query={query}
            setQuery={setQuery}
            waiting={waitingFilter}
            setWaiting={setWaitingFilter}
            options={waitingOnOptions(store.taskSettings).map(option => option.label)}
          />
          {inquiryItems.length ? (
            <div className="inquiry-list">
              {inquiryItems.map(item => {
                const isNewDiscord = item.source === 'Discord' && newExternalInquiryIds.includes(item.id)
                return (
                  <div
                    className={`inquiry-card${item.source === 'Discord' ? ' inquiry-discord' : ''}${isNewDiscord ? ' inquiry-new' : ''}`}
                    key={item.id}
                  >
                    <div>
                      <div className="row-meta">
                        <PriorityChip value={item.priority} />
                        <InquirySourceBadge source={item.source} isNew={isNewDiscord} />
                        <span>
                          {clientName(item.clientId)} · {projectName(item.projectId)}
                        </span>
                      </div>
                      <h3>{item.title}</h3>
                      <p>{item.description}</p>
                      <div className="row-meta">
                        <span>
                          Waiting on <b>{item.waitingOn}</b>
                        </span>
                        <span>Follow-up {niceDate(item.followUpDate)}</span>
                        {item.sourceSender && <span>From: {item.sourceSender}</span>}
                      </div>
                    </div>
                    <div className="inquiry-actions">
                      {canUseAI && (
                        <button
                          className="secondary"
                          onClick={() => {
                            setAiClientId(item.clientId ?? '')
                            setAiProjectId(item.projectId ?? '')
                            setAiPrompt(
                              `Assess this client inquiry and recommend what I should do next.\n\nTitle: ${item.title}\nDetails: ${item.description}`,
                            )
                            setView('ai')
                          }}
                        >
                          <Sparkles size={15} /> Ask AI
                        </button>
                      )}
                      {canWrite && (
                        <>
                          <button className="secondary" onClick={() => convertInquiry(item.id, 'Requirement')}>
                            → Requirement
                          </button>
                          <button className="secondary" onClick={() => convertInquiry(item.id, 'Issue')}>
                            → Issue
                          </button>
                          <button className="success" onClick={() => resolveItem(item.id)}>
                            <CheckCircle2 size={16} /> Answered
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <Empty text="No open inquiries match your filters." />
          )}
          <details className="inquiry-archive">
            <summary>
              <span>Discord inquiry archive</span>
              <b>{archivedInquiryItems.length}</b>
            </summary>
            <p className="inquiry-archive-help">
              Resolved Discord inquiries and inquiries converted into tasks remain here as a historical record.
            </p>
            {archivedInquiryItems.length ? (
              <div className="inquiry-archive-list">
                {archivedInquiryItems.map(item => {
                  const closed =
                    isTaskClosed(item.status, store.taskSettings) || isWaitingOnDone(item.waitingOn, store.taskSettings)
                  const outcome =
                    item.type !== 'Inquiry' ? `Converted to ${item.type}` : closed ? item.status : 'Archived'
                  return (
                    <div className="inquiry-archive-row" key={`archive-${item.id}`}>
                      <div>
                        <div className="row-meta">
                          <InquirySourceBadge source={item.source} />
                          <span>{outcome}</span>
                          <span>
                            {clientName(item.clientId)} · {projectName(item.projectId)}
                          </span>
                          {item.sourceSender && <span>From: {item.sourceSender}</span>}
                        </div>
                        <strong>{item.title}</strong>
                        {item.docHubDocuments?.map(d => (
                          <span className="dochub-task-badge" key={d.id}>
                            DocHub · {docHubLabels[d.status] || d.status} · {d.signed}/{d.total}
                          </span>
                        ))}
                        <small>{item.description || 'No description'}</small>
                      </div>
                      <div className="inquiry-archive-meta">
                        <StatusChip value={item.status} />
                        <span>
                          {item.resolvedDate
                            ? `Resolved ${niceDate(item.resolvedDate)}`
                            : `Received ${niceDate(item.dateRaised)}`}
                        </span>
                      </div>
                    </div>
                  )
                })}
              </div>
            ) : (
              <Empty text="No archived Discord inquiries yet." />
            )}
          </details>
        </div>
      </details>
    </section>
  )
}
