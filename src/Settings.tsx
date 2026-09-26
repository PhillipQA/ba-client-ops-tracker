import { useEffect, useState } from 'react'
import type { Client, UserAccount } from './types'
import ThemePreferences, { type AppearancePatch } from './ThemePreferences'
import { DocHubSettings } from './DocHubPanel'
import { CalendarAccountSettings } from './GoogleCalendarPanel'
import { GmailAccountSettings } from './GmailAccountSettings'

export async function settingsRequest(url: string, method = 'GET', data?: unknown) {
  const response = await fetch(url, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || 'Settings request failed.')
  return result
}
type AiProvider = 'gemini' | 'openai' | 'anthropic' | 'deepseek'
type Integration = { kind: 'discord' | 'openai'; configured: boolean; maskedKey: string; enabled: boolean; config: { provider?: AiProvider; model?: string; allowedUserIds?: string[] }; connectionStatus: string; lastTestedAt?: string }
type AiAgent = { id: 'ba_assistant' | 'document'; name: string; shortName: string; description: string; configured: boolean; inherited: boolean; enabled: boolean; maskedKey: string; config: { provider: AiProvider; model: string }; connectionStatus: string; lastTestedAt?: string | null; schemaReady: boolean; responsibilities: string[]; context: string[] }
function providerFor(value: Integration) { return value.config.provider || (value.config.model?.startsWith('gpt-') ? 'openai' : 'gemini') }
function defaultModel(provider: AiProvider) { return { gemini: 'gemini-3.8-flash', openai: 'gpt-5.6-terra', anthropic: 'claude-sonnet-5', deepseek: 'deepseek-flash' }[provider] }
function IntegrationCard({ value, refresh, runtime }: { value: Integration; refresh: () => Promise<void>; runtime?: any }) {
  const [secret, setSecret] = useState('')
  const [enabled, setEnabled] = useState(value.enabled)
  const [provider, setProvider] = useState<AiProvider>(providerFor(value))
  const [model, setModel] = useState(value.config.model || defaultModel(providerFor(value)))
  const [ids, setIds] = useState((value.config.allowedUserIds || []).join(', '))
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const providerChanged = value.kind === 'openai' && value.configured && provider !== providerFor(value)
  useEffect(() => { const nextProvider = providerFor(value); setEnabled(value.enabled); setProvider(nextProvider); setModel(value.config.model || defaultModel(nextProvider)); setIds((value.config.allowedUserIds || []).join(', ')) }, [value])
  const act = async (action: 'save' | 'test' | 'remove') => {
    if (action === 'remove' && !window.confirm(`Remove this account’s ${value.kind === 'discord' ? 'Discord' : 'AI'} credential?`)) return
    setBusy(true); setMessage('')
    try {
      const url = `/api/account/integrations/${value.kind}`
      const result = await settingsRequest(action === 'test' ? `${url}/test` : url, action === 'test' ? 'POST' : action === 'remove' ? 'DELETE' : 'PUT', action === 'save' ? { secret, enabled, config: value.kind === 'discord' ? { allowedUserIds: ids } : { provider, model } } : undefined)
      if (action !== 'test') setSecret('')
      setMessage(result.message || (action === 'remove' ? 'Credential removed.' : 'Account integration saved.'))
      await refresh()
    } catch (e) { setMessage(e instanceof Error ? e.message : 'Request failed.') }
    finally { setBusy(false) }
  }
  return <div className="panel account-integration-card">
    <div className="panel-heading"><div><h2>{value.kind === 'discord' ? 'Discord Integration' : 'Legacy Shared AI (Fallback)'}</h2><p>{value.kind === 'discord' ? 'Capture DMs and mentions into this account’s Inbox.' : 'Compatibility fallback for agents that do not yet have their own credential. AI Agent Manager settings take priority.'}</p></div><span className="role-badge">{value.configured ? value.enabled ? 'Enabled' : 'Disabled' : 'Not configured'}</span></div>
    <p>Saved key: <b>{value.maskedKey || 'None'}</b> · Connection: {value.connectionStatus.replace(/_/g, ' ')}</p>
    {value.lastTestedAt && <p>Last tested: {new Date(value.lastTestedAt).toLocaleString()}</p>}
    <div className="integration-form"><label>{value.configured ? 'Replace credential (leave blank to keep it)' : value.kind === 'discord' ? 'Discord bot token' : 'AI provider API key'}<input type="password" value={secret} autoComplete="new-password" onChange={e => setSecret(e.target.value)} /></label>
    {value.kind === 'discord' ? <label>Allowed Discord user IDs (comma-separated)<input value={ids} onChange={e => setIds(e.target.value)} /><small>Leave blank to allow anyone who can DM or mention your bot.</small></label> : <><label>AI provider<select value={provider} onChange={e => { const next = e.target.value as AiProvider; setProvider(next); setModel(defaultModel(next)) }}><option value="gemini">Gemini (Google AI Studio)</option><option value="openai">OpenAI (ChatGPT models)</option><option value="anthropic">Claude (Anthropic)</option><option value="deepseek">DeepSeek</option></select></label><label>AI model ID<input value={model} onChange={e => setModel(e.target.value)} required /></label>{provider === 'gemini' && <small>Create the key in Google AI Studio. New Gemini keys should use Google’s current Auth Key flow.</small>}{providerChanged && <small>Changing provider requires that provider’s API key.</small>}</>}
    <label className="checkbox-label"><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} /> Enable for this account</label></div>
    {value.kind === 'discord' && <p>Gateway: {runtime?.online ? `Online — ${runtime.botName}` : 'Offline'}{runtime?.lastMessageAt ? ` · Last capture ${new Date(runtime.lastMessageAt).toLocaleString()}` : ''}{runtime?.lastError ? ` · ${runtime.lastError}` : ''}</p>}
    {message && <p role="status" className="settings-message">{message}</p>}
    <div className="integration-actions"><button className="primary" disabled={busy || (!value.configured && !secret.trim()) || (providerChanged && !secret.trim())} onClick={() => void act('save')}>Save settings</button><button className="secondary" disabled={busy || !value.configured} onClick={() => void act('test')}>Test saved connection</button><button className="secondary danger-button" disabled={busy || !value.configured} onClick={() => void act('remove')}>Remove key</button></div>
    <small>Saved credentials are encrypted. The full key is never returned after saving.{value.kind === 'discord' ? ' Enable Message Content intent in the Discord Developer Portal.' : ' This shared AI credential is retained as a fallback only. Configure separate agent credentials in AI Agent Manager for independent models and providers.'}</small>
  </div>
}

