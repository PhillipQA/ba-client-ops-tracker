import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { FolderOpen, Mail, Paperclip, Send, Undo2, X } from 'lucide-react'
import type { Client, Project, UserAccount, WorkItem } from './types'
import { EMAIL_LIMITS, blockedAttachmentReason, formatBytes, isValidEmail, parseRecipients, splitAddresses } from './emailCompose'
import { outbox, UNDO_SECONDS, type DriveRef, type EmailDraft, type OutboxEntry, type Upload } from './emailOutbox'
import { driveFileGroups, placeOf, taskOptions } from './documentDriveTargets'
import { workHubSync } from './workHubSync'
import { RecipientInput, addressesOn, type Suggestion } from './RecipientInput'
import { knownPeople } from './knownPeople'
import { searchContacts } from './contactSearch'
import './emailComposer.css'

/**
 * Send an email from the tracker, from the person's own Gmail account.
 * Opened from anywhere with composeEmail(); the email is linked to the tasks or subtasks chosen here.
 */
export type ComposePrefill = {
  taskIds?: string[]; to?: string; cc?: string; bcc?: string; subject?: string; message?: string
  driveFiles?: DriveRef[]; uploads?: Upload[]; replyToId?: string
  /** A reply that copied the other people on the original email, so the composer can say so and offer to remove them. */
  autoCc?: boolean
  /** A short message shown above the form, for example when part of the prefill could not be filled in. */
  notice?: string
  /** An email taken back with Undo: closing it asks first, because it would otherwise be lost. */
  restored?: boolean
}
const OPEN = 'email-compose'
export function composeEmail(prefill: ComposePrefill = {}) { window.dispatchEvent(new CustomEvent(OPEN, { detail: prefill })) }

// Buttons elsewhere in the app show only when this person can send. The host reports it here.
let enabled = false
const enabledListeners = new Set<() => void>()
function setEmailEnabled(value: boolean) { if (enabled !== value) { enabled = value; enabledListeners.forEach(listener => listener()) } }
export function useEmailEnabled() {
  return useSyncExternalStore(listener => { enabledListeners.add(listener); return () => { enabledListeners.delete(listener) } }, () => enabled, () => false)
}

type Status = { writer: boolean; available: boolean; connected: boolean; canSend: boolean; reconnectRequired: boolean; email: string; message: string }
type Scope = { items: WorkItem[]; clients: Client[]; projects: Project[] }
/** Teammates whose addresses can be suggested. */
type Team = { accounts?: UserAccount[] }

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => { const result = String(reader.result || ''); resolve(result.slice(result.indexOf(',') + 1)) }
    reader.onerror = () => reject(new Error(`“${file.name}” could not be read.`))
    reader.readAsDataURL(file)
  })
}
const signatureKey = (user: UserAccount) => `email-signature:${user.organizationId || ''}:${user.id}`
function readSignature(user: UserAccount) { try { return localStorage.getItem(signatureKey(user)) || '' } catch { return '' } }
function writeSignature(user: UserAccount, value: string) { try { localStorage.setItem(signatureKey(user), value) } catch { /* The signature still applies to this email. */ } }

async function allowSending() {
  const response = await fetch('/api/communications/gmail/connect?send=1', { credentials: 'same-origin' })
  const result = await response.json().catch(() => ({}))
  if (!response.ok || !result.url) throw new Error(result.error || 'Could not start the Google permission step.')
  window.location.assign(result.url)
}

