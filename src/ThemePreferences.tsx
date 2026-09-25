import { useState } from 'react'
import { THEME_OPTIONS, normalizeAppTheme, type AppTheme } from './theme'
import type { InterfaceMode } from './appearance'
import type { Client, UserAccount } from './types'
import AppearancePreferences from './AppearancePreferences'

export type AppearancePatch = { theme?: AppTheme; interfaceMode?: InterfaceMode | null; clientId?: string; clientTheme?: AppTheme | null }

export default function ThemePreferences({ user, clients, onSave, embedded = false }: {
  user: UserAccount; clients: Client[]; onSave: (patch: AppearancePatch) => Promise<void>; embedded?: boolean
}) {
  const [clientId, setClientId] = useState('')
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<{ text: string; error?: boolean } | null>(null)
  const selected = clientId ? user.clientThemes?.[clientId] : normalizeAppTheme(user.theme)
  const save = async (theme: AppTheme | null) => {
    setBusy(true); setFeedback(null)
    try {
      await onSave(clientId ? { clientId, clientTheme: theme } : { theme: theme || 'default' })
      setFeedback({ text: 'Background theme saved for your profile.' })
    } catch (error) { setFeedback({ text: (error as Error).message, error: true }) } finally { setBusy(false) }
  }
  return <section className={embedded ? 'appearance-content' : 'page-stack themes-page'}>
    {!embedded && <div className="page-heading"><div><h1>My Themes</h1><p>{user.organizationName} · Your interface and background preferences</p></div></div>}
    <AppearancePreferences user={user} onSave={onSave} />
    <div className="panel background-preferences">
      <div className="appearance-heading"><div><h2>Background themes</h2><p>Keep one background across your workspace or choose a different one for a client and its projects.</p></div></div>
      <div className="background-scope"><label>Theme for<select value={clientId} disabled={busy} onChange={e => { setClientId(e.target.value); setFeedback(null) }}><option value="">My workspace</option>{clients.map(client => <option key={client.id} value={client.id}>{client.name}</option>)}</select></label>{clientId && <button type="button" className="secondary" disabled={busy || selected === undefined} onClick={() => void save(null)}>Use my workspace theme</button>}</div>
      {clientId && selected === undefined && <p className="settings-helper">This client uses your workspace theme.</p>}
      {feedback && <p role={feedback.error ? 'alert' : 'status'} className="settings-message">{feedback.text}</p>}
      <div className="personal-theme-grid">{THEME_OPTIONS.map(theme => <button type="button" key={theme.id} className={`personal-theme-card ${selected === theme.id ? 'selected' : ''}`} aria-pressed={selected === theme.id} disabled={busy} onClick={() => void save(theme.id)}>{theme.image ? <img src={theme.image} alt="" /> : <div className="theme-default-swatch" />}<strong>{theme.name}</strong><span>{theme.description}</span><small>{selected === theme.id ? 'Selected' : busy ? 'Saving…' : 'Apply theme'}</small></button>)}</div>
    </div>
  </section>
}
