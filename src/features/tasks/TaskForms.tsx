import { DocHubHistory } from '../../DocHubPanel'
import { composeEmail, useEmailEnabled } from '../../EmailComposer'
import RtmTaskLinks from '../../RtmTaskLinks'
import TaskEffort from '../../TaskEffort'
import { type Store, defaultOpenTaskStatus, isTaskClosed } from '../../app/store'
import { businessDateKey } from '../../businessDate'
import { normalizeEstimate } from '../../effort'
import { isArchived } from '../../lifecycle'
import { type RtmLink } from '../../rtm'
import ClientSelect from '../../shared/ui/SearchSelect'
import { type TaskCommentMutationResult, addTaskComment } from '../../taskComments'
import { TASK_EVIDENCE_MAX_BYTES, type TaskEvidenceMutationResult, deleteTaskEvidence, taskEvidenceUrl, uploadTaskEvidence } from '../../taskEvidence'
import { type TimeEntryMutationResult } from '../../timeEntries'
import { type ItemType, type Priority, type TaskEvidence, type WaitingOn, type WorkItem } from '../../types'
import { defaultWaitingOn, findWaitingOn, isWaitingOnDone, waitingOnOptions } from '../../waitingOn'
import { CircleDot, HardDrive, LockKeyhole, MessageSquareText, Paperclip, Trash2, Upload } from 'lucide-react'
import { type ClipboardEvent, FormEvent, useEffect, useRef, useState } from 'react'

export function WorkScheduleFields({ itemKind, startDate = '', dueDate = '', followUpDate = '' }: { itemKind: 'Task' | 'Subtask'; startDate?: string; dueDate?: string; followUpDate?: string }) {
  return <fieldset className="work-schedule-fields span-2">
    <legend>{itemKind} schedule</legend>
    <p>Set when this {itemKind.toLowerCase()} starts, when it is due, and when it needs follow-up.</p>
    <div className="work-schedule-grid">
      <label>Start date<input name="startDate" type="date" defaultValue={startDate} /></label>
      <label>Due date<input name="dueDate" type="date" defaultValue={dueDate} /></label>
      <label>Follow-up date<input name="followUpDate" type="date" defaultValue={followUpDate} /></label>
    </div>
  </fieldset>
}