export function EmailComposerHost({ enabled: allowed, items, clients, projects, accounts, currentUser, onSent }: Scope & Team & { enabled: boolean; currentUser: UserAccount; onSent?: () => void | Promise<void> }) {
  const [open, setOpen] = useState<{ prefill: ComposePrefill; key: number } | null>(null)
  useEffect(() => { setEmailEnabled(allowed); return () => setEmailEnabled(false) }, [allowed])
  useEffect(() => {
    if (!allowed) return
    const listen = (event: Event) => setOpen({ prefill: (event as CustomEvent<ComposePrefill>).detail || {}, key: Date.now() })
    window.addEventListener(OPEN, listen)
    return () => window.removeEventListener(OPEN, listen)
  }, [allowed])
  const afterSent = useRef(onSent)
  afterSent.current = onSent
  useEffect(() => outbox.onSent(() => {
    workHubSync.invalidate('gmail')
    window.dispatchEvent(new Event('email-sent'))
    void afterSent.current?.()
  }), [])
  if (!allowed) return null
  const edit = (draft: EmailDraft) => setOpen({ prefill: { ...draft, restored: true }, key: Date.now() })
  return <>
    {open && <EmailComposer key={open.key} prefill={open.prefill} items={items} clients={clients} projects={projects} accounts={accounts} currentUser={currentUser} onClose={() => setOpen(null)} />}
    <EmailOutboxBar onEdit={edit} />
  </>
}

/** Emails waiting out the undo window, being sent, just sent, or that failed. */
function EmailOutboxBar({ onEdit }: { onEdit: (draft: EmailDraft) => void }) {
  const entries = useSyncExternalStore(outbox.subscribe, outbox.snapshot, outbox.snapshot)
  if (!entries.length) return null
  return <div className="email-outbox" role="region" aria-label="Emails being sent">
    {entries.map((entry: OutboxEntry) => <div key={entry.id} className={`email-outbox-item ${entry.phase}`} role={entry.phase === 'failed' ? 'alert' : 'status'}>
      <div className="email-outbox-text">
        <strong>{entry.draft.subject || '(no subject)'}</strong>
        {entry.phase === 'waiting' && <span>Sending to {entry.summary} in {entry.secondsLeft} s. You can still change it.</span>}
        {entry.phase === 'sending' && <span>Sending to {entry.summary}…</span>}
        {entry.phase === 'sent' && <span>Sent to {entry.summary}. A copy is in Work Hub, linked to the task.{entry.warning ? ` ${entry.warning}` : ''}</span>}
        {entry.phase === 'failed' && <span>{entry.error}</span>}
      </div>
      <div className="email-outbox-actions">
        {entry.phase === 'waiting' && <>
          <button type="button" className="secondary compact" onClick={() => { const draft = outbox.undo(entry.id); if (draft) onEdit(draft) }}><Undo2 size={14} aria-hidden="true" /> Undo</button>
          <button type="button" className="primary compact" onClick={() => outbox.sendNow(entry.id)}>Send now</button>
        </>}
        {entry.phase === 'failed' && <>
          {entry.code === 'NETWORK' && <button type="button" className="primary compact" onClick={() => outbox.retry(entry.id)}>Retry</button>}
          {entry.code !== 'NETWORK' && entry.code !== 'UNCONFIRMED' && <button type="button" className="primary compact" onClick={() => { const draft = outbox.undo(entry.id); if (draft) onEdit(draft) }}>Edit</button>}
          <button type="button" className="secondary compact" onClick={() => outbox.dismiss(entry.id)}>Dismiss</button>
        </>}
        {entry.phase === 'sent' && <button type="button" className="secondary compact" onClick={() => outbox.dismiss(entry.id)}>Close</button>}
      </div>
    </div>)}
  </div>
}

