import { useMemo, useState, type DragEvent } from 'react'
import { MessageSquareText, ListTree } from 'lucide-react'
import { effortSummary, formatHours } from './effort'
import { boardColumns, type BoardGroup } from './taskBoardModel'
import { isWaitingOnDone, openWaitingOnOptions, waitingOnTone } from './waitingOn'
import type { Client, Project, TaskSettings, UserAccount, WaitingOn, WorkItem } from '../../shared/types'
import './effort.css'
import { PriorityChip } from '../../shared/ui/Chips'
import { isTaskClosed } from '../../app/store'
import { BlockedBadge, RepeatBadge } from './BlockedBadge'
import { dateFormat } from '../../shared/intlFormat'

type Props = {
  items: WorkItem[]
  allItems: WorkItem[]
  clients: Client[]
  projects: Project[]
  accounts: UserAccount[]
  taskSettings: TaskSettings
  group: BoardGroup
  showSubtasks: boolean
  today: string
  canEdit: boolean
  onStatusChange: (id: string, status: string) => void
  onWaitingChange: (id: string, waitingOn: WaitingOn) => void
  /** Opens the task editor. Omitted when the person cannot edit tasks. */
  onOpen?: (id: string) => void
}

function shortDate(date: string) {
  const [year, month, day] = date.split('-').map(Number)
  return dateFormat('en', { month: 'short', day: 'numeric' }).format(new Date(year, month - 1, day))
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  return (
    parts.length > 1 ? `${parts[0][0]}${parts[parts.length - 1][0]}` : (parts[0] || '?').slice(0, 2)
  ).toUpperCase()
}

