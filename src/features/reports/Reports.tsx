import { businessDateKey, useBusinessDate } from '../../shared/businessDate'
import { useMemo, useState } from 'react'
import { Activity, AlertTriangle, CalendarRange, CheckCircle2, Clock3, Download, ListTodo, UsersRound } from 'lucide-react'
import type { Client, PlannerActivity, Project, TaskSettings, UserAccount, WorkActivityEvent, WorkItem } from '../../shared/types'
import EffortReport from './EffortReport'
import { defaultWaitingOn, isWaitingOnDone, openWaitingOnOptions } from '../tasks/waitingOn'
import ClientSelect from '../../shared/ui/SearchSelect'

function localDateKey(date: Date) {
  const yyyy = date.getFullYear()
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

function dateFromKey(date: string) {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(year, month - 1, day)
}

function daysBetween(start: string, end: string) {
  if (!start || !end) return 0
  const ms = dateFromKey(end).getTime() - dateFromKey(start).getTime()
  return Math.max(0, Math.round(ms / 86400000))
}

function niceDate(date: string) {
  if (!date) return '—'
  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(dateFromKey(date))
}

function startOfMonthKey() {
  const today = dateFromKey(businessDateKey())
  return localDateKey(new Date(today.getFullYear(), today.getMonth(), 1))
}

function endOfMonthKey() {
  const today = dateFromKey(businessDateKey())
  return localDateKey(new Date(today.getFullYear(), today.getMonth() + 1, 0))
}

function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
}

function median(values: number[]) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function csvEscape(value: unknown) {
  const text = String(value ?? '')
  return `"${text.replace(/"/g, '""')}"`
}

