import { type FormEvent, useEffect, useMemo, useState } from 'react'
import {
  Bot,
  CalendarPlus,
  CheckCircle2,
  Clipboard,
  FileText,
  Loader2,
  Mail,
  MessageSquareText,
  PlusCircle,
  Sparkles,
  TicketCheck,
} from 'lucide-react'
import { useDocumentOperation } from '../documents/useDocumentOperation'
import {
  applyEmailDocument,
  askBAAssistant,
  assistantMessages,
  type AIMessage,
  type AISuggestion,
  type AISuggestionKind,
} from './ai'
import type {
  Client,
  PlannerActivity,
  Project,
  TaskSettings,
  UserAccount,
  WorkActivityEvent,
  WorkItem,
} from '../../shared/types'
import { isWaitingOnDone } from '../tasks/waitingOn'
import ClientSelect from '../../shared/ui/SearchSelect'

const THREAD_STORAGE_KEY = 'ba-client-ops-ai-threads-v1'

function loadThreads(): Record<string, AIMessage[]> {
  try {
    return JSON.parse(localStorage.getItem(THREAD_STORAGE_KEY) || '{}') as Record<string, AIMessage[]>
  } catch {
    return {}
  }
}

function saveThreads(threads: Record<string, AIMessage[]>) {
  localStorage.setItem(THREAD_STORAGE_KEY, JSON.stringify(threads))
}

function suggestionIcon(kind: AISuggestionKind) {
  if (kind === 'activity') return <CalendarPlus size={16} />
  if (kind === 'draft_reply') return <MessageSquareText size={16} />
  if (kind === 'email_document') return <Mail size={16} />
  if (kind === 'issue') return <TicketCheck size={16} />
  if (kind === 'requirement') return <FileText size={16} />
  return <PlusCircle size={16} />
}

function suggestionLabel(kind: AISuggestionKind) {
  if (kind === 'draft_reply') return 'Draft reply'
  if (kind === 'follow_up') return 'Follow-up'
  if (kind === 'email_document') return 'Link email'
  return kind.charAt(0).toUpperCase() + kind.slice(1)
}

/** What approving an email suggestion does: the email, the task it goes to, and the document opened after. */
function emailPlan(suggestion: AISuggestion) {
  const place = suggestion.newTask ? ` (${suggestion.newTask.clientName} / ${suggestion.newTask.projectName})` : ''
  const task = suggestion.taskTitle ? `Task: ${suggestion.taskTitle}` : `New task: ${suggestion.newTask?.title}${place}`
  const then = suggestion.document ? ` · Then: open the ${suggestion.document === 'drf' ? 'DRF' : 'sign-off'}` : ''
  return `Email: ${suggestion.emailSubject || 'No subject'} · ${task}${then}`
}

function applyLabel(suggestion: AISuggestion, done: boolean) {
  if (suggestion.kind === 'email_document')
    return (
      <>
        <Mail size={15} /> {done ? 'Linked' : 'Approve & link'}
      </>
    )
  if (suggestion.kind === 'draft_reply')
    return (
      <>
        <Clipboard size={15} /> Copy draft
      </>
    )
  return (
    <>
      <PlusCircle size={15} /> Approve & add
    </>
  )
}

