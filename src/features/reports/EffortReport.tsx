import { useMemo } from 'react'
import { Clock3, Download } from 'lucide-react'
import {
  capacityHoursBetween,
  DEFAULT_WEEKLY_CAPACITY_HOURS,
  EFFORT_CATEGORIES,
  effortRows,
  effortSummary,
  formatHours,
  roundToQuarter,
} from '../tasks/effort'
import type { Client, Project, UserAccount, WorkItem } from '../../shared/types'
import '../tasks/effort.css'

type Props = {
  items: WorkItem[]
  clients: Client[]
  projects: Project[]
  trackedUsers: UserAccount[]
  from: string
  to: string
  clientId: string
  projectId: string
  /** Blank for the whole team. Matches the person who logged the time. */
  userId: string
  showTeam: boolean
}

function csvCell(value: unknown) {
  const text = String(value ?? '')
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export default function EffortReport({
  items,
  clients,
  projects,
  trackedUsers,
  from,
  to,
  clientId,
  projectId,
  userId,
  showTeam,
}: Props) {
  const rows = useMemo(
    () => effortRows(items, { from, to, clientId, projectId, userId }),
    [items, from, to, clientId, projectId, userId],
  )
  const total = roundToQuarter(rows.reduce((sum, row) => sum + row.entry.hours, 0))
  const clientName = (id?: string) =>
    id ? (clients.find(client => client.id === id)?.name ?? 'Unknown client') : 'General / no client'
  const projectName = (id?: string) =>
    id ? (projects.find(project => project.id === id)?.name ?? 'Unknown project') : 'No project'

  // Estimate vs actual uses each touched task's own estimate and own entries in range, so subtasks are not counted twice.
  const touched = useMemo(() => {
    const byTask = new Map<string, { item: WorkItem; hours: number }>()
    for (const row of rows) {
      const current = byTask.get(row.item.id) || { item: row.item, hours: 0 }
      current.hours += row.entry.hours
      byTask.set(row.item.id, current)
    }
    return [...byTask.values()]
  }, [rows])
  const estimated = touched.filter(row => typeof row.item.estimateHours === 'number' && row.item.estimateHours > 0)
  const estimatedHours = roundToQuarter(estimated.reduce((sum, row) => sum + (row.item.estimateHours || 0), 0))
  const estimatedLogged = roundToQuarter(estimated.reduce((sum, row) => sum + effortSummary(row.item).ownLogged, 0))
  const variance = estimatedHours ? Math.round(((estimatedLogged - estimatedHours) / estimatedHours) * 100) : undefined
  const unestimated = touched.filter(row => !(typeof row.item.estimateHours === 'number' && row.item.estimateHours > 0))

  const byClient = useMemo(() => {
    const totals = new Map<string, { label: string; within: number; over: number }>()
    for (const row of touched) {
      const key = row.item.clientId || '__none__'
      const current = totals.get(key) || { label: clientName(row.item.clientId), within: 0, over: 0 }
      const estimate = row.item.estimateHours || 0
      const allTime = effortSummary(row.item).ownLogged
      // Hours beyond the estimate (across all time) count as over; this period's share is split proportionally.
      const overShare =
        estimate && allTime > estimate ? Math.min(row.hours, ((allTime - estimate) / allTime) * row.hours) : 0
      current.within += row.hours - overShare
      current.over += overShare
      totals.set(key, current)
    }
    return [...totals.values()].sort((a, b) => b.within + b.over - (a.within + a.over))
  }, [touched, clients])
  const maxClient = Math.max(1, ...byClient.map(row => row.within + row.over))

  const capacity = capacityHoursBetween(from, to)
  const byUser = trackedUsers
    .filter(user => !userId || user.id === userId)
    .map(user => {
      const logged = roundToQuarter(
        rows.filter(row => row.entry.userId === user.id).reduce((sum, row) => sum + row.entry.hours, 0),
      )
      return { user, logged, utilization: capacity ? Math.round((logged / capacity) * 100) : 0 }
    })
    .sort((a, b) => b.logged - a.logged)

  const byCategory = EFFORT_CATEGORIES.map(category => ({
    category,
    hours: roundToQuarter(
      rows.filter(row => row.entry.category === category).reduce((sum, row) => sum + row.entry.hours, 0),
    ),
  })).filter(row => row.hours > 0)
  const maxCategory = Math.max(1, ...byCategory.map(row => row.hours))

  const overruns = estimated
    .map(row => ({ item: row.item, estimate: row.item.estimateHours || 0, logged: effortSummary(row.item).ownLogged }))
    .filter(row => row.logged > row.estimate)
    .sort((a, b) => b.logged / b.estimate - a.logged / a.estimate)
    .slice(0, 8)

  const exportCsv = () => {
    const lines = [
      ['Date', 'User', 'Hours', 'Category', 'Task', 'Subtask of', 'Client', 'Project', 'Task estimate (h)', 'Note'],
      ...rows.map(({ item, entry }) => [
        entry.date,
        entry.userName,
        entry.hours,
        entry.category,
        item.title,
        item.parentTaskId ? (items.find(candidate => candidate.id === item.parentTaskId)?.title ?? '') : '',
        clientName(item.clientId),
        projectName(item.projectId),
        item.estimateHours ?? '',
        entry.note,
      ]),
    ]
    const blob = new Blob([lines.map(line => line.map(csvCell).join(',')).join('\n')], {
      type: 'text/csv;charset=utf-8',
    })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `ba-effort-${from}-to-${to}.csv`
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="panel report-panel effort-report">
      <div className="panel-heading">
        <div>
          <h2>Effort</h2>
          <p>Time logged on tasks and subtasks in this range. The user filter shows time that person logged.</p>
        </div>
        <button className="secondary" type="button" onClick={exportCsv} disabled={!rows.length}>
          <Download size={16} /> Export time entries
        </button>
      </div>
      <div className="subtask-report-summary">
        <div>
          <strong>{formatHours(total)}</strong>
          <span>
            Hours logged · {rows.length} {rows.length === 1 ? 'entry' : 'entries'}
          </span>
        </div>
        <div>
          <strong>{estimatedHours ? formatHours(estimatedHours) : '—'}</strong>
          <span>Estimated, {estimated.length} tasks with time</span>
        </div>
        <div>
          <strong>{variance === undefined ? '—' : `${variance > 0 ? '+' : ''}${variance}%`}</strong>
          <span>Logged vs estimate, all time</span>
        </div>
        <div>
          <strong>{unestimated.length}</strong>
          <span>Tasks with time but no estimate</span>
        </div>
      </div>
      {!rows.length ? (
        <div className="report-empty">
          <Clock3 size={16} /> No time logged in this range. Log time from the Effort section of a task.
        </div>
      ) : (
        <>
          <div className="report-grid-two">
            <div>
              <h3>By client</h3>
              <div className="report-bars">
                {byClient.map(row => (
                  <div className="report-bar-row" key={row.label}>
                    <div className="report-bar-label">
                      <span>{row.label}</span>
                      <strong>{formatHours(row.within + row.over)}</strong>
                    </div>
                    <div
                      className="effort-split-track"
                      style={{ width: `${((row.within + row.over) / maxClient) * 100}%` }}
                    >
                      <div style={{ flex: row.within }} />
                      <div style={{ flex: row.over }} />
                    </div>
                  </div>
                ))}
              </div>
              <div className="effort-legend">
                <span>
                  <i /> Within estimate or not estimated
                </span>
                <span>
                  <i className="over" /> Over estimate
                </span>
              </div>
            </div>
            <div>
              <h3>Where the time goes</h3>
              <div className="report-bars">
                {byCategory.map(row => (
                  <div className="report-bar-row" key={row.category}>
                    <div className="report-bar-label">
                      <span>{row.category}</span>
                      <strong>
                        {formatHours(row.hours)} · {Math.round((row.hours / total) * 100)}%
                      </strong>
                    </div>
                    <div className="report-bar-track">
                      <div className="report-bar-fill" style={{ width: `${(row.hours / maxCategory) * 100}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className="report-grid-two">
            {showTeam && (
              <div>
                <h3>By user</h3>
                <div className="table-scroll">
                  <table className="report-table">
                    <thead>
                      <tr>
                        <th>User</th>
                        <th>Logged</th>
                        <th>Capacity</th>
                        <th>Utilization</th>
                      </tr>
                    </thead>
                    <tbody>
                      {byUser.map(row => (
                        <tr key={row.user.id}>
                          <td>
                            <strong>{row.user.name}</strong>
                          </td>
                          <td>{formatHours(row.logged)}</td>
                          <td>
                            {formatHours(capacity)}
                            <small>{DEFAULT_WEEKLY_CAPACITY_HOURS}h / week</small>
                          </td>
                          <td>
                            <div className={`effort-util${row.utilization > 100 ? ' high' : ''}`}>
                              <div className="effort-progress-track">
                                <div
                                  className="effort-progress-within"
                                  style={{ width: `${Math.min(100, row.utilization)}%` }}
                                />
                              </div>
                              {row.utilization}%
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            <div>
              <h3>Biggest overruns</h3>
              {overruns.length ? (
                <div className="table-scroll">
                  <table className="report-table">
                    <thead>
                      <tr>
                        <th>Task</th>
                        <th>Estimate</th>
                        <th>Logged</th>
                        <th>Over</th>
                      </tr>
                    </thead>
                    <tbody>
                      {overruns.map(row => (
                        <tr key={row.item.id}>
                          <td>
                            <strong>{row.item.title}</strong>
                            <small>
                              {clientName(row.item.clientId)} · {projectName(row.item.projectId)}
                            </small>
                          </td>
                          <td>{formatHours(row.estimate)}</td>
                          <td>{formatHours(row.logged)}</td>
                          <td>
                            <span className="effort-over-chip">
                              +{Math.round(((row.logged - row.estimate) / row.estimate) * 100)}%
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="report-empty">No task with time in this range has gone over its estimate.</div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
