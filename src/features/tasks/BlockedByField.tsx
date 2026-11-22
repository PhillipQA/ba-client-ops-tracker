/**
 * The task editor's Dependencies: the tasks that block this one (add by typing a name, remove with ×) and, read
 * only, the tasks this one blocks. Tasks that would make a loop are not offered. Saving the task saves the list.
 */
import { Lock, X } from 'lucide-react'
import './taskViews.css'
import { isTaskClosed } from '../../app/store'
import { SearchSelect } from '../../shared/ui/SearchSelect'
import type { Client, Project, TaskSettings, WorkItem } from '../../shared/types'
import { blockedBy, blockerChoices, MAX_BLOCKERS } from './dependencies'

type Props = {
  task: WorkItem
  items: WorkItem[]
  clients: Client[]
  projects: Project[]
  taskSettings: TaskSettings
  value: string[]
  onChange: (ids: string[]) => void
  disabled?: boolean
}

export function BlockedByField({ task, items, clients, projects, taskSettings, value, onChange, disabled }: Props) {
  const byId = new Map(items.map(item => [item.id, item]))
  const where = (item: WorkItem) =>
    [
      clients.find(client => client.id === item.clientId)?.name,
      projects.find(project => project.id === item.projectId)?.name,
      item.status,
    ]
      .filter(Boolean)
      .join(' · ')
  const chosen = value.map(id => byId.get(id)).filter((item): item is WorkItem => Boolean(item))
  const blocking = blockedBy(task.id, items)
  const choices = blockerChoices(task, value, items)
    .filter(item => !item.archived)
    .map(item => ({
      value: item.id,
      label: item.title,
      hint: where(item),
      depth: item.parentTaskId ? 1 : 0,
    }))

  return (
    <div className="span-2 blocked-by">
      <span className="blocked-by-label">Blocked by</span>
      {chosen.length ? (
        <ul className="blocked-by-list">
          {chosen.map(item => {
            const closed = isTaskClosed(item.status, taskSettings)
            return (
              <li key={item.id} className={closed ? 'is-done' : ''}>
                {!closed && <Lock size={12} aria-label="Still open" />}
                <span>
                  <strong>{item.title}</strong> <small>{where(item)}</small>
                </span>
                {!disabled && (
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Remove ${item.title}`}
                    onClick={() => onChange(value.filter(id => id !== item.id))}
                  >
                    <X size={13} />
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="muted">Nothing blocks this task.</p>
      )}
      {!disabled && value.length < MAX_BLOCKERS && (
        <SearchSelect
          choices={[{ value: '', label: 'Add a task that blocks this one' }, ...choices]}
          value=""
          onChange={id => id && onChange([...value, id])}
          placeholder="Type a task name"
          aria-label="Add a task that blocks this one"
          empty="No other tasks to add"
        />
      )}
      {blocking.length > 0 && (
        <p className="muted blocked-by-blocking">This task blocks: {blocking.map(item => item.title).join(', ')}</p>
      )}
    </div>
  )
}
