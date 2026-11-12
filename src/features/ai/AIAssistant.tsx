import { type FormEvent, useEffect, useMemo, useState } from 'react'
import {
  Bot,
  CalendarPlus,
  Clock,
  ListChecks,
  PencilLine,
  Table2,
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
  applyTimeLog,
  applyTrackerChange,
  openEmailDraft,
  plannedRefs,
  togglePlanned,
  type TaskPlan,
  askBAAssistant,
  draftDrfFromEmail,
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
import { drfPrefillCount } from '../documents/drfPrefill'
import { createTrackerDraft } from './trackerDraft'
import ClientSelect from '../../shared/ui/SearchSelect'
import type { TimeEntryMutationResult } from '../tasks/timeEntries'

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
  if (kind === 'tracker_draft') return <Table2 size={16} />
  if (kind === 'email_draft') return <Mail size={16} />
  if (kind === 'task_plan') return <ListChecks size={16} />
  if (kind === 'tracker_update') return <PencilLine size={16} />
  if (kind === 'time_log') return <Clock size={16} />
  if (kind === 'issue') return <TicketCheck size={16} />
  if (kind === 'requirement') return <FileText size={16} />
  return <PlusCircle size={16} />
}

function suggestionLabel(kind: AISuggestionKind) {
  if (kind === 'draft_reply') return 'Draft reply'
  if (kind === 'follow_up') return 'Follow-up'
  if (kind === 'email_document') return 'Link email'
  if (kind === 'tracker_draft') return 'Tracker draft'
  if (kind === 'email_draft') return 'Follow-up email'
  if (kind === 'task_plan') return 'Tasks from notes'
  if (kind === 'tracker_update') return 'Tracker update'
  if (kind === 'time_log') return 'Time log'
  return kind.charAt(0).toUpperCase() + kind.slice(1)
}

/** What approving an email suggestion does: the email, the task it goes to, and the document opened after. */
function emailPlan(suggestion: AISuggestion) {
  const place = suggestion.newTask ? ` (${suggestion.newTask.clientName} / ${suggestion.newTask.projectName})` : ''
  const task = suggestion.taskTitle ? `Task: ${suggestion.taskTitle}` : `New task: ${suggestion.newTask?.title}${place}`
  const then = suggestion.document ? ` · Then: open the ${suggestion.document === 'drf' ? 'DRF' : 'sign-off'}` : ''
  return `Email: ${suggestion.emailSubject || 'No subject'} · ${task}${then}`
}

/** What approving a tracker draft makes: its template, where it belongs, and the first rows. */
function trackerPlan(suggestion: AISuggestion) {
  const draft = suggestion.tracker
  if (!draft) return ''
  const place = [draft.clientName, draft.projectName].filter(Boolean).join(' / ')
  const first = draft.rows.slice(0, 3).map(row => Object.values(row)[0])
  const more = draft.rows.length > first.length ? ` +${draft.rows.length - first.length} more` : ''
  const rows = draft.rows.length ? `${draft.rows.length} rows: ${first.join(', ')}${more}` : 'No rows yet'
  return `“${draft.name}” · ${draft.templateName} template${place ? ` · ${place}` : ''} · ${rows}`
}

const hoursText = (hours: number) => {
  const whole = Math.floor(hours),
    minutes = Math.round((hours - whole) * 60)
  return [whole ? `${whole}h` : '', minutes ? `${minutes}m` : ''].filter(Boolean).join(' ') || '0m'
}

/** What approving a time log logs. */
function timeLogPlan(suggestion: AISuggestion) {
  const log = suggestion.timeLog
  if (!log) return ''
  return [
    `Task: ${log.taskTitle}`,
    log.subtaskTitle ? `Subtask: ${log.subtaskTitle}` : '',
    `${log.date} · ${hoursText(log.hours)}`,
    log.seeds ? `Seeds task: ${log.seedsTaskName || 'the task’s tag'}` : `Category: ${log.category}`,
    log.note ? `Remarks: ${log.note}` : '',
  ]
    .filter(Boolean)
    .join(' · ')
}