export default function TaskBoard({
  items,
  allItems,
  clients,
  projects,
  accounts,
  taskSettings,
  group,
  showSubtasks,
  today,
  canEdit,
  onStatusChange,
  onWaitingChange,
  onOpen,
}: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [dropKey, setDropKey] = useState<string | null>(null)
  const visible = useMemo(
    () => (showSubtasks ? items : items.filter(item => !item.parentTaskId)),
    [items, showSubtasks],
  )
  const columns = useMemo(() => boardColumns(visible, group, taskSettings), [visible, group, taskSettings])
  const clientName = (id?: string) =>
    id ? (clients.find(client => client.id === id)?.name ?? 'Unknown client') : 'General / no client'
  const projectName = (id?: string) =>
    id ? (projects.find(project => project.id === id)?.name ?? 'Unknown project') : 'No project'
  const assigneeName = (item: WorkItem) =>
    accounts.find(account => account.id === item.assignedToUserId)?.name || item.owner || ''

  const moveTo = (item: WorkItem, key: string) => {
    if (group === 'status') {
      if (item.status !== key) onStatusChange(item.id, key)
    } else if (item.waitingOn !== key) onWaitingChange(item.id, key as WaitingOn)
  }
  const dropOn = (event: DragEvent, key: string, accepts: boolean) => {
    event.preventDefault()
    setDropKey(null)
    const id = event.dataTransfer?.getData('text/plain') || draggedId
    setDraggedId(null)
    const item = id ? visible.find(candidate => candidate.id === id) : undefined
    if (item && accepts) moveTo(item, key)
  }

  if (!visible.length)
    return (
      <div className="task-board">
        <div className="board-empty">No tasks match this view.</div>
      </div>
    )

  return (
    <div className="task-board" aria-label={`Task board grouped by ${group === 'status' ? 'status' : 'waiting on'}`}>
      <div className="task-board-columns">
        {columns.map(column => {
          const open = !column.collapsed || expanded.has(column.key)
          const hours = column.items.reduce(
            (total, item) =>
              total + (showSubtasks ? effortSummary(item).ownLogged : effortSummary(item, allItems).logged),
            0,
          )
          const accepts = canEdit && column.acceptsDrops
          return (
            <section
              key={column.key}
              className={`board-column${dropKey === column.key ? ' drop-target' : ''}`}
              aria-label={`${column.label}, ${column.items.length} tasks`}
              onDragOver={event => {
                if (!accepts || !draggedId) return
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
                setDropKey(column.key)
              }}
              onDragLeave={event => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                  setDropKey(current => (current === column.key ? null : current))
              }}
              onDrop={event => dropOn(event, column.key, accepts)}
            >
              <div className="board-column-head">
                <span className={`board-dot tone-${column.tone}`} aria-hidden="true" />
                <h3>{column.label}</h3>
                <span className="count-pill">{column.items.length}</span>
                {hours > 0 && <small>{formatHours(hours)} logged</small>}
              </div>
              {open &&
                column.items.map(item => {
                  const closed = column.tone === 'closed'
                  const effort = effortSummary(item, showSubtasks ? [] : allItems)
                  const children = allItems.filter(candidate => candidate.parentTaskId === item.id)
                  const doneChildren = children.filter(
                    child =>
                      isWaitingOnDone(child.waitingOn, taskSettings) ||
                      taskSettings.statuses.find(status => status.label === child.status)?.closed,
                  ).length
                  const dueKind =
                    !closed && item.dueDate
                      ? item.dueDate < today
                        ? 'overdue'
                        : item.dueDate === today
                          ? 'today'
                          : ''
                      : ''
                  const dueLabel = item.dueDate
                    ? dueKind === 'overdue'
                      ? `Overdue · ${shortDate(item.dueDate)}`
                      : dueKind === 'today'
                        ? 'Due today'
                        : `Due ${shortDate(item.dueDate)}`
                    : item.followUpDate
                      ? `Follow-up ${shortDate(item.followUpDate)}`
                      : ''
                  const assignee = assigneeName(item)
                  const parent = item.parentTaskId
                    ? allItems.find(candidate => candidate.id === item.parentTaskId)
                    : undefined
                  const within = effort.estimate ? Math.min(effort.logged, effort.estimate) : 0
                  const scale = Math.max(effort.logged, effort.estimate || 0) || 1
                  const draggable = canEdit && column.acceptsDrops
                  return (
                    <article
                      key={item.id}
                      className={`board-card${draggedId === item.id ? ' dragging' : ''}`}
                      draggable={draggable}
                      onDragStart={event => {
                        event.dataTransfer.setData('text/plain', item.id)
                        event.dataTransfer.effectAllowed = 'move'
                        setDraggedId(item.id)
                      }}
                      onDragEnd={() => {
                        setDraggedId(null)
                        setDropKey(null)
                      }}
                      onClick={onOpen ? () => onOpen(item.id) : undefined}
                    >
                      <div className="board-card-chips">
                        <PriorityChip value={item.priority} />
                        {group === 'status' ? (
                          <span className={`chip waiting-${waitingOnTone(item.waitingOn, taskSettings)}`}>
                            Waiting: {item.waitingOn}
                          </span>
                        ) : (
                          <span className="chip neutral">{item.status}</span>
                        )}
                        {dueLabel && (
                          <span className={`board-card-due${dueKind ? ` ${dueKind}` : ''}`}>{dueLabel}</span>
                        )}
                      </div>
                      <div>
                        <h4>
                          {onOpen ? (
                            <button
                              type="button"
                              className="board-card-title"
                              onClick={event => {
                                event.stopPropagation()
                                onOpen(item.id)
                              }}
                            >
                              {item.title}
                            </button>
                          ) : (
                            item.title
                          )}
                        </h4>
                        <p className="board-card-where">
                          {parent ? `Subtask of ${parent.title} · ` : ''}
                          {clientName(item.clientId)} · {projectName(item.projectId)}
                        </p>
                        {!isTaskClosed(item.status, taskSettings) && (
                          <BlockedBadge item={item} items={allItems} taskSettings={taskSettings} />
                        )}
                        <RepeatBadge item={item} />
                      </div>
                      <div className={`board-card-effort${effort.overBy > 0 ? ' over' : ''}`}>
                        <div className="effort-progress-track" aria-hidden="true">
                          {effort.estimate ? (
                            <>
                              <div className="effort-progress-within" style={{ width: `${(within / scale) * 100}%` }} />
                              {effort.overBy > 0 && (
                                <div
                                  className="effort-progress-over"
                                  style={{ width: `${(effort.overBy / scale) * 100}%` }}
                                />
                              )}
                            </>
                          ) : null}
                        </div>
                        <span>
                          {effort.estimate
                            ? `${formatHours(effort.logged)} / ${formatHours(effort.estimate)}`
                            : effort.logged
                              ? `${formatHours(effort.logged)} · no estimate`
                              : 'No estimate'}
                        </span>
                      </div>
                      <div className="board-card-foot">
                        {children.length > 0 && (
                          <span title="Subtasks done">
                            <ListTree size={12} aria-hidden="true" /> {doneChildren}/{children.length}
                          </span>
                        )}
                        {(item.comments?.length || 0) > 0 && (
                          <span title="Comments">
                            <MessageSquareText size={12} aria-hidden="true" /> {item.comments!.length}
                          </span>
                        )}
                        {draggable && (
                          <label className="board-move" onClick={event => event.stopPropagation()}>
                            <span className="visually-hidden">Move {item.title} to</span>
                            <select
                              value={group === 'status' ? item.status : item.waitingOn}
                              onChange={event => moveTo(item, event.target.value)}
                            >
                              {(group === 'status'
                                ? taskSettings.statuses.map(status => status.label)
                                : openWaitingOnOptions(taskSettings).map(option => option.label)
                              ).map(option => (
                                <option key={option} value={option}>
                                  {option}
                                </option>
                              ))}
                            </select>
                          </label>
                        )}
                        <span
                          className="board-avatar"
                          title={assignee || 'Unassigned'}
                          aria-label={`Assigned to ${assignee || 'nobody'}`}
                        >
                          {assignee ? initials(assignee) : '–'}
                        </span>
                      </div>
                    </article>
                  )
                })}
              {column.collapsed && column.items.length > 0 && (
                <button
                  type="button"
                  className="board-collapsed"
                  aria-expanded={open}
                  onClick={() =>
                    setExpanded(current => {
                      const next = new Set(current)
                      if (next.has(column.key)) next.delete(column.key)
                      else next.add(column.key)
                      return next
                    })
                  }
                >
                  {open ? 'Hide' : 'Show'} {column.items.length} {column.items.length === 1 ? 'task' : 'tasks'}
                </button>
              )}
              {!column.items.length && (
                <div className="board-empty">{accepts ? 'Drop a task here' : 'Nothing here'}</div>
              )}
            </section>
          )
        })}
      </div>
    </div>
  )
}