export function EmailComposer({ prefill, items, clients, projects, accounts, currentUser, onClose }: Scope & Team & { prefill: ComposePrefill; currentUser: UserAccount; onClose: () => void }) {
  const scope: Scope = { items, clients, projects }
  const dialog = useRef<HTMLDialogElement>(null), titleId = useId()
  const primary = items.find(item => item.id === prefill.taskIds?.[0])
  const clientEmail = clients.find(client => client.id === primary?.clientId)?.email || ''
  const signature = useRef(readSignature(currentUser))
  const [to, setTo] = useState(prefill.to ?? (isValidEmail(clientEmail) ? clientEmail : ''))
  const [cc, setCc] = useState(prefill.cc ?? ''), [bcc, setBcc] = useState(prefill.bcc ?? '')
  const [showCopies, setShowCopies] = useState(Boolean(prefill.cc || prefill.bcc))
  const [subject, setSubject] = useState(prefill.subject ?? '')
  const [message, setMessage] = useState(prefill.message ?? (signature.current ? `\n\n-- \n${signature.current}` : ''))
  const [taskIds, setTaskIds] = useState<string[]>(prefill.taskIds ?? [])
  const [driveFiles, setDriveFiles] = useState<DriveRef[]>(prefill.driveFiles ?? [])
  const [uploads, setUploads] = useState<Upload[]>(prefill.uploads ?? [])
  const [status, setStatus] = useState<Status | null>(null), [statusError, setStatusError] = useState('')
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [clientFilter, setClientFilter] = useState(primary?.clientId ?? ''), [pickTask, setPickTask] = useState('')
  const [driveOpen, setDriveOpen] = useState(false), [fileQuery, setFileQuery] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)
  // Type-ahead for the recipient lines: clients and teammates are known here; people emailed before come from the server.
  const people = useMemo<Suggestion[]>(() => knownPeople({ clients, accounts, leaveOut: { id: currentUser.id, email: currentUser.email } }), [clients, accounts, currentUser.id, currentUser.email])
  const taken = useMemo(() => [...addressesOn(to), ...addressesOn(cc), ...addressesOn(bcc)], [to, cc, bcc])
  // Ask once as the composer opens, so the list is ready by the time someone types.
  useEffect(() => { searchContacts('').catch(() => {}) }, [])
  const initial = useRef(JSON.stringify([to, cc, bcc, subject, message, taskIds, driveFiles, uploads.map(file => file.name)]))
  const dirty = () => Boolean(prefill.restored) || JSON.stringify([to, cc, bcc, subject, message, taskIds, driveFiles, uploads.map(file => file.name)]) !== initial.current

  useEffect(() => {
    const element = dialog.current
    if (!element) return
    const returnFocus = document.activeElement
    const previousOverflow = document.body.style.overflow
    element.showModal()
    document.body.style.overflow = 'hidden'
    return () => {
      element.close()
      document.body.style.overflow = previousOverflow
      if (returnFocus instanceof HTMLElement && returnFocus.isConnected) returnFocus.focus({ preventScroll: true })
    }
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    void fetch('/api/communications/send/status', { credentials: 'same-origin', signal: controller.signal })
      .then(async response => { const result = await response.json().catch(() => ({})); if (!response.ok) throw new Error(result.error || 'Could not check your Gmail connection.'); return result as Status })
      .then(setStatus).catch(e => { if (!controller.signal.aborted) setStatusError(e instanceof Error ? e.message : 'Could not check your Gmail connection.') })
    return () => controller.abort()
  }, [])
  const close = () => { if (!busy && (!dirty() || window.confirm('Discard this email?'))) onClose() }

  const usedBytes = uploads.reduce((sum, file) => sum + file.size, 0) + driveFiles.reduce((sum, file) => sum + (file.size || 0), 0)
  const attachmentCount = uploads.length + driveFiles.length
  const taskLabel = (id: string) => { const item = items.find(candidate => candidate.id === id); return item ? `${item.parentTaskId ? '↳ ' : ''}${item.title}` : 'Removed task' }
  const options = useMemo(() => taskOptions(scope, clientFilter).filter(option => !taskIds.includes(option.id)), [items, clients, projects, clientFilter, taskIds])
  const linkedFirst = (id: string) => taskIds.includes(id) || taskIds.includes(items.find(item => item.id === id)?.parentTaskId || '')
  const groups = useMemo(() => driveFileGroups(scope, { allowed: null, clientId: clientFilter, query: fileQuery })
    .sort((a, b) => Number(linkedFirst(b.item.id)) - Number(linkedFirst(a.item.id))), [items, clients, projects, clientFilter, fileQuery, taskIds])

  const addDrive = (taskId: string, file: { id: string; name: string; size: number }) => {
    const blocked = blockedAttachmentReason(file.name)
    if (blocked) { setError(blocked); return }
    if (attachmentCount >= EMAIL_LIMITS.attachments) { setError(`An email can have at most ${EMAIL_LIMITS.attachments} attachments.`); return }
    if (usedBytes + (file.size || 0) > EMAIL_LIMITS.attachmentBytes) { setError(`“${file.name}” does not fit. Attachments can total ${formatBytes(EMAIL_LIMITS.attachmentBytes)}.`); return }
    setError(''); setDriveFiles(previous => [...previous, { taskId, fileId: file.id, name: file.name, size: file.size || 0 }])
  }
  const addUploads = async (list: FileList | null) => {
    const files = Array.from(list || [])
    if (fileInput.current) fileInput.current.value = ''
    if (!files.length) return
    setError('')
    let total = usedBytes, count = attachmentCount
    const added: Upload[] = []
    for (const file of files) {
      const blocked = blockedAttachmentReason(file.name)
      if (blocked) { setError(blocked); break }
      if (!file.size) { setError(`“${file.name}” is empty.`); break }
      if (count >= EMAIL_LIMITS.attachments) { setError(`An email can have at most ${EMAIL_LIMITS.attachments} attachments.`); break }
      if (total + file.size > EMAIL_LIMITS.attachmentBytes) { setError(`“${file.name}” does not fit. Attachments can total ${formatBytes(EMAIL_LIMITS.attachmentBytes)}.`); break }
      try { added.push({ name: file.name, mimeType: file.type || 'application/octet-stream', size: file.size, data: await readBase64(file) }); total += file.size; count += 1 }
      catch (e) { setError(e instanceof Error ? e.message : 'A file could not be read.'); break }
    }
    if (added.length) setUploads(previous => [...previous, ...added])
  }

  const problem = () => {
    const recipients = [parseRecipients(to), parseRecipients(cc), parseRecipients(bcc)]
    const invalid = recipients.flatMap(r => r.invalid)
    if (invalid.length) return `These are not valid email addresses: ${invalid.slice(0, 3).join(', ')}.`
    if (!recipients[0].addresses.length) return 'Add at least one recipient in To.'
    if (new Set(recipients.flatMap(r => r.addresses.map(a => a.toLowerCase()))).size > EMAIL_LIMITS.recipients) return `An email can go to at most ${EMAIL_LIMITS.recipients} recipients.`
    if (!subject.trim()) return 'Enter a subject.'
    if (!message.trim() && !attachmentCount) return 'Write a message or attach a file.'
    if (!taskIds.length) return 'Link the email to a task or subtask, so it is kept with the work.'
    return ''
  }
  const submit = () => {
    if (busy) return
    const found = problem()
    if (found) { setError(found); return }
    setBusy(true)
    outbox.queue({ to, cc, bcc, subject: subject.trim(), message, taskIds, driveFiles, uploads, replyToId: prefill.replyToId })
    onClose()
  }
  const reasonBlocked = !status ? '' : !status.writer ? 'Viewer accounts cannot send email.' : !status.available || !status.connected ? (status.message || (status.reconnectRequired ? 'Reconnect your Gmail account in Work Hub → My integration settings.' : 'Connect your Gmail account in Work Hub → My integration settings first.')) : ''
  // The people copied automatically from the original email, until the person edits the Cc line.
  const copiedFromOriginal = Boolean(prefill.autoCc && prefill.cc && cc === prefill.cc), copiedCount = copiedFromOriginal ? splitAddresses(cc).length : 0
  const needsPermission = Boolean(status && !reasonBlocked && !status.canSend)
  const ready = Boolean(status && !reasonBlocked && status.canSend)

  return <dialog ref={dialog} className="modal email-composer" aria-labelledby={titleId} aria-modal="true"
    onCancel={event => { event.preventDefault(); close() }}>
    <div className="modal-head"><div><h2 id={titleId}><Mail size={18} aria-hidden="true" /> {prefill.replyToId ? 'Reply by email' : 'New email'}</h2>
      <p>{status?.email ? `Sent from ${status.email}, like any email you send from Gmail.` : 'Sent from your own Gmail account.'}</p></div>
      <button className="icon-button" type="button" aria-label="Close email" onClick={close}><X size={20} /></button></div>
    <div className="email-composer-body">
      {!status && !statusError && <p role="status">Checking your Gmail connection…</p>}
      {statusError && <p role="alert" className="email-error">{statusError}</p>}
      {reasonBlocked && <p role="alert" className="email-error">{reasonBlocked}</p>}
      {needsPermission && <div className="email-permission" role="alert"><p>The tracker needs your permission to send email as you. You approve it once on Google’s page, then return to Work Hub. This email will not be kept, so start it again after approving.</p>
        <button type="button" className="primary" disabled={busy} onClick={() => { setBusy(true); void allowSending().catch(e => { setError(e instanceof Error ? e.message : 'Could not start the Google permission step.'); setBusy(false) }) }}>Allow sending</button></div>}
      <div className="email-fields">
        <RecipientInput label="To" value={to} onChange={setTo} local={people} taken={taken} search={searchContacts} placeholder="name@company.com, another@company.com" />
        {!showCopies && <button type="button" className="link-button email-copies-toggle" onClick={() => setShowCopies(true)}>Add Cc or Bcc</button>}
        {showCopies && <><RecipientInput label="Cc" value={cc} onChange={setCc} local={people} taken={taken} search={searchContacts} />
          <RecipientInput label="Bcc" value={bcc} onChange={setBcc} local={people} taken={taken} search={searchContacts}><small>Bcc recipients are not shown to the others, and are left out of the note on the task.</small></RecipientInput></>}
        {copiedFromOriginal && <p className="email-note" role="status">{copiedCount} {copiedCount === 1 ? 'other person from the original email is' : 'other people from the original email are'} copied and will see your reply. <button type="button" className="link-button email-copies-toggle" onClick={() => setCc('')}>Reply to sender only</button></p>}
        <label>Subject<input value={subject} maxLength={EMAIL_LIMITS.subject} onChange={e => setSubject(e.target.value)} /></label>
        <label>Message<textarea rows={9} value={message} maxLength={EMAIL_LIMITS.body} onChange={e => setMessage(e.target.value)} /></label>
        <details className="email-signature"><summary>Signature</summary>
          <textarea rows={3} defaultValue={signature.current} aria-label="Email signature" onChange={e => { signature.current = e.target.value; writeSignature(currentUser, e.target.value) }} placeholder="Name, title, phone" />
          <small>Added to new emails on this browser. Gmail does not add your Gmail signature to emails sent by the tracker.</small></details>
      </div>
      <section className="email-section" aria-label="Linked work">
        <h3>Linked task or subtask</h3>
        <p>The email is kept in Work Hub with the work, and a short note (recipient, subject and file names, never the message) is added to the task’s activity.</p>
        {taskIds.length > 0 && <ul className="email-chips">{taskIds.map(id => <li key={id}><span>{taskLabel(id)}</span><button type="button" aria-label={`Unlink ${taskLabel(id)}`} onClick={() => setTaskIds(previous => previous.filter(x => x !== id))}><X size={13} /></button></li>)}</ul>}
        {taskIds.length < EMAIL_LIMITS.taskLinks && <div className="email-fields email-pick">
          <label>Client<select value={clientFilter} onChange={e => { setClientFilter(e.target.value); setPickTask('') }}><option value="">All clients</option>{clients.filter(client => !client.archived).map(client => <option key={client.id} value={client.id}>{client.name}</option>)}</select></label>
          <label>{taskIds.length ? 'Link another' : 'Task or subtask'}<select value={pickTask} onChange={e => { const id = e.target.value; setPickTask(''); if (id) setTaskIds(previous => [...previous, id]) }}><option value="">Choose a task or subtask</option>{options.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
        </div>}
      </section>
      <section className="email-section" aria-label="Attachments">
        <h3>Attachments</h3>
        {attachmentCount > 0 && <ul className="email-chips">
          {driveFiles.map(file => <li key={`d:${file.fileId}`}><Paperclip size={13} aria-hidden="true" /><span>{file.name}{file.size ? ` · ${formatBytes(file.size)}` : ''} · Google Drive</span><button type="button" aria-label={`Remove ${file.name}`} onClick={() => setDriveFiles(previous => previous.filter(x => x.fileId !== file.fileId))}><X size={13} /></button></li>)}
          {uploads.map((file, index) => <li key={`u:${index}:${file.name}`}><Paperclip size={13} aria-hidden="true" /><span>{file.name} · {formatBytes(file.size)}</span><button type="button" aria-label={`Remove ${file.name}`} onClick={() => setUploads(previous => previous.filter((_x, i) => i !== index))}><X size={13} /></button></li>)}
        </ul>}
        <div className="email-attach-actions">
          <button type="button" className="secondary" aria-expanded={driveOpen} onClick={() => setDriveOpen(value => !value)}><FolderOpen size={15} aria-hidden="true" /> Attach from Google Drive</button>
          <button type="button" className="secondary" onClick={() => fileInput.current?.click()}><Paperclip size={15} aria-hidden="true" /> Attach from this computer</button>
          <input ref={fileInput} type="file" multiple hidden onChange={e => void addUploads(e.target.files)} />
        </div>
        <small>{attachmentCount ? `${attachmentCount} file${attachmentCount === 1 ? '' : 's'}` : 'No files'} · up to {formatBytes(EMAIL_LIMITS.attachmentBytes)} in total{usedBytes ? ` (${formatBytes(usedBytes)} used)` : ''}. Gmail does not allow program files such as .exe.</small>
        {driveOpen && <div className="email-drive-panel" role="region" aria-label="Files saved in Google Drive">
          <label>Search<input value={fileQuery} onChange={e => setFileQuery(e.target.value)} placeholder="File or task name" /></label>
          {!groups.length ? <p>No matching files. Files appear here after they are saved to a task: email attachments (Save to Drive), signed documents and generated documents.</p>
            : <ul className="email-drive-groups">{groups.map(({ item, files }) => <li key={item.id}><strong>{item.parentTaskId ? '↳ ' : ''}{item.title}</strong><small>{placeOf(scope, item)}</small>
              <ul>{files.map(file => { const attached = driveFiles.some(x => x.fileId === file.id); return <li key={file.id}><span>{file.name}<small>{formatBytes(file.size)}{file.savedByName ? ` · ${file.savedByName}` : ''}</small></span>
                <button type="button" className="secondary compact" disabled={attached} onClick={() => addDrive(item.id, file)}>{attached ? 'Attached' : 'Attach'}</button></li> })}</ul></li>)}</ul>}
        </div>}
      </section>
      {prefill.notice && <p className="email-note" role="status">{prefill.notice}</p>}
      {prefill.replyToId && <p className="email-note">This reply stays in the same Gmail conversation.</p>}
      {error && <p role="alert" className="email-error">{error}</p>}
    </div>
    <div className="email-composer-actions">
      <small>After you press Send you have {UNDO_SECONDS} seconds to undo. Keep this page open until it is sent.</small>
      <div><button type="button" className="secondary" disabled={busy} onClick={close}>Cancel</button><button type="button" className="primary" disabled={busy || !ready} onClick={submit}><Send size={15} aria-hidden="true" /> Send email</button></div>
    </div>
  </dialog>
}
