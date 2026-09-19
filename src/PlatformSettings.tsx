import { useEffect, useState } from 'react'
import { settingsRequest } from './Settings'
import type { TaskColumnKey, TaskSettings } from './types'
const columns: [TaskColumnKey, string][] = [['status','Status'],['client','Client'],['project','Project'],['type','Type'],['waitingOn','Waiting on'],['priority','Priority'],['owner','Owner'],['dueDate','Due date'],['followUpDate','Follow-up date']]
export default function PlatformSettings({ organizationId, organizationName }: { organizationId: string; organizationName: string }) {
  const [system,setSystem] = useState<any>(null), [account,setAccount] = useState<any>(null)
  const [taskSettings,setTaskSettings] = useState<TaskSettings | null>(null), [newStatus,setNewStatus] = useState('')
  const [message,setMessage] = useState(''), [busy,setBusy] = useState(false)
  const load = async () => {
    setSystem(await settingsRequest('/api/internal-admin/system'))
    if (organizationId) { const result = await settingsRequest(`/api/internal-admin/organizations/${organizationId}/system`); setAccount(result); setTaskSettings(result.taskSettings) }
  }
  useEffect(() => {
    let active = true
    setAccount(null); setTaskSettings(null); setMessage('')
    void Promise.all([settingsRequest('/api/internal-admin/system'), organizationId ? settingsRequest(`/api/internal-admin/organizations/${organizationId}/system`) : Promise.resolve(null)]).then(([s,a]) => { if (active) { setSystem(s);setAccount(a);setTaskSettings(a?.taskSettings || null) } }).catch(e => { if (active) setMessage(e.message) })
    return () => { active = false }
  }, [organizationId])
  const run = async (fn: () => Promise<any>) => {
    setBusy(true); setMessage('')
    try { const result = await fn(); await load(); setMessage(result.message || 'Completed successfully.') }
    catch(e) { setMessage(e instanceof Error ? e.message : 'Request failed.') }
    finally { setBusy(false) }
  }
  return <div className="panel platform-settings"><div className="panel-heading"><div><h2>Platform settings</h2><p>System updates, Supabase sync, and account configuration.</p></div><span className="version-badge">v{system?.version || '…'}</span></div>
    {message && <p className="settings-message" role="status">{message}</p>}
    <div className="platform-settings-grid"><section><h3>Patch Updater</h3><p>Run from the server’s project folder. Each patch creates a rollback backup.</p><code>npm run patch -- "C:\Downloads\ba-client-ops-patch-vX.Y.Z.zip"</code><p><code>npm run patch:status</code></p><p><code>npm run patch:rollback</code></p><small>Apply source updates locally, build, then redeploy to Render.</small></section>
    <section><h3>Supabase & credential storage</h3><p>Supabase: {system?.supabaseConfigured ? 'Configured' : 'Not configured'}</p><p>Integration tables: {system?.integrationsReady ? 'Ready' : 'Setup required'}</p><p>Encryption key: {system?.encryptionReady ? 'Configured' : 'Setup required'}</p><small>Server setup uses SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and TENANT_INTEGRATION_MASTER_KEY. Apply schema-v8-tenant-integrations.sql. Keep these infrastructure secrets server-side.</small></section></div>
    <h3>{organizationName ? `${organizationName} — account configuration` : 'Choose an account above'}</h3>
    {organizationId && <><section><h4>Supabase Sync</h4><p>Last normalized sync: {account?.sync?.syncedAt ? new Date(account.sync.syncedAt).toLocaleString() : 'No sync recorded'}</p><button className="secondary" disabled={busy || !account?.sync?.ready} onClick={() => void run(() => settingsRequest('/api/data-architecture/migrate','POST',{ organizationId }))}>Migrate / Sync selected account</button></section>
    <section><h4>Integration health</h4>{['discord','openai'].map(kind => { const row = system?.health?.find((r: any) => r.tenant_id === organizationId && r.integration_type === kind); return <p key={kind}>{kind === 'discord' ? 'Discord' : 'AI'}: {row ? `${row.is_enabled ? 'Enabled' : 'Disabled'} · ${row.connection_status}` : 'Not configured'}</p> })}</section>
    {(system?.legacy?.discord || system?.legacy?.openai) && <section><h4>Import existing Render credentials</h4><p>Import into <b>{organizationName}</b> as disabled credentials. Existing account credentials cannot be overwritten.</p><div className="integration-actions">{(['discord','openai'] as const).filter(kind => system.legacy[kind]).map(kind => <button className="secondary" key={kind} disabled={busy} onClick={() => { if (window.confirm(`Import the old ${kind} credential into ${organizationName}? It will be saved disabled.`)) void run(() => settingsRequest(`/api/internal-admin/organizations/${organizationId}/import-legacy/${kind}`, 'POST')) }}>Import {kind === 'discord' ? 'Discord' : 'AI'}</button>)}</div><small>Test and enable from that account’s Settings, then remove the old provider variables from Render.</small></section>}
    {taskSettings && <section><h4>Task configuration</h4><p>Changes apply to {organizationName}. Users should reload their workspace after changes.</p><div className="task-status-list">{taskSettings.statuses.map(status => <div key={status.id} className="task-status-row"><strong>{status.label}</strong><label className="checkbox-label"><input type="checkbox" checked={status.closed} onChange={e => setTaskSettings({ ...taskSettings, statuses: taskSettings.statuses.map(s => s.id === status.id ? { ...s, closed: e.target.checked } : s) })} /> Completed</label><button className="secondary" onClick={() => setTaskSettings({ ...taskSettings, statuses: taskSettings.statuses.filter(s => s.id !== status.id) })}>Remove</button></div>)}</div><div className="integration-actions"><input aria-label="New task status" value={newStatus} onChange={e => setNewStatus(e.target.value)} placeholder="New status" /><button className="secondary" disabled={!newStatus.trim()} onClick={() => { setTaskSettings({ ...taskSettings, statuses: [...taskSettings.statuses, { id: crypto.randomUUID(), label: newStatus.trim(), closed: false }] });setNewStatus('') }}>Add status</button></div><div className="module-check-grid">{columns.map(([key,label]) => <label key={key} className="checkbox-label"><input type="checkbox" disabled={key === 'status'} checked={taskSettings.visibleColumns.includes(key)} onChange={e => setTaskSettings({ ...taskSettings, visibleColumns: e.target.checked ? [...taskSettings.visibleColumns,key] : taskSettings.visibleColumns.filter(k => k !== key) })} />{label}</label>)}</div><button className="primary" disabled={busy} onClick={() => void run(() => settingsRequest(`/api/internal-admin/organizations/${organizationId}/task-settings`, 'PUT', taskSettings))}>Save task configuration</button></section>}</>}
  </div>
}
