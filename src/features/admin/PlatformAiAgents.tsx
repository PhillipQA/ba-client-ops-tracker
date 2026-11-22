/**
 * Internal Admin › AI: the key, provider and model of each AI agent (BA Assistant, Document Agent), used by every
 * account whose AI module is on. Accounts no longer hold AI keys. There is no connection test: a wrong key shows up
 * as an error the first time someone uses AI.
 */
import { useEffect, useState } from 'react'
import { settingsRequest } from '../settings/settingsRequest'

type AiProvider = 'gemini' | 'openai' | 'anthropic' | 'deepseek'
type PlatformAgent = {
  id: 'ba_assistant' | 'document'
  name: string
  description: string
  configured: boolean
  enabled: boolean
  maskedKey: string
  config: { provider: AiProvider; model: string }
  updatedAt: string | null
  updatedBy: string
  schemaReady: boolean
  responsibilities: string[]
}

export const DEFAULT_MODELS: Record<AiProvider, string> = {
  gemini: 'gemini-3.8-flash',
  openai: 'gpt-5.6-terra',
  anthropic: 'claude-sonnet-5',
  deepseek: 'deepseek-flash',
}

function AgentCard({ value, refresh }: { value: PlatformAgent; refresh: () => Promise<void> }) {
  const [secret, setSecret] = useState('')
  const [enabled, setEnabled] = useState(value.enabled)
  const [provider, setProvider] = useState<AiProvider>(value.config.provider)
  const [model, setModel] = useState(value.config.model)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const providerChanged = value.configured && provider !== value.config.provider
  useEffect(() => {
    setEnabled(value.enabled)
    setProvider(value.config.provider)
    setModel(value.config.model)
    setSecret('')
  }, [value])

  const act = async (action: 'save' | 'remove') => {
    if (
      action === 'remove' &&
      !window.confirm(`Remove the ${value.name} key? AI that uses it stops working in every account.`)
    )
      return
    setBusy(true)
    setMessage('')
    try {
      const url = `/api/internal-admin/ai-agents/${value.id}`
      await settingsRequest(
        url,
        action === 'remove' ? 'DELETE' : 'PUT',
        action === 'save' ? { secret, enabled, config: { provider, model } } : undefined,
      )
      setSecret('')
      setMessage(action === 'remove' ? `${value.name} key removed.` : `${value.name} saved.`)
      await refresh()
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'The AI settings could not be saved.')
    } finally {
      setBusy(false)
    }
  }

  const status = value.configured ? (value.enabled ? 'On' : 'Off') : 'No key'
  return (
    <div className="panel ai-agent-card">
      <div className="panel-heading">
        <div>
          <h3>{value.name}</h3>
          <p>{value.description}</p>
        </div>
        <span className="role-badge">{status}</span>
      </div>
      <div className="ai-agent-meta">
        <span>
          <b>Key:</b> {value.maskedKey || 'None'}
        </span>
        {value.updatedAt && (
          <span>
            <b>Saved:</b> {new Date(value.updatedAt).toLocaleString()}
            {value.updatedBy ? ` by ${value.updatedBy}` : ''}
          </span>
        )}
      </div>
      <p className="settings-helper">{value.responsibilities.join(' · ')}</p>
      <div className="integration-form">
        <label>
          {value.configured ? 'Replace API key (leave blank to keep it)' : 'API key'}
          <input type="password" value={secret} autoComplete="new-password" onChange={e => setSecret(e.target.value)} />
        </label>
        <label>
          Provider
          <select
            value={provider}
            onChange={e => {
              const next = e.target.value as AiProvider
              setProvider(next)
              setModel(DEFAULT_MODELS[next])
            }}
          >
            <option value="gemini">Gemini (Google AI Studio)</option>
            <option value="openai">OpenAI</option>
            <option value="anthropic">Claude (Anthropic)</option>
            <option value="deepseek">DeepSeek</option>
          </select>
        </label>
        <label>
          Model ID
          <input value={model} onChange={e => setModel(e.target.value)} required />
        </label>
        <label className="checkbox-label">
          <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} /> {value.name} on
        </label>
      </div>
      {providerChanged && !secret.trim() && <small>Changing the provider needs that provider’s key.</small>}
      {message && (
        <p role="status" className="settings-message">
          {message}
        </p>
      )}
      <div className="integration-actions">
        <button
          type="button"
          className="primary"
          disabled={
            busy || !value.schemaReady || (!value.configured && !secret.trim()) || (providerChanged && !secret.trim())
          }
          onClick={() => void act('save')}
        >
          Save
        </button>
        <button
          type="button"
          className="secondary danger-button"
          disabled={busy || !value.configured}
          onClick={() => void act('remove')}
        >
          Remove key
        </button>
      </div>
    </div>
  )
}

export function PlatformAiAgents() {
  const [data, setData] = useState<{
    agents: PlatformAgent[]
    schemaReady: boolean
    encryptionReady: boolean
  } | null>(null)
  const [error, setError] = useState('')
  const load = async () => {
    setData(await settingsRequest('/api/internal-admin/ai-agents'))
    setError('')
  }
  useEffect(() => {
    void load().catch(e => setError(e instanceof Error ? e.message : 'The AI settings could not be loaded.'))
  }, [])
  return (
    <section className="panel internal-admin-ai">
      <div className="panel-heading">
        <div>
          <h2>AI</h2>
          <p>
            One key per agent, used by every account whose <b>AI</b> module is on. Turn AI on or off for an account
            under Tenant accounts › the account › Modules.
          </p>
        </div>
      </div>
      {data && !data.schemaReady && (
        <p role="alert" className="settings-message">
          AI keys need database schema v44: run database/migrations/schema-v44-platform-ai.sql.
        </p>
      )}
      {data && !data.encryptionReady && (
        <p role="alert" className="settings-message">
          TENANT_INTEGRATION_MASTER_KEY must be set on the server before AI keys can be saved.
        </p>
      )}
      {error && (
        <p role="alert" className="settings-message">
          {error}
        </p>
      )}
      {data && (
        <div className="ai-agent-grid">
          {data.agents.map(agent => (
            <AgentCard key={agent.id} value={agent} refresh={load} />
          ))}
        </div>
      )}
      <small>Keys are encrypted, and never shown again after saving.</small>
    </section>
  )
}
