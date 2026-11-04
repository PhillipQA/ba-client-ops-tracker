// DRF creation: the Work Hub emails linked to the DRF's task (or its subtasks), to read while filling the form.
// Panel 2 picks the task and lists its emails; the open email shows in a dock at the bottom of the window (like a
// Gmail draft) that stays in view while scrolling down the form. Read-only: reply, attach or archive in Work Hub.
import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, Mail, Maximize2, Minimize2, Minus, X } from 'lucide-react'
import type { Client, Project, WorkItem } from '../../shared/types'
import ClientSelect, { SearchSelect } from '../../shared/ui/SearchSelect'
import { useIsClosed } from '../tasks/openWork'
import { taskChoices } from './documentDriveTargets'
import { requestJson } from '../../shared/http'

type LinkedEmail = { id: string; subject: string; sender: string; body: string; received_at: string }

export function LinkedEmails({
  taskId,
  clientId,
  items,
  clients,
  projects,
  onTaskChange,
  onClientChange,
  disabled = false,
  active = true,
  children,
}: {
  taskId: string
  /** The DRF's client: tasks are chosen within it. The same client as DocHub's “Link to client”. */
  clientId: string
  items: WorkItem[]
  clients: Client[]
  projects: Project[]
  /** Links the DRF to a task here, at the top: the same choice as DocHub's “Existing task or subtask”. */
  onTaskChange: (taskId: string) => void
  /** Choosing another client clears the task, as in DocHub. */
  onClientChange: (clientId: string) => void
  disabled?: boolean
  /** The page is on screen: the dock shows only then. */
  active?: boolean
  /** Shown above the emails (DRF creation: a missing-template warning). */
  children?: ReactNode
}) {
  const [emails, setEmails] = useState<LinkedEmail[] | null>(null)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  // The email in the dock ('' = dock closed) and how the dock is shown.
  const [openId, setOpenId] = useState('')
  const [dock, setDock] = useState<'normal' | 'min' | 'max'>('normal')
  const isClosed = useIsClosed()
  // The chosen client's open tasks, each followed by its subtasks (the chosen one stays listed even once closed).
  // Nothing is listed before a client is chosen, so the list is never every task in the account.
  const choices = clientId
    ? taskChoices(
        { items: items.filter(item => item.id === taskId || !isClosed(item.status)), clients, projects },
        clientId,
      )
    : []
  // The task and its subtasks: an email turned into a subtask still belongs to this DRF's work.
  const ids = [taskId, ...items.filter(item => item.parentTaskId === taskId).map(item => item.id)].slice(0, 50)
  const key = ids.join(',')
  useEffect(() => {
    if (!taskId) {
      setEmails(null)
      setError('')
      setOpenId('')
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
      .then(result => {
        const list = result.items || []
        setEmails(list)
        // A newly linked task opens its newest email in the dock.
        setOpenId(list[0]?.id || '')
        setDock('normal')
      })
      .catch(e => {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Linked emails could not be loaded.')
      })
    return () => controller.abort()
  }, [key, retry])

  const count = emails?.length || 0
  const at = emails ? emails.findIndex(email => email.id === openId) : -1
  const opened = at >= 0 && emails ? emails[at] : null
  const show = (by: number) => emails && setOpenId(emails[(at + by + emails.length) % emails.length].id)
  // Plain JSX, not a component made during render: re-renders keep the dock's scroll position.
  const dockNode = opened && (
    <section className={`linked-email-dock is-${dock}`} aria-label="Linked email, read-only">
      <header>
        <button
          type="button"
          className="linked-email-dock-title"
          title={dock === 'min' ? 'Show the email' : 'Minimize'}
          onClick={() => setDock(current => (current === 'min' ? 'normal' : 'min'))}
        >
          <Mail size={15} aria-hidden="true" />
          <span>{opened.subject || '(No subject)'}</span>
        </button>
        {count > 1 && (
          <span className="linked-email-dock-nav">
            <button type="button" aria-label="Previous email" onClick={() => show(-1)}>
              <ChevronLeft size={15} />
            </button>
            {at + 1} of {count}
            <button type="button" aria-label="Next email" onClick={() => show(1)}>
              <ChevronRight size={15} />
            </button>
          </span>
        )}
        <button
          type="button"
          aria-label={dock === 'min' ? 'Show the email' : 'Minimize'}
          onClick={() => setDock(current => (current === 'min' ? 'normal' : 'min'))}
        >
          <Minus size={15} />
        </button>
        <button
          type="button"
          aria-label={dock === 'max' ? 'Smaller' : 'Larger'}
          onClick={() => setDock(current => (current === 'max' ? 'normal' : 'max'))}
        >
          {dock === 'max' ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>
        <button type="button" aria-label="Close" onClick={() => setOpenId('')}>
          <X size={15} />
        </button>
      </header>
      {dock !== 'min' && (
        <div className="linked-email-dock-body">
          <p className="linked-email-dock-meta">
            {opened.sender} · {new Date(opened.received_at).toLocaleString()}
          </p>
          <div className="linked-email-body">{opened.body || 'No plain text body available.'}</div>
        </div>
      )}
    </section>
  )
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
      <div className="linked-emails-pickers">
        <label className="linked-emails-task">
          <span>Client</span>
          <ClientSelect
            clients={clients.filter(client => !client.archived || client.id === clientId)}
            value={clientId}
            onChange={onClientChange}
            extra={[{ value: '', label: 'Choose a client' }]}
            disabled={disabled}
          />
        </label>
        <label className="linked-emails-task">
          <span>Task or subtask</span>
          <SearchSelect
            disabled={disabled || !clientId}
            value={taskId}
            onChange={onTaskChange}
            choices={[{ value: '', label: 'No task linked' }, ...choices]}
            placeholder={clientId ? 'Type a task or subtask' : 'Choose a client first'}
            empty="This client has no open task or subtask matching that"
          />
        </label>
      </div>
      {!taskId ? (
        <p className="linked-emails-empty">
          {clientId
            ? 'Choose the task this DRF is for to read its email.'
            : 'Choose the client, then the task this DRF is for, to read its email.'}
        </p>
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
        <ul className="linked-email-list">
          {emails.map(email => (
            <li key={email.id}>
              <button
                type="button"
                className={email.id === openId ? 'active' : ''}
                aria-pressed={email.id === openId}
                onClick={() => {
                  setOpenId(email.id)
                  setDock(current => (current === 'min' ? 'normal' : current))
                }}
              >
                <strong>{email.subject || '(No subject)'}</strong>
                <span>
                  {email.sender} · {new Date(email.received_at).toLocaleString()}
                </span>
              </button>
            </li>
          ))}
          <li className="linked-emails-empty">Opens at the bottom of the window and stays there while you scroll.</li>
        </ul>
      )}
      {active && opened && emails && createPortal(dockNode, document.body)}
    </div>
  )
}
