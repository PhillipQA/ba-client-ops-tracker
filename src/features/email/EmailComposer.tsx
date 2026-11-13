import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { FolderOpen, Mail, Maximize2, Minimize2, Minus, Paperclip, Send, Undo2, X } from 'lucide-react'
import type { Client, Project, UserAccount, WorkItem } from '../../shared/types'
import {
  EMAIL_LIMITS,
  blockedAttachmentReason,
  formatBytes,
  isValidEmail,
  parseRecipients,
  splitAddresses,
} from './emailCompose'
import { outbox, UNDO_SECONDS, type DriveRef, type EmailDraft, type OutboxEntry, type Upload } from './emailOutbox'
import { driveFileGroups, placeOf, taskChoices } from '../documents/documentDriveTargets'
import { workHubSync } from '../work-hub/workHubSync'
import { RecipientInput, addressesOn, type Suggestion } from '../../shared/ui/RecipientInput'
import { knownPeople } from '../../shared/knownPeople'
import { searchContacts } from '../../shared/contactSearch'
import { MentionTextarea } from './MentionTextarea'
import { activeMentions, type Mention } from './emailMentions'
import './emailComposer.css'
import { useIsClosed } from '../tasks/openWork'
import ClientSelect, { SearchSelect } from '../../shared/ui/SearchSelect'
import { applyTemplateBody, emailStore, signatureBlock, type EmailTemplate } from './emailStore'
import { EmailTemplatesManager } from './EmailTemplates'
import { SignatureEditor } from './SignatureEditor'
import { sanitizeSignature, signatureHtml, storeSignature } from './signatureHtml'
import { COMPOSE_EVENT, type ComposePrefill } from './composeEvent'
import {
  draftKey,
  draftPrefill,
  hasContent,
  MAX_DRAFTS,
  readDrafts,
  removeDraft,
  type SavedDraft,
  saveDraft,
} from './emailDrafts'

/**
 * Send an email from the tracker, from the person's own Gmail account.
 * Opened from anywhere with composeEmail(); the email is linked to the tasks or subtasks chosen here.
 */
// Kept in composeEvent.ts (no styles or UI) so code and tests can open the composer without loading it.
export { composeEmail, type ComposePrefill } from './composeEvent'

// Buttons elsewhere in the app show only when this person can send. The host reports it here.
let enabled = false
const enabledListeners = new Set<() => void>()
function setEmailEnabled(value: boolean) {
  if (enabled !== value) {
    enabled = value
    enabledListeners.forEach(listener => listener())
  }
}
export function useEmailEnabled() {
  return useSyncExternalStore(
    listener => {
      enabledListeners.add(listener)
      return () => {
        enabledListeners.delete(listener)
      }
    },
    () => enabled,
    () => false,
  )
}

type Status = {
  writer: boolean
  available: boolean
  connected: boolean
  canSend: boolean
  reconnectRequired: boolean
  email: string
  message: string
}
type Scope = { items: WorkItem[]; clients: Client[]; projects: Project[] }
/** Teammates whose addresses can be suggested. */
type Team = { accounts?: UserAccount[] }

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result || '')
      resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.onerror = () => reject(new Error(`“${file.name}” could not be read.`))
    reader.readAsDataURL(file)
  })
}
const signatureKey = (user: UserAccount) => `email-signature:${user.organizationId || ''}:${user.id}`
function readSignature(user: UserAccount) {
  try {
    return localStorage.getItem(signatureKey(user)) || ''
  } catch {
    return ''
  }
}
function writeSignature(user: UserAccount, value: string) {
  try {
    localStorage.setItem(signatureKey(user), value)
  } catch {
    /* The signature still applies to this email. */
  }
}

async function allowSending() {
  const response = await fetch('/api/communications/gmail/connect?send=1', { credentials: 'same-origin' })
  const result = await response.json().catch(() => ({}))
  if (!response.ok || !result.url) throw new Error(result.error || 'Could not start the Google permission step.')
  window.location.assign(result.url)
}

