import { useEffect, useState } from 'react'
import type { UserAccount } from './types'

export async function settingsRequest(url: string, method = 'GET', data?: unknown) {
  const response = await fetch(url, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || 'Settings request failed.')
  return result
}
type Integration = { kind: 'discord' | 'openai'; configured: boolean; maskedKey: string; enabled: boolean; config: { model?: string; allowedUserIds?: string[] }; connectionStatus: string; lastTestedAt?: string }
function IntegrationCard({ value, refresh, runtime }: { value: Integration; refresh: () => Promise<void>; runtime?: any }) {
  const [secret, setSecret] = useState('')
  const [enabled, setEnabled] = useState(value.enabled)
  const [model, setModel] = useState(value.config.model || 'gpt-5.6-terra')
  const [ids, setIds] = useState((value.config.allowedUserIds || []).join(', '))
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { setEnabled(value.enabled); setModel(value.config.model || 'gpt-5.6-terra'); setIds((value.config.allowedUserIds || []).join(', ')) }, [value])
  const act = async (action: 'save' | 'test' | 'remove') => {
    if (action === 'remove' && !window.confirm(`Remove this account’s ${value.kind === 'discord' ? 'Discord' : 'AI'} credential?`)) return
    setBusy(true); setMessage('')
    try {
      const url = `/api/account/integrations/${value.kind}`
      const result = await settingsRequest(action === 'test' ? `${url}/test` : url, action === 'test' ? 'POST' : action === 'remove' ? 'DELETE' : 'PUT', action === 'save' ? { secret, enabled, config: value.kind === 'discord' ? { allowedUserIds: ids } : { model } } : undefined)
      if (action !== 'test') setSecret('')
      setMessage(result.message || (action === 'remove' ? 'Credential removed.' : 'Account integration saved.'))
      await refresh()
    } catch (e) { setMessage(e instanceof Error ? e.message : 'Request failed.') }
    finally { setBusy(false) }
  }
  return <div className="panel account-integration-card">
    <div className="panel-heading"><div><h2>{value.kind === 'discord' ? 'Discord Integration' : 'AI Integration'}</h2><p>{value.kind === 'discord' ? 'Capture DMs and mentions into this account’s Inbox.' : 'Use this account’s OpenAI key for the BA Assistant and Discord inquiry assessment.'}</p></div><span className="role-badge">{value.configured ? value.enabled ? 'Enabled' : 'Disabled' : 'Not configured'}</span></div>
    <p>Saved key: <b>{value.maskedKey || 'None'}</b> · Connection: {value.connectionStatus.replace(/_/g, ' ')}</p>
    {value.lastTestedAt && <p>Last tested: {new Date(value.lastTestedAt).toLocaleString()}</p>}
    <div className="integration-form"><label>{value.configured ? 'Replace credential (leave blank to keep it)' : value.kind === 'discord' ? 'Discord bot token' : 'OpenAI API key'}<input type="password" value={secret} autoComplete="new-password" onChange={e => setSecret(e.target.value)} /></label>
    {value.kind === 'discord' ? <label>Allowed Discord user IDs (comma-separated)<input value={ids} onChange={e => setIds(e.target.value)} /><small>Leave blank to allow anyone who can DM or mention your bot.</small></label> : <label>OpenAI model<input value={model} onChange={e => setModel(e.target.value)} required /></label>}
    <label className="checkbox-label"><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} /> Enable for this account</label></div>
    {value.kind === 'discord' && <p>Gateway: {runtime?.online ? `Online — ${runtime.botName}` : 'Offline'}{runtime?.lastMessageAt ? ` · Last capture ${new Date(runtime.lastMessageAt).toLocaleString()}` : ''}{runtime?.lastError ? ` · ${runtime.lastError}` : ''}</p>}
    {message && <p role="status" className="settings-message">{message}</p>}
    <div className="integration-actions"><button className="primary" disabled={busy || (!value.configured && !secret.trim())} onClick={() => void act('save')}>Save settings</button><button className="secondary" disabled={busy || !value.configured} onClick={() => void act('test')}>Test saved connection</button><button className="secondary danger-button" disabled={busy || !value.configured} onClick={() => void act('remove')}>Remove key</button></div>
    <small>Saved credentials are encrypted. The full key is never returned after saving.{value.kind === 'discord' ? ' Enable Message Content intent in the Discord Developer Portal.' : ' COR OCR continues to run locally in your browser.'}</small>
  </div>
}
function Templates() {
  const [name, setName] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false)
  const load = async () => { const result = await settingsRequest('/api/account/templates'); setName(result.template?.name || '') }
  useEffect(() => { void load().catch(e => setMessage(e.message)) }, [])
  const upload = async (file?: File) => {
    if (!file) return
    if (!/\.xlsx$/i.test(file.name) || file.size > 5 * 1024 * 1024) return setMessage('Choose an .xlsx file up to 5 MB.')
    setBusy(true)
    try {
      const content_base64 = await new Promise<string>((resolve,reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = reject; reader.readAsDataURL(file) })
      await settingsRequest('/api/account/templates', 'PUT', { name: file.name, content_base64 }); await load(); setMessage('Template saved for this account.')
    } catch(e) { setMessage(e instanceof Error ? e.message : 'Upload failed.') } finally { setBusy(false) }
  }
  return <div className="panel"><div className="panel-heading"><div><h2>Templates</h2><p>Save the account’s Excel DRF template for Document Creation.</p></div></div><p>{name || 'No saved template'}</p><label>Upload or replace template<input type="file" accept=".xlsx" disabled={busy} onChange={e => { void upload(e.target.files?.[0]); e.target.value = '' }} /></label><button className="secondary" disabled={busy || !name} onClick={async () => { if (!window.confirm('Remove the saved account template?')) return; setBusy(true); try { await settingsRequest('/api/account/templates','DELETE'); await load(); setMessage('Template removed.') } catch(e) { setMessage((e as Error).message) } finally { setBusy(false) } }}>Remove template</button>{message && <p role="status">{message}</p>}</div>
}
export default function Settings({ currentUser }: { currentUser: UserAccount }) {
  const [data,setData] = useState<any>(null), [error,setError] = useState('')
  const load = async () => { setData(await settingsRequest('/api/account/integrations')); setError('') }
  useEffect(() => { if (currentUser.role === 'Administrator') void load().catch(e => setError(e.message)) }, [currentUser.id])
  if (currentUser.role !== 'Administrator') return <div className="panel"><h2>Account settings</h2><p>Your account administrator manages templates and integration credentials. Personal details and themes are available in My Profile.</p></div>
  return <section className="page-stack settings-page"><div className="page-heading"><div><h1>Account settings</h1><p>{currentUser.organizationName} · Templates and integrations</p></div><button className="secondary" onClick={() => void load().catch(e => setError(e.message))}>Refresh status</button></div>{error && <p role="alert" className="settings-message">{error}</p>}{data && !data.encryptionReady && <p role="alert">Integration storage needs setup by Internal Admin.</p>}<Templates />{data?.integrations.map((value: Integration) => <IntegrationCard key={value.kind} value={value} runtime={data.discord} refresh={load} />)}</section>
}
