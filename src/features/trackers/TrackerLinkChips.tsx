import { Table2 } from 'lucide-react'
import type { TaskLink } from './trackerApi'

/** Where a task came from: the tracker, the row and, when it is linked to one, the cell. Opens that row. */
export default function TrackerLinkChips({
  links,
  taskId,
  onOpen,
}: {
  links: readonly TaskLink[]
  taskId: string
  onOpen?: (link: TaskLink) => void
}) {
  const mine = links.filter(link => link.taskId === taskId)
  if (!mine.length) return null
  return (
    <div className="tracker-link-chips" aria-label="Linked from a tracker">
      {mine.map(link => {
        const label = [link.trackerName, link.rowTitle, link.columnName].filter(Boolean).join(' › ')
        return onOpen ? (
          <button
            type="button"
            key={link.id}
            className="tracker-link-chip"
            title={`Open ${label}`}
            onClick={() => onOpen(link)}
          >
            <Table2 size={12} aria-hidden="true" />
            <span>{label}</span>
          </button>
        ) : (
          <span key={link.id} className="tracker-link-chip static" title={label}>
            <Table2 size={12} aria-hidden="true" />
            <span>{label}</span>
          </span>
        )
      })}
    </div>
  )
}