export function EmailComposerHost({
  enabled: allowed,
  items,
  clients,
  projects,
  accounts,
  currentUser,
  onSent,
}: Scope & Team & { enabled: boolean; currentUser: UserAccount; onSent?: () => void | Promise<void> }) {
  // The email windows, like Gmail's compose windows: docked at the bottom right, each can be minimized or made larger.
  // Each is a draft, saved as it is written, so a minimized or interrupted email is never lost.
  const storageKey = draftKey(currentUser)
  const [windows, setWindows] = useState<ComposeWindow[]>(() =>
    allowed
      ? readDrafts(storage(), storageKey).map((draft, index) => ({
          id: draft.id,
          prefill: draftPrefill(draft),
          mode: 'min' as const,
          key: index,
        }))
      : [],
  )
  useEffect(() => {
    setEmailEnabled(allowed)
    return () => setEmailEnabled(false)
  }, [allowed])
  const openWindow = (prefill: ComposePrefill) =>
    setWindows(current => {
      if (current.length >= MAX_DRAFTS) {
        window.alert(
          `You already have ${MAX_DRAFTS} emails open. Send or discard one of them (at the bottom of the screen) first.`,
        )
        return current
      }
      // A new email opens in front; the others are minimized so they do not cover it.
      return [
        ...current.map(item => ({ ...item, mode: 'min' as const })),
        { id: newDraftId(), prefill, mode: 'normal' as const, key: Date.now() },
      ]
    })
  useEffect(() => {
    if (!allowed) return
    const listen = (event: Event) => openWindow((event as CustomEvent<ComposePrefill>).detail || {})
    window.addEventListener(COMPOSE_EVENT, listen)
    return () => window.removeEventListener(COMPOSE_EVENT, listen)
  }, [allowed])
  // Only one window is large at a time.
  const setMode = (id: string, mode: WindowMode) =>
    setWindows(current =>
      current.map(item => {
        if (item.id === id) return { ...item, mode }
        return mode === 'max' && item.mode === 'max' ? { ...item, mode: 'normal' as const } : item
      }),
    )
  /** Sent or discarded: the window and its draft go. */
  const closeWindow = (id: string) => {
    removeDraft(storage(), storageKey, id)
    setWindows(current => current.filter(item => item.id !== id))
  }
  const afterSent = useRef(onSent)
  afterSent.current = onSent
  useEffect(
    () =>
      outbox.onSent(() => {
        workHubSync.invalidate('gmail')
        window.dispatchEvent(new Event('email-sent'))
        void afterSent.current?.()
      }),
    [],
  )
  if (!allowed) return null
  const edit = (draft: EmailDraft) => openWindow({ ...draft, restored: true })
  const large = windows.find(item => item.mode === 'max')
  return (
    <>
      {large && (
        <div className="email-window-backdrop" aria-hidden="true" onClick={() => setMode(large.id, 'normal')} />
      )}
      {windows.length > 0 && (
        <div className="email-window-dock">
          {windows.map(item => (
            <EmailComposer
              key={item.key}
              draftId={item.id}
              mode={item.mode}
              onMode={mode => setMode(item.id, mode)}
              onDraft={draft => saveDraft(storage(), storageKey, draft)}
              prefill={item.prefill}
              items={items}
              clients={clients}
              projects={projects}
              accounts={accounts}
              currentUser={currentUser}
              onClose={() => closeWindow(item.id)}
            />
          ))}
        </div>
      )}
      <EmailOutboxBar onEdit={edit} />
    </>
  )
}

