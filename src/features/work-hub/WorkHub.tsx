import { useEffect, useRef, useState } from 'react'
import { LayoutGrid, List, ChevronLeft, ChevronRight, Paperclip, CloudUpload } from 'lucide-react'
import GitProviderHub from '../integrations/GitProviderHub'
import {
  workHubSync,
  integrationLabel,
  WORK_HUB_INTEGRATIONS,
  type WorkHubIntegration,
  type WorkHubSource,
} from './workHubSync'
import { useWorkHubSync } from './useWorkHubSync'
import { WORK_HUB_TABS } from '../integrations/github-model'
import type { Client, Project, TaskSettings, UserAccount, WorkItem } from '../../shared/types'
import { findCommunicationTaskDuplicate } from './communicationTasks'
import { composeEmail, useEmailEnabled } from '../email/EmailComposer'
import { extractAddress, quoteReply, replySubject } from '../email/emailCompose'
import ClientSelect from '../../shared/ui/SearchSelect'
import { EmailTemplatesManager } from '../email/EmailTemplates'
import { requestJson, type HttpMethod } from '../../shared/http'

type Message = {
  id: string
  source: 'Gmail' | 'Discord' | 'Manual'
  subject: string
  body: string
  sender: string
  source_label?: string
  source_labels?: string[]
  thread_id?: string
  attachments?: Attachment[]
  status: string
  received_at: string
  linked_task_id?: string
  linked_task_ids?: string[]
}
// Older Gmail rows stored only file names; newer rows also carry part id, type and size.
type Attachment = string | { name: string; partId?: string; mimeType?: string; size?: number }
type Settings = {
  discordUserId: string
  captureMentions: boolean
  gmailEmail: string
  gmailLabels: string[]
  gmailLabelCatalog: Label[]
  gmailConnected: boolean
  gmailReconnectRequired: boolean
  gmailAvailable: boolean
  gmailPlatformEnabled: boolean
  callbackUrl: string
}
type Label = { id: string; name: string }
type ViewPreferences = { layout: 'cards' | 'rows'; pageSize: 5 | 10 | 15 }
function readView(key: string): ViewPreferences {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '{}')
    return {
      layout: value.layout === 'rows' ? 'rows' : 'cards',
      pageSize: value.pageSizeVersion === 2 && [5, 10, 15].includes(value.pageSize) ? value.pageSize : 5,
    }
  } catch {
    return { layout: 'cards', pageSize: 5 }
  }
}
function fileSize(bytes?: number) {
  if (!bytes || bytes < 0) return ''
  return bytes < 1024
    ? `${bytes} B`
    : bytes < 1048576
      ? `${Math.round(bytes / 1024)} KB`
      : `${(bytes / 1048576).toFixed(1)} MB`
}
type DriveTarget = {
  id: string
  title: string
  kind: 'Task' | 'Subtask'
  parentTaskId?: string
  clientName: string
  projectName: string
}
type DriveOptions = { available: boolean; onSaved: () => Promise<void> }
/** Gmail attachments are fetched from Gmail when clicked; the app never stores the file. */
function AttachmentList({ message, drive }: { message: Message; drive?: DriveOptions }) {
  const [pending, setPending] = useState<number | null>(null),
    [error, setError] = useState('')
  const [picking, setPicking] = useState<number | null>(null),
    [targets, setTargets] = useState<DriveTarget[] | null>(null),
    [target, setTarget] = useState('')
  const [saved, setSaved] = useState<Record<number, { url: string; where: string }>>({}),
    [driveNote, setDriveNote] = useState('')
  const files = (message.attachments || [])
    .map(entry => (typeof entry === 'string' ? { name: entry } : entry))
    .filter(entry => entry?.name)
  if (!files.length) return null
  const gmail = message.source === 'Gmail',
    canSave = gmail && Boolean(drive?.available)
  const download = async (index: number, name: string) => {
    setPending(index)
    setError('')
    try {
      const response = await fetch(`/api/communications/${encodeURIComponent(message.id)}/attachments/${index}`, {
        credentials: 'same-origin',
      })
      if (!response.ok) {
        const result = await response.json().catch(() => ({}))
        throw new Error(result.error || 'Could not download this attachment.')
      }
      const url = URL.createObjectURL(await response.blob()),
        link = document.createElement('a')
      link.href = url
      link.download = name
      document.body.appendChild(link)
      link.click()
      link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 10000)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not download this attachment.')
    } finally {
      setPending(null)
    }
  }
  const openPicker = async (index: number) => {
    // Always reload: a task may have been created since the picker was last opened.
    setError('')
    setDriveNote('')
    setPicking(index)
    setTargets(null)
    try {
      const result = (await request(`/api/communications/${encodeURIComponent(message.id)}/drive-targets`)) as {
        targets: DriveTarget[]
      }
      setTargets(result.targets)
      setTarget(result.targets[0]?.id || '')
    } catch (e) {
      setPicking(null)
      setError(e instanceof Error ? e.message : 'Could not load tasks for this email.')
    }
  }
  const targetLabel = (t: DriveTarget) =>
    t.kind === 'Subtask'
      ? `↳ ${t.title}`
      : `${t.title}${t.clientName || t.projectName ? ` — ${[t.clientName, t.projectName].filter(Boolean).join(' / ')}` : ''}`
  const saveToDrive = async (index: number) => {
    const chosen = targets?.find(t => t.id === target)
    if (!chosen) return
    setPending(index)
    setError('')
    setDriveNote('')
    try {
      const response = await fetch(`/api/communications/${encodeURIComponent(message.id)}/attachments/${index}/drive`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: chosen.id }),
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok && result.code !== 'ALREADY_SAVED')
        throw new Error(result.error || 'Could not save this attachment to Google Drive.')
      const where = chosen.kind === 'Subtask' ? `subtask “${chosen.title}”` : `task “${chosen.title}”`
      if (result.file?.url) setSaved(previous => ({ ...previous, [index]: { url: result.file.url, where } }))
      setPicking(null)
      if (result.code === 'ALREADY_SAVED') {
        setDriveNote(result.error)
        return
      }
      try {
        await drive?.onSaved()
      } catch {
        setDriveNote('Saved to Google Drive. Refresh the workspace to see the link on the task.')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save this attachment to Google Drive.')
    } finally {
      setPending(null)
    }
  }
  return (
    <div className="communication-attachments">
      <strong>Attachments</strong>
      <ul>
        {files.map((file, index) => (
          <li key={`${index}:${file.name}`}>
            <div className="communication-attachment-row">
              {gmail ? (
                <button
                  type="button"
                  className="communication-attachment-link"
                  disabled={pending !== null}
                  onClick={() => void download(index, file.name)}
                  aria-label={`Download ${file.name}`}
                >
                  <Paperclip size={14} aria-hidden="true" />
                  <span>{file.name}</span>
                </button>
              ) : (
                <span className="communication-attachment-name">
                  <Paperclip size={14} aria-hidden="true" />
                  {file.name}
                </span>
              )}
              {'size' in file && fileSize(file.size) ? <small>{fileSize(file.size)}</small> : null}
              {canSave && picking !== index && (
                <button
                  type="button"
                  className="secondary compact communication-drive-button"
                  disabled={pending !== null}
                  onClick={() => void openPicker(index)}
                >
                  <CloudUpload size={14} aria-hidden="true" /> Save to Drive
                </button>
              )}
              {pending === index ? (
                <small role="status">{picking === index ? 'Saving to Drive…' : 'Downloading…'}</small>
              ) : null}
              {saved[index] && (
                <a
                  className="communication-drive-saved"
                  href={saved[index].url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Saved to {saved[index].where} · Open in Drive
                </a>
              )}
            </div>
            {picking === index && (
              <div className="communication-drive-picker">
                {targets === null ? (
                  <small role="status">Loading tasks…</small>
                ) : targets.length === 0 ? (
                  <>
                    <p>
                      No task has been created from this email thread yet. Use “Create a project task” below (tasks made
                      on the Tasks page are not linked to emails), then save the file to it or one of its subtasks.
                    </p>
                    <button type="button" className="secondary compact" onClick={() => setPicking(null)}>
                      Close
                    </button>
                  </>
                ) : (
                  <>
                    <label>
                      Save “{file.name}” to
                      <select value={target} disabled={pending !== null} onChange={e => setTarget(e.target.value)}>
                        {targets.map(t => (
                          <option key={t.id} value={t.id}>
                            {targetLabel(t)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <small>
                      Goes to the team Drive folder Client / Project / Task
                      {targets.find(t => t.id === target)?.kind === 'Subtask' ? ' / Subtask' : ''}. Everyone with access
                      to that Drive can open it.
                    </small>
                    <div className="communication-drive-actions">
                      <button
                        type="button"
                        className="primary compact"
                        disabled={pending !== null || !target}
                        onClick={() => void saveToDrive(index)}
                      >
                        {pending === index ? 'Saving…' : 'Save'}
                      </button>
                      <button
                        type="button"
                        className="secondary compact"
                        disabled={pending !== null}
                        onClick={() => setPicking(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
      {driveNote && <p role="status">{driveNote}</p>}
      {error && <p role="alert">{error}</p>}
    </div>
  )
}
class CommunicationRequestError extends Error {
  constructor(
    message: string,
    public code?: string,
  ) {
    super(message)
  }
}
const request = (url: string, method = 'GET', body?: unknown, signal?: AbortSignal) =>
  requestJson(url, {
    method: method as HttpMethod,
    body,
    signal,
    fallback: 'Communication request failed.',
    error: (message, _status, data) => new CommunicationRequestError(message, data.code),
  })
export default function WorkHub({
  clients,
  projects,
  accounts,
  tasks,
  taskSettings,
  currentUser,
  onTaskCreated,
}: {
  clients: Client[]
  projects: Project[]
  accounts: UserAccount[]
  tasks: WorkItem[]
  taskSettings?: TaskSettings
  currentUser: UserAccount
  onTaskCreated: () => Promise<void>
}) {
  const [items, setItems] = useState<Message[]>([]),
    [settings, setSettings] = useState<Settings | null>(null),
    [labels, setLabels] = useState<Label[]>([])
  const [tab, setTab] = useState('Gmail'),
    [archived, setArchived] = useState(false),
    [labelFilter, setLabelFilter] = useState(''),
    [selected, setSelected] = useState<Message | null>(null),
    [compose, setCompose] = useState(false),
    [config, setConfig] = useState(false)
  const [title, setTitle] = useState(''),
    [description, setDescription] = useState(''),
    [clientId, setClientId] = useState(''),
    [projectId, setProjectId] = useState(''),
    [assignee, setAssignee] = useState(currentUser.id)
  const [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false)
  const hubSync = useWorkHubSync()
  const canEmail = useEmailEnabled()
  const [replying, setReplying] = useState(false)
  const [templatesOpen, setTemplatesOpen] = useState(false)
  const [sendStatus, setSendStatus] = useState<{ canSend: boolean } | null>(null)
  const [driveAvailable, setDriveAvailable] = useState(false)
  useEffect(() => {
    if (!settings?.gmailAvailable) {
      setDriveAvailable(false)
      return
    }
    const controller = new AbortController()
    void request('/api/communications/drive', 'GET', undefined, controller.signal)
      .then(r => setDriveAvailable(Boolean(r.available)))
      .catch(() => {
        if (!controller.signal.aborted) setDriveAvailable(false)
      })
    return () => controller.abort()
  }, [settings?.gmailAvailable])
  useEffect(() => {
    if (!config || !settings?.gmailConnected) {
      setSendStatus(null)
      return
    }
    const controller = new AbortController()
    void request('/api/communications/send/status', 'GET', undefined, controller.signal)
      .then(result => setSendStatus({ canSend: Boolean(result.canSend) }))
      .catch(() => {
        if (!controller.signal.aborted) setSendStatus(null)
      })
    return () => controller.abort()
  }, [config, settings?.gmailConnected])
  const driveOptions: DriveOptions = { available: driveAvailable, onSaved: onTaskCreated }
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const detailRef = useRef<HTMLDivElement>(null)
  const taskTitleRef = useRef<HTMLInputElement>(null),
    creatingTask = useRef(false),
    focusTaskTitle = useRef(false)
  useEffect(() => {
    if (!busy && focusTaskTitle.current) {
      focusTaskTitle.current = false
      taskTitleRef.current?.focus()
    }
  }, [busy])
  const [openCount, setOpenCount] = useState(0),
    [labelsLoading, setLabelsLoading] = useState(false)
  const viewKey = `communications-view:${currentUser.organizationId || ''}:${currentUser.id}`
  const [view, setView] = useState<ViewPreferences>(() => readView(viewKey))
  const [page, setPage] = useState(1),
    [total, setTotal] = useState(0),
    [loading, setLoading] = useState(true),
    [listError, setListError] = useState(''),
    [refresh, setRefresh] = useState(0)
  const [selectedThread, setSelectedThread] = useState<Message[]>([]),
    [threadPage, setThreadPage] = useState(1),
    [threadTotal, setThreadTotal] = useState(0),
    [threadLoading, setThreadLoading] = useState(false),
    [threadError, setThreadError] = useState(''),
    [threadRetry, setThreadRetry] = useState(0)
  const changeView = (next: ViewPreferences) => {
    setView(next)
    if (next.pageSize !== view.pageSize) setPage(1)
    try {
      localStorage.setItem(viewKey, JSON.stringify({ ...next, pageSizeVersion: 2 }))
    } catch {
      /* Preferences still work when browser storage is unavailable. */
    }
  }
  const load = async (signal?: AbortSignal) => {
    const prefs: Settings = await request('/api/communications/settings', 'GET', undefined, signal)
    if (!alive.current || signal?.aborted) return prefs
    const catalog = prefs.gmailLabelCatalog || []
    setSettings(prefs)
    setLabels(catalog)
    return prefs
  }
  const source = tab.toLowerCase() as WorkHubSource
  const sourceRevision = source === 'manual' ? hubSync.manualRevision : hubSync.integrations[source].revision
  const reloadMessages = () => {
    workHubSync.invalidate(source)
    setRefresh(value => value + 1)
  }
  const syncSource = (id: WorkHubIntegration) => act(() => workHubSync.syncOne(id))
  useEffect(() => {
    setThreadPage(1)
  }, [sourceRevision])
  useEffect(() => {
    if (!openCount) return
    const frame = requestAnimationFrame(() => {
      const detail = detailRef.current
      if (!detail) return
      const topbar = detail.closest('.app-shell')?.querySelector('.topbar')
      detail.style.scrollMarginTop = `${(topbar?.getBoundingClientRect().height || 0) + 16}px`
      detail.focus({ preventScroll: true })
      detail.scrollIntoView({
        block: 'start',
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      })
    })
    return () => cancelAnimationFrame(frame)
  }, [openCount])
  useEffect(() => {
    setView(readView(viewKey))
    setPage(1)
    setSelected(null)
    setItems([])
  }, [viewKey])
  useEffect(() => {
    if (tab === 'GitHub') {
      setItems([])
      setLoading(false)
      return
    }
    const controller = new AbortController()
    let active = true
    setLoading(true)
    setListError('')
    const query = new URLSearchParams({
      page: String(page),
      pageSize: String(view.pageSize),
      tab,
      archived: String(archived),
      ...(tab === 'Gmail' && labelFilter ? { label: labelFilter } : {}),
    })
    void workHubSync
      .read(source, `/api/communications?${query}`, controller.signal)
      .then(result => {
        if (!active) return
        const lastPage = Math.max(1, Math.ceil(result.total / view.pageSize))
        if (page > lastPage) {
          setPage(lastPage)
          return
        }
        setItems(result.items)
        setTotal(result.total)
        setLoading(false)
      })
      .catch(e => {
        if (active && e.name !== 'AbortError') {
          setListError(e.message)
          setLoading(false)
          setItems([])
          setTotal(0)
        }
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [viewKey, tab, archived, labelFilter, page, view.pageSize, refresh, sourceRevision])
  useEffect(() => {
    if (!selected) return
    const controller = new AbortController()
    let active = true
    setThreadLoading(true)
    setThreadError('')
    void workHubSync
      .read(
        selected.source.toLowerCase() as WorkHubSource,
        `/api/communications/${selected.id}/thread?page=${threadPage}`,
        controller.signal,
      )
      .then(result => {
        if (active) {
          setSelectedThread(previous => (threadPage === 1 ? result.items : [...previous, ...result.items]))
          setThreadTotal(result.total)
          setThreadLoading(false)
        }
      })
      .catch(e => {
        if (active && e.name !== 'AbortError') {
          setThreadError(e.message)
          setThreadLoading(false)
        }
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [selected?.id, threadPage, threadRetry, sourceRevision])
  useEffect(() => {
    const result = new URLSearchParams(window.location.hash.slice(1)).get('gmail')
    if (result) {
      setMessage(
        result === 'connected'
          ? 'Your Gmail account is connected. Select the labels to monitor, save settings, then click Sync Gmail.'
          : result === 'send-enabled'
            ? 'Sending is allowed. You can now email documents from the tracker: use Email on a saved file or a signed document, or New email here.'
            : result === 'send-denied'
              ? 'Gmail is connected, but permission to send email was not given. Try Allow sending again and keep every box ticked on Google’s page.'
              : result === 'denied'
                ? 'Gmail authorization was cancelled.'
                : 'Gmail connection did not complete. Check the account OAuth settings, redirect URI, and your Google test-user access.',
      )
      window.history.replaceState(null, '', window.location.pathname + window.location.search)
    }
    const controller = new AbortController()
    void load(controller.signal).catch(e => {
      if (e.name !== 'AbortError') setMessage(e.message)
    })
    return () => controller.abort()
  }, [currentUser.id, currentUser.organizationId])
  const act = async (fn: () => Promise<void>) => {
    setBusy(true)
    setMessage('')
    try {
      await fn()
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Request failed.')
    } finally {
      setBusy(false)
    }
  }
  const saveSettings = () =>
    act(async () => {
      await request('/api/communications/settings', 'PUT', settings)
      await load()
      setMessage('Your communication preferences were saved. Use Sync Gmail to import selected labels.')
    })
  const beginGmail = () =>
    act(async () => {
      const result = await request('/api/communications/gmail/connect')
      window.location.assign(result.url)
    })
  const fetchLabels = () =>
    act(async () => {
      setLabelsLoading(true)
      try {
        const result = await request('/api/communications/gmail/labels')
        setLabels(result.labels)
      } finally {
        setLabelsLoading(false)
      }
    })
  const sync = () => syncSource('gmail')
  const update = (status: string) =>
    act(async () => {
      if (!selected) return
      await request(`/api/communications/${selected.id}`, 'PATCH', { status })
      await load()
      reloadMessages()
      setSelected(null)
    })
  const showDuplicateTask = (name: string) => {
    const warning = `Duplicate task: “${name}” already exists for this client and project. Enter a different task title.`
    setMessage(warning)
    window.alert(warning)
    focusTaskTitle.current = creatingTask.current
    taskTitleRef.current?.focus()
  }
  const createTask = () => {
    if (!selected || busy || creatingTask.current) return
    const duplicate = findCommunicationTaskDuplicate(tasks, { title, clientId, projectId })
    if (duplicate) {
      showDuplicateTask(duplicate.title)
      return
    }
    const communication = selected
    creatingTask.current = true
    return act(async () => {
      try {
        const result = await request(`/api/communications/${communication.id}/create-task`, 'POST', {
          title,
          description,
          clientId,
          projectId,
          assignedToUserId: assignee,
        })
        if (!alive.current) return
        setSelected(previous =>
          previous?.id === communication.id ? { ...previous, linked_task_id: result.task.id } : previous,
        )
        setTitle('')
        setDescription('')
        focusTaskTitle.current = true
        const warnings: string[] = result.warning ? [result.warning] : []
        try {
          await onTaskCreated()
        } catch {
          warnings.push('The workspace list could not refresh. Refresh the workspace to see the saved task.')
        }
        if (!alive.current) return
        reloadMessages()
        setMessage(
          `Task “${result.task.title}” created. You can create another task from this message. The original communication remains private to you.${warnings.length ? ' ' + warnings.join(' ') : ''}`,
        )
      } catch (error) {
        if (error instanceof CommunicationRequestError && error.code === 'DUPLICATE_TASK') showDuplicateTask(title)
        else throw error
      } finally {
        creatingTask.current = false
      }
    })
  }
  const replyByEmail = async () => {
    if (!selected || replying) return
    setReplying(true)
    const thread = selectedThread.length ? selectedThread : [selected]
    // Reply to the latest message from someone else, not to a copy of your own sent email.
    const received = [...thread].reverse().find(entry => !entry.source_labels?.includes('SENT')) || selected
    const linked: string[] = Array.from(
      new Set<string>(
        thread.flatMap((entry: Message) => [
          ...(entry.linked_task_ids || []),
          ...(entry.linked_task_id ? [entry.linked_task_id] : []),
        ]),
      ),
    ).filter(id => tasks.some(task => task.id === id))
    // Like Reply all: the sender gets the reply and everyone else on the email is copied. Gmail is asked at this moment, so older saved emails work too.
    let to = extractAddress(received.sender),
      cc = '',
      notice = ''
    try {
      const response = await fetch(`/api/communications/${encodeURIComponent(received.id)}/reply-recipients`, {
        credentials: 'same-origin',
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(String(result.error || ''))
      if (Array.isArray(result.to) && result.to.length) {
        to = result.to.join(', ')
        cc = Array.isArray(result.cc) ? result.cc.join(', ') : ''
      }
    } catch {
      notice =
        'The other people on the original email could not be read from Gmail, so only the sender was added. Add anyone else to Cc yourself.'
    }
    composeEmail({
      replyToId: received.id,
      to,
      cc,
      autoCc: Boolean(cc),
      notice,
      subject: replySubject(received.subject),
      message: quoteReply(received.sender, received.received_at, received.body),
      taskIds: linked,
    })
    setReplying(false)
  }
  const pages = Math.max(1, Math.ceil(total / view.pageSize))
  const openMessage = (item: Message) => {
    if (busy) return
    setSelected(item)
    setOpenCount(value => value + 1)
    setSelectedThread([])
    setThreadPage(1)
    setThreadTotal(0)
    setThreadError('')
    setThreadRetry(value => value + 1)
    setCompose(false)
    setMessage('')
    setTitle(item.subject || 'Follow up')
    setDescription('')
    setClientId('')
    setProjectId('')
    setAssignee(currentUser.id)
  }
  return (
    <section className="communications-hub page-stack">
      {templatesOpen && (
        <EmailTemplatesManager
          userId={currentUser.id}
          canWrite={currentUser.role !== 'Viewer'}
          onClose={() => setTemplatesOpen(false)}
        />
      )}
      <div className="panel communications-heading">
        <div>
          <h2>Work Hub</h2>
          <p>
            Your email, Discord messages, GitHub/GitLab tickets and manual logs in one place. Your imported content
            stays private; you choose what to share through tasks.
          </p>
          <small>
            Connected integrations sync once at sign-in. Refresh now syncs all integrations; each Sync button refreshes
            only its own integration.
          </small>
        </div>
        <div className="integration-actions">
          <button
            className="secondary"
            disabled={
              hubSync.allRunning || WORK_HUB_INTEGRATIONS.some(id => hubSync.integrations[id].phase === 'syncing')
            }
            onClick={() => void workHubSync.syncAll()}
          >
            {hubSync.allRunning ? 'Refreshing…' : 'Refresh now'}
          </button>
          <button className="secondary" onClick={() => setConfig(!config)}>
            My integration settings
          </button>
          {canEmail && (
            <button className="secondary" disabled={busy} onClick={() => composeEmail({})}>
              New email
            </button>
          )}
          {canEmail && (
            <button className="secondary" onClick={() => setTemplatesOpen(true)}>
              Email templates
            </button>
          )}
          <button
            className="primary"
            disabled={busy || currentUser.role === 'Viewer'}
            onClick={() => {
              setTab('Manual')
              setArchived(false)
              setSelected(null)
              setCompose(true)
              setTitle('')
              setDescription('')
            }}
          >
            + New manual log
          </button>
        </div>
      </div>
      {message && (
        <p className="settings-message" role="status">
          {message}
        </p>
      )}
      <div className="work-hub-sync-status" aria-live="polite">
        {WORK_HUB_INTEGRATIONS.filter(id =>
          ['syncing', 'success', 'error'].includes(hubSync.integrations[id].phase),
        ).map(id => (
          <p
            className="settings-message"
            key={id}
            role={hubSync.integrations[id].phase === 'error' ? 'alert' : 'status'}
          >
            {hubSync.integrations[id].message}
          </p>
        ))}
      </div>
      {config && settings && (
        <div className="panel communication-settings">
          <div className="panel-heading">
            <h2>My integration settings</h2>
          </div>
          <div className="communication-settings-grid">
            <div>
              <h3>Gmail</h3>
              <p>
                {settings.gmailConnected
                  ? `Connected: ${settings.gmailEmail}`
                  : 'Connect your own Google account to import messages from selected Gmail labels.'}
              </p>
              {settings.gmailAvailable ? (
                settings.gmailConnected ? (
                  <>
                    <small>
                      Selected labels sync messages from the latest 10 days once at sign-in or when you click Refresh
                      now or Sync Gmail. Previously imported messages remain in your Hub.
                    </small>
                    <button className="secondary" disabled={busy || labelsLoading} onClick={fetchLabels}>
                      Refresh Gmail labels
                    </button>
                    {sendStatus &&
                      (sendStatus.canSend ? (
                        <small>Sending email from the tracker is allowed.</small>
                      ) : (
                        <button
                          className="secondary"
                          disabled={busy}
                          title="Opens Google to approve sending email as you. Needed once."
                          onClick={() =>
                            void act(async () => {
                              const result = await request('/api/communications/gmail/connect?send=1')
                              window.location.assign(result.url)
                            })
                          }
                        >
                          Allow sending email
                        </button>
                      ))}
                    <button
                      className="secondary"
                      disabled={busy || hubSync.integrations.gmail.phase === 'syncing'}
                      onClick={sync}
                    >
                      {hubSync.integrations.gmail.phase === 'syncing' ? 'Syncing Gmail…' : 'Sync Gmail'}
                    </button>
                    <button
                      className="secondary danger-button"
                      disabled={busy}
                      onClick={() => {
                        if (
                          window.confirm('Disconnect your Gmail account? Imported private messages remain in your Hub.')
                        )
                          void act(async () => {
                            await request('/api/communications/gmail', 'DELETE')
                            await load()
                          })
                      }}
                    >
                      Disconnect
                    </button>
                  </>
                ) : (
                  <button className="primary" disabled={busy} onClick={beginGmail}>
                    {settings.gmailReconnectRequired ? 'Reconnect Gmail' : 'Connect Gmail'}
                  </button>
                )
              ) : (
                <small>
                  {settings.gmailPlatformEnabled
                    ? 'Ask your account administrator to configure Gmail in Settings → Integrations.'
                    : 'Internal Admin must enable Gmail for this account first.'}
                </small>
              )}
              {labels.length > 0 && (
                <div className="communication-labels">
                  {labels.map(label => (
                    <label key={label.id}>
                      <input
                        type="checkbox"
                        checked={settings.gmailLabels.includes(label.id)}
                        onChange={e =>
                          setSettings({
                            ...settings,
                            gmailLabels: e.target.checked
                              ? [...settings.gmailLabels, label.id]
                              : settings.gmailLabels.filter(id => id !== label.id),
                          })
                        }
                      />
                      {label.name}
                    </label>
                  ))}
                </div>
              )}
              {settings.gmailLabels.length > 0 && !labels.length && (
                <p>
                  Monitoring {settings.gmailLabels.length} saved label{settings.gmailLabels.length === 1 ? '' : 's'}.
                  Refresh labels to change them.
                </p>
              )}
            </div>
            <div>
              <h3>Discord</h3>
              <p>
                Link your personal Discord user ID. The existing workspace bot captures mentions of you and your DMs to
                the bot. Your Hub loads those saved messages once at sign-in or when you sync Discord.
              </p>
              <label>
                My Discord user ID
                <input
                  value={settings.discordUserId}
                  onChange={e => setSettings({ ...settings, discordUserId: e.target.value })}
                  placeholder="Numeric Discord user ID"
                />
              </label>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={settings.captureMentions}
                  onChange={e => setSettings({ ...settings, captureMentions: e.target.checked })}
                />
                Capture mentions of me
              </label>
              <small>
                Personal person-to-person DMs cannot be captured by the bot. The bot needs access to the server channel
                and message content.
              </small>
            </div>
          </div>
          <p>
            GitHub and GitLab use your own personal tokens.{' '}
            <button
              className="secondary"
              disabled={busy}
              onClick={() => {
                setTab('GitHub')
                setConfig(false)
                setSelected(null)
                setCompose(false)
              }}
            >
              Open Git ticket settings
            </button>
          </p>
          <button className="primary" disabled={busy} onClick={saveSettings}>
            Save my settings
          </button>
        </div>
      )}
      <div className="panel communication-results">
        <div className="communication-tabs" role="group" aria-label="Work Hub source">
          {WORK_HUB_TABS.map(({ id, label }) => (
            <button
              key={id}
              className={tab === id ? 'active' : ''}
              aria-pressed={tab === id}
              disabled={busy}
              onClick={() => {
                setTab(id)
                setPage(1)
                setArchived(false)
                setSelected(null)
                setCompose(false)
              }}
            >
              {label}
            </button>
          ))}
        </div>
        {tab === 'GitHub' ? (
          <GitProviderHub
            key={viewKey}
            clients={clients}
            projects={projects}
            accounts={accounts}
            tasks={tasks}
            taskSettings={taskSettings}
            currentUser={currentUser}
            onTaskCreated={onTaskCreated}
          />
        ) : (
          <>
            <div className="communication-toolbar">
              {source === 'manual' ? (
                <button className="secondary" disabled={loading || busy} onClick={reloadMessages}>
                  Refresh logs
                </button>
              ) : (
                <button
                  className="secondary"
                  disabled={
                    busy ||
                    hubSync.integrations[source].phase === 'syncing' ||
                    (source === 'gmail'
                      ? !settings?.gmailConnected || !settings?.gmailAvailable || !settings?.gmailLabels.length
                      : !settings?.discordUserId)
                  }
                  onClick={() => void syncSource(source)}
                >
                  {hubSync.integrations[source].phase === 'syncing'
                    ? `Syncing ${integrationLabel[source]}…`
                    : `Sync ${integrationLabel[source]}`}
                </button>
              )}
              {tab === 'Gmail' && settings?.gmailLabels.length ? (
                <label className="communication-label-filter">
                  Gmail label{' '}
                  <select
                    value={labelFilter}
                    onChange={e => {
                      setLabelFilter(e.target.value)
                      setPage(1)
                    }}
                  >
                    <option value="">All monitored labels</option>
                    {settings.gmailLabels.map((id, index) => (
                      <option key={id} value={id}>
                        {labels.find(x => x.id === id)?.name ||
                          (labelsLoading ? `Loading label ${index + 1}…` : `Unavailable label ${index + 1}`)}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <span className="communication-view-title">
                  {tab === 'Manual' ? 'Manual logs' : tab === 'Gmail' ? 'Email messages' : 'Discord messages'}
                </span>
              )}
              <div className="communication-view-controls">
                <label className="communication-page-size">
                  Show{' '}
                  <select
                    value={archived ? 'archived' : 'active'}
                    disabled={busy}
                    onChange={e => {
                      setArchived(e.target.value === 'archived')
                      setPage(1)
                      setSelected(null)
                    }}
                  >
                    <option value="active">Active</option>
                    <option value="archived">Archived</option>
                  </select>
                </label>
                <div className="communication-layout" role="group" aria-label="Communication layout">
                  <button
                    aria-pressed={view.layout === 'cards'}
                    onClick={() => changeView({ ...view, layout: 'cards' })}
                  >
                    <LayoutGrid size={16} aria-hidden="true" />
                    Cards
                  </button>
                  <button aria-pressed={view.layout === 'rows'} onClick={() => changeView({ ...view, layout: 'rows' })}>
                    <List size={16} aria-hidden="true" />
                    Rows
                  </button>
                </div>
                <label className="communication-page-size">
                  Per page{' '}
                  <select
                    value={view.pageSize}
                    onChange={e =>
                      changeView({ ...view, pageSize: Number(e.target.value) as ViewPreferences['pageSize'] })
                    }
                  >
                    {[5, 10, 15].map(size => (
                      <option key={size} value={size}>
                        {size}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>
            <div aria-busy={loading}>
              {loading ? (
                <p className="communication-empty" role="status">
                  Loading messages…
                </p>
              ) : listError ? (
                <div className="communication-empty" role="alert">
                  {listError}{' '}
                  <button className="secondary" onClick={() => reloadMessages()}>
                    Retry
                  </button>
                </div>
              ) : items.length ? (
                <div className={`communication-list communication-list--${view.layout}`}>
                  {items.map(item => (
                    <button
                      key={item.id}
                      className="communication-card"
                      aria-pressed={selected?.id === item.id}
                      onClick={() => openMessage(item)}
                    >
                      <span className="communication-card-meta">
                        <strong className="communication-source">
                          {item.source === 'Gmail'
                            ? item.source_labels?.includes('SENT')
                              ? 'Sent email'
                              : 'Email'
                            : item.source === 'Manual'
                              ? 'Manual Log'
                              : item.source}
                        </strong>
                        <span className="communication-status">{item.status}</span>
                        <time dateTime={item.received_at}>{new Date(item.received_at).toLocaleString()}</time>
                      </span>
                      <span className="communication-card-content">
                        <span className="communication-subject">{item.subject || 'Untitled communication'}</span>
                        <span className="communication-sender">{item.sender}</span>
                        <span className="communication-preview">
                          {item.body.slice(0, 180) || 'Open to review this message.'}
                        </span>
                      </span>
                      <span className="communication-card-footer">
                        {item.linked_task_id && <span className="communication-task-badge">Task created</span>}
                        <span className="communication-open">
                          Open message <ChevronRight size={15} aria-hidden="true" />
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="communication-empty">No communications in this view.</p>
              )}
            </div>
            <div className="communication-pagination">
              <span role="status">
                {loading
                  ? 'Loading…'
                  : listError
                    ? 'Unable to load messages'
                    : total
                      ? `Showing ${(page - 1) * view.pageSize + 1}–${Math.min(page * view.pageSize, total)} of ${total}`
                      : 'Showing 0 messages'}
              </span>
              <div className="communication-page-buttons">
                <button
                  className="secondary"
                  aria-label="Previous page"
                  disabled={loading || Boolean(listError) || page <= 1}
                  onClick={() => setPage(value => value - 1)}
                >
                  <ChevronLeft size={16} aria-hidden="true" />
                  Previous
                </button>
                <span>
                  Page {page} of {pages}
                </span>
                <button
                  className="secondary"
                  aria-label="Next page"
                  disabled={loading || Boolean(listError) || page >= pages}
                  onClick={() => setPage(value => value + 1)}
                >
                  Next
                  <ChevronRight size={16} aria-hidden="true" />
                </button>
              </div>
            </div>
          </>
        )}
      </div>
      {tab !== 'GitHub' && (selected || compose) && (
        <div
          className="panel communication-detail"
          ref={detailRef}
          tabIndex={-1}
          role="region"
          aria-label="Message details"
        >
          <div className="panel-heading">
            <div>
              <h2>{selected ? selected.subject || 'Communication' : 'New private manual log'}</h2>
              <p>
                {selected
                  ? `${selected.source} · ${selected.sender} · ${selected.status}`
                  : 'Visible only to your account'}
              </p>
            </div>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => {
                setSelected(null)
                setCompose(false)
              }}
            >
              Close
            </button>
          </div>
          {selected ? (
            <>
              <div className="communication-body">
                {threadLoading && !selectedThread.length ? (
                  <p role="status">Loading thread…</p>
                ) : threadError && !selectedThread.length ? (
                  <p role="alert">
                    {threadError}{' '}
                    <button className="secondary" onClick={() => setThreadRetry(value => value + 1)}>
                      Retry thread
                    </button>
                  </p>
                ) : selectedThread.length > 1 ? (
                  selectedThread.map(entry => (
                    <article key={entry.id} className="communication-thread-message">
                      <strong>
                        {entry.sender} · {new Date(entry.received_at).toLocaleString()}
                        {entry.source_labels?.includes('SENT') ? ' · Sent from the tracker' : ''}
                      </strong>
                      <p>{entry.body || 'No plain text body available.'}</p>
                      <AttachmentList message={entry} drive={driveOptions} />
                    </article>
                  ))
                ) : (
                  <>
                    {selected.body || 'No plain text body available.'}
                    <AttachmentList message={selected} drive={driveOptions} />
                  </>
                )}
                {threadError && selectedThread.length > 0 && (
                  <p role="alert">
                    {threadError}{' '}
                    <button className="secondary" onClick={() => setThreadRetry(value => value + 1)}>
                      Retry thread
                    </button>
                  </p>
                )}
                {!threadError && selectedThread.length > 0 && selectedThread.length < threadTotal && (
                  <button
                    className="secondary"
                    disabled={threadLoading}
                    onClick={() => setThreadPage(value => value + 1)}
                  >
                    {threadLoading
                      ? 'Loading…'
                      : `Load more thread messages (${selectedThread.length} of ${threadTotal})`}
                  </button>
                )}
              </div>
              <div className="integration-actions">
                {canEmail && selected.source === 'Gmail' && (
                  <button className="secondary" disabled={busy || replying} onClick={replyByEmail}>
                    {replying ? 'Opening reply…' : 'Reply by email'}
                  </button>
                )}
                {selected.status !== 'Resolved' && (
                  <button className="secondary" disabled={busy} onClick={() => update('Resolved')}>
                    Resolve
                  </button>
                )}
                {selected.status !== 'Archived' && (
                  <button className="secondary" disabled={busy} onClick={() => update('Archived')}>
                    Archive
                  </button>
                )}
                {selected.status === 'Archived' && (
                  <button className="secondary" disabled={busy} onClick={() => update('Open')}>
                    Restore
                  </button>
                )}
              </div>
            </>
          ) : null}
          {!selected && compose ? (
            <>
              <label>
                Subject
                <input value={title} onChange={e => setTitle(e.target.value)} />
              </label>
              <label>
                Message
                <textarea value={description} onChange={e => setDescription(e.target.value)} />
              </label>
              <button
                className="primary"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await request('/api/communications', 'POST', { subject: title, body: description })
                    await load()
                    reloadMessages()
                    setCompose(false)
                  })
                }
              >
                Save private log
              </button>
            </>
          ) : null}
          {selected && currentUser.role !== 'Viewer' && (
            <div className="communication-task-form">
              <h3>Create a project task</h3>
              <p>
                Enter only the information User B should see. The email or Discord thread and sender are never copied
                into the task.
              </p>
              <div className="communication-fields">
                <label>
                  Task title
                  <input
                    ref={taskTitleRef}
                    disabled={busy}
                    value={title}
                    maxLength={200}
                    onChange={e => setTitle(e.target.value)}
                  />
                </label>
                <label>
                  Client
                  <ClientSelect
                    clients={clients.filter(x => !x.archived)}
                    value={clientId}
                    onChange={value => setClientId(value)}
                    extra={[{ value: '', label: 'Select client' }]}
                    disabled={busy}
                  />
                </label>
                <label>
                  Project
                  <select disabled={busy} value={projectId} onChange={e => setProjectId(e.target.value)}>
                    <option value="">Select project</option>
                    {projects
                      .filter(x => !x.archived)
                      .map(x => (
                        <option key={x.id} value={x.id}>
                          {x.name}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  Assign to
                  <select disabled={busy} value={assignee} onChange={e => setAssignee(e.target.value)}>
                    {accounts
                      .filter(x => x.status !== 'Disabled' && x.role !== 'Viewer')
                      .map(x => (
                        <option key={x.id} value={x.id}>
                          {x.name || x.username}
                        </option>
                      ))}
                  </select>
                </label>
              </div>
              <label>
                Shared task description
                <textarea
                  disabled={busy}
                  value={description}
                  maxLength={5000}
                  onChange={e => setDescription(e.target.value)}
                  placeholder="Write a summary for the assignee. The private message is not included."
                />
              </label>
              <button
                className="primary"
                disabled={busy || !title.trim() || !clientId || !projectId || !assignee}
                onClick={createTask}
              >
                Create task without sharing thread
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
