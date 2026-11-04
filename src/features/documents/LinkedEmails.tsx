// DRF creation: the Work Hub emails linked to the DRF's task (or its subtasks), to read while filling the form.
// Read-only: open them in Work Hub to reply, attach or archive.
import { useEffect, useState } from 'react'
import { Mail } from 'lucide-react'
import type { WorkItem } from '../../shared/types'
import { requestJson } from '../../shared/http'

type LinkedEmail = { id: string; subject: string; sender: string; body: string; received_at: string }

export function LinkedEmails({ taskId, items }: { taskId: string; items: WorkItem[] }) {
  const [emails, setEmails] = useState<LinkedEmail[] | null>(null)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  // The task and its subtasks: an email turned into a subtask still belongs to this DRF's work.
  const ids = [taskId, ...items.filter(item => item.parentTaskId === taskId).map(item => item.id)].slice(0, 50)
  const key = ids.join(',')
  useEffect(() => {
    if (!taskId) return
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

  if (!taskId) return null
  const count = emails?.length || 0
  return (
    <details className="document-extraction-panel linked-emails">
      <summary>
        <Mail size={16} /> Linked email
        {emails ? ` (${count})` : ''}
      </summary>
      {error ? (
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
    </details>
  )
}
