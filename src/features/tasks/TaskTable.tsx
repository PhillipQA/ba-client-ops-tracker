import { isTaskClosed } from '../../app/store'
import { businessDateKey } from '../../shared/businessDate'
import { docHubLabels } from '../documents/dochub'
import { archivedWorkReason } from './lifecycle'
import { niceDate } from '../../shared/dates'
import { Empty, PriorityChip, StatusChip, TypeChip, WaitingChip } from '../../shared/ui/Chips'
import { taskEvidenceUrl } from './taskEvidence'
import type {
  Client,
  Project,
  TaskColumnKey,
  TaskSettings,
  WaitingOn,
  WorkItem,
} from '../../shared/types'
import { isWaitingOnDone } from './waitingOn'
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  GripVertical,
  Paperclip,
  Pencil,
  Plus,
  Search,
  Trash2,
} from 'lucide-react'
import { useState } from 'react'

export function FilterBar({
  query,
  setQuery,
  waiting,
  setWaiting,
  options,
}: {
  query: string
  setQuery: (v: string) => void
  waiting: 'All' | WaitingOn
  setWaiting: (v: 'All' | WaitingOn) => void
  options: string[]
}) {
  return (
    <div className="filters">
      <label className="search-box">
        <Search size={17} />
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search title, client, project..." />
      </label>
      <select
        aria-label="Filter by waiting on"
        value={waiting}
        onChange={e => setWaiting(e.target.value as 'All' | WaitingOn)}
      >
        <option>All</option>
        {(waiting === 'All' || options.includes(waiting) ? options : [...options, waiting]).map(option => (
          <option key={option}>{option}</option>
        ))}
      </select>
    </div>
  )
}

