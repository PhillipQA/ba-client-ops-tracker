import { recipientSummary, splitAddresses } from './emailCompose'

/**
 * A short holding area between pressing Send and the email leaving.
 * The browser waits UNDO_SECONDS, so a mistake can be corrected, then makes one send call.
 * It lives outside React, so moving between pages does not cancel a pending email.
 * Closing the tab during the wait would lose it, so the browser is asked to confirm first.
 */
export const UNDO_SECONDS = 10

export type DriveRef = { taskId: string; fileId: string; name: string; size: number }
export type Upload = { name: string; mimeType: string; size: number; data: string }
export type EmailDraft = {
  to: string
  cc: string
  bcc: string
  subject: string
  message: string
  taskIds: string[]
  driveFiles: DriveRef[]
  uploads: Upload[]
  replyToId?: string
  /** People @mentioned in the message; their mentions become links in the sent email. */
  mentions?: { name: string; email: string }[]
}
export type OutboxPhase = 'waiting' | 'sending' | 'sent' | 'failed'
export type OutboxEntry = {
  id: string
  requestId: string
  draft: EmailDraft
  phase: OutboxPhase
  sendAt: number
  secondsLeft: number
  summary: string
  error?: string
  code?: string
  warning?: string
}

const SENT_VISIBLE_MS = 8000
const SENT_WARNING_VISIBLE_MS = 20000
let entries: OutboxEntry[] = []
let ticker: ReturnType<typeof setInterval> | null = null
const listeners = new Set<() => void>()
const sentListeners = new Set<(entry: OutboxEntry) => void>()
const newId = () =>
  (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
  ).replace(/[^A-Za-z0-9_-]/g, '')

function emit() {
  entries = [...entries]
  listeners.forEach(listener => listener())
}
function change(id: string, patch: Partial<OutboxEntry>) {
  entries = entries.map(entry => (entry.id === id ? { ...entry, ...patch } : entry))
  emit()
}
const find = (id: string) => entries.find(entry => entry.id === id)
const hasPending = () => entries.some(entry => entry.phase === 'waiting' || entry.phase === 'sending')

function tick() {
  const now = Date.now()
  let moved = false
  for (const entry of entries) {
    if (entry.phase !== 'waiting') continue
    if (now >= entry.sendAt) {
      void transmit(entry.id)
      continue
    }
    const left = Math.max(1, Math.ceil((entry.sendAt - now) / 1000))
    if (left !== entry.secondsLeft) {
      entries = entries.map(item => (item.id === entry.id ? { ...item, secondsLeft: left } : item))
      moved = true
    }
  }
  if (moved) emit()
  if (!entries.some(entry => entry.phase === 'waiting') && ticker) {
    clearInterval(ticker)
    ticker = null
  }
}
function ensureTicker() {
  if (!ticker) ticker = setInterval(tick, 250)
}

async function transmit(id: string) {
  const entry = find(id)
  if (!entry || entry.phase === 'sending' || entry.phase === 'sent') return
  change(id, { phase: 'sending', error: undefined, code: undefined })
  try {
    const response = await fetch('/api/communications/send', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId: entry.requestId,
        to: entry.draft.to,
        cc: entry.draft.cc,
        bcc: entry.draft.bcc,
        subject: entry.draft.subject,
        message: entry.draft.message,
        taskIds: entry.draft.taskIds,
        replyToId: entry.draft.replyToId,
        mentions: entry.draft.mentions || [],
        driveFiles: entry.draft.driveFiles.map(({ taskId, fileId }) => ({ taskId, fileId })),
        uploads: entry.draft.uploads.map(({ name, mimeType, data }) => ({ name, mimeType, data })),
      }),
    })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) {
      change(id, { phase: 'failed', error: String(result.error || 'The email could not be sent.'), code: result.code })
      return
    }
    change(id, { phase: 'sent', warning: result.warning })
    const done = find(id)
    if (done) sentListeners.forEach(listener => listener(done))
    setTimeout(() => dismiss(id), result.warning ? SENT_WARNING_VISIBLE_MS : SENT_VISIBLE_MS)
  } catch {
    // The request may have reached the server. Retrying with the same reference is safe: the server answers with the earlier result instead of sending again.
    change(id, {
      phase: 'failed',
      code: 'NETWORK',
      error:
        'The connection dropped, so it is not certain the email was sent. Retry to check, or look in your Gmail Sent folder.',
    })
  }
}

function queue(draft: EmailDraft): string {
  const id = newId()
  const first = splitAddresses(draft.to)
  entries = [
    ...entries,
    {
      id,
      requestId: newId().padEnd(16, 'x'),
      draft,
      phase: 'waiting',
      sendAt: Date.now() + UNDO_SECONDS * 1000,
      secondsLeft: UNDO_SECONDS,
      summary: recipientSummary(first),
    },
  ]
  emit()
  ensureTicker()
  return id
}
/** Cancel a waiting email and hand the draft back so it can be edited. A failed one can be taken back the same way. */
function undo(id: string): EmailDraft | null {
  const entry = find(id)
  if (!entry || entry.phase === 'sending' || entry.phase === 'sent') return null
  entries = entries.filter(item => item.id !== id)
  emit()
  return entry.draft
}
function sendNow(id: string) {
  if (find(id)?.phase === 'waiting') void transmit(id)
}
function retry(id: string) {
  if (find(id)?.phase === 'failed') void transmit(id)
}
function dismiss(id: string) {
  const entry = find(id)
  if (!entry || entry.phase === 'waiting' || entry.phase === 'sending') return
  entries = entries.filter(item => item.id !== id)
  emit()
}

export const outbox = {
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  snapshot: () => entries,
  onSent(listener: (entry: OutboxEntry) => void) {
    sentListeners.add(listener)
    return () => {
      sentListeners.delete(listener)
    }
  },
  queue,
  undo,
  sendNow,
  retry,
  dismiss,
  hasPending,
  /** Test helper: forget everything. */
  reset() {
    entries = []
    if (ticker) {
      clearInterval(ticker)
      ticker = null
    }
    emit()
  },
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('beforeunload', event => {
    if (!hasPending()) return
    event.preventDefault()
    event.returnValue = ''
  })
}