function applyLabel(suggestion: AISuggestion, done: boolean, count = 0) {
  if (suggestion.kind === 'email_draft')
    return (
      <>
        <Mail size={15} /> {done ? 'Opened' : 'Open draft'}
      </>
    )
  if (suggestion.kind === 'task_plan')
    return (
      <>
        <ListChecks size={15} /> {done ? 'Created' : `Approve & create ${count}`}
      </>
    )
  if (suggestion.kind === 'tracker_update')
    return (
      <>
        <PencilLine size={15} /> {done ? 'Updated' : 'Approve & update'}
      </>
    )
  if (suggestion.kind === 'time_log')
    return (
      <>
        <Clock size={15} /> {done ? 'Logged' : 'Approve & log'}
      </>
    )
  if (suggestion.kind === 'tracker_draft')
    return (
      <>
        <Table2 size={15} /> {done ? 'Created' : 'Approve & create'}
      </>
    )
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
  canWriteTasks = false,
  onCreateTasks,
  onTimeEntry,
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
  /** Whether this person may add tasks and log time (actions are shown, but not approvable, without it). */
  canWriteTasks?: boolean
  /** Creates the ticked tasks of a plan drafted from notes. */
  onCreateTasks?: (plan: TaskPlan, refs: string[]) => { ok: boolean; message: string }
  /** A time entry was logged on a task: put it in the workspace. */
  onTimeEntry?: (result: TimeEntryMutationResult) => void
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
  // Which tasks of each plan are ticked (all of them until changed).
  const [ticked, setTicked] = useState<Record<string, string[]>>({})
  const tickedOf = (suggestion: AISuggestion) =>
    ticked[suggestion.id] ?? suggestion.plan?.tasks.map(task => task.ref) ?? []

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
      // A DRF opens with a draft of its fields from the email, when one can be made. It is only a draft to review.
      const drf = suggestion.document === 'drf' ? await draftDrfFromEmail(suggestion.emailId || '') : undefined
      const drafted = drf ? ` ${drfPrefillCount(drf)} fields were drafted from the email: review each one.` : ''
      const next = opened ? ` Opening the ${opened} for it.${drafted}` : ''
      setActionNotice(`Email linked to “${where}”${created ? ' (new task)' : ''}.${next}`)
      if (suggestion.document) {
        const detail = { taskId, flow: suggestion.document, drf }
        window.dispatchEvent(new CustomEvent('dochub-create', { detail }))
      }
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : 'The email could not be linked.')
    } finally {
      setApplying('')
    }
  }

  const applyTracker = async (suggestion: AISuggestion) => {
    if (!suggestion.tracker) return
    setApplying(suggestion.id)
    setError('')
    setActionNotice('')
    try {
      const made = await createTrackerDraft(suggestion.tracker)
      setApplied(done => [...done, suggestion.id])
      const rows = made.rowsFailed ? 'its rows could not be added' : `${made.rows} rows added`
      setActionNotice(
        `Tracker “${made.tracker.name}” created, ${rows}. Only you can see it until you share it: open Trackers to review.`,
      )
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : 'The tracker could not be created.')
    } finally {
      setApplying('')
    }
  }

  /** Runs an approved action, marking it done when it worked. */
  const run = async (suggestion: AISuggestion, action: () => Promise<string>, fallback: string) => {
    setApplying(suggestion.id)
    setError('')
    setActionNotice('')
    try {
      setActionNotice(await action())
      setApplied(done => [...done, suggestion.id])
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : fallback)
    } finally {
      setApplying('')
    }
  }

  const applyEmailDraft = (suggestion: AISuggestion) =>
    run(
      suggestion,
      async () =>
        (await openEmailDraft(suggestion)) === 'reply'
          ? 'The draft opened as Reply all on the task’s latest email. Review it there; nothing is sent until you press Send.'
          : 'The draft opened as a new email filed under the task. Add who it goes to, review it, then send.',
      'The draft could not be opened.',
    )

  const applyPlan = (suggestion: AISuggestion) =>
    run(
      suggestion,
      async () => {
        if (!suggestion.plan || !onCreateTasks) throw new Error('Tasks cannot be created here.')
        const result = onCreateTasks(suggestion.plan, plannedRefs(suggestion.plan, tickedOf(suggestion)))
        if (!result.ok) throw new Error(result.message)
        return result.message
      },
      'The tasks could not be created.',
    )

  const applyTrackerUpdate = (suggestion: AISuggestion) =>
    run(
      suggestion,
      async () => {
        const change = suggestion.trackerChange
        if (!change) throw new Error('This update names no rows.')
        const { done, failed } = await applyTrackerChange(change)
        if (!done) throw new Error(failed.map(row => `${row.label}: ${row.error}`).join(' '))
        const rows = `${done} row${done === 1 ? '' : 's'}`
        const left = failed.length ? ` Not changed: ${failed.map(row => `${row.label} (${row.error})`).join('; ')}` : ''
        return `Updated ${rows} in “${change.trackerName}”.${left}`
      },
      'The tracker could not be updated.',
    )

  const applyTime = (suggestion: AISuggestion) =>
    run(
      suggestion,
      async () => {
        const log = suggestion.timeLog
        if (!log) throw new Error('This time log names no task.')
        const result = await applyTimeLog(log)
        onTimeEntry?.(result)
        return `Logged ${hoursText(log.hours)} on “${log.taskTitle}”.${
          log.seeds ? ' It is not in Seeds yet: send it from the task’s time log.' : ''
        }`
      },
      'The time could not be logged.',
    )

  const applySuggestion = (suggestion: AISuggestion) => {
    if (suggestion.kind === 'email_document') return void applyEmail(suggestion)
    if (suggestion.kind === 'email_draft') return void applyEmailDraft(suggestion)
    if (suggestion.kind === 'task_plan') return void applyPlan(suggestion)
    if (suggestion.kind === 'tracker_update') return void applyTrackerUpdate(suggestion)
    if (suggestion.kind === 'time_log') return void applyTime(suggestion)
    if (suggestion.kind === 'tracker_draft') return void applyTracker(suggestion)
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
            <button type="button" onClick={() => setInput('Create a Site rollout tracker for … with these sites: ')}>
              Draft a tracker
            </button>
          )}
          {currentUser.modules?.includes('inbox') && (
            <button type="button" onClick={() => setInput('Remind the client about … on the task ….')}>
              Follow-up email
            </button>
          )}
          {canWriteTasks && (
            <button type="button" onClick={() => setInput('Create tasks for … / … from these meeting notes:\n')}>
              Notes to tasks
            </button>
          )}
          {currentUser.modules?.includes('trackers') && (
            <button type="button" onClick={() => setInput('In the … tracker, mark … as … and set … to ….')}>
              Update a tracker
            </button>
          )}
          {canWriteTasks && (
            <button type="button" onClick={() => setInput('Log 2 hours today on … for ….')}>
              Log time
            </button>
          )}
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
                      {suggestion.kind === 'tracker_draft' && <small>{trackerPlan(suggestion)}</small>}
                      {suggestion.kind === 'email_draft' && (
                        <small>
                          Task: {suggestion.taskTitle} · Subject: {suggestion.emailSubject}
                        </small>
                      )}
                      {suggestion.kind === 'task_plan' && suggestion.plan && (
                        <PlanList
                          plan={suggestion.plan}
                          ticked={tickedOf(suggestion)}
                          locked={applied.includes(suggestion.id)}
                          onToggle={ref =>
                            setTicked(current => ({
                              ...current,
                              [suggestion.id]: togglePlanned(suggestion.plan!, tickedOf(suggestion), ref),
                            }))
                          }
                        />
                      )}
                      {suggestion.kind === 'tracker_update' && suggestion.trackerChange && (
                        <div className="ai-plan">
                          <small>Tracker: {suggestion.trackerChange.trackerName}</small>
                          <ul>
                            {suggestion.trackerChange.rows.map(row => (
                              <li key={row.rowId}>
                                <b>
                                  Row {row.row} · {row.label}
                                </b>
                                {row.changes.map(change => (
                                  <span key={change.column}>
                                    {change.column}: {change.from} → <strong>{change.to}</strong>
                                  </span>
                                ))}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {suggestion.kind === 'time_log' && suggestion.timeLog && (
                        <>
                          <small>{timeLogPlan(suggestion)}</small>
                          {suggestion.timeLog.problem && (
                            <small className="ai-suggestion-problem">{suggestion.timeLog.problem}</small>
                          )}
                        </>
                      )}
                      <button
                        className="secondary"
                        type="button"
                        disabled={
                          applying === suggestion.id ||
                          applied.includes(suggestion.id) ||
                          ((suggestion.kind === 'task_plan' || suggestion.kind === 'time_log') && !canWriteTasks) ||
                          (suggestion.kind === 'time_log' && Boolean(suggestion.timeLog?.problem)) ||
                          (suggestion.kind === 'task_plan' &&
                            !plannedRefs(suggestion.plan!, tickedOf(suggestion)).length)
                        }
                        onClick={() => applySuggestion(suggestion)}
                      >
                        {applyLabel(
                          suggestion,
                          applied.includes(suggestion.id),
                          suggestion.plan ? plannedRefs(suggestion.plan, tickedOf(suggestion)).length : 0,
                        )}
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

/** The tasks of a plan, each with a tick box; subtasks under their task. */
function PlanList({
  plan,
  ticked,
  locked,
  onToggle,
}: {
  plan: TaskPlan
  ticked: string[]
  locked: boolean
  onToggle: (ref: string) => void
}) {
  const tops = plan.tasks.filter(task => !task.parentRef)
  const under = (ref: string) => plan.tasks.filter(task => task.parentRef === ref)
  const row = (task: TaskPlan['tasks'][number], subtask: boolean) => (
    <li key={task.ref} className={subtask ? 'ai-plan-subtask' : ''}>
      <label>
        <input
          type="checkbox"
          checked={ticked.includes(task.ref)}
          disabled={locked}
          onChange={() => onToggle(task.ref)}
        />
        <span>
          <b>{task.title}</b>
          <small>
            {[
              task.parentTitle ? `Subtask of ${task.parentTitle}` : '',
              subtask ? '' : task.assigneeName ? `For ${task.assigneeName}` : 'Unassigned',
              task.dueDate ? `Due ${task.dueDate}` : '',
              task.priority || '',
            ]
              .filter(Boolean)
              .join(' · ')}
          </small>
        </span>
      </label>
    </li>
  )
  return (
    <div className="ai-plan">
      <small>
        {plan.clientName} / {plan.projectName} · subtasks follow their task’s assignee
      </small>
      <ul>
        {tops.flatMap(task => [row(task, Boolean(task.parentTaskId)), ...under(task.ref).map(sub => row(sub, true))])}
      </ul>
    </div>
  )
}
