/**
 * Table-row and board-card badges: "Blocked by …" on an open task whose blockers are not all closed, and the repeat
 * rule of a repeating task.
 */
import { Lock, Repeat } from 'lucide-react'
import './taskViews.css'
import type { TaskSettings, WorkItem } from '../../shared/types'
import { blockedText, openBlockersOf } from './dependencies'
import { cleanRecurrence, recurrenceText } from './recurrence'

export function BlockedBadge({
  item,
  items,
  taskSettings,
}: {
  item: WorkItem
  items: WorkItem[]
  taskSettings: TaskSettings
}) {
  if (!item.blockedBy?.length) return null
  const open = openBlockersOf(item, items, taskSettings)
  if (!open.length) return null
  return (
    <span className="blocked-badge" title={open.map(blocker => `${blocker.title} (${blocker.status})`).join('\n')}>
      <Lock size={11} aria-hidden="true" /> {blockedText(open)}
    </span>
  )
}

export function RepeatBadge({ item }: { item: WorkItem }) {
  const rule = item.parentTaskId ? undefined : cleanRecurrence(item.recurrence)
  if (!rule) return null
  return (
    <span className="repeat-badge" title={`${recurrenceText(rule)}. Closing it makes the next one.`}>
      <Repeat size={11} aria-hidden="true" /> Repeats
    </span>
  )
}
