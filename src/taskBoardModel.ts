import type { TaskSettings, WaitingOn, WorkItem } from './types'

export type BoardGroup = 'status' | 'waiting'
export type TaskLayout = 'table' | 'board'

export const WAITING_ON_OPTIONS: WaitingOn[] = ['Me', 'Developer', 'Client', 'QA', 'Design', 'Done']

export interface BoardColumn {
  key: string
  label: string
  tone: string
  /** Closed work starts collapsed so the board stays short. */
  collapsed: boolean
  /** Whether cards can be dropped here. Moving work into "Done" happens through completion, not the board. */
  acceptsDrops: boolean
  items: WorkItem[]
}

const PRIORITY_RANK: Record<string, number> = { Urgent: 0, High: 1, Medium: 2, Low: 3 }

/** Most urgent first, then the earliest due or follow-up date, then title. */
export function boardCardOrder(a: WorkItem, b: WorkItem) {
  const priority = (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9)
  if (priority) return priority
  const dateA = a.dueDate || a.followUpDate || '9999-12-31'
  const dateB = b.dueDate || b.followUpDate || '9999-12-31'
  return dateA.localeCompare(dateB) || a.title.localeCompare(b.title)
}

function statusTone(label: string, closed: boolean) {
  if (closed) return 'closed'
  const lower = label.toLowerCase()
  if (lower.includes('block')) return 'blocked'
  if (lower.includes('progress') || lower.includes('review')) return 'progress'
  return 'open'
}

export function boardColumns(items: readonly WorkItem[], group: BoardGroup, settings: TaskSettings): BoardColumn[] {
  if (group === 'waiting') {
    return WAITING_ON_OPTIONS.map((waitingOn) => ({
      key: waitingOn,
      label: waitingOn,
      tone: waitingOn === 'Done' ? 'closed' : waitingOn.toLowerCase(),
      collapsed: waitingOn === 'Done',
      acceptsDrops: waitingOn !== 'Done',
      items: items.filter((item) => item.waitingOn === waitingOn).sort(boardCardOrder),
    })).filter((column) => column.key !== 'Design' || column.items.length > 0)
  }
  const known = new Set(settings.statuses.map((status) => status.label))
  const columns: BoardColumn[] = settings.statuses.map((status) => ({
    key: status.label,
    label: status.label,
    tone: statusTone(status.label, status.closed),
    collapsed: status.closed,
    acceptsDrops: true,
    items: items.filter((item) => item.status === status.label).sort(boardCardOrder),
  }))
  const unknown = items.filter((item) => !known.has(item.status))
  if (unknown.length) columns.push({ key: '__other__', label: 'Other status', tone: 'open', collapsed: false, acceptsDrops: false, items: [...unknown].sort(boardCardOrder) })
  return columns
}
