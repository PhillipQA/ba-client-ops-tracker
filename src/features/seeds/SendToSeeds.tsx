/**
 * Sending your time logs to Seeds. Seeds records time as the Google account that sends it, so each person signs in
 * with Google (the same email as here) and the server sends their entries with the app's Seeds token. A Google
 * sign-in lasts about an hour; it is kept in memory only, so a second send soon after needs no new sign-in.
 */
import { Send } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { loadGoogle } from '../../shared/googleIdentity'
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
type SeedsFailure = SeedsSendResult['failed'][number]
const entryWord = (count: number) => (count === 1 ? 'entry' : 'entries')

export const loadSeedsTime = () =>
  requestJson<SeedsTimeStatus>('/api/seeds/time', { fallback: 'Seeds time could not be read.' })
const sendTime = (idToken: string, entryIds?: string[], productId?: string) =>
  requestJson<SeedsSendResult>('/api/seeds/time/send', {
    method: 'POST',
    body: { idToken, ...(entryIds ? { entryIds } : {}), ...(productId ? { productId } : {}) },
    fallback: 'The time could not be sent to Seeds.',
  })

let signedIn: { token: string; until: number } | null = null
const expiresAt = (token: string) => {
  try {
    const claims = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
    return Number(claims.exp) * 1000
  } catch {
    return 0
  }
}

/** The entries Seeds turned down, behind a toggle. Shown inline so no surrounding panel can clip them. */
function FailedEntries({ failed }: { failed: SeedsFailure[] }) {
  const [shown, setShown] = useState(false)
  return (
    <>
      <button
        type="button"
        className="seeds-send-details-toggle"
        aria-expanded={shown}
        onClick={() => setShown(value => !value)}
      >
        {shown ? 'Hide failed entries' : `View ${failed.length} failed ${entryWord(failed.length)}`}
      </button>
      {shown && (
        <div className="seeds-send-failures" aria-label="Unsent Seeds entries">
          <strong>Unsent entries ({failed.length})</strong>
          {failed.map((failure, index) => (
            <div className="seeds-send-failure" key={failure.entryId}>
              <strong>
                {index + 1}. {failure.projectName || 'Unknown project'}
              </strong>
              <span>Task: {failure.taskName || 'Unknown task'}</span>
              {failure.date && <span>Date: {failure.date}</span>}
              {typeof failure.hours === 'number' && <span>Time: {failure.hours}h</span>}
              {failure.remarks && <span>Remarks: {failure.remarks}</span>}
              <span className="seeds-send-failure-reason">Reason: {failure.error}</span>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

/** A button that sends the person's unsent time (all of it, or the entries given) to Seeds, signing in if needed. */
export function SendToSeedsButton({
  entryIds,
  productId,
  label = 'Send to Seeds',
  onSent,
  className = 'secondary',
}: {
  entryIds?: string[]
  /** The Seeds product for entries that have none of their own. */
  productId?: string
  label?: string
  onSent: (result: SeedsSendResult) => void
  className?: string
}) {
  const [status, setStatus] = useState<SeedsTimeStatus | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{
    text: string
    ok: boolean
    failed?: SeedsFailure[]
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
    try {
      const result = await sendTime(token, entryIds, productId)
      onSent(result)
      const failed = result.failed.length
      setMessage({
        ok: !failed,
        text: failed
          ? `${result.sent} sent, ${failed} not: ${result.failed[0].error}`
          : `${result.sent} ${entryWord(result.sent)} sent to Seeds.`,
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
          {message.failed?.length ? <FailedEntries failed={message.failed} /> : null}
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
