import ActivityCommentPreview from '../tasks/ActivityCommentPreview'
import TrackerLinkChips from '../trackers/TrackerLinkChips'
import { businessDateKey } from '../../shared/businessDate'
import { docHubLabels } from '../documents/dochub'
import { isArchived, isClosedProject } from '../tasks/lifecycle'
import { activityTime, niceDate } from '../../shared/dates'
import { Empty, PriorityChip, StatusChip } from '../../shared/ui/Chips'
import ClientSelect from '../../shared/ui/SearchSelect'
import type { TaskLink } from '../trackers/trackerApi'
import type { Client, PlannerActivity, Project, UserAccount, WorkItem } from '../../shared/types'
import { CalendarDays, CheckCircle2, Clock3, ExternalLink, Pencil } from 'lucide-react'
import { type FormEvent, useEffect, useState } from 'react'

export function DashboardActivityTimeline({
  mode,
  items,
  followUps,
  allItems,
  accounts,
  clients,
  projects,
  onEdit,
  onToggle,
  onEditTask,
  canEdit,
  canEditTask,
  trackerLinks,
  onOpenTracker,
}: {
  trackerLinks: TaskLink[]
  onOpenTracker?: (link: TaskLink) => void
  mode: 'today' | 'week'
  items: PlannerActivity[]
  followUps: WorkItem[]
  allItems: WorkItem[]
  accounts: UserAccount[]
  clients: Client[]
  projects: Project[]
  onEdit: (activity: PlannerActivity) => void
  onToggle: (id: string) => void
  onEditTask: (id: string) => void
  canEdit: boolean
  canEditTask: (item: WorkItem) => boolean
}) {
  const clientName = (id?: string) => (id ? clients.find(client => client.id === id)?.name : '')
  const projectName = (id?: string) => (id ? projects.find(project => project.id === id)?.name : '')
  const entries = [
    ...items.map(activity => ({
      kind: 'activity' as const,
      date: activity.date,
      sortTime: activity.startTime || '99:99',
      activity,
    })),
    ...followUps.map(item => ({ kind: 'followup' as const, date: item.followUpDate, sortTime: '99:98', item })),
  ].sort((a, b) => a.date.localeCompare(b.date) || a.sortTime.localeCompare(b.sortTime))
  if (!entries.length)
    return (
      <div className="activity-empty dashboard-activity-empty">
        No activities or follow-ups scheduled for this view.
      </div>
    )
  return (
    <div className="activity-tile-grid" aria-label={mode === 'today' ? "Today's activities" : "This week's activities"}>
      {entries.map(entry => {
        if (entry.kind === 'followup') {
          const item = entry.item
          const parent = item.parentTaskId ? allItems.find(candidate => candidate.id === item.parentTaskId) : undefined
          const context = [clientName(item.clientId), projectName(item.projectId)].filter(Boolean).join(' · ')
          const overdue = Boolean(
            (item.dueDate && item.dueDate < businessDateKey()) || item.followUpDate < businessDateKey(),
          )
          const assignedTo = accounts.find(account => account.id === item.assignedToUserId)?.name || 'Unassigned'
          const canEditThisItem = canEditTask(item)
          return (
            <article className={`activity-tile${overdue ? ' activity-tile-overdue' : ''}`} key={`followup-${item.id}`}>
              <div className="activity-tile-top">
                <span className="activity-tile-kind">{item.parentTaskId ? 'Subtask' : 'Task'} follow-up</span>
                {overdue && <span className="activity-overdue-label">Overdue</span>}
              </div>
              <h3>
                {canEditThisItem ? (
                  <button type="button" className="activity-tile-title" onClick={() => onEditTask(item.id)}>
                    {item.title}
                  </button>
                ) : (
                  item.title
                )}
              </h3>
              <p className="activity-tile-context">{context || 'General'}</p>
              {parent && <p className="activity-tile-parent">Parent task: {parent.title}</p>}
              <TrackerLinkChips links={trackerLinks} taskId={item.id} onOpen={onOpenTracker} />
              <div className="activity-tile-badges">
                <StatusChip value={item.status} />
                <PriorityChip value={item.priority} />
              </div>
              <div className="activity-tile-details">
                <span>
                  Assigned to: <b>{assignedTo}</b>
                </span>
                <span>
                  Follow-up: <b>{niceDate(item.followUpDate)}</b>
                </span>
                {item.dueDate && (
                  <span>
                    Due: <b>{niceDate(item.dueDate)}</b>
                  </span>
                )}
                <span>
                  Waiting on: <b>{item.waitingOn}</b>
                </span>
              </div>
              {item.docHubDocuments?.map(d => (
                <span className="dochub-task-badge" key={d.id}>
                  DocHub · {docHubLabels[d.status] || d.status} · {d.signed}/{d.total}
                </span>
              ))}
              <ActivityCommentPreview
                text={[
                  item.description,
                  ...(item.comments || []).slice(-3).map(comment => `${comment.createdByName}: ${comment.text}`),
                ]
                  .filter(Boolean)
                  .join('\n\n')}
                title={item.title}
              />
              {canEditThisItem && (
                <div className="activity-tile-actions">
                  <button className="secondary compact" type="button" onClick={() => onEditTask(item.id)}>
                    Edit {item.parentTaskId ? 'subtask' : 'task'}
                  </button>
                </div>
              )}
            </article>
          )
        }
        const activity = entry.activity
        const context = [clientName(activity.clientId), projectName(activity.projectId)].filter(Boolean).join(' · ')
        const overdue = activity.status === 'Planned' && (activity.endDate || activity.date) < businessDateKey()
        return (
          <article
            className={`activity-tile${activity.status === 'Done' ? ' activity-tile-done' : ''}${overdue ? ' activity-tile-overdue' : ''}`}
            key={`activity-${activity.id}`}
          >
            <div className="activity-tile-top">
              <span className="activity-tile-kind">
                {activity.source === 'Google Calendar' ? 'Calendar' : 'Tracker'}
              </span>
              {overdue && <span className="activity-overdue-label">Overdue</span>}
            </div>
            <h3>
              {canEdit ? (
                <button type="button" className="activity-tile-title" onClick={() => onEdit(activity)}>
                  {activity.title}
                </button>
              ) : (
                activity.title
              )}
            </h3>
            <p className="activity-tile-context">{context || 'General'}</p>
            <div className="activity-tile-badges">
              <StatusChip value={activity.status} />
            </div>
            <div className="activity-tile-details">
              <span>
                <CalendarDays size={14} /> {niceDate(activity.date)}
              </span>
              <span>
                <Clock3 size={14} />{' '}
                {activity.allDay
                  ? 'All day'
                  : [activity.startTime, activity.endTime].filter(Boolean).join(' – ') || 'Time not set'}
              </span>
            </div>
            <ActivityCommentPreview text={activity.notes} title={activity.title} />
            <div className="activity-tile-actions">
              {canEdit && (
                <button className="secondary compact" type="button" onClick={() => onEdit(activity)}>
                  {activity.source === 'Google Calendar' ? 'Edit local copy' : 'Edit'}
                </button>
              )}
              {canEdit && (
                <button className="secondary compact" type="button" onClick={() => onToggle(activity.id)}>
                  {activity.status === 'Done' ? 'Mark planned' : 'Mark done'}
                </button>
              )}
              {activity.calendarLink && (
                <a
                  className="secondary compact dashboard-link-button"
                  href={activity.calendarLink}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open original
                </a>
              )}
            </div>
          </article>
        )
      })}
    </div>
  )
}