function AiAgentCard({ value, refresh }: { value: AiAgent; refresh: () => Promise<void> }) {
  const [secret, setSecret] = useState('')
  const [enabled, setEnabled] = useState(value.enabled)
  const [provider, setProvider] = useState<AiProvider>(value.config.provider)
  const [model, setModel] = useState(value.config.model)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const providerChanged = provider !== value.config.provider
  const hasEffectiveCredential = value.configured || value.inherited
  useEffect(() => { setEnabled(value.enabled); setProvider(value.config.provider); setModel(value.config.model); setSecret('') }, [value])

  const act = async (action: 'save' | 'test' | 'remove') => {
    if (action === 'remove' && !window.confirm(`Remove the dedicated ${value.name} configuration? If a Legacy Shared AI credential exists, this agent will fall back to it.`)) return
    setBusy(true); setMessage('')
    try {
      const url = `/api/account/ai-agents/${value.id}`
      const result = await settingsRequest(action === 'test' ? `${url}/test` : url, action === 'test' ? 'POST' : action === 'remove' ? 'DELETE' : 'PUT', action === 'save' ? { secret, enabled, config: { provider, model } } : undefined)
      if (action !== 'test') setSecret('')
      setMessage(result.message || (action === 'remove' ? 'Dedicated agent configuration removed.' : `${value.name} saved.`))
      await refresh()
    } catch (e) { setMessage(e instanceof Error ? e.message : 'AI Agent request failed.') }
    finally { setBusy(false) }
  }

  const status = value.configured ? (value.enabled ? 'Dedicated' : 'Disabled') : value.inherited ? (value.enabled ? 'Legacy fallback' : 'Fallback disabled') : 'Not configured'
  return <div className="panel ai-agent-card">
    <div className="panel-heading"><div><h3>{value.name}</h3><p>{value.description}</p></div><span className="role-badge">{status}</span></div>
    <div className="ai-agent-meta"><span><b>Key:</b> {value.maskedKey || 'None'}</span><span><b>Connection:</b> {value.connectionStatus.replace(/_/g, ' ')}</span>{value.lastTestedAt && <span><b>Tested:</b> {new Date(value.lastTestedAt).toLocaleString()}</span>}</div>
    <div className="ai-agent-route"><div><strong>Responsibilities</strong><span>{value.responsibilities.join(' · ')}</span></div><div><strong>Context boundary</strong><span>{value.context.join(' · ')}</span></div></div>
    <div className="integration-form">
      <label>{value.configured ? 'Replace agent API key (leave blank to keep it)' : value.inherited ? 'Dedicated API key (optional when keeping the same inherited provider)' : 'Agent API key'}<input type="password" value={secret} autoComplete="new-password" onChange={e => setSecret(e.target.value)} /></label>
      <label>Provider<select value={provider} onChange={e => { const next = e.target.value as AiProvider; setProvider(next); setModel(defaultModel(next)) }}><option value="gemini">Gemini (Google AI Studio)</option><option value="openai">OpenAI</option><option value="anthropic">Claude (Anthropic)</option><option value="deepseek">DeepSeek</option></select></label>
      <label>Model ID<input value={model} onChange={e => setModel(e.target.value)} required /></label>
      <label className="checkbox-label"><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} /> Enable {value.name}</label>
    </div>
    {value.inherited && !value.configured && <small>This agent currently inherits the Legacy Shared AI key. Saving creates an independent encrypted agent configuration.</small>}
    {!value.schemaReady && <p role="alert" className="settings-message">Separate agent storage is not installed yet. Run supabase/schema-v11-ai-agent-manager.sql. Existing Legacy Shared AI continues to work as fallback.</p>}
    {providerChanged && hasEffectiveCredential && !secret.trim() && <small>Changing provider requires that provider’s API key.</small>}
    {message && <p role="status" className="settings-message">{message}</p>}
    <div className="integration-actions"><button className="primary" disabled={busy || !value.schemaReady || (!hasEffectiveCredential && !secret.trim()) || (providerChanged && hasEffectiveCredential && !secret.trim())} onClick={() => void act('save')}>Save agent</button><button className="secondary" disabled={busy || !hasEffectiveCredential} onClick={() => void act('test')}>Test agent</button><button className="secondary danger-button" disabled={busy || !value.configured} onClick={() => void act('remove')}>Remove dedicated config</button></div>
  </div>
}

