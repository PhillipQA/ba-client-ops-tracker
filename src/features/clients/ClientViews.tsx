import { type Store, isTaskClosed } from '../../app/store'
import { businessDateKey } from '../../shared/businessDate'
import { isArchived, isTaskArchived } from '../tasks/lifecycle'
import { addDays, niceDate } from '../../shared/dates'
import { Empty, HealthChip, StatusChip } from '../../shared/ui/Chips'
import type { Client, Project } from '../../shared/types'
import { isWaitingOnDone } from '../tasks/waitingOn'
import { TaskTable } from '../tasks/TaskTable'
import { BriefcaseBusiness, ChevronRight, Mail, Plus, Sparkles, Table2 } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { StatusReportDialog } from '../ai/StatusReportDialog'

export function ClientDetail({
  onOpenRtms,
  controls,
  client,
  store,
  onBack,
  onOpenProject,
  onAddTask,
  onAskAI,
  canUseAI,
  canWrite,
}: {
  onOpenRtms?: () => void
  controls: React.ReactNode
  client: Client
  store: Store
  onBack: () => void
  onOpenProject: (projectId: string, clientId: string) => void
  onAddTask: (clientId: string) => void
  onAskAI: (clientId: string, projectId?: string) => void
  canUseAI: boolean
  canWrite: boolean
}) {
  const projectTaskCounts = new Map<string, number>()
  store.items
    .filter(item => item.clientId === client.id && item.projectId)
    .forEach(item =>
      projectTaskCounts.set(item.projectId as string, (projectTaskCounts.get(item.projectId as string) || 0) + 1),
    )
  const projects = store.projects.filter(project => projectTaskCounts.has(project.id))
  return (
    <section className="page-stack">
      <button className="back-link" onClick={onBack}>
        ← Back to clients
      </button>
      {onOpenRtms && (
        <button className="secondary" onClick={onOpenRtms}>
          <Table2 size={17} /> RTMs ({store.rtms.filter(m => m.clientId === client.id).length})
        </button>
      )}
      {controls}
      <div className="client-hero">
        <div>
          <div className="row-meta">
            <StatusChip value={client.status} />
            <HealthChip value={client.health} />
          </div>
          <p>
            {client.contact} · {client.email}
          </p>
          <p>{client.notes}</p>
        </div>
        <div className="client-hero-actions">
          {canWrite && !isArchived(client) && (
            <button className="primary" onClick={() => onAddTask(client.id)}>
              <Plus size={17} /> Add task
            </button>
          )}
          {canUseAI && !isArchived(client) && (
            <button className="secondary" onClick={() => onAskAI(client.id)}>
              <Sparkles size={17} /> Ask AI
            </button>
          )}
        </div>
      </div>
      <div className="panel">
        <div className="panel-heading">
          <div>
            <h2>Projects</h2>
            <p>Projects are global. Only projects containing tasks for {client.name} are shown here.</p>
          </div>
        </div>
        {projects.length ? (
          <div className="client-project-list">
            {projects.map(project => (
              <button
                type="button"
                className="mini-project mini-project-button"
                key={project.id}
                onClick={() => onOpenProject(project.id, client.id)}
              >
                <div>
                  <strong>{project.name}</strong>
                  <p>{project.summary || 'Open project dashboard'}</p>
                </div>
                <div>
                  <StatusChip value={isArchived(project) ? 'Archived · Inactive' : project.status} />
                  <small>
                    {projectTaskCounts.get(project.id) || 0} task{projectTaskCounts.get(project.id) === 1 ? '' : 's'} ·
                    Target {niceDate(project.targetDate)}
                  </small>
                  <ChevronRight size={16} />
                </div>
              </button>
            ))}
          </div>
        ) : (
          <Empty text="No tasks for this client are assigned to a project yet." />
        )}
      </div>
    </section>
  )
}