export function DashboardActionTable({
  items,
  accounts,
  clients,
  projects,
  planner,
  trackerLinks,
  onOpenTracker,
}: {
  items: WorkItem[]
  accounts: UserAccount[]
  clients: Client[]
  projects: Project[]
  planner: PlannerActivity[]
  trackerLinks: TaskLink[]
  onOpenTracker?: (link: TaskLink) => void
}) {
  const [pageSize, setPageSize] = useState(10)
  const [page, setPage] = useState(1)
  const clientName = (id?: string) => (id ? (clients.find(client => client.id === id)?.name ?? 'Unknown') : 'General')
  const nextActivity = (item: WorkItem) =>
    planner
      .filter(
        activity =>
          activity.status === 'Planned' &&
          activity.date >= businessDateKey() &&
          activity.clientId === item.clientId &&
          (!activity.projectId || activity.projectId === item.projectId),
      )
      .sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime))[0]
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize))
  const safePage = Math.min(page, totalPages)
  const start = (safePage - 1) * pageSize
  const visibleItems = items.slice(start, start + pageSize)
  useEffect(() => {
    if (page !== safePage) setPage(safePage)
  }, [page, safePage])
  if (!items.length) return <Empty text="Nothing needs your attention right now." />
  return (
    <>
      <div className="table-scroll">
        <table className="dashboard-action-table">
          <thead>
            <tr>
              <th>Client</th>
              <th>Task</th>
              <th>Assigned to</th>
              <th>Waiting on</th>
              <th>Follow-up</th>
              <th>Next activity</th>
            </tr>
          </thead>
          <tbody>
            {visibleItems.map(item => {
              const activity = nextActivity(item)
              const activityLabel = activity
                ? `${activity.date === businessDateKey() ? activityTime(activity) : `${niceDate(activity.date)} · ${activityTime(activity)}`} — ${activity.title}`
                : '—'
              const assignee = accounts.find(account => account.id === item.assignedToUserId)?.name || 'Unassigned'
              return (
                <tr key={item.id}>
                  <td>
                    <strong>{clientName(item.clientId)}</strong>
                  </td>
                  <td>
                    <strong>{item.title}</strong>
                    <small>{projects.find(project => project.id === item.projectId)?.name ?? ''}</small>
                    <TrackerLinkChips links={trackerLinks} taskId={item.id} onOpen={onOpenTracker} />
                  </td>
                  <td>{assignee}</td>
                  <td>{item.waitingOn}</td>
                  <td className={item.followUpDate && item.followUpDate < businessDateKey() ? 'overdue-date' : ''}>
                    {item.followUpDate === businessDateKey() ? 'Today' : niceDate(item.followUpDate)}
                  </td>
                  <td>{activityLabel}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="dashboard-action-pagination">
        <label>
          Items per page
          <select
            value={pageSize}
            onChange={event => {
              setPageSize(Number(event.target.value))
              setPage(1)
            }}
          >
            <option value={10}>10</option>
            <option value={25}>25</option>
            <option value={50}>50</option>
          </select>
        </label>
        <span>
          Showing {start + 1}–{Math.min(start + pageSize, items.length)} of {items.length}
        </span>
        <div className="dashboard-page-buttons">
          <button
            className="secondary compact"
            type="button"
            disabled={safePage <= 1}
            onClick={() => setPage(value => Math.max(1, value - 1))}
          >
            Previous
          </button>
          <span>
            Page {safePage} of {totalPages}
          </span>
          <button
            className="secondary compact"
            type="button"
            disabled={safePage >= totalPages}
            onClick={() => setPage(value => Math.min(totalPages, value + 1))}
          >
            Next
          </button>
        </div>
      </div>
    </>
  )
}

export function ActivityColumn({
  title,
  subtitle,
  items,
  clients,
  projects,
  onEdit,
  onToggle,
}: {
  title: string
  subtitle: string
  items: PlannerActivity[]
  clients: Client[]
  projects: Project[]
  onEdit: (activity: PlannerActivity) => void
  onToggle: (id: string) => void
}) {
  const clientName = (id?: string) => (id ? clients.find(client => client.id === id)?.name : '')
  const projectName = (id?: string) => (id ? projects.find(project => project.id === id)?.name : '')
  return (
    <div className="activity-column">
      <div className="activity-column-head">
        <div>
          <h3>{title}</h3>
          <span>{subtitle}</span>
        </div>
        <b>{items.length}</b>
      </div>
      <div className="activity-list">
        {items.length === 0 && <div className="activity-empty">No activities scheduled.</div>}
        {items.map(activity => (
          <div className={`activity-card ${activity.status === 'Done' ? 'done' : ''}`} key={activity.id}>
            <button
              className="activity-check"
              title={activity.status === 'Done' ? 'Mark planned' : 'Mark done'}
              onClick={() => onToggle(activity.id)}
            >
              <CheckCircle2 size={18} />
            </button>
            <div className="activity-main">
              <div className="activity-meta">
                <span>
                  {title === 'Today'
                    ? activityTime(activity)
                    : `${niceDate(activity.date)} · ${activityTime(activity)}`}
                </span>
                <span className={activity.source === 'Google Calendar' ? 'source-google' : 'source-local'}>
                  {activity.source}
                </span>
              </div>
              <strong>{activity.title}</strong>
              {(clientName(activity.clientId) || projectName(activity.projectId)) && (
                <small>
                  {[clientName(activity.clientId), projectName(activity.projectId)].filter(Boolean).join(' · ')}
                </small>
              )}
              {activity.notes && <p>{activity.notes}</p>}
            </div>
            <div className="activity-controls">
              <button className="icon-button" title="Edit local tracker copy" onClick={() => onEdit(activity)}>
                <Pencil size={16} />
              </button>
              {activity.calendarLink && (
                <a
                  className="icon-button"
                  title="Open original Google Calendar event"
                  href={activity.calendarLink}
                  target="_blank"
                  rel="noreferrer"
                >
                  <ExternalLink size={16} />
                </a>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export function ActivityForm({
  clients,
  projects,
  initial,
  onSubmit,
}: {
  clients: Client[]
  projects: Project[]
  initial: PlannerActivity | null
  onSubmit: (activity: PlannerActivity) => void
}) {
  const [clientId, setClientId] = useState(initial?.clientId ?? '')
  const [allDay, setAllDay] = useState(initial?.allDay ?? false)
  const linkedProjects = projects
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    const startDate = String(form.get('date') || businessDateKey())
    const requestedEndDate = String(form.get('endDate') || startDate)
    const endDate = requestedEndDate >= startDate ? requestedEndDate : startDate
    onSubmit({
      id: initial?.id ?? crypto.randomUUID(),
      title: String(form.get('title') || '').trim(),
      date: startDate,
      startTime: allDay ? '' : String(form.get('startTime') || ''),
      endTime: allDay ? '' : String(form.get('endTime') || ''),
      endDate,
      allDay,
      source: initial?.source ?? 'Local',
      status: (form.get('status') as PlannerActivity['status']) || 'Planned',
      clientId: String(form.get('clientId') || '') || undefined,
      projectId: String(form.get('projectId') || '') || undefined,
      notes: String(form.get('notes') || ''),
      calendarEventId: initial?.calendarEventId,
      calendarLink: initial?.calendarLink,
    })
  }
  return (
    <form className="form-grid" onSubmit={submit}>
      {initial?.source === 'Google Calendar' && (
        <div className="readonly-notice span-2">
          <CalendarDays size={18} />
          <div>
            <strong>Local calendar copy</strong>
            <span>Your edits here stay in the BA Tracker. They are never sent back to Google Calendar.</span>
          </div>
        </div>
      )}
      <label className="span-2">
        Activity title
        <input
          name="title"
          required
          defaultValue={initial?.title ?? ''}
          placeholder="Meeting, prep work, follow-up, review..."
        />
      </label>
      <label>
        Start date
        <input name="date" type="date" required defaultValue={initial?.date ?? businessDateKey()} />
      </label>
      <label>
        End date
        <input name="endDate" type="date" defaultValue={initial?.endDate ?? initial?.date ?? businessDateKey()} />
      </label>
      <label>
        Status
        <select name="status" defaultValue={initial?.status ?? 'Planned'}>
          <option>Planned</option>
          <option>Done</option>
          <option>Cancelled</option>
        </select>
      </label>
      <label className="checkbox-label">
        <input type="checkbox" checked={allDay} onChange={e => setAllDay(e.target.checked)} /> All-day activity
      </label>
      <div />
      {!allDay && (
        <>
          <label>
            Start time
            <input name="startTime" type="time" defaultValue={initial?.startTime ?? ''} />
          </label>
          <label>
            End time
            <input name="endTime" type="time" defaultValue={initial?.endTime ?? ''} />
          </label>
        </>
      )}
      <label>
        Client
        <ClientSelect
          clients={clients.filter(client => !isArchived(client) || client.id === initial?.clientId)}
          value={clientId}
          onChange={value => setClientId(value)}
          extra={[{ value: '', label: 'No client' }]}
          name="clientId"
        />
      </label>
      <label>
        Project
        <select name="projectId" defaultValue={initial?.projectId ?? ''}>
          <option value="">No project</option>
          {linkedProjects
            .filter(project => !isClosedProject(project) || project.id === initial?.projectId)
            .map(project => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
        </select>
      </label>
      <label className="span-2">
        BA notes
        <textarea
          name="notes"
          rows={4}
          defaultValue={initial?.notes ?? ''}
          placeholder="Preparation notes, agenda, follow-up context, decisions..."
        />
      </label>
      <div className="form-actions span-2">
        <button className="primary">{initial ? 'Save local changes' : 'Add activity'}</button>
      </div>
    </form>
  )
}

export function Metric({
  title,
  value,
  detail,
  tone = '',
  icon,
}: {
  title: string
  value: number
  detail: string
  tone?: string
  icon: React.ReactNode
}) {
  return (
    <div className={`metric-card ${tone}`}>
      <div className="metric-icon">{icon}</div>
      <div>
        <span>{title}</span>
        <strong>{value}</strong>
        <small>{detail}</small>
      </div>
    </div>
  )
}