function AIAgentManager() {
  const [data, setData] = useState<{ agents: AiAgent[]; schemaReady: boolean; encryptionReady: boolean } | null>(null)
  const [error, setError] = useState('')
  const load = async () => { setData(await settingsRequest('/api/account/ai-agents')); setError('') }
  useEffect(() => { void load().catch(e => setError(e instanceof Error ? e.message : 'Could not load AI Agent Manager.')) }, [])
  return <section className="ai-agent-manager">
    <div className="panel ai-agent-manager-head"><div className="panel-heading"><div><h2>AI Agent Manager</h2><p>Run separate AI roles with independent providers, models, credentials and context boundaries.</p></div><span className="role-badge">2 agents</span></div>
      <div className="ai-agent-architecture"><span>BA Client Ops Tracker</span><b>→</b><span>AI Agent Manager</span><b>→</b><span>BA Assistant</span><span className="architecture-divider">|</span><span>Document Agent</span></div>
      <p className="settings-helper">BA Assistant handles conversational workspace support. Document Agent handles BRD/FSD processing, AI test-case generation, and reviewed RTM requirement/reference mapping. RTM task linking and assignment remain manual.</p>
      {data && !data.encryptionReady && <p role="alert" className="settings-message">TENANT_INTEGRATION_MASTER_KEY must be configured before agent credentials can be encrypted.</p>}
      {error && <p role="alert" className="settings-message">{error}</p>}
    </div>
    {data && <div className="ai-agent-grid">{data.agents.map(agent => <AiAgentCard key={agent.id} value={agent} refresh={load} />)}</div>}
  </section>
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
export default function Settings({ currentUser, clients, onSaveAppearance }: { currentUser: UserAccount; clients: Client[]; onSaveAppearance: (patch: AppearancePatch) => Promise<void> }) {
  const [data,setData] = useState<any>(null), [error,setError] = useState('')
  const [activeTab, setActiveTab] = useState('appearance')
  const isAdmin = currentUser.role === 'Administrator'
  const tabs = [{ id: 'appearance', label: 'Appearance' }, ...(isAdmin ? [{ id: 'templates', label: 'Templates' }, { id: 'agents', label: 'AI Agents' }, { id: 'integrations', label: 'Integrations' }] : [])]
  const load = async () => { setData(await settingsRequest('/api/account/integrations')); setError('') }
  useEffect(() => { if (currentUser.role === 'Administrator') void load().catch(e => setError(e.message)) }, [currentUser.id, currentUser.organizationId, currentUser.role])
  useEffect(() => { if (!isAdmin) setActiveTab('appearance') }, [isAdmin])
  return <section className="page-stack settings-page">
    <div className="page-heading"><div><h1>Settings</h1><p>{currentUser.organizationName} · Personal appearance{isAdmin ? ' and account preferences' : ''}</p></div></div>
    <div className="settings-tabs" role="tablist" aria-label="Settings sections">{tabs.map((tab, index) => <button type="button" key={tab.id} id={`settings-tab-${tab.id}`} role="tab" aria-selected={activeTab === tab.id} aria-controls={`settings-section-${tab.id}`} tabIndex={activeTab === tab.id ? 0 : -1} onClick={() => setActiveTab(tab.id)} onKeyDown={event => {
      const nextIndex = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1
      if (nextIndex < 0) return
      event.preventDefault(); setActiveTab(tabs[nextIndex].id)
      event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[nextIndex]?.focus()
    }}>{tab.label}</button>)}</div>
    <div className="settings-tab-content" id="settings-section-appearance" role="tabpanel" aria-labelledby="settings-tab-appearance" hidden={activeTab !== 'appearance'} tabIndex={0}>
      <ThemePreferences embedded user={currentUser} clients={clients} onSave={onSaveAppearance} />
      {!isAdmin && <p className="settings-helper">Your account administrator manages templates, AI agents, and integrations.</p>}
    </div>
    {isAdmin && <>
      <div className="settings-tab-content" id="settings-section-templates" role="tabpanel" aria-labelledby="settings-tab-templates" hidden={activeTab !== 'templates'} tabIndex={0}><Templates /></div>
      <div className="settings-tab-content" id="settings-section-agents" role="tabpanel" aria-labelledby="settings-tab-agents" hidden={activeTab !== 'agents'} tabIndex={0}><AIAgentManager /></div>
      <div className="settings-tab-content" id="settings-section-integrations" role="tabpanel" aria-labelledby="settings-tab-integrations" hidden={activeTab !== 'integrations'} tabIndex={0}>
        <div className="settings-section-heading"><div><h2>Account integrations</h2><p>Manage connections used by your account.</p></div><button type="button" className="secondary" onClick={() => void load().catch(e => setError(e.message))}>Refresh status</button></div>
        {error && <p role="alert" className="settings-message">{error}</p>}{data && !data.encryptionReady && <p role="alert" className="settings-message">Integration storage needs setup by Internal Admin.</p>}
        {data?.integrations.map((value: Integration) => <IntegrationCard key={value.kind} value={value} runtime={data.discord} refresh={load} />)}
        <DocHubSettings key={`dochub:${currentUser.organizationId}`} /><CalendarAccountSettings key={currentUser.organizationId} /><GmailAccountSettings key={`gmail:${currentUser.organizationId}`} />
      </div>
    </>}
  </section>
}
