import { FormEvent, useEffect, useMemo, useState } from 'react'
import { Bot, CalendarPlus, CheckCircle2, Clipboard, FileText, Loader2, MessageSquareText, PlusCircle, Sparkles, TicketCheck } from 'lucide-react'
import { askBAAssistant, type AIMessage, type AISuggestion, type AISuggestionKind } from './ai'
import type { Client, PlannerActivity, Project, TaskSettings, WorkItem } from './types'

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
  if (kind === 'issue') return <TicketCheck size={16} />
  if (kind === 'requirement') return <FileText size={16} />
  return <PlusCircle size={16} />
}

function suggestionLabel(kind: AISuggestionKind) {
  if (kind === 'draft_reply') return 'Draft reply'
  if (kind === 'follow_up') return 'Follow-up'
  return kind.charAt(0).toUpperCase() + kind.slice(1)
}

export default function AIAssistant({
  clients,
  projects,
  items,
  planner,
  taskSettings,
  initialClientId = '',
  initialProjectId = '',
  initialPrompt = '',
  onContextChange,
  onApplySuggestion,
}: {
  clients: Client[]
  projects: Project[]
  items: WorkItem[]
  planner: PlannerActivity[]
  taskSettings: TaskSettings
  initialClientId?: string
  initialProjectId?: string
  initialPrompt?: string
  onContextChange?: (clientId: string, projectId: string) => void
  onApplySuggestion: (suggestion: AISuggestion, clientId: string, projectId: string) => string
}) {
  const [clientId, setClientId] = useState(initialClientId)
  const [projectId, setProjectId] = useState(initialProjectId)
  const [threads, setThreads] = useState<Record<string, AIMessage[]>>(loadThreads)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [actionNotice, setActionNotice] = useState('')

  useEffect(() => { setClientId(initialClientId) }, [initialClientId])
  useEffect(() => { setProjectId(initialProjectId) }, [initialProjectId])
  useEffect(() => { if (initialPrompt) setInput(initialPrompt) }, [initialPrompt])

  const linkedProjects = useMemo(() => clientId ? projects.filter((project) => !project.clientId || project.clientId === clientId) : projects, [clientId, projects])
  const resolvedProjectId = linkedProjects.some((project) => project.id === projectId) ? projectId : ''
  const threadKey = `${clientId || 'global'}:${resolvedProjectId || 'all'}`
  const messages = threads[threadKey] ?? []

  const context = useMemo(() => {
    const client = clients.find((value) => value.id === clientId)
    const project = projects.find((value) => value.id === resolvedProjectId)
    const scopedItems = items.filter((item) => (!clientId || item.clientId === clientId) && (!resolvedProjectId || item.projectId === resolvedProjectId))
    const closedStatuses = new Set(taskSettings.statuses.filter((status) => status.closed).map((status) => status.label))
    const openItems = scopedItems.filter((item) => !closedStatuses.has(item.status) && item.waitingOn !== 'Done').slice(0, 20)
    const upcomingActivities = planner.filter((activity) => (!clientId || activity.clientId === clientId) && (!resolvedProjectId || activity.projectId === resolvedProjectId) && activity.status === 'Planned').slice(0, 15)
    return { client, project, openItems, recentItems: scopedItems.slice(0, 20), upcomingActivities }
  }, [clientId, resolvedProjectId, clients, projects, items, planner, taskSettings])

  const updateContext = (nextClientId: string, nextProjectId: string) => {
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

    const userMessage: AIMessage = { id: crypto.randomUUID(), role: 'user', content: text, createdAt: new Date().toISOString() }
    const nextMessages = [...messages, userMessage]
    const nextThreads = { ...threads, [threadKey]: nextMessages }
    setThreads(nextThreads)
    saveThreads(nextThreads)
    setInput('')
    setBusy(true)
    setError('')
    setActionNotice('')

    try {
      const result = await askBAAssistant({ message: text, context, history: messages.slice(-8) })
      const assistantMessage: AIMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: result.message,
        suggestions: result.suggestions.map((suggestion) => ({ ...suggestion, id: suggestion.id || crypto.randomUUID() })),
        createdAt: new Date().toISOString(),
      }
      const completed = { ...nextThreads, [threadKey]: [...nextMessages, assistantMessage] }
      setThreads(completed)
      saveThreads(completed)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'The AI assistant could not respond.')
    } finally {
      setBusy(false)
    }
  }

  const applySuggestion = (suggestion: AISuggestion) => {
    if (suggestion.kind === 'draft_reply') {
      if (suggestion.draft && navigator.clipboard) {
        navigator.clipboard.writeText(suggestion.draft).then(() => setActionNotice('Draft copied. Nothing was sent to the client.')).catch(() => setActionNotice('Draft is ready below; copy it manually.'))
      }
      return
    }
    const notice = onApplySuggestion(suggestion, clientId, resolvedProjectId)
    setActionNotice(notice)
  }

  const clearThread = () => {
    const next = { ...threads }
    delete next[threadKey]
    setThreads(next)
    saveThreads(next)
    setError('')
    setActionNotice('Conversation cleared for this context.')
  }

  return <section className="ai-layout">
    <div className="ai-context-panel panel">
      <div className="panel-heading"><div><h2>AI BA Assistant</h2><p>Give it the messy client input. It will assess, organize, and suggest next actions.</p></div><Sparkles size={20} /></div>
      <div className="ai-context-form">
        <label>Client<select value={clientId} onChange={(e) => updateContext(e.target.value, '')}><option value="">All clients / general</option>{clients.map((client) => <option value={client.id} key={client.id}>{client.name}</option>)}</select></label>
        <label>Project<select value={resolvedProjectId} onChange={(e) => updateContext(clientId, e.target.value)}><option value="">All projects</option>{linkedProjects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select></label>
      </div>
      <div className="ai-context-summary">
        <div><strong>{context.openItems.length}</strong><span>open tasks</span></div>
        <div><strong>{context.upcomingActivities.length}</strong><span>planned activities</span></div>
        <div><strong>{context.client ? context.client.status : 'Global'}</strong><span>context</span></div>
      </div>
      <div className="ai-safety-note"><CheckCircle2 size={17} /><div><strong>Approval required</strong><span>The assistant can suggest records, but it cannot create or change tracker data until you click an action.</span></div></div>
      <div className="ai-prompts">
        <span>Try asking:</span>
        <button type="button" onClick={() => setInput('Assess this client inquiry and tell me what I should do next: ')}>Assess an inquiry</button>
        <button type="button" onClick={() => setInput('Review the open tasks in this context. What should I prioritize and follow up on?')}>Review open work</button>
        <button type="button" onClick={() => setInput('Draft a concise client update based on the current project context.')}>Draft client update</button>
      </div>
    </div>

    <div className="ai-chat panel">
      <div className="ai-chat-head"><div><Bot size={20} /><div><strong>{context.client?.name || 'BA workspace assistant'}</strong><span>{context.project?.name || (context.client ? 'All client projects' : 'General workspace')}</span></div></div><button className="secondary compact" type="button" onClick={clearThread}>Clear chat</button></div>
      <div className="ai-messages" aria-live="polite">
        {messages.length === 0 && <div className="ai-empty"><Bot size={30} /><h3>Drop the client situation here.</h3><p>Paste an inquiry, meeting notes, requirement text, or a document excerpt. I’ll separate facts, questions, risks, and recommended actions.</p></div>}
        {messages.map((message) => <div key={message.id} className={`ai-message ${message.role}`}>
          <div className="ai-message-label">{message.role === 'user' ? 'You' : 'BA Assistant'}</div>
          <div className="ai-message-body">{message.content}</div>
          {message.suggestions?.length ? <div className="ai-suggestions">{message.suggestions.map((suggestion) => <div className="ai-suggestion" key={suggestion.id}>
            <div className="ai-suggestion-head"><span>{suggestionIcon(suggestion.kind)} {suggestionLabel(suggestion.kind)}</span>{suggestion.priority && <b>{suggestion.priority}</b>}</div>
            <strong>{suggestion.title}</strong>
            <p>{suggestion.rationale}</p>
            {suggestion.description && <small>{suggestion.description}</small>}
            {suggestion.draft && <div className="ai-draft">{suggestion.draft}</div>}
            <button className="secondary" type="button" onClick={() => applySuggestion(suggestion)}>{suggestion.kind === 'draft_reply' ? <><Clipboard size={15} /> Copy draft</> : <><PlusCircle size={15} /> Approve & add</>}</button>
          </div>)}</div> : null}
        </div>)}
        {busy && <div className="ai-thinking"><Loader2 className="spin" size={18} /> Assessing the context…</div>}
      </div>
      {error && <div className="ai-error">{error}</div>}
      {actionNotice && <div className="ai-action-notice">{actionNotice}</div>}
      <form className="ai-composer" onSubmit={submit}>
        <textarea value={input} onChange={(e) => setInput(e.target.value)} rows={4} placeholder="Paste a client inquiry, meeting notes, requirement, or document excerpt…" />
        <div className="ai-composer-foot"><span>AI suggestions are not saved until you approve them.</span><button className="primary" disabled={busy || !input.trim()}><Sparkles size={17} /> Assess</button></div>
      </form>
    </div>
  </section>
}
