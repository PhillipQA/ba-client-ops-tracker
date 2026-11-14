/**
 * The minimized task windows, at the bottom left of every page (the email drafts have their own dock at the bottom
 * right). Clicking one opens the task again; × takes it off the dock.
 */
import { useRef, useState } from 'react'
import { SquarePen, X } from 'lucide-react'
import type { WorkItem } from '../../shared/types'
import { cleanDocked, dockTask, undockTask } from './taskDock'
import './taskDock.css'

/** The person's minimized tasks, kept in this browser under `key`. */
export function useTaskDock(key: string) {
  const read = () => {
    try {
      return cleanDocked(JSON.parse(window.localStorage.getItem(key) || '[]'))
    } catch {
      return []
    }
  }
  const [, setDocked] = useState<string[]>(read)
  const latest = useRef<string[]>([])
  const started = useRef(false)
  if (!started.current) {
    started.current = true
    latest.current = read()
  }
  const shownKey = useRef(key)
  if (shownKey.current !== key) {
    shownKey.current = key
    latest.current = read()
  }
  const keep = (next: string[]) => {
    latest.current = next
    setDocked(next)
    try {
      window.localStorage.setItem(key, JSON.stringify(next))
    } catch {
      /* The dock then lasts until the page reloads. */
    }
  }
  return {
    docked: latest.current,
    /** Puts a task on the dock; says why not when the dock is full. */
    add: (id: string) => {
      const result = dockTask(latest.current, id)
      if (!result.problem) keep(result.docked)
      return result.problem || ''
    },
    remove: (id: string) => keep(undockTask(latest.current, id)),
  }
}

export default function TaskDock({
  docked,
  items,
  onOpen,
  onRemove,
}: {
  docked: string[]
  items: WorkItem[]
  onOpen: (taskId: string) => void
  onRemove: (taskId: string) => void
}) {
  const tasks = docked.map(id => items.find(item => item.id === id)).filter((item): item is WorkItem => Boolean(item))
  if (!tasks.length) return null
  return (
    <div className="task-dock" role="region" aria-label="Minimized tasks">
      {tasks.map(item => (
        <div className="task-dock-tab" key={item.id}>
          <button
            type="button"
            className="task-dock-open"
            onClick={() => onOpen(item.id)}
            title={`Open: ${item.title}`}
          >
            <SquarePen size={13} aria-hidden="true" />
            <span>Task: {item.title || 'Untitled task'}</span>
          </button>
          <button
            type="button"
            className="task-dock-close"
            onClick={() => onRemove(item.id)}
            aria-label={`Take “${item.title}” off the dock`}
            title="Take it off the dock"
          >
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  )
}