export function ProjectDetail({
  onOpenRtms,
  controls,
  project,
  clientContextId,
  store,
  setStore,
  onBack,
  onAddTask,
  onCreateSubtask,
  onReorderSubtasks,
  onStatusChange,
  onResolve,
  onEditTask,
  onDeleteTask,
  canWrite,
  canEditTasks,
}: {
  onOpenRtms?: () => void
  controls: React.ReactNode
  project: Project
  clientContextId: string | null
  store: Store
  setStore: (store: Store) => void
  onBack: () => void
  onAddTask: () => void
  onCreateSubtask: (id: string) => void
  onReorderSubtasks: (parentTaskId: string, orderedIds: string[]) => void
  onStatusChange: (id: string, status: string) => void
  onResolve: (id: string) => void
  onEditTask: (id: string) => void
  onDeleteTask: (id: string) => void
  canWrite: boolean
  canEditTasks: boolean
}) {
  const contextClient = clientContextId ? store.clients.find(client => client.id === clientContextId) : undefined
  const allProjectTasks = store.items.filter(item => item.projectId === project.id)
  // Archived tasks are put away: they are listed under Tasks → Archived, not here.
  const tasks = (
    clientContextId ? allProjectTasks.filter(item => item.clientId === clientContextId) : allProjectTasks
  ).filter(item => !isTaskArchived(store.items, item))
  const parentTasks = tasks.filter(item => !item.parentTaskId)
  const subtasks = tasks.filter(item => Boolean(item.parentTaskId))
  const openTasks = tasks.filter(
    item => !isTaskClosed(item.status, store.taskSettings) && !isWaitingOnDone(item.waitingOn, store.taskSettings),
  )
  const dueSoon = openTasks.filter(
    item => item.dueDate && item.dueDate >= businessDateKey() && item.dueDate <= addDays(businessDateKey(), 7),
  )
  const completedSubtasks = subtasks.filter(
    item => isTaskClosed(item.status, store.taskSettings) || isWaitingOnDone(item.waitingOn, store.taskSettings),
  ).length
  const clientCount = new Set(allProjectTasks.map(item => item.clientId).filter(Boolean)).size
  const communication = store.activity
    .filter(entry => entry.projectId === project.id && (!clientContextId || entry.clientId === clientContextId))
    .sort((a, b) => b.date.localeCompare(a.date))
  const [note, setNote] = useState('')
  const [reporting, setReporting] = useState(false)
  const addNote = (event: FormEvent) => {
    event.preventDefault()
    if (!canWrite || !note.trim()) return
    setStore({
      ...store,
      activity: [
        {
          id: crypto.randomUUID(),
          clientId: clientContextId || undefined,
          projectId: project.id,
          date: businessDateKey(),
          text: note.trim(),
        },
        ...store.activity,
      ],
    })
    setNote('')
  }
  return (
    <section className="page-stack project-detail-page">
      <button className="back-link" onClick={onBack}>
        {contextClient ? `← Back to ${contextClient.name}` : '← Back to projects'}
      </button>
      {onOpenRtms && (
        <button className="secondary" onClick={onOpenRtms}>
          <Table2 size={17} /> Requirements / RTMs (
          {
            store.rtms.filter(m => m.projectId === project.id && (!clientContextId || m.clientId === clientContextId))
              .length
          }
          )
        </button>
      )}
      {controls}
      <div className="project-hero">
        <div>
          <div className="row-meta">
            <StatusChip value={isArchived(project) ? 'Archived · Inactive' : project.status} />
            <span>
              {contextClient
                ? `${contextClient.name} view`
                : `Global project · ${clientCount} client${clientCount === 1 ? '' : 's'} with tasks`}
            </span>
          </div>
          <p>{project.summary || 'No project summary yet.'}</p>
          <small>Target {niceDate(project.targetDate)}</small>
        </div>
        <div className="project-hero-actions">
          {!project.accessLimited && !isArchived(project) && (
            <button type="button" className="secondary" onClick={() => setReporting(true)}>
              <Mail size={16} /> Status report
            </button>
          )}
          {canEditTasks && !isArchived(project) && !isArchived(contextClient) && (
            <button className="primary" onClick={onAddTask}>
              <Plus size={18} /> Add task{contextClient ? ` for ${contextClient.name}` : ''}
            </button>
          )}
        </div>
      </div>
      {reporting && (
        <StatusReportDialog
          project={project}
          store={store}
          clientId={clientContextId}
          onClose={() => setReporting(false)}
        />
      )}
      {contextClient && (
        <div className="project-context-banner">
          <strong>{contextClient.name}</strong>
          <span>
            Only this client's tasks, subtasks, and communications are shown. Work from other clients in {project.name}{' '}
            is hidden.
          </span>
        </div>
      )}
      <div className="project-stat-grid">
        <div className="project-stat">
          <span>Parent tasks</span>
          <strong>{parentTasks.length}</strong>
        </div>
        <div className="project-stat">
          <span>Subtasks</span>
          <strong>{subtasks.length}</strong>
          <small>{subtasks.length ? `${completedSubtasks}/${subtasks.length} completed` : 'No subtasks yet'}</small>
        </div>
        <div className="project-stat">
          <span>Open work</span>
          <strong>{openTasks.length}</strong>
        </div>
        <div className="project-stat">
          <span>Due in 7 days</span>
          <strong>{dueSoon.length}</strong>
        </div>
      </div>
      <div className="panel">
        <div className="panel-heading">
          <div>
            <h2>{contextClient ? `${contextClient.name} tasks` : 'Project tasks'}</h2>
            <p>
              {contextClient
                ? `Tasks and subtasks for ${contextClient.name} under ${project.name}.`
                : 'All client and general tasks created under this global project, with subtasks nested below their parent.'}
            </p>
          </div>
          <span className="count-pill">
            {parentTasks.length} tasks · {subtasks.length} subtasks
          </span>
        </div>
        <TaskTable
          items={tasks}
          allItems={store.items}
          clients={store.clients}
          projects={store.projects}
          taskSettings={store.taskSettings}
          onResolve={onResolve}
          onStatusChange={onStatusChange}
          onEdit={onEditTask}
          onDelete={onDeleteTask}
          onCreateSubtask={onCreateSubtask}
          onReorderSubtasks={onReorderSubtasks}
          canEdit={canEditTasks}
          hiddenColumns={contextClient ? ['project', 'client'] : ['project']}
        />
      </div>
      <div className="panel project-communication-panel">
        <div className="panel-heading">
          <div>
            <h2>Communication log</h2>
            <p>
              {contextClient
                ? `Communication for ${contextClient.name} within this project.`
                : 'Project notes, decisions, task events, and follow-up context across all clients.'}
            </p>
          </div>
        </div>
        {canWrite && !isArchived(project) && !isArchived(contextClient) && (
          <form className="quick-note" onSubmit={addNote}>
            <input
              value={note}
              onChange={event => setNote(event.target.value)}
              placeholder={
                contextClient
                  ? `Add a ${contextClient.name} communication note...`
                  : 'Add a project communication note...'
              }
            />
            <button className="secondary">Add</button>
          </form>
        )}
        <div className="timeline">
          {communication.length ? (
            communication.map(entry => (
              <div key={entry.id}>
                <span>
                  {niceDate(entry.date)}
                  {!clientContextId && entry.clientId
                    ? ` · ${store.clients.find(client => client.id === entry.clientId)?.name || 'Unknown client'}`
                    : ''}
                </span>
                <p>{entry.text}</p>
              </div>
            ))
          ) : (
            <div className="activity-empty">No communication logged for this view yet.</div>
          )}
        </div>
      </div>
    </section>
  )
}