export default function Reports({ clients, projects, items, planner, taskSettings, accounts, workEvents, currentUser }: { clients: Client[]; projects: Project[]; items: WorkItem[]; planner: PlannerActivity[]; taskSettings: TaskSettings; accounts: UserAccount[]; workEvents: WorkActivityEvent[]; currentUser: UserAccount }) {
  const [from, setFrom] = useState(startOfMonthKey())
  const [to, setTo] = useState(endOfMonthKey())
  const [clientId, setClientId] = useState('')
  const [projectId, setProjectId] = useState('')
  const [userId, setUserId] = useState(currentUser.role === 'Administrator' ? '' : currentUser.id)
  const today = useBusinessDate()
  const trackedUsers = useMemo(() => accounts.filter((account) => account.status === 'Active' && (account.role === 'Administrator' || account.role === 'Contributor')), [accounts])
  const effectiveUserId = currentUser.role === 'Administrator' ? userId : currentUser.id

  const contextProjects = useMemo(() => projects, [projects])
  const contextItems = useMemo(() => items.filter((item) => (!clientId || item.clientId === clientId) && (!projectId || item.projectId === projectId) && (!effectiveUserId || item.assignedToUserId === effectiveUserId)), [items, clientId, projectId, effectiveUserId])
  const periodActivities = useMemo(() => planner.filter((activity) => {
    const endDate = activity.endDate || activity.date
    return activity.status !== 'Cancelled' && activity.date <= to && endDate >= from && (!clientId || activity.clientId === clientId) && (!projectId || activity.projectId === projectId)
  }), [planner, from, to, clientId, projectId])
  const resolvedInPeriod = useMemo(() => contextItems.filter((item) => item.resolvedDate && item.resolvedDate >= from && item.resolvedDate <= to), [contextItems, from, to])
  const raisedInPeriod = useMemo(() => contextItems.filter((item) => item.dateRaised >= from && item.dateRaised <= to), [contextItems, from, to])
  const isClosed = (status: string) => taskSettings.statuses.find((candidate) => candidate.label === status)?.closed ?? ['Resolved', 'Closed'].includes(status)
  const openItems = useMemo(() => contextItems.filter((item) => !isClosed(item.status) && !isWaitingOnDone(item.waitingOn, taskSettings)), [contextItems, taskSettings])
  const overdueItems = useMemo(() => openItems.filter((item) => (item.dueDate && item.dueDate < today) || (item.followUpDate && item.followUpDate < today)), [openItems, today])
  const parentTasks = useMemo(() => contextItems.filter((item) => !item.parentTaskId), [contextItems])
  const subtasks = useMemo(() => contextItems.filter((item) => Boolean(item.parentTaskId)), [contextItems])
  const openSubtasks = useMemo(() => subtasks.filter((item) => !isClosed(item.status) && !isWaitingOnDone(item.waitingOn, taskSettings)), [subtasks, taskSettings])
  const completedSubtasks = subtasks.length - openSubtasks.length
  const overdueSubtasks = useMemo(() => openSubtasks.filter((item) => (item.dueDate && item.dueDate < today) || (item.followUpDate && item.followUpDate < today)), [openSubtasks, today])
  const subtasksRaisedInPeriod = useMemo(() => subtasks.filter((item) => item.dateRaised >= from && item.dateRaised <= to), [subtasks, from, to])
  const subtasksResolvedInPeriod = useMemo(() => subtasks.filter((item) => item.resolvedDate && item.resolvedDate >= from && item.resolvedDate <= to), [subtasks, from, to])
  const subtaskCompletion = subtasks.length ? Math.round((completedSubtasks / subtasks.length) * 100) : 0
  const subtaskProgress = useMemo(() => parentTasks.map((parent) => {
    const children = subtasks.filter((item) => item.parentTaskId === parent.id)
    const completed = children.filter((item) => isClosed(item.status) || isWaitingOnDone(item.waitingOn, taskSettings)).length
    return { parent, total: children.length, completed, percent: children.length ? Math.round((completed / children.length) * 100) : 0 }
  }).filter((row) => row.total > 0).sort((a, b) => a.percent - b.percent || b.total - a.total), [parentTasks, subtasks, taskSettings])

  const tatValues = resolvedInPeriod.map((item) => daysBetween(item.dateRaised, item.resolvedDate || item.dateRaised))
  const avgTat = average(tatValues)
  const medianTat = median(tatValues)
  const completedActivities = periodActivities.filter((activity) => activity.status === 'Done').length
  const activityCompletion = periodActivities.length ? Math.round((completedActivities / periodActivities.length) * 100) : 0

  const waitingBreakdown = openWaitingOnOptions(taskSettings).map(({ label: waitingOn }) => ({ waitingOn, count: openItems.filter((item) => item.waitingOn === waitingOn).length }))
  const maxWaiting = Math.max(1, ...waitingBreakdown.map((row) => row.count))
  const workload = clients
    .filter((client) => !clientId || client.id === clientId)
    .map((client) => ({ client, count: openItems.filter((item) => item.clientId === client.id).length }))
    .filter((row) => row.count > 0)
    .sort((a, b) => b.count - a.count)
  const maxWorkload = Math.max(1, ...workload.map((row) => row.count))

  const turnaroundByClient = clients
    .filter((client) => !clientId || client.id === clientId)
    .map((client) => {
      const values = resolvedInPeriod.filter((item) => item.clientId === client.id).map((item) => daysBetween(item.dateRaised, item.resolvedDate || item.dateRaised))
      return { client, count: values.length, avg: average(values) }
    })
    .filter((row) => row.count > 0)
    .sort((a, b) => b.avg - a.avg)
  const maxTat = Math.max(1, ...turnaroundByClient.map((row) => row.avg))

  const aging = [...openItems]
    .map((item) => ({ item, age: daysBetween(item.dateRaised, today) }))
    .sort((a, b) => b.age - a.age)
    .slice(0, 8)

  const ganttDays = Math.max(1, daysBetween(from, to) + 1)
  const ganttTicks = Array.from({ length: Math.min(ganttDays, 7) }, (_, index) => {
    const dayOffset = ganttDays <= 7 ? index : Math.round((index * (ganttDays - 1)) / 6)
    const d = dateFromKey(from)
    d.setDate(d.getDate() + dayOffset)
    return { offset: dayOffset, label: niceDate(localDateKey(d)) }
  })
  const ganttActivities = [...periodActivities].sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime))
  const userItems = useMemo(() => items.filter((item) => (!effectiveUserId || item.assignedToUserId === effectiveUserId) && (!clientId || item.clientId === clientId) && (!projectId || item.projectId === projectId)), [items, effectiveUserId, clientId, projectId])
  const userEvents = useMemo(() => workEvents.map(event => ({ ...event, date: event.occurredAt && Number.isFinite(Date.parse(event.occurredAt)) ? businessDateKey(event.occurredAt) : event.date })).filter((event) => event.date >= from && event.date <= to && (!effectiveUserId || event.actorUserId === effectiveUserId || event.assignedToUserId === effectiveUserId || (event.field === 'assignedToUserId' && event.oldValue === effectiveUserId)) && (!clientId || event.clientId === clientId) && (!projectId || event.projectId === projectId)).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)), [workEvents, from, to, effectiveUserId, clientId, projectId])
  const userOpen = userItems.filter((item) => !isClosed(item.status) && !isWaitingOnDone(item.waitingOn, taskSettings))
  const userCompleted = userEvents.filter((event) => event.action === 'completed' && (!effectiveUserId || event.assignedToUserId === effectiveUserId || event.actorUserId === effectiveUserId))
  const userStarted = userEvents.filter((event) => event.action === 'started')
  const userOverdue = userOpen.filter((item) => Boolean(item.dueDate && item.dueDate < today))
  const userGanttItems = userItems.filter((item) => item.startDate && (item.dueDate || item.startDate) >= from && item.startDate! <= to).sort((a, b) => (a.startDate || '').localeCompare(b.startDate || ''))
  const teamWorkload = trackedUsers.filter(user => !effectiveUserId || user.id === effectiveUserId).map((user) => {
    const assigned = contextItems.filter((item) => item.assignedToUserId === user.id)
    const active = assigned.filter((item) => !isClosed(item.status) && !isWaitingOnDone(item.waitingOn, taskSettings))
    return { user, active: active.length, waiting: active.filter((item) => item.waitingOn !== defaultWaitingOn(taskSettings)).length, overdue: active.filter((item) => Boolean(item.dueDate && item.dueDate < today)).length, completed: userEvents.filter((event) => event.assignedToUserId === user.id && event.action === 'completed' && event.date >= from && event.date <= to).length }
  }).filter((row) => currentUser.role === 'Administrator' || row.user.id === currentUser.id)

  const exportCsv = () => {
    const rows = [
      ['Metric', 'Value'],
      ['Date range', `${from} to ${to}`],
      ['Client', clients.find(c => c.id === clientId)?.name || 'All clients'],
      ['Project', projects.find(p => p.id === projectId)?.name || 'All projects'],
      ['Assigned user', accounts.find(a => a.id === effectiveUserId)?.name || 'All users'],
      ['Activity scope', 'Shared planner activities have no assigned user; filtered by client, project and date.'],
      ['Tasks and subtasks raised', raisedInPeriod.length],
      ['Tasks and subtasks resolved', resolvedInPeriod.length],
      ['Parent tasks', parentTasks.length],
      ['Subtasks', subtasks.length],
      ['Open subtasks', openSubtasks.length],
      ['Completed subtasks', completedSubtasks],
      ['Overdue subtasks', overdueSubtasks.length],
      ['Subtasks raised in range', subtasksRaisedInPeriod.length],
      ['Subtasks resolved in range', subtasksResolvedInPeriod.length],
      ['Subtask completion percent', subtaskCompletion],
      ['Average turnaround days', avgTat.toFixed(1)],
      ['Median turnaround days', medianTat.toFixed(1)],
      ['Open tasks', openItems.length],
      ['Overdue tasks', overdueItems.length],
      ['Activities', periodActivities.length],
      ['Activity completion percent', activityCompletion],
      [],
      ['Resolved task', 'Parent task', 'Client', 'Project', 'Raised', 'Resolved', 'Turnaround days'],
      ...resolvedInPeriod.map((item) => [item.title, item.parentTaskId ? contextItems.find((candidate) => candidate.id === item.parentTaskId)?.title ?? '' : '', clients.find((client) => client.id === item.clientId)?.name ?? '', projects.find((project) => project.id === item.projectId)?.name ?? '', item.dateRaised, item.resolvedDate ?? '', daysBetween(item.dateRaised, item.resolvedDate || item.dateRaised)]),
    ]
    const blob = new Blob([rows.map((row) => row.map(csvEscape).join(',')).join('\n')], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `ba-report-${from}-to-${to}.csv`
    link.click()
    URL.revokeObjectURL(url)
  }

  return <section className="page-stack reports-page">
    <div className="panel report-filter-panel">
      <div className="panel-heading"><div><h2>Reports</h2><p>Task metrics follow the selected client, project and assigned user. Shared planner activities have no assigned user and follow only client, project and date filters.</p></div><button className="secondary" onClick={exportCsv}><Download size={16} /> Export CSV</button></div>
      <div className="report-filters">
        <label>From<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
        <label>To<input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
        <label>Client<ClientSelect clients={clients} value={clientId} onChange={(value) => { setClientId(value); setProjectId('') }} extra={[{ value: '', label: 'All clients' }]} /></label>
        <label>Project<select value={projectId} onChange={(event) => setProjectId(event.target.value)}><option value="">All projects</option>{contextProjects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
        <label>User<select value={effectiveUserId} disabled={currentUser.role !== 'Administrator'} onChange={(event) => setUserId(event.target.value)}>{currentUser.role === 'Administrator' && <option value="">All tracked users</option>}{trackedUsers.map((user) => <option key={user.id} value={user.id}>{user.name}{user.id === currentUser.id ? ' · You' : ''}</option>)}</select></label>
      </div>
    </div>

    <div className="panel report-panel user-work-report">
      <div className="panel-heading"><div><h2>User work tracking</h2><p>{effectiveUserId ? `Assignment, contribution, and activity for ${trackedUsers.find((user) => user.id === effectiveUserId)?.name || 'this user'}.` : 'Team assignment, contribution, and activity across tracked users.'}</p></div><Activity size={19} /></div>
      <div className="subtask-report-summary user-report-summary"><div><strong>{userItems.length}</strong><span>Assigned items</span></div><div><strong>{userStarted.length}</strong><span>Started in range</span></div><div><strong>{userCompleted.length}</strong><span>Completed in range</span></div><div><strong>{userOpen.length}</strong><span>Open now</span></div><div><strong>{userOverdue.length}</strong><span>Overdue now</span></div><div><strong>{userEvents.length}</strong><span>Work events</span></div></div>
      <div className="report-grid-two user-report-grid">
        <div>
          <h3>Workload by user</h3>
          <div className="table-scroll"><table className="report-table"><thead><tr><th>User</th><th>Active</th><th>Waiting</th><th>Overdue</th><th>Completed</th></tr></thead><tbody>{teamWorkload.map((row) => <tr key={row.user.id}><td><strong>{row.user.name}</strong><small>{row.user.role}</small></td><td>{row.active}</td><td>{row.waiting}</td><td className={row.overdue ? 'overdue-date' : ''}>{row.overdue}</td><td>{row.completed}</td></tr>)}</tbody></table></div>
        </div>
        <div>
          <h3>Recent contribution</h3>
          <div className="user-activity-timeline">{userEvents.slice(0, 10).map((event) => <div key={event.id}><span>{new Date(event.occurredAt).toLocaleString()}</span><strong>{event.actorName}</strong><p>{event.summary}</p></div>)}{!userEvents.length && <div className="report-empty">No tracked user activity in this range.</div>}</div>
        </div>
      </div>
    </div>

    <EffortReport items={items} clients={clients} projects={projects} trackedUsers={trackedUsers} from={from} to={to} clientId={clientId} projectId={projectId} userId={effectiveUserId} showTeam />

    <div className="panel report-panel">
      <div className="panel-heading"><div><h2>User Gantt</h2><p>Task and subtask timelines use Start Date through Due Date.</p></div><span className="count-pill">{userGanttItems.length} scheduled</span></div>
      <div className="gantt-scroll"><div className="gantt-chart" style={{ minWidth: ganttDays > 21 ? 980 : 760 }}>
        <div className="gantt-header"><div className="gantt-label-head">User · Work</div><div className="gantt-axis">{ganttTicks.map((tick) => <span key={`user-${tick.offset}-${tick.label}`} style={{ left: `${(tick.offset / Math.max(1, ganttDays - 1)) * 100}%` }}>{tick.label}</span>)}</div></div>
        {!userGanttItems.length && <div className="report-empty">Add a Start Date and Due Date to assigned tasks to see them here.</div>}
        {userGanttItems.map((item) => { const visibleStart = item.startDate! < from ? from : item.startDate!; const rawEnd = item.dueDate || item.startDate!; const visibleEnd = rawEnd > to ? to : rawEnd; const left = (daysBetween(from, visibleStart) / ganttDays) * 100; const width = Math.max(1.4, ((daysBetween(visibleStart, visibleEnd) + 1) / ganttDays) * 100); const assigned = trackedUsers.find((user) => user.id === item.assignedToUserId)?.name || 'Unassigned'; return <div className="gantt-row" key={`user-work-${item.id}`}><div className="gantt-label"><strong>{item.title}</strong><small>{assigned} · {item.parentTaskId ? 'Subtask' : 'Task'} · {item.status}</small></div><div className="gantt-track" style={{ backgroundSize: `${100 / ganttDays}% 100%` }}><div className={`gantt-bar local ${isClosed(item.status) ? 'done' : ''}`} style={{ left: `${left}%`, width: `${width}%` }} title={`${assigned}: ${item.startDate} to ${rawEnd}`}><span>{ganttDays <= 21 ? assigned : ''}</span></div></div></div> })}
      </div></div>
    </div>

    <div className="metric-grid dashboard-metrics">
      <ReportMetric title="Avg turnaround" value={resolvedInPeriod.length ? `${avgTat.toFixed(1)}d` : '—'} detail={`${resolvedInPeriod.length} resolved · median ${medianTat.toFixed(1)}d`} icon={<Clock3 size={18} />} />
      <ReportMetric title="Work raised" value={raisedInPeriod.length} detail={`${parentTasks.length} parent tasks · ${subtasks.length} subtasks`} icon={<ListTodo size={18} />} />
      <ReportMetric title="Subtask completion" value={`${subtaskCompletion}%`} detail={`${completedSubtasks} of ${subtasks.length} completed`} icon={<CheckCircle2 size={18} />} />
      <ReportMetric title="Overdue now" value={overdueItems.length} detail={`${overdueSubtasks.length} overdue subtasks`} icon={<AlertTriangle size={18} />} />
      <ReportMetric title="Shared activity completion" value={`${activityCompletion}%`} detail={`${completedActivities} of ${periodActivities.length} activities done`} icon={<CalendarRange size={18} />} />
    </div>

    <div className="panel report-panel">
      <div className="panel-heading"><div><h2>Subtask progress</h2><p>Completion and overdue status for work broken down under parent tasks.</p></div><span className="count-pill">{subtasks.length} subtasks</span></div>
      <div className="subtask-report-summary"><div><strong>{subtasks.length}</strong><span>Total subtasks</span></div><div><strong>{openSubtasks.length}</strong><span>Open</span></div><div><strong>{completedSubtasks}</strong><span>Completed</span></div><div><strong>{overdueSubtasks.length}</strong><span>Overdue</span></div></div>
      <div className="subtask-progress-list">{subtaskProgress.length ? subtaskProgress.slice(0, 10).map((row) => <div className="subtask-progress-row" key={row.parent.id}><div className="subtask-progress-label"><span><strong>{row.parent.title}</strong>{clients.find((client) => client.id === row.parent.clientId)?.name ? ` · ${clients.find((client) => client.id === row.parent.clientId)?.name}` : ''}</span><span>{row.completed}/{row.total} · {row.percent}%</span></div><div className="subtask-progress-track"><div className="subtask-progress-fill" style={{ width: `${row.percent}%` }} /></div></div>) : <div className="report-empty">Create subtasks under a task to see progress here.</div>}</div>
    </div>

    <div className="panel report-panel">
      <div className="panel-heading"><div><h2>Activity Gantt</h2><p>Timeline of meetings and BA activities for the selected period.</p></div><span className="count-pill">{ganttActivities.length} activities</span></div>
      <div className="gantt-scroll">
        <div className="gantt-chart" style={{ minWidth: ganttDays > 21 ? 980 : 760 }}>
          <div className="gantt-header"><div className="gantt-label-head">Activity</div><div className="gantt-axis">{ganttTicks.map((tick) => <span key={`${tick.offset}-${tick.label}`} style={{ left: `${(tick.offset / Math.max(1, ganttDays - 1)) * 100}%` }}>{tick.label}</span>)}</div></div>
          {ganttActivities.length === 0 && <div className="report-empty">No activities in this report range.</div>}
          {ganttActivities.map((activity) => {
            const visibleStart = activity.date < from ? from : activity.date
            const rawEnd = activity.endDate || activity.date
            const visibleEnd = rawEnd > to ? to : rawEnd
            const left = (daysBetween(from, visibleStart) / ganttDays) * 100
            const width = Math.max(1.4, ((daysBetween(visibleStart, visibleEnd) + 1) / ganttDays) * 100)
            const client = clients.find((entry) => entry.id === activity.clientId)?.name
            return <div className="gantt-row" key={activity.id}>
              <div className="gantt-label"><strong>{activity.title}</strong><small>{client || (activity.source === 'Google Calendar' ? 'Calendar' : 'Internal')} · {activity.status}</small></div>
              <div className="gantt-track" style={{ backgroundSize: `${100 / ganttDays}% 100%` }}><div className={`gantt-bar ${activity.source === 'Google Calendar' ? 'calendar' : 'local'} ${activity.status === 'Done' ? 'done' : ''}`} style={{ left: `${left}%`, width: `${width}%` }} title={`${activity.title}: ${activity.date}${rawEnd !== activity.date ? ` to ${rawEnd}` : ''}`}><span>{ganttDays <= 14 ? activity.startTime || 'All day' : ''}</span></div></div>
            </div>
          })}
        </div>
      </div>
    </div>

    <div className="report-grid-two">
      <div className="panel report-panel">
        <div className="panel-heading"><div><h2>Open workload by client</h2><p>Where your unresolved work is concentrated.</p></div><UsersRound size={18} /></div>
        <div className="report-bars">{workload.length ? workload.map(({ client, count }) => <ReportBar key={client.id} label={client.name} value={count} max={maxWorkload} suffix=" open" />) : <div className="report-empty">No open workload for this filter.</div>}</div>
      </div>
      <div className="panel report-panel">
        <div className="panel-heading"><div><h2>Waiting-on breakdown</h2><p>Who currently owns the next move.</p></div></div>
        <div className="report-bars">{waitingBreakdown.map((row) => <ReportBar key={row.waitingOn} label={row.waitingOn} value={row.count} max={maxWaiting} suffix=" tasks" />)}</div>
      </div>
    </div>

    <div className="report-grid-two">
      <div className="panel report-panel">
        <div className="panel-heading"><div><h2>Turnaround by client</h2><p>Average days from task raised to resolved.</p></div></div>
        <div className="report-bars">{turnaroundByClient.length ? turnaroundByClient.map((row) => <ReportBar key={row.client.id} label={row.client.name} value={row.avg} max={maxTat} suffix={` days · ${row.count} completed`} decimals={1} />) : <div className="report-empty">Resolve tasks to build turnaround reporting.</div>}</div>
      </div>
      <div className="panel report-panel">
        <div className="panel-heading"><div><h2>Activity mix</h2><p>Calendar meetings versus tracker-only BA work.</p></div><CalendarRange size={18} /></div>
        <div className="report-mini-stats"><div><strong>{periodActivities.filter((activity) => activity.source === 'Google Calendar').length}</strong><span>Calendar meetings</span></div><div><strong>{periodActivities.filter((activity) => activity.source === 'Local').length}</strong><span>Tracker activities</span></div><div><strong>{completedActivities}</strong><span>Completed</span></div><div><strong>{periodActivities.filter((activity) => activity.status === 'Planned').length}</strong><span>Still planned</span></div></div>
      </div>
    </div>

    <div className="panel report-panel">
      <div className="panel-heading"><div><h2>Task aging</h2><p>Your oldest unresolved tasks, useful for spotting work that is quietly sitting too long.</p></div></div>
      <div className="table-scroll"><table className="report-table"><thead><tr><th>Task</th><th>Client</th><th>Age</th><th>Waiting on</th><th>Follow-up</th></tr></thead><tbody>{aging.map(({ item, age }) => <tr key={item.id}><td><strong>{item.title}</strong><small>{item.parentTaskId ? `Subtask of ${contextItems.find((candidate) => candidate.id === item.parentTaskId)?.title || 'parent task'} · ` : ''}{projects.find((project) => project.id === item.projectId)?.name ?? ''}</small></td><td>{clients.find((client) => client.id === item.clientId)?.name ?? 'General'}</td><td>{age} day{age === 1 ? '' : 's'}</td><td>{item.waitingOn}</td><td className={item.followUpDate && item.followUpDate < today ? 'overdue-date' : ''}>{niceDate(item.followUpDate)}</td></tr>)}</tbody></table></div>
    </div>
  </section>
}

function ReportMetric({ title, value, detail, icon }: { title: string; value: string | number; detail: string; icon: React.ReactNode }) {
  return <div className="metric-card"><div className="metric-icon">{icon}</div><div><span>{title}</span><strong>{value}</strong><small>{detail}</small></div></div>
}

function ReportBar({ label, value, max, suffix, decimals = 0 }: { label: string; value: number; max: number; suffix: string; decimals?: number }) {
  const width = max ? Math.max(value > 0 ? 4 : 0, (value / max) * 100) : 0
  return <div className="report-bar-row"><div className="report-bar-label"><span>{label}</span><strong>{value.toFixed(decimals)}{suffix}</strong></div><div className="report-bar-track"><div className="report-bar-fill" style={{ width: `${width}%` }} /></div></div>
}