export default function AIAssistant({
  clients,
  projects,
  items,
  planner,
  taskSettings,
  accounts,
  workEvents,
  currentUser,
  initialClientId = '',
  initialProjectId = '',
  initialPrompt = '',
  onContextChange,
  onApplySuggestion,
  onWorkChanged,
}: {
  clients: Client[]
  projects: Project[]
  items: WorkItem[]
  planner: PlannerActivity[]
  taskSettings: TaskSettings
  accounts: UserAccount[]
  workEvents: WorkActivityEvent[]
  currentUser: UserAccount
  initialClientId?: string
  initialProjectId?: string
  initialPrompt?: string
  onContextChange?: (clientId: string, projectId: string) => void
  onApplySuggestion: (suggestion: AISuggestion, clientId: string, projectId: string) => string
  /** The server made a task (from an email): reload the workspace so it shows. */
  onWorkChanged?: () => Promise<void>
}) {
  const [clientId, setClientId] = useState(initialClientId)
  const [projectId, setProjectId] = useState(initialProjectId)
  const [threads, setThreads] = useState<Record<string, AIMessage[]>>(loadThreads)
  const [input, setInput] = useState('')
  const operation = useDocumentOperation()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [actionNotice, setActionNotice] = useState('')
  // An email suggestion being carried out, and those already done (so one is not linked twice).
  const [applying, setApplying] = useState('')
  const [applied, setApplied] = useState<string[]>([])

  useEffect(() => {
    setClientId(initialClientId)
  }, [initialClientId])
  useEffect(() => {
    setProjectId(initialProjectId)
  }, [initialProjectId])
  useEffect(() => {
    if (initialPrompt) setInput(initialPrompt)
  }, [initialPrompt])

  const linkedProjects = useMemo(() => projects, [projects])
  const resolvedProjectId = linkedProjects.some(project => project.id === projectId) ? projectId : ''
  const threadKey = `${currentUser.id}:${clientId || 'global'}:${resolvedProjectId || 'all'}`
  const messages = threads[threadKey] ?? []
  useEffect(() => {
    operation.cancel()
    setBusy(false)
    setError('')
  }, [threadKey])
  useEffect(() => {
    saveThreads(threads)
  }, [threads])

  const context = useMemo(() => {
    const client = clients.find(value => value.id === clientId)
    const project = projects.find(value => value.id === resolvedProjectId)
    const scopedItems = items.filter(
      item => (!clientId || item.clientId === clientId) && (!resolvedProjectId || item.projectId === resolvedProjectId),
    )
    const closedStatuses = new Set(taskSettings.statuses.filter(status => status.closed).map(status => status.label))
    const openItems = scopedItems.filter(
      item => !closedStatuses.has(item.status) && !isWaitingOnDone(item.waitingOn, taskSettings),
    )
    const upcomingActivities = planner.filter(
      activity =>
        (!clientId || activity.clientId === clientId) &&
        (!resolvedProjectId || activity.projectId === resolvedProjectId) &&
        activity.status === 'Planned',
    )
    const myAssignments = scopedItems.filter(item => item.assignedToUserId === currentUser.id)
    const myRecentActivity = workEvents
      .filter(
        event =>
          (event.actorUserId === currentUser.id ||
            event.assignedToUserId === currentUser.id ||
            (event.field === 'assignedToUserId' && event.oldValue === currentUser.id)) &&
          (!clientId || event.clientId === clientId) &&
          (!resolvedProjectId || event.projectId === resolvedProjectId),
      )
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
    return {
      currentUser: { id: currentUser.id, name: currentUser.name, role: currentUser.role, modules: currentUser.modules },
      client,
      project,
      openItems,
      recentItems: scopedItems,
      upcomingActivities,
      myAssignments,
      myRecentActivity,
    }
  }, [clientId, resolvedProjectId, clients, projects, items, planner, taskSettings, currentUser, workEvents, accounts])

  const updateContext = (nextClientId: string, nextProjectId: string) => {
    operation.cancel()
    setBusy(false)
    setClientId(nextClientId)
    setProjectId(nextProjectId)
    setError('')
    setActionNotice('')
    onContextChange?.(nextClientId, nextProjectId)
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const text = input.trim()
    if (!text || busy) return

    const job = operation.begin()
    const userMessage: AIMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      createdAt: new Date().toISOString(),
    }
    const nextMessages = [...messages, userMessage]
    const nextThreads = { ...threads, [threadKey]: nextMessages }
    setThreads(nextThreads)
    saveThreads(nextThreads)
    setInput('')
    setBusy(true)
    setError('')
    setActionNotice('')

    try {
      const result = await askBAAssistant({ message: text, context, history: messages.slice(-8) }, job.signal)
      if (!job.isCurrent()) return
      const replies = assistantMessages(result)
      setThreads(current => ({ ...current, [threadKey]: [...(current[threadKey] || nextMessages), ...replies] }))
    } catch (requestError) {
      if (job.isCurrent())
        setError(requestError instanceof Error ? requestError.message : 'The AI assistant could not respond.')
    } finally {
      if (job.isCurrent()) setBusy(false)
    }
  }

  const applyEmail = async (suggestion: AISuggestion) => {
    setApplying(suggestion.id)
    setError('')
    setActionNotice('')
    try {
      const { taskId, created } = await applyEmailDocument(suggestion, currentUser.id)
      setApplied(done => [...done, suggestion.id])
      if (created) await onWorkChanged?.()
      const where = suggestion.taskTitle || suggestion.newTask?.title || 'the task'
      const opened = suggestion.document === 'drf' ? 'DRF' : suggestion.document === 'signoff' ? 'sign-off' : ''
      const next = opened ? ` Opening the ${opened} for it.` : ''
      setActionNotice(`Email linked to “${where}”${created ? ' (new task)' : ''}.${next}`)
      if (suggestion.document)
        window.dispatchEvent(new CustomEvent('dochub-create', { detail: { taskId, flow: suggestion.document } }))
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : 'The email could not be linked.')
    } finally {
      setApplying('')
    }
  }

  const applySuggestion = (suggestion: AISuggestion) => {
    if (suggestion.kind === 'email_document') return void applyEmail(suggestion)
    if (suggestion.kind === 'draft_reply') {
      if (suggestion.draft && navigator.clipboard) {
        navigator.clipboard
          .writeText(suggestion.draft)
          .then(() => setActionNotice('Draft copied. Nothing was sent to the client.'))
          .catch(() => setActionNotice('Draft is ready below; copy it manually.'))
      }
      return
    }
    const notice = onApplySuggestion(suggestion, clientId, resolvedProjectId)
    setActionNotice(notice)
  }

  const clearThread = () => {
    operation.cancel()
    setBusy(false)
    const next = { ...threads }
    delete next[threadKey]
    setThreads(next)
    saveThreads(next)
    setError('')
    setActionNotice('Conversation cleared for this context.')
  }

  return (
    <section className="ai-layout">
      <div className="ai-context-panel panel">
        <div className="panel-heading">
          <div>
            <h2>AI BA Assistant</h2>
            <p>Give it the messy client input. It will assess, organize, and suggest next actions.</p>
          </div>
          <Sparkles size={20} />
        </div>
        <div className="ai-context-form">
          <label>
            Client
            <ClientSelect
              clients={clients}
              value={clientId}
              onChange={value => updateContext(value, '')}
              extra={[{ value: '', label: 'All clients / general' }]}
            />
          </label>
          <label>
            Project
            <select value={resolvedProjectId} onChange={e => updateContext(clientId, e.target.value)}>
              <option value="">All projects</option>
              {linkedProjects.map(project => (
                <option value={project.id} key={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="ai-user-context">
          <strong>{currentUser.name}</strong>
          <span>{currentUser.role} · AI understands “I”, “me”, and “my” as this user.</span>
        </div>
        <div className="ai-context-summary">
          <div>
            <strong>{context.openItems.length}</strong>
            <span>open tasks</span>
          </div>
          <div>
            <strong>{context.myAssignments.length}</strong>
            <span>my assignments</span>
          </div>
          <div>
            <strong>{context.upcomingActivities.length}</strong>
            <span>planned activities</span>
          </div>
          <div>
            <strong>{context.client ? context.client.status : 'Global'}</strong>
            <span>context</span>
          </div>
        </div>
        <div className="ai-safety-note">
          <CheckCircle2 size={17} />
          <div>
            <strong>Approval required</strong>
            <span>
              The assistant can suggest records, but it cannot create or change tracker data until you click an action.
            </span>
          </div>
        </div>
        <div className="ai-prompts">
          <span>Try asking:</span>
          <button
            type="button"
            onClick={() => setInput('Assess this client inquiry and tell me what I should do next: ')}
          >
            Assess an inquiry
          </button>
          <button
            type="button"
            onClick={() =>
              setInput('Review the open tasks in this context. What should I prioritize and follow up on?')
            }
          >
            Review open work
          </button>
          <button
            type="button"
            onClick={() => setInput('Summarize what I accomplished this week and what is still outstanding.')}
          >
            My weekly summary
          </button>
          <button
            type="button"
            onClick={() => setInput('Draft a concise client update based on the current project context.')}
          >
            Draft client update
          </button>
          <button
            type="button"
            onClick={() => setInput('I received an email from … about …. Link it to … and prepare a DRF.')}
          >
            Link an email
          </button>
          {currentUser.modules?.includes('trackers') && (
            <button
              type="button"
              onClick={() =>
                setInput(
                  'Summarize the trackers in this context: progress, dates passed or coming up, and what needs attention. Tracker name (optional): ',
                )
              }
            >
              Summarize trackers
            </button>
          )}
        </div>
      </div>

      <div className="ai-chat panel">
        <div className="ai-chat-head">
          <div>
            <Bot size={20} />
            <div>
              <strong>{context.client?.name || 'BA workspace assistant'}</strong>
              <span>{context.project?.name || (context.client ? 'All client projects' : 'General workspace')}</span>
            </div>
          </div>
          <button className="secondary compact" type="button" onClick={clearThread}>
            Clear chat
          </button>
        </div>
        <div className="ai-messages" aria-live="polite">
          {messages.length === 0 && (
            <div className="ai-empty">
              <Bot size={30} />
              <h3>Drop the client situation here.</h3>
              <p>
                Paste an inquiry, meeting notes, requirement text, or a document excerpt. I’ll separate facts,
                questions, risks, and recommended actions.
              </p>
            </div>
          )}
          {messages.map(message => (
            <div key={message.id} className={`ai-message ${message.role}`}>
              <div className="ai-message-label">{message.role === 'user' ? 'You' : 'BA Assistant'}</div>
              <div className="ai-message-body">{message.content}</div>
              {message.suggestions?.length ? (
                <div className="ai-suggestions">
                  {message.suggestions.map(suggestion => (
                    <div className="ai-suggestion" key={suggestion.id}>
                      <div className="ai-suggestion-head">
                        <span>
                          {suggestionIcon(suggestion.kind)} {suggestionLabel(suggestion.kind)}
                        </span>
                        {suggestion.priority && <b>{suggestion.priority}</b>}
                      </div>
                      <strong>{suggestion.title}</strong>
                      <p>{suggestion.rationale}</p>
                      {suggestion.description && <small>{suggestion.description}</small>}
                      {suggestion.draft && <div className="ai-draft">{suggestion.draft}</div>}
                      {suggestion.kind === 'email_document' && <small>{emailPlan(suggestion)}</small>}
                      <button
                        className="secondary"
                        type="button"
                        disabled={applying === suggestion.id || applied.includes(suggestion.id)}
                        onClick={() => applySuggestion(suggestion)}
                      >
                        {applyLabel(suggestion, applied.includes(suggestion.id))}
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
          {busy && (
            <div className="ai-thinking">
              <Loader2 className="spin" size={18} /> Assessing the context…
            </div>
          )}
        </div>
        {error && <div className="ai-error">{error}</div>}
        {actionNotice && <div className="ai-action-notice">{actionNotice}</div>}
        <form className="ai-composer" onSubmit={submit}>
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            rows={4}
            placeholder="Paste a client inquiry, meeting notes, requirement, or document excerpt…"
          />
          <div className="ai-composer-foot">
            <span>AI suggestions are not saved until you approve them.</span>
            <button className="primary" disabled={busy || !input.trim()}>
              <Sparkles size={17} /> Assess
            </button>
          </div>
        </form>
      </div>
    </section>
  )
}
