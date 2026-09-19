import { useState } from 'react'
import { THEME_OPTIONS, normalizeAppTheme, type AppTheme } from './theme'
import type { Client, UserAccount } from './types'

export default function ThemePreferences({ user, clients, onSave }: { user: UserAccount; clients: Client[]; onSave: (patch: { theme?: AppTheme; clientId?: string; clientTheme?: AppTheme | null }) => Promise<void> }) {
  const [clientId, setClientId] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const selected = clientId ? user.clientThemes?.[clientId] : normalizeAppTheme(user.theme)
  const save = async (theme: AppTheme | null) => {
    setBusy(true); setMessage('')
    try {
      await onSave(clientId ? { clientId, clientTheme: theme } : { theme: theme || 'default' })
      setMessage('Theme saved for your user in this account.')
    } catch (error) { setMessage((error as Error).message) } finally { setBusy(false) }
  }
  return <section className="page-stack"><div className="page-heading"><div><h1>My Themes</h1><p>{user.organizationName} · {user.name}</p></div></div><div className="panel"><h2>Choose where to apply your theme</h2><p>Your personal theme applies throughout this account. You can choose a different theme when viewing a particular client and its projects. Other users keep their own preferences.</p><label>Theme for<select value={clientId} disabled={busy} onChange={e => { setClientId(e.target.value); setMessage('') }}><option value="">My workspace</option>{clients.map(client => <option key={client.id} value={client.id}>{client.name}</option>)}</select></label>{clientId && <button className="secondary" disabled={busy || selected === undefined} onClick={() => void save(null)}>Use my workspace theme</button>}{clientId && selected === undefined && <p>This client uses your workspace theme.</p>}</div>
    {message && <p role="status" className="settings-message">{message}</p>}
    <div className="personal-theme-grid">{THEME_OPTIONS.map(theme => <button type="button" key={theme.id} className={`personal-theme-card ${selected === theme.id ? 'selected' : ''}`} aria-pressed={selected === theme.id} disabled={busy} onClick={() => void save(theme.id)}>{theme.image ? <img src={theme.image} alt="" /> : <div className="theme-default-swatch" />}<strong>{theme.name}</strong><span>{theme.description}</span><small>{selected === theme.id ? 'Selected' : busy ? 'Saving…' : 'Apply theme'}</small></button>)}</div>
  </section>
}