type WindowMode = 'normal' | 'min' | 'max'
type ComposeWindow = { id: string; prefill: ComposePrefill; mode: WindowMode; key: number }
function storage() {
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}
const newDraftId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`

/** Emails waiting out the undo window, being sent, just sent, or that failed. */
function EmailOutboxBar({ onEdit }: { onEdit: (draft: EmailDraft) => void }) {
  const entries = useSyncExternalStore(outbox.subscribe, outbox.snapshot, outbox.snapshot)
  if (!entries.length) return null
  return (
    <div className="email-outbox" role="region" aria-label="Emails being sent">
      {entries.map((entry: OutboxEntry) => (
        <div
          key={entry.id}
          className={`email-outbox-item ${entry.phase}`}
          role={entry.phase === 'failed' ? 'alert' : 'status'}
        >
          <div className="email-outbox-text">
            <strong>{entry.draft.subject || '(no subject)'}</strong>
            {entry.phase === 'waiting' && (
              <span>
                Sending to {entry.summary} in {entry.secondsLeft} s. You can still change it.
              </span>
            )}
            {entry.phase === 'sending' && <span>Sending to {entry.summary}…</span>}
            {entry.phase === 'sent' && (
              <span>
                Sent to {entry.summary}. A copy is in Work Hub, linked to the task.
                {entry.warning ? ` ${entry.warning}` : ''}
              </span>
            )}
            {entry.phase === 'failed' && <span>{entry.error}</span>}
          </div>
          <div className="email-outbox-actions">
            {entry.phase === 'waiting' && (
              <>
                <button
                  type="button"
                  className="secondary compact"
                  onClick={() => {
                    const draft = outbox.undo(entry.id)
                    if (draft) onEdit(draft)
                  }}
                >
                  <Undo2 size={14} aria-hidden="true" /> Undo
                </button>
                <button type="button" className="primary compact" onClick={() => outbox.sendNow(entry.id)}>
                  Send now
                </button>
              </>
            )}
            {entry.phase === 'failed' && (
              <>
                {entry.code === 'NETWORK' && (
                  <button type="button" className="primary compact" onClick={() => outbox.retry(entry.id)}>
                    Retry
                  </button>
                )}
                {entry.code !== 'NETWORK' && entry.code !== 'UNCONFIRMED' && (
                  <button
                    type="button"
                    className="primary compact"
                    onClick={() => {
                      const draft = outbox.undo(entry.id)
                      if (draft) onEdit(draft)
                    }}
                  >
                    Edit
                  </button>
                )}
                <button type="button" className="secondary compact" onClick={() => outbox.dismiss(entry.id)}>
                  Dismiss
                </button>
              </>
            )}
            {entry.phase === 'sent' && (
              <button type="button" className="secondary compact" onClick={() => outbox.dismiss(entry.id)}>
                Close
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

export function EmailComposer({
  prefill,
  items,
  clients,
  projects,
  accounts,
  currentUser,
  onClose,
  draftId,
  mode = 'normal',
  onMode,
  onDraft,
}: Scope &
  Team & {
    prefill: ComposePrefill
    currentUser: UserAccount
    onClose: () => void
    /** The draft this window saves to as it is written. */
    draftId?: string
    mode?: WindowMode
    onMode?: (mode: WindowMode) => void
    /** Saves the draft; answers false when the browser would not keep it. */
    onDraft?: (draft: SavedDraft) => boolean
  }) {
  const scope: Scope = { items, clients, projects }
  const titleId = useId()
  const windowRef = useRef<HTMLElement>(null)
  const primary = items.find(item => item.id === prefill.taskIds?.[0])
  const clientEmail = clients.find(client => client.id === primary?.clientId)?.email || ''
  // The signature lives on the person's account, formatted (see signatureHtml). It is shown under the message and
  // added when the email is sent, not typed into the message. The copy in this browser shows at once.
  // `signature` is the text block older versions put in the message itself: none now.
  const signature = useRef('')
  const [signatureShown, setSignatureShown] = useState(() => signatureHtml(readSignature(currentUser)))
  const [addSignature, setAddSignature] = useState(prefill.signature !== false)
  const [signatureNote, setSignatureNote] = useState('')
  const signatureTimer = useRef<number | undefined>(undefined)
  const [to, setTo] = useState(prefill.to ?? (isValidEmail(clientEmail) ? clientEmail : ''))
  const [cc, setCc] = useState(prefill.cc ?? ''),
    [bcc, setBcc] = useState(prefill.bcc ?? '')
  const [showCopies, setShowCopies] = useState(Boolean(prefill.cc || prefill.bcc))
  const [subject, setSubject] = useState(prefill.subject ?? '')
  const [message, setMessage] = useState(prefill.message ?? signatureBlock(signature.current))
  /** People @mentioned in the message. Only those still written in it are sent. */
  const [mentions, setMentions] = useState<Mention[]>([])
  const [templates, setTemplates] = useState<EmailTemplate[] | null>(null)
  const [managing, setManaging] = useState(false)
  const [saveAs, setSaveAs] = useState<{ subject: string; body: string } | undefined>(undefined)
  const [taskIds, setTaskIds] = useState<string[]>(prefill.taskIds ?? [])
  const [driveFiles, setDriveFiles] = useState<DriveRef[]>(prefill.driveFiles ?? [])
  const [uploads, setUploads] = useState<Upload[]>(prefill.uploads ?? [])
  const [status, setStatus] = useState<Status | null>(null),
    [statusError, setStatusError] = useState('')
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const [clientFilter, setClientFilter] = useState(primary?.clientId ?? '')
  const [driveOpen, setDriveOpen] = useState(false),
    [fileQuery, setFileQuery] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)
  // Type-ahead for the recipient lines: clients and teammates are known here; people emailed before come from the server.
  const people = useMemo<Suggestion[]>(
    () => knownPeople({ clients, accounts, leaveOut: { id: currentUser.id, email: currentUser.email } }),
    [clients, accounts, currentUser.id, currentUser.email],
  )
  const taken = useMemo(() => [...addressesOn(to), ...addressesOn(cc), ...addressesOn(bcc)], [to, cc, bcc])
  // Ask once as the composer opens, so the list is ready by the time someone types.
  useEffect(() => {
    searchContacts('').catch(() => {})
  }, [])
  const initial = useRef(
    JSON.stringify([to, cc, bcc, subject, message, taskIds, driveFiles, uploads.map(file => file.name)]),
  )
  const dirty = () =>
    Boolean(prefill.restored) ||
    JSON.stringify([to, cc, bcc, subject, message, taskIds, driveFiles, uploads.map(file => file.name)]) !==
      initial.current

  // A window that opens in front takes focus, so typing goes to it.
  useEffect(() => {
    if (mode !== 'min') windowRef.current?.querySelector<HTMLElement>('input, textarea')?.focus({ preventScroll: true })
  }, [])
  // Saved as a draft while it is written (half a second after the last change), once it holds anything.
  const [draftNote, setDraftNote] = useState('')
  const draftTimer = useRef<number | undefined>(undefined)
  const saveNow = () => {
    if (!draftId || !onDraft) return
    window.clearTimeout(draftTimer.current)
    const content = { to, cc, bcc, subject, message }
    if (!hasContent(content, signatureBlock(signature.current)) && !driveFiles.length && !uploads.length) return
    const saved = onDraft({
      id: draftId,
      updatedAt: new Date().toISOString(),
      ...content,
      taskIds,
      driveFiles,
      ...(prefill.replyToId ? { replyToId: prefill.replyToId } : {}),
      ...(prefill.autoCc ? { autoCc: true } : {}),
      ...(uploads.length ? { droppedUploads: uploads.map(file => file.name) } : {}),
    })
    setDraftNote(saved ? 'Draft saved' : 'This browser could not save the draft')
  }
  useEffect(() => {
    if (!draftId || !onDraft) return
    window.clearTimeout(draftTimer.current)
    draftTimer.current = window.setTimeout(saveNow, 500)
    return () => window.clearTimeout(draftTimer.current)
  }, [to, cc, bcc, subject, message, taskIds, driveFiles, uploads])
  useEffect(() => {
    const controller = new AbortController()
    void fetch('/api/communications/send/status', { credentials: 'same-origin', signal: controller.signal })
      .then(async response => {
        const result = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(result.error || 'Could not check your Gmail connection.')
        return result as Status
      })
      .then(setStatus)
      .catch(e => {
        if (!controller.signal.aborted)
          setStatusError(e instanceof Error ? e.message : 'Could not check your Gmail connection.')
      })
    return () => controller.abort()
  }, [])
  const close = () => {
    // A restored draft is unchanged but still worth asking about before it is deleted.
    const typed = hasContent({ to, cc, bcc, subject, message }, signatureBlock(signature.current))
    const written = dirty() || typed || attachmentCount > 0
    if (!busy && (!written || window.confirm('Discard this draft? It will be deleted.'))) onClose()
  }
  const toggleMin = () => onMode?.(mode === 'min' ? 'normal' : 'min')

  // Load the account's signature. One only kept in this browser (before v0.8.0) is moved to the account once.
  useEffect(() => {
    let live = true
    emailStore
      .signature()
      .then(async result => {
        if (!live) return
        let stored = result.signature
        const local = readSignature(currentUser)
        if (!result.saved && local.trim())
          stored = (await emailStore.saveSignature(local).catch(() => ({ signature: local }))).signature
        if (!live) return
        writeSignature(currentUser, stored)
        setSignatureShown(signatureHtml(stored))
      })
      .catch(error => {
        if (live && error?.status === 503)
          setSignatureNote(
            'Saved on this browser only until your Administrator applies the email templates update (schema v26).',
          )
      })
    return () => {
      live = false
      window.clearTimeout(signatureTimer.current)
    }
  }, [])
  const signatureSafe = sanitizeSignature(signatureShown)
  const editSignature = (html: string) => {
    const stored = storeSignature(html)
    setSignatureShown(signatureHtml(stored))
    writeSignature(currentUser, stored)
    window.clearTimeout(signatureTimer.current)
    signatureTimer.current = window.setTimeout(() => {
      emailStore
        .saveSignature(stored)
        .then(() => setSignatureNote('Saved to your account. It is added to your emails on any device.'))
        .catch(error =>
          setSignatureNote(
            error?.status === 503
              ? 'Saved on this browser only until your Administrator applies the email templates update (schema v26).'
              : error instanceof Error
                ? error.message
                : 'The signature could not be saved.',
          ),
        )
    }, 700)
  }
  // Before the templates update (schema v26) is applied there is nothing to show, so the Template field stays hidden.
  const loadTemplates = () =>
    emailStore
      .templates()
      .then(result => setTemplates(result.templates))
      .catch(error => setTemplates(error?.status === 503 || error?.status === 403 ? null : []))
  useEffect(() => {
    void loadTemplates()
  }, [])
  const applyTemplate = (template: EmailTemplate) => {
    const typed =
      message.trim() !== signatureBlock(signature.current).trim() ||
      (subject.trim() !== '' && subject !== template.subject)
    if (typed && !window.confirm(`Replace the subject and message with the template “${template.name}”?`)) return false
    if (template.subject) setSubject(template.subject)
    setMessage(applyTemplateBody(template.body, signature.current))
    return true
  }

  const usedBytes =
    uploads.reduce((sum, file) => sum + file.size, 0) + driveFiles.reduce((sum, file) => sum + (file.size || 0), 0)
  const attachmentCount = uploads.length + driveFiles.length
  const taskLabel = (id: string) => {
    const item = items.find(candidate => candidate.id === id)
    return item ? `${item.parentTaskId ? '↳ ' : ''}${item.title}` : 'Removed task'
  }
  const isClosed = useIsClosed()
  const taskPicks = useMemo(
    () => [
      { value: '', label: taskIds.length ? 'Link another task or subtask' : 'Choose a task or subtask' },
      ...taskChoices(scope, clientFilter, isClosed).filter(option => !taskIds.includes(option.value)),
    ],
    [items, clients, projects, clientFilter, taskIds, isClosed],
  )
  const linkedFirst = (id: string) =>
    taskIds.includes(id) || taskIds.includes(items.find(item => item.id === id)?.parentTaskId || '')
  const groups = useMemo(
    () =>
      driveFileGroups(scope, { allowed: null, clientId: clientFilter, query: fileQuery }).sort(
        (a, b) => Number(linkedFirst(b.item.id)) - Number(linkedFirst(a.item.id)),
      ),
    [items, clients, projects, clientFilter, fileQuery, taskIds],
  )

  const addDrive = (taskId: string, file: { id: string; name: string; size: number }) => {
    const blocked = blockedAttachmentReason(file.name)
    if (blocked) {
      setError(blocked)
      return
    }
    if (attachmentCount >= EMAIL_LIMITS.attachments) {
      setError(`An email can have at most ${EMAIL_LIMITS.attachments} attachments.`)
      return
    }
    if (usedBytes + (file.size || 0) > EMAIL_LIMITS.attachmentBytes) {
      setError(`“${file.name}” does not fit. Attachments can total ${formatBytes(EMAIL_LIMITS.attachmentBytes)}.`)
      return
    }
    setError('')
    setDriveFiles(previous => [...previous, { taskId, fileId: file.id, name: file.name, size: file.size || 0 }])
  }
  const addUploads = async (list: FileList | null) => {
    const files = Array.from(list || [])
    if (fileInput.current) fileInput.current.value = ''
    if (!files.length) return
    setError('')
    let total = usedBytes,
      count = attachmentCount
    const added: Upload[] = []
    for (const file of files) {
      const blocked = blockedAttachmentReason(file.name)
      if (blocked) {
        setError(blocked)
        break
      }
      if (!file.size) {
        setError(`“${file.name}” is empty.`)
        break
      }
      if (count >= EMAIL_LIMITS.attachments) {
        setError(`An email can have at most ${EMAIL_LIMITS.attachments} attachments.`)
        break
      }
      if (total + file.size > EMAIL_LIMITS.attachmentBytes) {
        setError(`“${file.name}” does not fit. Attachments can total ${formatBytes(EMAIL_LIMITS.attachmentBytes)}.`)
        break
      }
      try {
        added.push({
          name: file.name,
          mimeType: file.type || 'application/octet-stream',
          size: file.size,
          data: await readBase64(file),
        })
        total += file.size
        count += 1
      } catch (e) {
        setError(e instanceof Error ? e.message : 'A file could not be read.')
        break
      }
    }
    if (added.length) setUploads(previous => [...previous, ...added])
  }

  const problem = () => {
    const recipients = [parseRecipients(to), parseRecipients(cc), parseRecipients(bcc)]
    const invalid = recipients.flatMap(r => r.invalid)
    if (invalid.length) return `These are not valid email addresses: ${invalid.slice(0, 3).join(', ')}.`
    if (!recipients[0].addresses.length) return 'Add at least one recipient in To.'
    if (new Set(recipients.flatMap(r => r.addresses.map(a => a.toLowerCase()))).size > EMAIL_LIMITS.recipients)
      return `An email can go to at most ${EMAIL_LIMITS.recipients} recipients.`
    if (!subject.trim()) return 'Enter a subject.'
    if (!message.trim() && !attachmentCount) return 'Write a message or attach a file.'
    if (!taskIds.length) return 'Link the email to a task or subtask, so it is kept with the work.'
    return ''
  }
  const submit = () => {
    if (busy) return
    const found = problem()
    if (found) {
      setError(found)
      return
    }
    setBusy(true)
    outbox.queue({
      to,
      cc,
      bcc,
      subject: subject.trim(),
      message,
      taskIds,
      driveFiles,
      uploads,
      replyToId: prefill.replyToId,
      mentions: activeMentions(message, mentions),
      signature: addSignature && Boolean(signatureShown),
    })
    onClose()
  }
  const reasonBlocked = !status
    ? ''
    : !status.writer
      ? 'Viewer accounts cannot send email.'
      : !status.available || !status.connected
        ? status.message ||
          (status.reconnectRequired
            ? 'Reconnect your Gmail account in Work Hub → My integration settings.'
            : 'Connect your Gmail account in Work Hub → My integration settings first.')
        : ''
  // The people copied automatically from the original email, until the person edits the Cc line.
  const copiedFromOriginal = Boolean(prefill.autoCc && prefill.cc && cc === prefill.cc),
    copiedCount = copiedFromOriginal ? splitAddresses(cc).length : 0
  const needsPermission = Boolean(status && !reasonBlocked && !status.canSend)
  const ready = Boolean(status && !reasonBlocked && status.canSend)

  const manager = managing && (
    <EmailTemplatesManager
      userId={currentUser.id}
      canWrite={currentUser.role !== 'Viewer'}
      onClose={() => {
        setManaging(false)
        setSaveAs(undefined)
        void loadTemplates()
      }}
      onUse={template => {
        if (applyTemplate(template)) {
          setManaging(false)
          void loadTemplates()
        }
      }}
      startWith={saveAs ? { name: '', subject: saveAs.subject, body: saveAs.body, shared: true } : undefined}
    />
  )
  const heading = subject.trim() || (prefill.replyToId ? 'Reply by email' : 'New email')
  return (
    <section
      ref={windowRef}
      className={`modal email-composer is-${mode}`}
      role="dialog"
      aria-labelledby={titleId}
      onKeyDown={event => {
        // Escape makes a large window normal again, and a normal one minimized: nothing written is lost.
        if (event.key !== 'Escape' || managing) return
        event.stopPropagation()
        if (mode === 'max') onMode?.('normal')
        else if (mode === 'normal') onMode?.('min')
      }}
    >
      <header className="email-window-bar">
        <button
          type="button"
          className="email-window-title"
          title={mode === 'min' ? 'Open' : 'Minimize'}
          aria-expanded={mode !== 'min'}
          onClick={toggleMin}
        >
          <Mail size={15} aria-hidden="true" />
          <span id={titleId}>{heading}</span>
        </button>
        <button type="button" aria-label={mode === 'min' ? 'Open' : 'Minimize'} onClick={toggleMin}>
          <Minus size={15} />
        </button>
        <button
          type="button"
          aria-label={mode === 'max' ? 'Smaller' : 'Larger'}
          onClick={() => onMode?.(mode === 'max' ? 'normal' : 'max')}
        >
          {mode === 'max' ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>
        <button type="button" aria-label="Discard draft" title="Discard draft" onClick={close}>
          <X size={15} />
        </button>
      </header>
      <p className="email-window-from" hidden={mode === 'min'}>
        {status?.email
          ? `Sent from ${status.email}, like any email you send from Gmail.`
          : 'Sent from your own Gmail account.'}
      </p>
      <div className="email-composer-body" hidden={mode === 'min'}>
        {!status && !statusError && <p role="status">Checking your Gmail connection…</p>}
        {statusError && (
          <p role="alert" className="email-error">
            {statusError}
          </p>
        )}
        {reasonBlocked && (
          <p role="alert" className="email-error">
            {reasonBlocked}
          </p>
        )}
        {needsPermission && (
          <div className="email-permission" role="alert">
            <p>
              The tracker needs your permission to send email as you. You approve it once on Google’s page, then return
              to Work Hub. This email is kept as a draft and comes back minimized at the bottom of the screen (files
              from your computer need attaching again).
            </p>
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => {
                setBusy(true)
                saveNow()
                void allowSending().catch(e => {
                  setError(e instanceof Error ? e.message : 'Could not start the Google permission step.')
                  setBusy(false)
                })
              }}
            >
              Allow sending
            </button>
          </div>
        )}
        <div className="email-fields">
          <RecipientInput
            label="To"
            value={to}
            onChange={setTo}
            local={people}
            taken={taken}
            search={searchContacts}
            placeholder="name@company.com, another@company.com"
          />
          {!showCopies && (
            <button type="button" className="link-button email-copies-toggle" onClick={() => setShowCopies(true)}>
              Add Cc or Bcc
            </button>
          )}
          {showCopies && (
            <>
              <RecipientInput
                label="Cc"
                value={cc}
                onChange={setCc}
                local={people}
                taken={taken}
                search={searchContacts}
              />
              <RecipientInput
                label="Bcc"
                value={bcc}
                onChange={setBcc}
                local={people}
                taken={taken}
                search={searchContacts}
              >
                <small>Bcc recipients are not shown to the others, and are left out of the note on the task.</small>
              </RecipientInput>
            </>
          )}
          {copiedFromOriginal && (
            <p className="email-note" role="status">
              {copiedCount}{' '}
              {copiedCount === 1
                ? 'other person from the original email is'
                : 'other people from the original email are'}{' '}
              copied and will see your reply.{' '}
              <button type="button" className="link-button email-copies-toggle" onClick={() => setCc('')}>
                Reply to sender only
              </button>
            </p>
          )}
          {templates !== null && (
            <div className="email-template-bar">
              <label>
                Template
                <SearchSelect
                  value=""
                  onChange={id => {
                    const template = templates.find(item => item.id === id)
                    if (template) applyTemplate(template)
                  }}
                  choices={[
                    { value: '', label: templates.length ? 'Start from a template' : 'No templates yet' },
                    ...templates.map(template => ({
                      value: template.id,
                      label: template.name,
                      hint: template.shared ? template.subject : `Only me · ${template.subject}`,
                    })),
                  ]}
                  placeholder="Type a template name"
                  empty="No template matches"
                />
              </label>
              <span className="email-template-buttons">
                <button
                  type="button"
                  className="secondary compact"
                  onClick={() => {
                    setSaveAs(undefined)
                    setManaging(true)
                  }}
                >
                  Manage templates
                </button>
                {currentUser.role !== 'Viewer' &&
                  (subject.trim() || message.trim() !== signatureBlock(signature.current).trim()) && (
                    <button
                      type="button"
                      className="secondary compact"
                      title="Make a template from this subject and message"
                      onClick={() => {
                        const block = signatureBlock(signature.current)
                        setSaveAs({
                          subject,
                          body: block && message.endsWith(block) ? message.slice(0, -block.length) : message,
                        })
                        setManaging(true)
                      }}
                    >
                      Save as template
                    </button>
                  )}
              </span>
            </div>
          )}
          <label>
            Subject
            <input value={subject} maxLength={EMAIL_LIMITS.subject} onChange={e => setSubject(e.target.value)} />
          </label>
          <label>
            Message
            <MentionTextarea
              value={message}
              maxLength={EMAIL_LIMITS.body}
              onChange={setMessage}
              local={people}
              search={searchContacts}
              onMention={mention => {
                setMentions(list => [...list, mention])
                // Like Outlook: a mentioned person is added to To, unless they are already on a recipient line.
                if (!taken.includes(mention.email.toLowerCase()))
                  setTo(current =>
                    current.trim() ? `${current.trim().replace(/[,;]\s*$/, '')}, ${mention.email}` : mention.email,
                  )
              }}
            />
          </label>
          {signatureShown && (
            <div className="email-signature-preview">
              <label className="email-signature-toggle">
                <input type="checkbox" checked={addSignature} onChange={e => setAddSignature(e.target.checked)} />
                Add my signature under the message
              </label>
              {addSignature && (
                // Cleaned by sanitizeSignature: only safe formatting, links and embedded pictures are left.
                // biome-ignore lint/security/noDangerouslySetInnerHtml: the HTML is sanitized just above
                <div className="email-signature-shown" dangerouslySetInnerHTML={{ __html: signatureSafe }} />
              )}
            </div>
          )}
          <details className="email-signature">
            <summary>{signatureShown ? 'Edit signature' : 'Add a signature'}</summary>
            <SignatureEditor html={signatureShown} onChange={editSignature} />
            <small>
              Yours only, saved to your account and added under your emails. Format it like in Gmail: fonts, colours,
              highlight, links and pictures such as a logo. Gmail does not add your Gmail signature to emails sent by
              the tracker.
            </small>
            {signatureNote && (
              <small className="email-signature-status" role="status">
                {signatureNote}
              </small>
            )}
          </details>
        </div>
        <section className="email-section" aria-label="Linked work">
          <h3>Linked task or subtask</h3>
          <p>
            The email is kept in Work Hub with the work, and a short note (recipient, subject and file names, never the
            message) is added to the task’s activity.
          </p>
          {taskIds.length > 0 && (
            <ul className="email-chips">
              {taskIds.map(id => (
                <li key={id}>
                  <span>{taskLabel(id)}</span>
                  <button
                    type="button"
                    aria-label={`Unlink ${taskLabel(id)}`}
                    onClick={() => setTaskIds(previous => previous.filter(x => x !== id))}
                  >
                    <X size={13} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {taskIds.length < EMAIL_LIMITS.taskLinks && (
            <div className="email-fields email-pick">
              <label>
                Client
                <ClientSelect
                  clients={clients.filter(client => !client.archived)}
                  value={clientFilter}
                  onChange={value => {
                    setClientFilter(value)
                  }}
                  extra={[{ value: '', label: 'All clients' }]}
                />
              </label>
              <label>
                {taskIds.length ? 'Link another' : 'Task or subtask'}
                <SearchSelect
                  choices={taskPicks}
                  value=""
                  onChange={id => {
                    if (id) setTaskIds(previous => [...previous, id])
                  }}
                  placeholder="Type a task or subtask"
                  empty="No open task or subtask matches"
                />
              </label>
            </div>
          )}
        </section>
        <section className="email-section" aria-label="Attachments">
          <h3>Attachments</h3>
          {attachmentCount > 0 && (
            <ul className="email-chips">
              {driveFiles.map(file => (
                <li key={`d:${file.fileId}`}>
                  <Paperclip size={13} aria-hidden="true" />
                  <span>
                    {file.name}
                    {file.size ? ` · ${formatBytes(file.size)}` : ''} · Google Drive
                  </span>
                  <button
                    type="button"
                    aria-label={`Remove ${file.name}`}
                    onClick={() => setDriveFiles(previous => previous.filter(x => x.fileId !== file.fileId))}
                  >
                    <X size={13} />
                  </button>
                </li>
              ))}
              {uploads.map((file, index) => (
                <li key={`u:${index}:${file.name}`}>
                  <Paperclip size={13} aria-hidden="true" />
                  <span>
                    {file.name} · {formatBytes(file.size)}
                  </span>
                  <button
                    type="button"
                    aria-label={`Remove ${file.name}`}
                    onClick={() => setUploads(previous => previous.filter((_x, i) => i !== index))}
                  >
                    <X size={13} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="email-attach-actions">
            <button
              type="button"
              className="secondary"
              aria-expanded={driveOpen}
              onClick={() => setDriveOpen(value => !value)}
            >
              <FolderOpen size={15} aria-hidden="true" /> Attach from Google Drive
            </button>
            <button type="button" className="secondary" onClick={() => fileInput.current?.click()}>
              <Paperclip size={15} aria-hidden="true" /> Attach from this computer
            </button>
            <input ref={fileInput} type="file" multiple hidden onChange={e => void addUploads(e.target.files)} />
          </div>
          <small>
            {attachmentCount ? `${attachmentCount} file${attachmentCount === 1 ? '' : 's'}` : 'No files'} · up to{' '}
            {formatBytes(EMAIL_LIMITS.attachmentBytes)} in total{usedBytes ? ` (${formatBytes(usedBytes)} used)` : ''}.
            Gmail does not allow program files such as .exe.
          </small>
          {driveOpen && (
            <div className="email-drive-panel" role="region" aria-label="Files saved in Google Drive">
              <label>
                Search
                <input value={fileQuery} onChange={e => setFileQuery(e.target.value)} placeholder="File or task name" />
              </label>
              {!groups.length ? (
                <p>
                  No matching files. Files appear here after they are saved to a task: email attachments (Save to
                  Drive), signed documents and generated documents.
                </p>
              ) : (
                <ul className="email-drive-groups">
                  {groups.map(({ item, files }) => (
                    <li key={item.id}>
                      <strong>
                        {item.parentTaskId ? '↳ ' : ''}
                        {item.title}
                      </strong>
                      <small>{placeOf(scope, item)}</small>
                      <ul>
                        {files.map(file => {
                          const attached = driveFiles.some(x => x.fileId === file.id)
                          return (
                            <li key={file.id}>
                              <span>
                                {file.name}
                                <small>
                                  {formatBytes(file.size)}
                                  {file.savedByName ? ` · ${file.savedByName}` : ''}
                                </small>
                              </span>
                              <button
                                type="button"
                                className="secondary compact"
                                disabled={attached}
                                onClick={() => addDrive(item.id, file)}
                              >
                                {attached ? 'Attached' : 'Attach'}
                              </button>
                            </li>
                          )
                        })}
                      </ul>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>
        {prefill.notice && (
          <p className="email-note" role="status">
            {prefill.notice}
          </p>
        )}
        {prefill.replyToId && <p className="email-note">This reply stays in the same Gmail conversation.</p>}
        {error && (
          <p role="alert" className="email-error">
            {error}
          </p>
        )}
      </div>
      <div className="email-composer-actions" hidden={mode === 'min'}>
        <small>
          {draftNote ? `${draftNote}. ` : ''}After you press Send you have {UNDO_SECONDS} seconds to undo. Keep this
          page open until it is sent.
        </small>
        <div>
          <button type="button" className="secondary" disabled={busy} onClick={close}>
            Discard
          </button>
          <button type="button" className="primary" disabled={busy || !ready} onClick={submit}>
            <Send size={15} aria-hidden="true" /> Send email
          </button>
        </div>
      </div>
      {manager}
    </section>
  )
}
