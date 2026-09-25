import { useId, useState } from 'react'
import { INTERFACE_MODES, normalizeInterfaceMode, type InterfaceMode } from './appearance'
import type { UserAccount } from './types'

export default function AppearancePreferences({ user, onSave }: {
  user: UserAccount
  onSave: (patch: { interfaceMode: InterfaceMode | null }) => Promise<void>
}) {
  const id = useId()
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<{ text: string; error?: boolean } | null>(null)
  const selected = normalizeInterfaceMode(user.interfaceMode)
  const save = async (interfaceMode: InterfaceMode | null) => {
    setBusy(true); setFeedback(null)
    try {
      await onSave({ interfaceMode })
      setFeedback({ text: interfaceMode ? `${INTERFACE_MODES.find(mode => mode.id === interfaceMode)!.name} mode saved for your profile.` : 'Original theme appearance restored.' })
    } catch (error) {
      setFeedback({ text: error instanceof Error ? error.message : 'Could not save appearance. Please retry.', error: true })
    } finally { setBusy(false) }
  }
  return <div className="panel appearance-preferences" aria-busy={busy}>
    <div className="appearance-heading"><div><h2 id={`${id}-title`}>Interface mode</h2><p>Choose the colors of your menus, panels, and forms. This preference is personal to you in this account.</p></div><span className="role-badge">Personal</span></div>
    <fieldset className="interface-mode-grid" aria-labelledby={`${id}-title`} aria-describedby={`${id}-note`} disabled={busy}>
      {INTERFACE_MODES.map(mode => <label key={mode.id} className={`interface-mode-choice ${selected === mode.id ? 'selected' : ''}`}>
        <span className={`interface-mode-preview preview-${mode.id}`} aria-hidden="true"><span className="mode-preview-sidebar"><i /><i /><i /></span><span className="mode-preview-workspace"><i /><span><i /><i /></span><i /></span></span>
        <span className="mode-choice-title"><span>{mode.name}</span><input type="radio" name={`${id}-mode`} value={mode.id} checked={selected === mode.id} onChange={() => void save(mode.id)} /></span>
        <span className="mode-choice-description">{mode.description}</span>
      </label>)}
    </fieldset>
    <div className="appearance-footer"><p id={`${id}-note`}>Your background themes and document templates stay as they are.{!selected && ' Your original theme appearance is currently active.'}</p><button type="button" className="secondary" disabled={busy || !selected} onClick={() => void save(null)}>Use original theme appearance</button></div>
    {busy && <p className="settings-message" role="status">Saving appearance…</p>}
    {feedback && <p className="settings-message" role={feedback.error ? 'alert' : 'status'}>{feedback.text}</p>}
  </div>
}
