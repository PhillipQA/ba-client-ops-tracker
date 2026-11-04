// DRF creation: the Work Hub emails linked to the DRF's task (or its subtasks), to read while filling the form.
// Read-only: open them in Work Hub to reply, attach or archive.
import { useEffect, useState, type ReactNode } from 'react'
import { Mail } from 'lucide-react'
import type { Client, Project, WorkItem } from '../../shared/types'
import { SearchSelect } from '../../shared/ui/SearchSelect'
import { useIsClosed } from '../tasks/openWork'
import { taskChoices } from './documentDriveTargets'
import { requestJson } from '../../shared/http'

type LinkedEmail = { id: string; subject: string; sender: string; body: string; received_at: string }

export function LinkedEmails({
  taskId,
  items,
  clients,
  projects,
  onTaskChange,
  disabled = false,
  children,
}: {
  taskId: string
  items: WorkItem[]
  clients: Client[]
  projects: Project[]
  /** Links the DRF to a task here, at the top: the same choice as DocHub's “Existing task or subtask”. */
  onTaskChange: (taskId: string) => void
  disabled?: boolean
  /** Shown above the emails (DRF creation: a missing-template warning). */
  children?: ReactNode
}) {
  const [emails, setEmails] = useState<LinkedEmail[] | null>(null)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const isClosed = useIsClosed()
  // Open tasks and subtasks (the chosen one stays listed even once closed), searchable by name; the client follows.
  const choices = taskChoices(
    { items: items.filter(item => item.id === taskId || !isClosed(item.status)), clients, projects },
    '',
  )
  // The task and its subtasks: an email turned into a subtask still belongs to this DRF's work.
  const ids = [taskId, ...items.filter(item => item.parentTaskId === taskId).map(item => item.id)].slice(0, 50)
  const key = ids.join(',')
  useEffect(() => {
    if (!taskId) {
      setEmails(null)
      setError('')
      return
    }
    const controller = new AbortController()
    setEmails(null)
    setError('')
    requestJson<{ items: LinkedEmail[] }>(`/api/communications?taskIds=${encodeURIComponent(key)}`, {
      signal: controller.signal,
      noStore: true,
      fallback: 'Linked emails could not be loaded.',
    })
      .then(result => setEmails(result.items || []))
      .catch(e => {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Linked emails could not be loaded.')
      })
    return () => controller.abort()
  }, [key, retry])

  const count = emails?.length || 0
  return (
    <div className="document-upload-panel linked-emails">
      <div className="document-section-title">
        <Mail size={18} />
        <div>
          <strong>2. Linked email{emails ? ` (${count})` : ''}</strong>
          <span>The task’s Work Hub email, to read while you fill in the DRF · read-only</span>
        </div>
      </div>
      {children}
      <label className="linked-emails-task">
        <span>Task or subtask</span>
        <SearchSelect
          disabled={disabled}
          value={taskId}
          onChange={onTaskChange}
          choices={[{ value: '', label: 'No task linked' }, ...choices]}
          placeholder="Type a task or subtask"
          empty="No open task or subtask matches"
        />
      </label>
      {!taskId ? (
        <p className="linked-emails-empty">Choose the task this DRF is for to read its email here.</p>
      ) : error ? (
        <p role="alert">
          {error}{' '}
          <button type="button" className="secondary" onClick={() => setRetry(value => value + 1)}>
            Retry
          </button>
        </p>
      ) : !emails ? (
        <p role="status">Loading…</p>
      ) : !count ? (
        <p className="linked-emails-empty">No Work Hub email is linked to this task.</p>
      ) : (
        emails.map((email, index) => (
          <details key={email.id} className="linked-email" open={index === 0}>
            <summary>
              <strong>{email.subject || '(No subject)'}</strong>
              <span>
                {email.sender} · {new Date(email.received_at).toLocaleString()}
              </span>
            </summary>
            <div className="linked-email-body">{email.body || 'No plain text body available.'}</div>
          </details>
        ))
      )}
    </div>
  )
}
