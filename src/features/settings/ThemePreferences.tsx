import { useState } from 'react'
import { THEME_OPTIONS, normalizeAppTheme, type AppTheme } from './theme'
import type { InterfaceMode } from './appearance'
import type { UserAccount } from '../../shared/types'
import AppearancePreferences from './AppearancePreferences'

export type AppearancePatch = { theme?: AppTheme; interfaceMode?: InterfaceMode | null }

export default function ThemePreferences({ user, onSave, embedded = false }: {
  user: UserAccount; onSave: (patch: AppearancePatch) => Promise<void>; embedded?: boolean
}) {
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<{ text: string; error?: boolean } | null>(null)
  const selected = normalizeAppTheme(user.theme)
  const save = async (theme: AppTheme) => {
    setBusy(true); setFeedback(null)
    try {
      await onSave({ theme })
      setFeedback({ text: 'Workspace background theme saved for your profile.' })
    } catch (error) { setFeedback({ text: (error as Error).message, error: true }) } finally { setBusy(false) }
  }
  return <section className={embedded ? 'appearance-content' : 'page-stack themes-page'}>
    {!embedded && <div className="page-heading"><div><h1>My Themes</h1><p>{user.organizationName} · Your workspace interface and background preferences</p></div></div>}
    <AppearancePreferences user={user} onSave={onSave} />
    <div className="panel background-preferences">
      <div className="appearance-heading"><div><h2>Workspace background</h2><p>Choose one background theme for your workspace. The same theme is used across clients, projects, and modules.</p></div></div>
      {feedback && <p role={feedback.error ? 'alert' : 'status'} className="settings-message">{feedback.text}</p>}
      <div className="personal-theme-grid">{THEME_OPTIONS.map(theme => <button type="button" key={theme.id} className={`personal-theme-card ${selected === theme.id ? 'selected' : ''}`} aria-pressed={selected === theme.id} disabled={busy} onClick={() => void save(theme.id)}>{theme.image ? <img src={theme.image} alt="" /> : <div className="theme-default-swatch" />}<strong>{theme.name}</strong><span>{theme.description}</span><small>{selected === theme.id ? 'Selected' : busy ? 'Saving…' : 'Apply theme'}</small></button>)}</div>
    </div>
  </section>
}