export function ClientForm({ onSubmit }: { onSubmit: (client: Client) => void }) {
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    onSubmit({
      id: crypto.randomUUID(),
      name: String(f.get('name')),
      contact: String(f.get('contact')),
      email: String(f.get('email')),
      status: 'Active',
      health: 'Good',
      notes: String(f.get('notes') || ''),
    })
  }
  return (
    <form className="form-grid" onSubmit={submit}>
      <label>
        Client name
        <input name="name" required />
      </label>
      <label>
        Primary contact
        <input name="contact" required />
      </label>
      <label className="span-2">
        Email
        <input name="email" type="email" required />
      </label>
      <label className="span-2">
        Notes
        <textarea name="notes" rows={4} />
      </label>
      <div className="form-actions span-2">
        <button className="primary">Create client</button>
      </div>
    </form>
  )
}

export function ProjectForm({ onSubmit }: { onSubmit: (project: Project) => void }) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    onSubmit({
      id: crypto.randomUUID(),
      name: String(form.get('name')),
      status: 'Discovery',
      targetDate: String(form.get('targetDate') || ''),
      summary: String(form.get('summary') || ''),
    })
  }
  return (
    <form className="form-grid" onSubmit={submit}>
      <div className="readonly-notice span-2">
        <BriefcaseBusiness size={18} />
        <div>
          <strong>Global project</strong>
          <span>Projects are not owned by one client. Client association happens on each task.</span>
        </div>
      </div>
      <label className="span-2">
        Project name
        <input name="name" required />
      </label>
      <label>
        Target date
        <input name="targetDate" type="date" />
      </label>
      <div />
      <label className="span-2">
        Summary
        <textarea name="summary" rows={4} placeholder="Purpose, scope, rollout context, sign-off expectations..." />
      </label>
      <div className="form-actions span-2">
        <button className="primary">Create project</button>
      </div>
    </form>
  )
}