export function TaskForm({ canLinkRtm, store, preset, onSubmit }: { canLinkRtm: boolean; store: Store; preset: { clientId?: string; projectId?: string; type?: ItemType; parentTaskId?: string } | null; onSubmit: (item: WorkItem) => void }) {
  const parent = preset?.parentTaskId ? store.items.find((item) => item.id === preset.parentTaskId) : undefined
  const [clientId, setClientId] = useState(parent?.clientId || preset?.clientId || '')
  const [projectId, setProjectId] = useState(parent?.projectId || preset?.projectId || '')
  const clientLocked = Boolean(parent || preset?.clientId)
  const [rtmLinks, setRtmLinks] = useState<RtmLink[]>([])
  const [type, setType] = useState<ItemType>(preset?.type || 'Task')
  const [status, setStatus] = useState(defaultOpenTaskStatus(store.taskSettings))
  const assignableUsers = store.accounts.filter((account) => account.status === 'Active' && (account.role === 'Administrator' || account.role === 'Contributor'))
  const workloadFor = (userId: string) => { const active = store.items.filter((item) => item.assignedToUserId === userId && !isTaskClosed(item.status, store.taskSettings) && !isWaitingOnDone(item.waitingOn, store.taskSettings)); return `${active.length} active · ${active.filter((item) => Boolean(item.dueDate && item.dueDate < businessDateKey())).length} overdue` }
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const startDate = String(form.get('startDate') || '')
    const dueDate = String(form.get('dueDate') || '')
    const assignedToUserId = parent?.assignedToUserId || String(form.get('assignedToUserId') || '') || undefined
    if (startDate && dueDate && dueDate < startDate) { window.alert('Due Date cannot be earlier than Start Date.'); return }
    const estimate = normalizeEstimate(form.get('estimateHours'))
    if (!estimate.ok) { window.alert(estimate.error); return }
    onSubmit({
      estimateHours: estimate.value,
      id: crypto.randomUUID(),
      clientId: parent?.clientId || clientId || undefined,
      projectId: parent?.projectId || projectId || undefined,
      rtmLinks,
      qaResult: String(form.get('qaResult') || 'Not Run') as WorkItem['qaResult'],
      parentTaskId: parent?.id,
      subtaskOrder: parent ? Math.max(-1, ...store.items.filter((item) => item.parentTaskId === parent.id).map((item) => item.subtaskOrder ?? -1)) + 1 : undefined,
      title: String(form.get('title') || '').trim(),
      type,
      priority: form.get('priority') as Priority,
      status,
      waitingOn: form.get('waitingOn') as WaitingOn,
      assignedToUserId,
      assignmentInherited: parent ? true : undefined,
      owner: assignedToUserId ? assignableUsers.find((account) => account.id === assignedToUserId)?.name || parent?.owner || '' : '',
      dateRaised: businessDateKey(),
      startDate,
      dueDate,
      followUpDate: String(form.get('followUpDate') || ''),
      description: String(form.get('description') || ''),
      resolution: '',
      source: form.get('source') as WorkItem['source'],
    })
  }
  const lockedClientId = parent?.clientId || preset?.clientId || ''
  const clientLabel = lockedClientId ? store.clients.find((client) => client.id === lockedClientId)?.name || 'Unknown client' : 'Select client'
  const projectLabel = parent?.projectId ? store.projects.find((project) => project.id === parent.projectId)?.name || 'Unknown project' : 'No project'
  return <form className="form-grid" onSubmit={submit}>
    {parent && <div className="readonly-notice span-2"><CircleDot size={18} /><div><strong>Subtask of: {parent.title}</strong><span>Client and project are inherited from the parent task so the hierarchy stays consistent.</span></div></div>}
    {!parent && preset?.clientId && <div className="readonly-notice span-2"><CircleDot size={18} /><div><strong>Client context: {clientLabel}</strong><span>This task is being created from the client record, so the client stays fixed. You can assign any global project to it.</span></div></div>}
    <label className="span-2">{parent ? 'Subtask title' : 'Task title'}<input name="title" required placeholder={parent ? 'Enter the work needed under this task...' : 'Rollout, sign-off, client follow-up, QA review...'} /></label>
    {parent ? <><label>Client<input value={clientLabel} readOnly disabled /></label><label>Project<input value={projectLabel} readOnly disabled /></label></> : <><label>Client{clientLocked ? <input value={clientLabel} readOnly disabled /> : <ClientSelect clients={store.clients.filter(client => !isArchived(client))} value={clientId} onChange={(value) => setClientId(value)} extra={[{ value: '', label: type === 'Inquiry' ? 'Unassigned / select client' : 'Select client' }]} required={type !== 'Inquiry'} />}</label><label>Project<select value={projectId} disabled={!clientId} onChange={(event) => setProjectId(event.target.value)}><option value="">{clientId ? 'No project' : 'Select a client first'}</option>{store.projects.filter(project => !isArchived(project)).map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label></>}
    <label>Type<select value={type} onChange={(event) => setType(event.target.value as ItemType)}><option>Task</option><option>Inquiry</option><option>Requirement</option><option>Issue</option><option>Decision</option><option>Follow-up</option></select></label>
    <label>Status<select value={status} onChange={(event) => setStatus(event.target.value)}>{store.taskSettings.statuses.map((taskStatus) => <option key={taskStatus.id} value={taskStatus.label}>{taskStatus.label}</option>)}</select></label>
    <label>Priority<select name="priority" defaultValue="Medium"><option>Low</option><option>Medium</option><option>High</option><option>Urgent</option></select></label>
    <label>Waiting on<select name="waitingOn" defaultValue={defaultWaitingOn(store.taskSettings)}>{waitingOnOptions(store.taskSettings).map((option) => <option key={option.id}>{option.label}</option>)}</select></label>
    {parent
      ? <label>Assigned to<input value={assignableUsers.find((account) => account.id === parent.assignedToUserId)?.name || 'Unassigned'} readOnly disabled /><small>Inherited from the main task. You can override it after creating the subtask.</small></label>
      : <label>Assigned to<select name="assignedToUserId" defaultValue=""><option value="">Unassigned</option>{assignableUsers.map((account) => <option key={account.id} value={account.id}>{account.name} · {workloadFor(account.id)}</option>)}</select></label>}
    {canLinkRtm && <RtmTaskLinks store={store} clientId={clientId} projectId={projectId} value={rtmLinks} onChange={setRtmLinks} />}
    <label>QA result<select name="qaResult" defaultValue="Not Run"><option>Not Run</option><option>Passed</option><option>Failed</option><option>Blocked</option></select><small>Used by linked Testing stages. Passed requires completed work.</small></label>
    <WorkScheduleFields itemKind={parent ? 'Subtask' : 'Task'} />
    <label>Estimate (hours)<input name="estimateHours" type="number" inputMode="decimal" min="0" max="1000" step="0.25" placeholder="Optional" /></label>
    <label>Source<select name="source" defaultValue={type === 'Inquiry' ? 'Chat' : 'Internal'}><option>Email</option><option>Meeting</option><option>Chat</option><option>Discord</option><option>Internal</option><option>Other</option></select></label>
    <label className="span-2">Description / comments<textarea name="description" rows={4} placeholder="Context, comments, acceptance details, dependencies, or what needs to be done..." /></label>
    <div className="form-actions span-2"><button className="primary">{parent ? 'Create subtask' : type === 'Inquiry' ? 'Capture inquiry' : 'Create task'}</button></div>
  </form>
}

