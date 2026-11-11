/**
 * Sending your time logs to Seeds. Seeds records time as the Google account that sends it, so each person signs in
 * with Google (the same email as here) and the server sends their entries with the app's Seeds token. A Google
 * sign-in lasts about an hour; it is kept in memory only, so a second send soon after needs no new sign-in.
 */
import { Send } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { requestJson } from '../../shared/http'
import { Dialog } from '../../shared/ui/Dialog'
import type { WorkItem } from '../../shared/types'
import './seeds.css'

export type SeedsTimeStatus = { ready: boolean; clientId: string; unsent: number; hours: number }
export type SeedsSendResult = {
  sent: number
  failed: {
    entryId: string
    error: string
    projectName?: string
    taskName?: string
    date?: string
    hours?: number
    remarks?: string
  }[]
  left: number
  items: WorkItem[]
}

export const loadSeedsTime = () =>
  requestJson<SeedsTimeStatus>('/api/seeds/time', { fallback: 'Seeds time could not be read.' })
const sendTime = (idToken: string, entryIds?: string[]) =>
  requestJson<SeedsSendResult>('/api/seeds/time/send', {
    method: 'POST',
    body: { idToken, ...(entryIds ? { entryIds } : {}) },
    fallback: 'The time could not be sent to Seeds.',
  })

const failedEntriesTooltip = (failed: SeedsSendResult['failed']) =>
  [
    `Unsent entries (${failed.length})`,
    ...failed.map((failure, index) =>
      [
        `${index + 1}. ${failure.projectName || 'Unknown project'}`,
        `Task: ${failure.taskName || 'Unknown task'}`,
        ...(failure.date ? [`Date: ${failure.date}`] : []),
        ...(typeof failure.hours === 'number' ? [`Time: ${failure.hours}h`] : []),
        ...(failure.remarks ? [`Remarks: ${failure.remarks}`] : []),
        `Reason: ${failure.error}`,
      ].join('\n'),
    ),
  ].join('\n\n')

let signedIn: { token: string; until: number } | null = null
const expiresAt = (token: string) => {
  try {
    const claims = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
    return Number(claims.exp) * 1000
  } catch {
    return 0
  }
}

let script: Promise<void> | null = null
function loadGoogle() {
  script ||= new Promise<void>((resolve, reject) => {
    if ((window as any).google?.accounts?.id) return resolve()
    const tag = document.createElement('script')
    tag.src = 'https://accounts.google.com/gsi/client'
    tag.async = true
    tag.onload = () => resolve()
    tag.onerror = () => {
      script = null
      reject(new Error('Google sign-in could not load. Check the connection and try again.'))
    }
    document.head.appendChild(tag)
  })
  return script
}

/** A button that sends the person's unsent time (all of it, or the entries given) to Seeds, signing in if needed. */
export function SendToSeedsButton({
  entryIds,
  label = 'Send to Seeds',
  onSent,
  className = 'secondary',
}: {
  entryIds?: string[]
  label?: string
  onSent: (result: SeedsSendResult) => void
  className?: string
}) {
  const [status, setStatus] = useState<SeedsTimeStatus | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [showFailures, setShowFailures] = useState(false)
  const [message, setMessage] = useState<{
    text: string
    ok: boolean
    failed?: SeedsSendResult['failed']
  } | null>(null)
  const holder = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void loadSeedsTime()
      .then(setStatus)
      .catch(() => setStatus(null))
  }, [])

  const send = async (token: string) => {
    setBusy(true)
    setMessage(null)
    setShowFailures(false)
    try {
      const result = await sendTime(token, entryIds)
      onSent(result)
      const failed = result.failed.length
      setMessage({
        ok: !failed,
        text: failed
          ? `${result.sent} sent, ${failed} not: ${result.failed[0].error}`
          : `${result.sent} ${result.sent === 1 ? 'entry' : 'entries'} sent to Seeds.`,
        ...(failed ? { failed: result.failed } : {}),
      })
      if (/sign in|sign-in/i.test(result.failed[0]?.error || '')) signedIn = null
      setOpen(false)
      setStatus(await loadSeedsTime().catch(() => status))
    } catch (error) {
      const text = error instanceof Error ? error.message : 'The time could not be sent to Seeds.'
      if (/google|sign in|sign-in/i.test(text)) signedIn = null
      setMessage({ ok: false, text })
    } finally {
      setBusy(false)
    }
  }

  const start = async () => {
    if (!status?.ready) return
    if (signedIn && signedIn.until - 60_000 > Date.now()) return void send(signedIn.token)
    setOpen(true)
    try {
      await loadGoogle()
      const google = (window as any).google
      google.accounts.id.initialize({
        client_id: status.clientId,
        callback: (response: { credential?: string }) => {
          if (!response.credential) return
          signedIn = { token: response.credential, until: expiresAt(response.credential) }
          void send(response.credential)
        },
        auto_select: false,
        cancel_on_tap_outside: true,
      })
      requestAnimationFrame(() => {
        if (holder.current) google.accounts.id.renderButton(holder.current, { theme: 'outline', size: 'large' })
      })
    } catch (error) {
      setOpen(false)
      setMessage({ ok: false, text: error instanceof Error ? error.message : 'Google sign-in could not load.' })
    }
  }

  if (!status?.ready) return null
  const count = entryIds ? entryIds.length : status.unsent
  if (!count && !message) return null
  const failureTooltip = message?.failed?.length ? failedEntriesTooltip(message.failed) : undefined
  return (
    <span className="seeds-send">
      {count > 0 && (
        <button type="button" className={className} disabled={busy} onClick={() => void start()}>
          <Send size={14} aria-hidden="true" /> {busy ? 'Sending…' : `${label} (${count})`}
        </button>
      )}
      {message && (
        <div className={message.ok ? 'seeds-send-ok' : 'seeds-send-feedback'}>
          <small role={message.ok ? 'status' : 'alert'}>{message.text}</small>
          {Boolean(message.failed?.length) && (
            <button
              type="button"
              className="seeds-send-details-toggle"
              aria-expanded={showFailures}
              onClick={() => setShowFailures(value => !value)}
            >
              {showFailures ? 'Hide failed entries' : `View ${message.failed?.length} failed entries`}
            </button>
          )}
          {showFailures && message.failed?.length ? (
            <div className="seeds-send-failures" aria-label="Unsent Seeds entries">
              <strong>Unsent entries ({message.failed.length})</strong>
              {message.failed.map((failure, index) => (
                <div className="seeds-send-failure" key={failure.entryId}>
                  <strong>{index + 1}. {failure.projectName || 'Unknown project'}</strong>
                  <span>Task: {failure.taskName || 'Unknown task'}</span>
                  {failure.date && <span>Date: {failure.date}</span>}
                  {typeof failure.hours === 'number' && <span>Time: {failure.hours}h</span>}
                  {failure.remarks && <span>Remarks: {failure.remarks}</span>}
                  <span className="seeds-send-failure-reason">Reason: {failure.error}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      )}
      {open && (
        <Dialog title="Sign in to send to Seeds" eyebrow="Seeds" onClose={() => setOpen(false)} busy={busy}>
          <p>
            Seeds records time as the Google account that sends it. Sign in with your iRipple Google account (the same
            email as here).
          </p>
          <div ref={holder} className="seeds-google-button" />
          {busy && <p role="status">Sending…</p>}
        </Dialog>
      )}
    </span>
  )
}
