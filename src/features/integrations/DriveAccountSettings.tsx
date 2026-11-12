import { useEffect, useState } from 'react'
import { requestJson, type HttpMethod } from '../../shared/http'

type Status = {
  gmailReady: boolean
  connected: boolean
  email: string
  rootFolderUrl: string
  reconnectRequired: boolean
}
const request = (url: string, method = 'GET') =>
  requestJson(url, { method: method as HttpMethod, fallback: 'Google Drive settings request failed.' })
const RESULTS: Record<string, string> = {
  connected: 'Google Drive is connected. Team members can now save Gmail attachments to task folders from Work Hub.',
  denied:
    'Google Drive was not connected. Allow access to files created by this app on the Google consent screen, then try again.',
  error:
    'Google Drive connection did not complete. Make sure the Google Drive API is enabled in the same Google Cloud project as Gmail, then try again.',
}

type EvidenceStorage = { inDatabase: number; inDrive: number; driveReady: boolean }
type MoveResult = { moved: number; failed: { fileName: string; error: string }[]; remaining: number }

/**
 * Task evidence still kept in the app's database, and a button that moves it to the task folders in Drive, a batch
 * at a time until none is left (or a batch moves nothing, so a file that keeps failing does not loop forever).
 */
function EvidenceToDrive({ connected }: { connected: boolean }) {
  const [storage, setStorage] = useState<EvidenceStorage | null>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('')
  const load = async () =>
    setStorage(
      (await requestJson('/api/tasks/evidence/storage', {
        fallback: 'Evidence storage could not be read.',
      })) as EvidenceStorage,
    )
  useEffect(() => {
    void load().catch(() => setStorage(null))
  }, [connected])
  if (!storage || (!storage.inDatabase && !storage.inDrive)) return null
  const move = async () => {
    setBusy(true)
    setMessage('')
    let moved = 0
    const failed: MoveResult['failed'] = []
    try {
      for (;;) {
        const result = (await requestJson('/api/tasks/evidence/move-to-drive', {
          method: 'POST',
          fallback: 'Evidence could not be moved to Google Drive.',
        })) as MoveResult
        moved += result.moved
        failed.push(...result.failed)
        setMessage(`Moving… ${moved} moved, ${result.remaining} left.`)
        if (!result.remaining || !result.moved) break
      }
      const left = failed.length
        ? ` Not moved: ${failed
            .slice(0, 5)
            .map(file => `${file.fileName} (${file.error})`)
            .join('; ')}${failed.length > 5 ? ` and ${failed.length - 5} more` : ''}.`
        : ''
      setMessage(`${moved} evidence file${moved === 1 ? '' : 's'} moved to Google Drive.${left}`)
    } catch (e) {
      setMessage(`${moved ? `${moved} moved, then: ` : ''}${e instanceof Error ? e.message : 'The move stopped.'}`)
    } finally {
      setBusy(false)
      await load().catch(() => undefined)
    }
  }
  return (
    <div className="evidence-storage">
      <h3>Task evidence</h3>
      <p>
        New evidence is saved in each task’s folder in this Drive.{' '}
        {storage.inDatabase
          ? `${storage.inDatabase} older file${storage.inDatabase === 1 ? ' is' : 's are'} still stored in the app’s database.`
          : 'All evidence files are in Drive.'}
        {storage.inDrive ? ` ${storage.inDrive} in Drive.` : ''}
      </p>
      {storage.inDatabase > 0 && (
        <div className="integration-actions">
          <button className="secondary" disabled={busy || !storage.driveReady} onClick={() => void move()}>
            {busy ? 'Moving…' : `Move ${storage.inDatabase} file${storage.inDatabase === 1 ? '' : 's'} to Drive`}
          </button>
        </div>
      )}
      {!storage.driveReady && storage.inDatabase > 0 && <small>Connect Google Drive above first.</small>}
      {message && (
        <p role="status" className="settings-message">
          {message}
        </p>
      )}
    </div>
  )
}

/** One shared Drive for the account, connected by an administrator through the account's Gmail OAuth client. */
export function DriveAccountSettings() {
  const [status, setStatus] = useState<Status | null>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('')
  const load = async () => setStatus((await request('/api/account/drive')) as Status)
  useEffect(() => {
    const result = new URLSearchParams(window.location.hash.slice(1)).get('drive')
    if (result) {
      setMessage(RESULTS[result] || RESULTS.error)
      window.history.replaceState(null, '', window.location.pathname + window.location.search)
    }
    void load().catch(e => setMessage(e.message))
  }, [])
  const connect = async () => {
    setBusy(true)
    setMessage('')
    try {
      const { url } = await request('/api/account/drive/connect', 'POST')
      window.location.assign(url)
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Could not start the Google Drive connection.')
      setBusy(false)
    }
  }
  const disconnect = async () => {
    if (
      !window.confirm(
        'Disconnect Google Drive? Files already saved stay in Drive and their links stay on tasks, but nobody can save new attachments until Drive is connected again.',
      )
    )
      return
    setBusy(true)
    setMessage('')
    try {
      await request('/api/account/drive', 'DELETE')
      await load()
      setMessage('Google Drive disconnected.')
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Could not disconnect Google Drive.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="panel account-integration-card calendar-card">
      <div className="panel-heading">
        <div>
          <h2>Google Drive — team folder</h2>
          <p>
            One shared Drive for this account. Gmail attachments saved from Work Hub, signed documents and task evidence
            go into Client / Project / Task / Subtask folders that the app creates.
          </p>
        </div>
      </div>
      {status && (
        <>
          {!status.gmailReady && (
            <p role="alert">
              Set up and enable Gmail above first. Google Drive uses the same Google OAuth client and callback address.
            </p>
          )}
          <p>
            Status:{' '}
            {status.connected ? (
              <>
                Connected as <strong>{status.email}</strong>
                {status.reconnectRequired ? ' — reconnect needed because the Gmail OAuth client changed' : ''}
              </>
            ) : (
              'Not connected'
            )}
          </p>
          {status.rootFolderUrl && (
            <p>
              <a href={status.rootFolderUrl} target="_blank" rel="noopener noreferrer">
                Open the “BA Client Ops Tracker” folder in Google Drive
              </a>
            </p>
          )}
          <div className="integration-actions">
            <button className="primary" disabled={busy || !status.gmailReady} onClick={() => void connect()}>
              {busy ? 'Opening Google…' : status.connected ? 'Reconnect Google Drive' : 'Connect Google Drive'}
            </button>
            {status.connected && (
              <button className="secondary" disabled={busy} onClick={() => void disconnect()}>
                Disconnect
              </button>
            )}
          </div>
          <small>
            Sign in with the Google account that should own the team folder, then share that folder with your team or
            move it into a shared drive. In Google Cloud, enable the Google Drive API in the same project as Gmail. The
            app asks only for access to files and folders it creates. The redirect URI does not change.
          </small>
          <EvidenceToDrive connected={status.connected && !status.reconnectRequired} />
        </>
      )}
      {message && (
        <p role="status" className="settings-message">
          {message}
        </p>
      )}
    </section>
  )
}