export function TaskEditForm({ autoRefreshDocuments=true, canLinkRtm, store, item, onSubmit, onDelete, onEvidenceMutation, onCommentMutation, onTimeEntryMutation, currentUser, today }: { autoRefreshDocuments?: boolean; canLinkRtm: boolean; store: Store; item: WorkItem; onSubmit: (item: WorkItem) => Promise<void>; onDelete: (id: string) => void; onEvidenceMutation: (result: TaskEvidenceMutationResult) => void; onCommentMutation: (result: TaskCommentMutationResult) => void; onTimeEntryMutation: (result: TimeEntryMutationResult) => void; currentUser: { id: string; role?: string }; today: string }) {
  const [rtmLinks, setRtmLinks] = useState<RtmLink[]>(item.rtmLinks || [])
  const [editProjectId, setEditProjectId] = useState(item.projectId || '')
  const [type, setType] = useState<ItemType>(item.type)
  const [status, setStatus] = useState(item.status)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const parent = item.parentTaskId ? store.items.find((candidate) => candidate.id === item.parentTaskId) : undefined
  const inheritAssignmentValue = '__inherit_parent_assignment__'
  const inheritsParentAssignment = Boolean(parent && (typeof item.assignmentInherited === 'boolean' ? item.assignmentInherited : String(item.assignedToUserId || '') === String(parent.assignedToUserId || '')))
  const assignableUsers = store.accounts.filter((account) => account.status === 'Active' && (account.role === 'Administrator' || account.role === 'Contributor'))
  const workloadFor = (userId: string) => { const active = store.items.filter((candidate) => candidate.assignedToUserId === userId && !isTaskClosed(candidate.status, store.taskSettings) && !isWaitingOnDone(candidate.waitingOn, store.taskSettings)); return `${active.length} active · ${active.filter((candidate) => Boolean(candidate.dueDate && candidate.dueDate < businessDateKey())).length} overdue` }
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (saving) return
    const form = new FormData(event.currentTarget)
    const startDate = String(form.get('startDate') || '')
    const dueDate = String(form.get('dueDate') || '')
    const assignmentSelection = String(form.get('assignedToUserId') || '')
    const assignedToUserId = parent && assignmentSelection === inheritAssignmentValue ? parent.assignedToUserId : assignmentSelection || undefined
    if (startDate && dueDate && dueDate < startDate) { window.alert('Due Date cannot be earlier than Start Date.'); return }
    const estimate = normalizeEstimate(form.get('estimateHours'))
    if (!estimate.ok) { setSaveError(estimate.error); return }
    const changes: WorkItem = {
      ...item,
      estimateHours: estimate.value,
      rtmLinks,
      qaResult: String(form.get('qaResult') || 'Not Run') as WorkItem['qaResult'],
      title: item.title,
      clientId: item.clientId,
      projectId: parent ? item.projectId : editProjectId || undefined,
      type,
      status,
      priority: form.get('priority') as Priority,
      waitingOn: form.get('waitingOn') as WaitingOn,
      assignedToUserId,
      assignmentInherited: parent ? assignmentSelection === inheritAssignmentValue : undefined,
      owner: assignedToUserId ? assignableUsers.find((account) => account.id === assignedToUserId)?.name || '' : '',
      startDate,
      dueDate,
      followUpDate: String(form.get('followUpDate') || ''),
      source: form.get('source') as WorkItem['source'],
      description: String(form.get('description') || ''),
    }
    setSaveError('')
    setSaving(true)
    try { await onSubmit(changes) }
    catch (error) { setSaveError(error instanceof Error ? error.message : 'Your changes could not be saved. Please try again.') }
    finally { setSaving(false) }
  }
  const clientLabel = item.clientId ? store.clients.find((client) => client.id === item.clientId)?.name || 'Unknown client' : 'General / no client'
  const projectLabel = item.projectId ? store.projects.find((project) => project.id === item.projectId)?.name || 'Unknown project' : 'No project'
  return <form className="form-grid" onSubmit={(event) => void submit(event)}>
    <div className="readonly-notice span-2"><LockKeyhole size={18} /><div><strong>{parent ? `Subtask of: ${parent.title}` : 'Task identity is locked'}</strong><span>{parent ? 'Subtask name, client, and parent project stay fixed. You can update its execution fields below.' : 'Task name and client cannot be changed after creation.'}</span></div></div>
    <label className="span-2">{parent ? 'Subtask title' : 'Task title'}<input value={item.title} readOnly disabled /></label>
    <label>Client<input value={clientLabel} readOnly disabled /></label>
    {parent ? <label>Project<input value={projectLabel} readOnly disabled /></label> : <label>Project<select name="projectId" value={editProjectId} onChange={e => setEditProjectId(e.target.value)}><option value="">No project</option>{store.projects.filter(project => !isArchived(project)).map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>}
    <label>Type<select value={type} onChange={(event) => setType(event.target.value as ItemType)}><option>Task</option><option>Inquiry</option><option>Requirement</option><option>Issue</option><option>Decision</option><option>Follow-up</option></select></label>
    <label>Status<select value={status} onChange={(event) => setStatus(event.target.value)}>{store.taskSettings.statuses.map((taskStatus) => <option key={taskStatus.id} value={taskStatus.label}>{taskStatus.label}</option>)}</select></label>
    <label>Priority<select name="priority" defaultValue={item.priority}><option>Low</option><option>Medium</option><option>High</option><option>Urgent</option></select></label>
    <label>Waiting on<select name="waitingOn" defaultValue={item.waitingOn}>{waitingOnOptions(store.taskSettings).map((option) => <option key={option.id}>{option.label}</option>)}{item.waitingOn && !findWaitingOn(item.waitingOn, store.taskSettings) && <option>{item.waitingOn}</option>}</select></label>
    <label>Assigned to<select name="assignedToUserId" defaultValue={parent && inheritsParentAssignment ? inheritAssignmentValue : item.assignedToUserId || ''}>{parent && <option value={inheritAssignmentValue}>Same as main task · {assignableUsers.find((account) => account.id === parent.assignedToUserId)?.name || 'Unassigned'}</option>}<option value="">Unassigned</option>{assignableUsers.map((account) => <option key={account.id} value={account.id}>{account.name} · {workloadFor(account.id)}</option>)}</select>{parent && <small>{inheritsParentAssignment ? 'This subtask follows main-task assignment changes.' : 'This subtask has its own assignee override.'}</small>}</label>
    {canLinkRtm && <RtmTaskLinks store={store} clientId={item.clientId || parent?.clientId} projectId={editProjectId || parent?.projectId} value={rtmLinks} onChange={setRtmLinks} />}
    <label>QA result<select name="qaResult" defaultValue={item.qaResult || 'Not Run'}><option>Not Run</option><option>Passed</option><option>Failed</option><option>Blocked</option></select><small>Completed work without an explicit pass shows Done, not Passed.</small></label>
    <WorkScheduleFields itemKind={parent ? 'Subtask' : 'Task'} startDate={item.startDate || ''} dueDate={item.dueDate || ''} followUpDate={item.followUpDate || ''} />
    <label>Estimate (hours)<input name="estimateHours" type="number" inputMode="decimal" min="0" max="1000" step="0.25" defaultValue={item.estimateHours ?? ''} placeholder="Optional" /><small>{parent ? 'Rolls up to the main task when it has no estimate.' : 'Leave blank to use the sum of subtask estimates.'}</small></label>
    <label>Source<select name="source" defaultValue={item.source}><option>Email</option><option>Meeting</option><option>Chat</option><option>Discord</option><option>Internal</option><option>Other</option></select></label>
    <label className="span-2">Description / comments<textarea name="description" rows={4} defaultValue={item.description} /></label>
    <DocHubHistory active={autoRefreshDocuments} taskId={item.id} canCreate onComplete={() => { const closed=store.taskSettings.statuses.find(s=>s.closed); if(closed)setStatus(closed.label) }} />
    <TaskEffort item={item} allItems={store.items} currentUser={currentUser} canLog={currentUser.role !== 'Viewer'} today={today} onMutation={onTimeEntryMutation} />
    <WorkCommentTrail item={item} onMutation={onCommentMutation} />
    {parent && <SubtaskEvidencePanel item={item} onMutation={onEvidenceMutation} />}
    <TaskDriveFiles item={item} />
    {saveError && <p className="record-editor-error span-2" role="alert">{saveError}</p>}
    <div className="form-actions span-2 task-edit-actions"><button type="button" className="secondary danger-button" disabled={saving} onClick={() => onDelete(item.id)}><Trash2 size={16} /> Delete {parent ? 'subtask' : 'task'}</button><button className="primary" disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</button></div>
  </form>
}

