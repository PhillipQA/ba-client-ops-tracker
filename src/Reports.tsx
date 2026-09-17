import { useMemo, useState } from 'react'
import { AlertTriangle, CalendarRange, CheckCircle2, Clock3, Download, ListTodo, UsersRound } from 'lucide-react'
import type { Client, PlannerActivity, Project, TaskSettings, WorkItem } from './types'

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
  const today = new Date()
  return localDateKey(new Date(today.getFullYear(), today.getMonth(), 1))
}

function endOfMonthKey() {
  const today = new Date()
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

export default function Reports({ clients, projects, items, planner, taskSettings }: { clients: Client[]; projects: Project[]; items: WorkItem[]; planner: PlannerActivity[]; taskSettings: TaskSettings }) {
  const [from, setFrom] = useState(startOfMonthKey())
  const [to, setTo] = useState(endOfMonthKey())
  const [clientId, setClientId] = useState('')
  const [projectId, setProjectId] = useState('')
  const today = localDateKey(new Date())

  const contextProjects = useMemo(() => projects.filter((project) => !clientId || !project.clientId || project.clientId === clientId), [projects, clientId])
  const contextItems = useMemo(() => items.filter((item) => (!clientId || item.clientId === clientId) && (!projectId || item.projectId === projectId)), [items, clientId, projectId])
  const periodActivities = useMemo(() => planner.filter((activity) => {
    const endDate = activity.endDate || activity.date
    return activity.status !== 'Cancelled' && activity.date <= to && endDate >= from && (!clientId || activity.clientId === clientId) && (!projectId || activity.projectId === projectId)
  }), [planner, from, to, clientId, projectId])
  const resolvedInPeriod = useMemo(() => contextItems.filter((item) => item.resolvedDate && item.resolvedDate >= from && item.resolvedDate <= to), [contextItems, from, to])
  const raisedInPeriod = useMemo(() => contextItems.filter((item) => item.dateRaised >= from && item.dateRaised <= to), [contextItems, from, to])
  const isClosed = (status: string) => taskSettings.statuses.find((candidate) => candidate.label === status)?.closed ?? ['Resolved', 'Closed'].includes(status)
  const openItems = useMemo(() => contextItems.filter((item) => !isClosed(item.status) && item.waitingOn !== 'Done'), [contextItems, taskSettings])
  const overdueItems = useMemo(() => openItems.filter((item) => (item.dueDate && item.dueDate < today) || (item.followUpDate && item.followUpDate < today)), [openItems, today])

  const tatValues = resolvedInPeriod.map((item) => daysBetween(item.dateRaised, item.resolvedDate || item.dateRaised))
  const avgTat = average(tatValues)
  const medianTat = median(tatValues)
  const completedActivities = periodActivities.filter((activity) => activity.status === 'Done').length
  const activityCompletion = periodActivities.length ? Math.round((completedActivities / periodActivities.length) * 100) : 0

  const waitingBreakdown = ['Me', 'Developer', 'Client', 'QA', 'Design'].map((waitingOn) => ({ waitingOn, count: openItems.filter((item) => item.waitingOn === waitingOn).length }))
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

  const exportCsv = () => {
    const rows = [
      ['Metric', 'Value'],
      ['Date range', `${from} to ${to}`],
      ['Tasks raised', raisedInPeriod.length],
      ['Tasks resolved', resolvedInPeriod.length],
      ['Average turnaround days', avgTat.toFixed(1)],
      ['Median turnaround days', medianTat.toFixed(1)],
      ['Open tasks', openItems.length],
      ['Overdue tasks', overdueItems.length],
      ['Activities', periodActivities.length],
      ['Activity completion percent', activityCompletion],
      [],
      ['Resolved task', 'Client', 'Project', 'Raised', 'Resolved', 'Turnaround days'],
      ...resolvedInPeriod.map((item) => [item.title, clients.find((client) => client.id === item.clientId)?.name ?? '', projects.find((project) => project.id === item.projectId)?.name ?? '', item.dateRaised, item.resolvedDate ?? '', daysBetween(item.dateRaised, item.resolvedDate || item.dateRaised)]),
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
      <div className="panel-heading"><div><h2>Reports</h2><p>Operational reporting derived from your tasks and activities.</p></div><button className="secondary" onClick={exportCsv}><Download size={16} /> Export CSV</button></div>
      <div className="report-filters">
        <label>From<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
        <label>To<input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
        <label>Client<select value={clientId} onChange={(event) => { setClientId(event.target.value); setProjectId('') }}><option value="">All clients</option>{clients.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}</select></label>
        <label>Project<select value={projectId} onChange={(event) => setProjectId(event.target.value)}><option value="">All projects</option>{contextProjects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
      </div>
    </div>

    <div className="metric-grid dashboard-metrics">
      <ReportMetric title="Avg turnaround" value={resolvedInPeriod.length ? `${avgTat.toFixed(1)}d` : '—'} detail={`${resolvedInPeriod.length} resolved · median ${medianTat.toFixed(1)}d`} icon={<Clock3 size={18} />} />
      <ReportMetric title="Tasks raised" value={raisedInPeriod.length} detail={`${resolvedInPeriod.length} resolved in range`} icon={<ListTodo size={18} />} />
      <ReportMetric title="Overdue now" value={overdueItems.length} detail={`${openItems.length} open tasks`} icon={<AlertTriangle size={18} />} />
      <ReportMetric title="Activity completion" value={`${activityCompletion}%`} detail={`${completedActivities} of ${periodActivities.length} activities done`} icon={<CheckCircle2 size={18} />} />
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
      <div className="table-scroll"><table className="report-table"><thead><tr><th>Task</th><th>Client</th><th>Age</th><th>Waiting on</th><th>Follow-up</th></tr></thead><tbody>{aging.map(({ item, age }) => <tr key={item.id}><td><strong>{item.title}</strong><small>{projects.find((project) => project.id === item.projectId)?.name ?? ''}</small></td><td>{clients.find((client) => client.id === item.clientId)?.name ?? 'General'}</td><td>{age} day{age === 1 ? '' : 's'}</td><td>{item.waitingOn}</td><td className={item.followUpDate && item.followUpDate < today ? 'overdue-date' : ''}>{niceDate(item.followUpDate)}</td></tr>)}</tbody></table></div>
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