export function TaskTable({
  items,
  allItems,
  clients,
  projects,
  taskSettings,
  onResolve,
  onStatusChange,
  onEdit,
  onDelete,
  onCreateSubtask,
  onReorderSubtasks,
  canEdit = true,
  hiddenColumns = [],
}: {
  items: WorkItem[]
  allItems?: WorkItem[]
  clients: Client[]
  projects: Project[]
  taskSettings: TaskSettings
  onResolve: (id: string) => void
  onStatusChange: (id: string, status: string) => void
  onEdit: (id: string) => void
  onDelete: (id: string) => void
  onCreateSubtask: (id: string) => void
  onReorderSubtasks: (parentTaskId: string, orderedIds: string[]) => void
  canEdit?: boolean
  hiddenColumns?: TaskColumnKey[]
}) {
  const sourceItems = allItems || items
  const visibleIds = new Set(items.map(item => item.id))
  const [draggedSubtaskId, setDraggedSubtaskId] = useState<string | null>(null)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)
  const [collapsedParents, setCollapsedParents] = useState<Set<string>>(() => new Set())
  const clientName = (id?: string) =>
    id ? (clients.find(client => client.id === id)?.name ?? 'Unknown client') : 'General / no client'
  const projectName = (id?: string) =>
    id ? (projects.find(project => project.id === id)?.name ?? 'Unknown project') : 'No project'
  const labels: Record<TaskColumnKey, string> = {
    status: 'Status',
    client: 'Client',
    project: 'Project',
    type: 'Type',
    waitingOn: 'Waiting on',
    priority: 'Priority',
    owner: 'Assigned to',
    startDate: 'Start date',
    dueDate: 'Due date',
    followUpDate: 'Follow-up',
  }
  const columns = taskSettings.visibleColumns.filter(column => !hiddenColumns.includes(column))
  // Start Date is a core scheduling field in v0.6.22. Keep it visible even when
  // an older saved column preference does not contain the newly introduced key.
  if (!hiddenColumns.includes('startDate') && !columns.includes('startDate')) {
    const dueDateIndex = columns.indexOf('dueDate')
    columns.splice(dueDateIndex >= 0 ? dueDateIndex : columns.length, 0, 'startDate')
  }
  if (!items.length) return <Empty text="No tasks match this view." />

  const sortedChildren = (parentTaskId: string) =>
    sourceItems
      .filter(candidate => candidate.parentTaskId === parentTaskId)
      .sort(
        (a, b) =>
          (a.subtaskOrder ?? Number.MAX_SAFE_INTEGER) - (b.subtaskOrder ?? Number.MAX_SAFE_INTEGER) ||
          a.dateRaised.localeCompare(b.dateRaised) ||
          a.title.localeCompare(b.title),
      )

  const parentIdsWithChildren = items
    .filter(item => !item.parentTaskId && sortedChildren(item.id).length > 0)
    .map(item => item.id)
  const allVisibleParentsCollapsed =
    parentIdsWithChildren.length > 0 && parentIdsWithChildren.every(id => collapsedParents.has(id))
  const toggleParent = (id: string) =>
    setCollapsedParents(current => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const toggleAllParents = () =>
    setCollapsedParents(current => {
      const next = new Set(current)
      if (allVisibleParentsCollapsed) parentIdsWithChildren.forEach(id => next.delete(id))
      else parentIdsWithChildren.forEach(id => next.add(id))
      return next
    })

  const moveSubtask = (item: WorkItem, direction: -1 | 1) => {
    if (!item.parentTaskId) return
    const siblings = sortedChildren(item.parentTaskId)
    const currentIndex = siblings.findIndex(candidate => candidate.id === item.id)
    const nextIndex = currentIndex + direction
    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= siblings.length) return
    const next = [...siblings]
    const [moved] = next.splice(currentIndex, 1)
    next.splice(nextIndex, 0, moved)
    onReorderSubtasks(
      item.parentTaskId,
      next.map(candidate => candidate.id),
    )
  }

  const dropSubtask = (target: WorkItem) => {
    if (!draggedSubtaskId || !target.parentTaskId || draggedSubtaskId === target.id) {
      setDraggedSubtaskId(null)
      setDropTargetId(null)
      return
    }
    const dragged = sourceItems.find(candidate => candidate.id === draggedSubtaskId)
    if (!dragged?.parentTaskId || dragged.parentTaskId !== target.parentTaskId) {
      setDraggedSubtaskId(null)
      setDropTargetId(null)
      return
    }
    const siblings = sortedChildren(target.parentTaskId)
    const from = siblings.findIndex(candidate => candidate.id === dragged.id)
    const to = siblings.findIndex(candidate => candidate.id === target.id)
    if (from >= 0 && to >= 0 && from !== to) {
      const next = [...siblings]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      onReorderSubtasks(
        target.parentTaskId,
        next.map(candidate => candidate.id),
      )
    }
    setDraggedSubtaskId(null)
    setDropTargetId(null)
  }

  const renderRow = (item: WorkItem, isSubtask = false) => {
    const rowEditable = canEdit && !archivedWorkReason({ clients, projects, items: sourceItems, taskSettings }, item)
    const closed = isTaskClosed(item.status, taskSettings)
    const overdue =
      !closed &&
      Boolean(
        (item.dueDate && item.dueDate < businessDateKey()) ||
          (item.followUpDate && item.followUpDate < businessDateKey()),
      )
    const children = sortedChildren(item.id)
    const completedChildren = children.filter(
      child => isTaskClosed(child.status, taskSettings) || isWaitingOnDone(child.waitingOn, taskSettings),
    ).length
    const siblings = isSubtask && item.parentTaskId ? sortedChildren(item.parentTaskId) : []
    const siblingIndex = siblings.findIndex(candidate => candidate.id === item.id)
    const rowClass =
      `${overdue ? 'overdue-row ' : ''}${isSubtask ? 'subtask-row ' : ''}${draggedSubtaskId === item.id ? 'subtask-dragging ' : ''}${dropTargetId === item.id ? 'subtask-drop-target' : ''}`.trim()
    return (
      <tr
        key={item.id}
        className={rowClass}
        draggable={Boolean(rowEditable && isSubtask)}
        onDragStart={
          isSubtask
            ? event => {
                setDraggedSubtaskId(item.id)
                event.dataTransfer.effectAllowed = 'move'
                event.dataTransfer.setData('text/plain', item.id)
              }
            : undefined
        }
        onDragOver={
          isSubtask
            ? event => {
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
                setDropTargetId(item.id)
              }
            : undefined
        }
        onDragLeave={
          isSubtask
            ? () => {
                if (dropTargetId === item.id) setDropTargetId(null)
              }
            : undefined
        }
        onDrop={
          isSubtask
            ? event => {
                event.preventDefault()
                dropSubtask(item)
              }
            : undefined
        }
        onDragEnd={
          isSubtask
            ? () => {
                setDraggedSubtaskId(null)
                setDropTargetId(null)
              }
            : undefined
        }
      >
        <td>
          <div className={isSubtask ? 'subtask-title' : 'task-title-with-toggle'}>
            {isSubtask && (
              <>
                <span className="subtask-branch">↳</span>
                {rowEditable && (
                  <span className="subtask-drag-handle" title="Drag to reorder">
                    <GripVertical size={15} />
                  </span>
                )}
              </>
            )}
            {!isSubtask && children.length > 0 && (
              <button
                className="subtask-collapse-button"
                type="button"
                title={collapsedParents.has(item.id) ? 'Expand subtasks' : 'Collapse subtasks'}
                aria-label={collapsedParents.has(item.id) ? 'Expand subtasks' : 'Collapse subtasks'}
                onClick={() => toggleParent(item.id)}
              >
                {collapsedParents.has(item.id) ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
              </button>
            )}
            <div>
              <strong>{item.title}</strong>
              {item.docHubDocuments?.map(d => (
                <span className="dochub-task-badge" key={d.id}>
                  DocHub · {docHubLabels[d.status] || d.status} · {d.signed}/{d.total}
                </span>
              ))}
              <small>
                {item.description || (isSubtask ? 'Subtask' : 'No description')}
                {isSubtask && item.evidence?.length
                  ? ` · ${item.evidence.length} evidence file${item.evidence.length === 1 ? '' : 's'}`
                  : ''}
                {isSubtask && item.comments?.length
                  ? ` · ${item.comments.length} system update${item.comments.length === 1 ? '' : 's'}`
                  : ''}
                {!isSubtask && children.length
                  ? ` · ${completedChildren}/${children.length} subtasks completed${collapsedParents.has(item.id) ? ' · collapsed' : ''}`
                  : ''}
              </small>
              {isSubtask && (
                <span className="subtask-schedule-summary">
                  Start: {item.startDate ? niceDate(item.startDate) : 'Not set'} · Due:{' '}
                  {item.dueDate ? niceDate(item.dueDate) : 'Not set'}
                </span>
              )}
            </div>
          </div>
        </td>
        {columns.map(column => (
          <td key={column}>
            {column === 'status' ? (
              rowEditable ? (
                <select
                  className="task-status-select"
                  value={item.status}
                  onChange={event => onStatusChange(item.id, event.target.value)}
                >
                  {taskSettings.statuses.map(status => (
                    <option key={status.id} value={status.label}>
                      {status.label}
                    </option>
                  ))}
                </select>
              ) : (
                <StatusChip value={item.status} />
              )
            ) : column === 'client' ? (
              clientName(item.clientId)
            ) : column === 'project' ? (
              projectName(item.projectId)
            ) : column === 'type' ? (
              <TypeChip value={item.type} />
            ) : column === 'waitingOn' ? (
              <WaitingChip value={item.waitingOn} settings={taskSettings} />
            ) : column === 'priority' ? (
              <PriorityChip value={item.priority} />
            ) : column === 'owner' ? (
              item.owner || 'Unassigned'
            ) : column === 'startDate' ? (
              niceDate(item.startDate || '')
            ) : column === 'dueDate' ? (
              <span className={item.dueDate && item.dueDate < businessDateKey() && !closed ? 'overdue-date' : ''}>
                {niceDate(item.dueDate || '')}
              </span>
            ) : (
              <span
                className={item.followUpDate && item.followUpDate < businessDateKey() && !closed ? 'overdue-date' : ''}
              >
                {niceDate(item.followUpDate)}
              </span>
            )}
          </td>
        ))}
        <td>
          <div className="task-row-actions">
            {!rowEditable &&
              (item.evidence || []).map(entry => (
                <a
                  key={entry.id}
                  className="secondary compact"
                  href={taskEvidenceUrl(item.id, entry)}
                  target="_blank"
                  rel="noreferrer"
                >
                  {entry.fileName}
                </a>
              ))}
            {rowEditable && isSubtask && (
              <>
                <button
                  className="icon-button"
                  title="Move subtask up"
                  disabled={siblingIndex <= 0}
                  onClick={() => moveSubtask(item, -1)}
                >
                  <ChevronUp size={16} />
                </button>
                <button
                  className="icon-button"
                  title="Move subtask down"
                  disabled={siblingIndex < 0 || siblingIndex >= siblings.length - 1}
                  onClick={() => moveSubtask(item, 1)}
                >
                  <ChevronDown size={16} />
                </button>
              </>
            )}
            {rowEditable && !isSubtask && !item.parentTaskId && (
              <button className="icon-button" title="Create subtask" onClick={() => onCreateSubtask(item.id)}>
                <Plus size={17} />
              </button>
            )}
            {rowEditable && isSubtask && (
              <button
                className="icon-button"
                title={item.evidence?.length ? `Evidence (${item.evidence.length})` : 'Add evidence'}
                onClick={() => onEdit(item.id)}
              >
                <Paperclip size={17} />
              </button>
            )}
            {rowEditable && (
              <button
                className="icon-button"
                title={isSubtask ? 'Edit subtask' : 'Edit task'}
                onClick={() => onEdit(item.id)}
              >
                <Pencil size={17} />
              </button>
            )}
            {rowEditable && !closed && (
              <button
                className="icon-button"
                title={isSubtask ? 'Mark subtask completed' : 'Mark task completed'}
                onClick={() => onResolve(item.id)}
              >
                <CheckCircle2 size={18} />
              </button>
            )}
            {rowEditable && (
              <button
                className="icon-button danger-button"
                title={isSubtask ? 'Delete subtask' : 'Delete task'}
                onClick={() => onDelete(item.id)}
              >
                <Trash2 size={17} />
              </button>
            )}
          </div>
        </td>
      </tr>
    )
  }

  const topLevel = items.filter(item => !item.parentTaskId || !visibleIds.has(item.parentTaskId))
  const rows = topLevel.flatMap(item => [
    renderRow(item, Boolean(item.parentTaskId)),
    ...(collapsedParents.has(item.id)
      ? []
      : sortedChildren(item.id)
          .filter(child => visibleIds.has(child.id) || visibleIds.has(item.id))
          .map(child => renderRow(child, true))),
  ])
  return (
    <div className="task-table-wrap">
      {parentIdsWithChildren.length > 0 && (
        <div className="task-table-tools">
          <button className="secondary compact" type="button" onClick={toggleAllParents}>
            {allVisibleParentsCollapsed ? 'Expand all subtasks' : 'Collapse all subtasks'}
          </button>
        </div>
      )}
      <div className="table-scroll">
        <table className="item-table task-table">
          <thead>
            <tr>
              <th>Task / Subtask</th>
              {columns.map(column => (
                <th key={column}>{labels[column]}</th>
              ))}
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>{rows}</tbody>
        </table>
      </div>
    </div>
  )
}