export function WorkCommentTrail({ item, onMutation }: { item: WorkItem; onMutation: (result: TaskCommentMutationResult) => void }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [pageSize, setPageSize] = useState<2 | 3 | 5>(3)
  const [page, setPage] = useState(1)
  const comments = [...(item.comments || [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const totalPages = Math.max(1, Math.ceil(comments.length / pageSize))
  const currentPage = Math.min(page, totalPages)
  const pageStart = (currentPage - 1) * pageSize
  const visibleComments = comments.slice(pageStart, pageStart + pageSize)
  useEffect(() => setPage(1), [item.id])
  useEffect(() => { if (page > totalPages) setPage(totalPages) }, [page, totalPages])
  const submitComment = async () => {
    const trimmed = text.trim()
    if (!trimmed || busy) return
    setBusy(true)
    setMessage('')
    try {
      const result = await addTaskComment(item.id, trimmed)
      onMutation(result)
      setText('')
      setPage(1)
      setMessage('Comment added.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Comment could not be saved.')
    } finally {
      setBusy(false)
    }
  }
  return <section className="subtask-comment-trail span-2">
    <div className="subtask-comment-heading"><div><strong><MessageSquareText size={15} /> Activity comments</strong><span>User notes and permanent System follow-up entries.</span></div><span className="count-pill">{comments.length}</span></div>
    <div className="task-comment-composer"><textarea value={text} maxLength={2000} rows={2} placeholder="Add a comment for the assignee or team…" onChange={(event) => setText(event.target.value)} /><button className="secondary" type="button" disabled={!text.trim() || busy} onClick={() => void submitComment()}>{busy ? 'Adding…' : 'Add comment'}</button></div>
    {message && <div className={`task-comment-message${message === 'Comment added.' ? ' success' : ''}`}>{message}</div>}
    {comments.length ? <>
      <div className="subtask-comment-list">{visibleComments.map((comment) => <article key={comment.id} className="subtask-comment-entry">
        <div><span className={comment.kind === 'System' ? 'system-comment-badge' : 'user-comment-badge'}>{comment.kind === 'System' ? 'System' : comment.createdByName || 'User'}</span><time>{evidenceDate(comment.createdAt)}</time></div>
        <p>{comment.text}</p>
      </article>)}</div>
      <div className="task-comment-pagination">
        <span>{pageStart + 1}–{Math.min(pageStart + pageSize, comments.length)} of {comments.length}</span>
        <label>Show<select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value) as 2 | 3 | 5); setPage(1) }}><option value={2}>2</option><option value={3}>3</option><option value={5}>5</option></select></label>
        <div className="task-comment-page-buttons">
          <button type="button" className="secondary compact" disabled={currentPage <= 1} onClick={() => setPage(value => Math.max(1, value - 1))}>Previous</button>
          <span>Page {currentPage} of {totalPages}</span>
          <button type="button" className="secondary compact" disabled={currentPage >= totalPages} onClick={() => setPage(value => Math.min(totalPages, value + 1))}>Next</button>
        </div>
      </div>
    </> : <div className="subtask-comment-empty">No comments yet.</div>}
  </section>
}

