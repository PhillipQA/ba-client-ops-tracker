/** "Blocked by …" on an open task whose blockers are not all closed (table rows and board cards). */
import { Lock } from 'lucide-react'
import './taskViews.css'
import type { TaskSettings, WorkItem } from '../../shared/types'
import { blockedText, openBlockersOf } from './dependencies'

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
