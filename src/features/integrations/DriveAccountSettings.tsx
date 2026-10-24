import { useEffect, useState } from 'react'
import { requestJson, type HttpMethod } from '../../shared/http'

type Status = { gmailReady: boolean; connected: boolean; email: string; rootFolderUrl: string; reconnectRequired: boolean }
const request = (url: string, method = 'GET') =>
  requestJson(url, { method: method as HttpMethod, fallback: 'Google Drive settings request failed.' })
const RESULTS: Record<string, string> = {
  connected: 'Google Drive is connected. Team members can now save Gmail attachments to task folders from Work Hub.',
  denied: 'Google Drive was not connected. Allow access to files created by this app on the Google consent screen, then try again.',
  error: 'Google Drive connection did not complete. Make sure the Google Drive API is enabled in the same Google Cloud project as Gmail, then try again.',
}

/** One shared Drive for the account, connected by an administrator through the account's Gmail OAuth client. */
export function DriveAccountSettings() {
  const [status, setStatus] = useState<Status | null>(null), [busy, setBusy] = useState(false), [message, setMessage] = useState('')
  const load = async () => setStatus(await request('/api/account/drive') as Status)
  useEffect(() => {
    const result = new URLSearchParams(window.location.hash.slice(1)).get('drive')
    if (result) { setMessage(RESULTS[result] || RESULTS.error); window.history.replaceState(null, '', window.location.pathname + window.location.search) }
    void load().catch(e => setMessage(e.message))
  }, [])
  const connect = async () => {
    setBusy(true); setMessage('')
    try { const { url } = await request('/api/account/drive/connect', 'POST'); window.location.assign(url) }
    catch (e) { setMessage(e instanceof Error ? e.message : 'Could not start the Google Drive connection.'); setBusy(false) }
  }
  const disconnect = async () => {
    if (!window.confirm('Disconnect Google Drive? Files already saved stay in Drive and their links stay on tasks, but nobody can save new attachments until Drive is connected again.')) return
    setBusy(true); setMessage('')
    try { await request('/api/account/drive', 'DELETE'); await load(); setMessage('Google Drive disconnected.') }
    catch (e) { setMessage(e instanceof Error ? e.message : 'Could not disconnect Google Drive.') }
    finally { setBusy(false) }
  }
  return <section className="panel account-integration-card calendar-card">
    <div className="panel-heading"><div><h2>Google Drive — team folder</h2><p>One shared Drive for this account. Gmail attachments saved from Work Hub go into Client / Project / Task / Subtask folders that the app creates.</p></div></div>
    {status && <>
      {!status.gmailReady && <p role="alert">Set up and enable Gmail above first. Google Drive uses the same Google OAuth client and callback address.</p>}
      <p>Status: {status.connected ? <>Connected as <strong>{status.email}</strong>{status.reconnectRequired ? ' — reconnect needed because the Gmail OAuth client changed' : ''}</> : 'Not connected'}</p>
      {status.rootFolderUrl && <p><a href={status.rootFolderUrl} target="_blank" rel="noopener noreferrer">Open the “BA Client Ops Tracker” folder in Google Drive</a></p>}
      <div className="integration-actions">
        <button className="primary" disabled={busy || !status.gmailReady} onClick={() => void connect()}>{busy ? 'Opening Google…' : status.connected ? 'Reconnect Google Drive' : 'Connect Google Drive'}</button>
        {status.connected && <button className="secondary" disabled={busy} onClick={() => void disconnect()}>Disconnect</button>}
      </div>
      <small>Sign in with the Google account that should own the team folder, then share that folder with your team or move it into a shared drive. In Google Cloud, enable the Google Drive API in the same project as Gmail. The app asks only for access to files and folders it creates. The redirect URI does not change.</small>
    </>}
    {message && <p role="status" className="settings-message">{message}</p>}
  </section>
}