export function evidenceSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return 'Unknown size'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function evidenceDate(value: string) {
  const date = value ? new Date(value) : null
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleString() : 'Uploaded'
}

/** Gmail attachments saved to the team Google Drive from Work Hub. Links only; the files live in Drive. */
export function TaskDriveFiles({ item }: { item: WorkItem }) {
  const canEmail = useEmailEnabled()
  const files = (item.driveFiles || []).filter((file) => file && file.id && file.name && /^https:\/\/drive\.google\.com\//.test(String(file.url || '')))
  if (!files.length) return null
  return <section className="subtask-evidence-panel span-2 task-drive-files">
    <div className="subtask-evidence-heading">
      <div><strong><HardDrive size={15} /> Saved to Google Drive</strong><span>Email attachments and documents filed in the team Drive under this {item.parentTaskId ? 'subtask' : 'task'}’s folder.</span></div>
      <span className="count-pill">{files.length}</span>
    </div>
    <div className="subtask-evidence-list">
      {files.map((file) => <div className="subtask-evidence-item" key={file.id}>
        <div className="subtask-evidence-file"><Paperclip size={15} /><div><strong title={file.name}>{file.name}</strong><span>{file.size ? `${evidenceSize(file.size)} · ` : ''}{evidenceDate(file.savedAt)}{file.savedByName ? ` · ${file.savedByName}` : ''}</span></div></div>
        <div className="subtask-evidence-actions"><a className="secondary compact" href={file.url} target="_blank" rel="noopener noreferrer">Open in Drive</a>{canEmail && <button type="button" className="secondary compact" title="Email this file from your Gmail, linked to this work" onClick={() => composeEmail({ taskIds: [item.id], driveFiles: [{ taskId: item.id, fileId: file.id, name: file.name, size: file.size || 0 }], subject: file.name.replace(/\.[^.]+$/, '') })}>Email</button>}</div>
      </div>)}
    </div>
  </section>
}

export function SubtaskEvidencePanel({ item, onMutation }: { item: WorkItem; onMutation: (result: TaskEvidenceMutationResult) => void }) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const evidence = item.evidence || []

  const uploadFiles = async (files: File[]) => {
    if (!files.length || busy) return
    const oversized = files.find((file) => file.size > TASK_EVIDENCE_MAX_BYTES)
    if (oversized) {
      setMessage(`${oversized.name} is larger than the 10 MB evidence limit.`)
      return
    }
    setBusy(true)
    setMessage('')
    try {
      let uploaded = 0
      for (const file of files) {
        const result = await uploadTaskEvidence(item.id, file)
        onMutation(result)
        uploaded += 1
      }
      setMessage(`${uploaded} evidence file${uploaded === 1 ? '' : 's'} uploaded.`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not upload evidence.')
    } finally {
      setBusy(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  const removeEvidence = async (entry: TaskEvidence) => {
    if (busy || !window.confirm(`Remove evidence "${entry.fileName}" from this subtask?`)) return
    setBusy(true)
    setMessage('')
    try {
      const result = await deleteTaskEvidence(item.id, entry.id)
      onMutation(result)
      setMessage('Evidence removed.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not remove evidence.')
    } finally {
      setBusy(false)
    }
  }

  const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
    const files = Array.from(event.clipboardData.files || [])
    const images = files.filter((file) => file.type.startsWith('image/'))
    if (!images.length) return
    event.preventDefault()
    const stamped = images.map((file, index) => {
      if (file.name && file.name !== 'image.png') return file
      const extension = file.type === 'image/jpeg' ? 'jpg' : file.type === 'image/webp' ? 'webp' : 'png'
      return new File([file], `screenshot-${new Date().toISOString().replace(/[:.]/g, '-')}${index ? `-${index + 1}` : ''}.${extension}`, { type: file.type })
    })
    void uploadFiles(stamped)
  }

  return <section className="subtask-evidence-panel span-2">
    <div className="subtask-evidence-heading">
      <div><strong><Paperclip size={15} /> Activity evidence</strong><span>Attach a file, drag and drop, or paste a screenshot with Ctrl+V. Files are stored privately in the database.</span></div>
      <span className="count-pill">{evidence.length}</span>
    </div>
    <div
      className={`subtask-evidence-dropzone ${busy ? 'is-busy' : ''}`}
      tabIndex={0}
      onPaste={handlePaste}
      onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' }}
      onDrop={(event) => { event.preventDefault(); void uploadFiles(Array.from(event.dataTransfer.files || [])) }}
    >
      <Upload size={20} />
      <div><b>{busy ? 'Uploading evidence…' : 'Drop evidence here or paste a screenshot'}</b><span>Images, PDF, Office files, TXT/CSV or ZIP · maximum 10 MB each</span></div>
      <button type="button" className="secondary compact" disabled={busy} onClick={() => inputRef.current?.click()}>Choose files</button>
      <input ref={inputRef} className="evidence-file-input" type="file" multiple disabled={busy} accept="image/png,image/jpeg,image/webp,image/gif,image/bmp,application/pdf,text/plain,text/csv,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.zip" onChange={(event) => void uploadFiles(Array.from(event.target.files || []))} />
    </div>
    {message && <div className="subtask-evidence-message">{message}</div>}
    {evidence.length > 0 && <div className="subtask-evidence-list">
      {evidence.map((entry) => <div className="subtask-evidence-item" key={entry.id}>
        <div className="subtask-evidence-file"><Paperclip size={15} /><div><strong>{entry.fileName}</strong><span>{entry.kind} · {evidenceSize(entry.fileSize)} · {evidenceDate(entry.uploadedAt)}{entry.uploadedByName ? ` · ${entry.uploadedByName}` : ''}</span></div></div>
        <div className="subtask-evidence-actions"><a className="secondary compact" href={taskEvidenceUrl(item.id, entry)} target="_blank" rel="noreferrer">Open</a><button type="button" className="icon-button danger-button" title="Remove evidence" disabled={busy} onClick={() => void removeEvidence(entry)}><Trash2 size={16} /></button></div>
      </div>)}
    </div>}
  </section>
}
