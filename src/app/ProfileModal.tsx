import { type AppTheme, THEME_OPTIONS, normalizeAppTheme } from '../theme'
import { type UserAccount } from '../types'
import { X } from 'lucide-react'
import { FormEvent, useState } from 'react'

export function ProfileModal({ user, onClose, onSave }: { user: UserAccount; onClose: () => void; onSave: (profile: { name: string; email: string; phone: string; theme: AppTheme; newPassword?: string; currentPassword?: string }) => Promise<string | void> }) {
  const [message, setMessage] = useState('')
  const [saving, setSaving] = useState(false)
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSaving(true)
    setMessage('')
    const form = new FormData(event.currentTarget)
    const password = String(form.get('newPassword') || '')
    const confirm = String(form.get('confirmPassword') || '')
    const currentPassword = String(form.get('currentPassword') || '')
    const email = String(form.get('email') || '').trim()
    if (password && password !== confirm) {
      setMessage('The new password and confirmation do not match.')
      setSaving(false)
      return
    }
    if ((password || email.toLowerCase() !== String(user.email || '').trim().toLowerCase()) && !currentPassword) {
      setMessage('Enter your current password to change your email address or password.')
      setSaving(false)
      return
    }
    const result = await onSave({
      name: String(form.get('name') || '').trim(),
      email,
      phone: String(form.get('phone') || '').trim(),
      theme: normalizeAppTheme(form.get('theme')),
      newPassword: password || undefined,
      currentPassword: currentPassword || undefined,
    })
    setMessage(result || 'Profile updated.')
    setSaving(false)
  }
  return <div className="modal-backdrop" role="presentation">
    <div className="modal profile-modal" role="dialog" aria-modal="true" aria-label="My profile">
      <div className="modal-head"><div><h2>My profile</h2><p>Update your personal details. Your role and module access are controlled by an Administrator.</p></div><button className="icon-button" type="button" onClick={onClose}><X size={20} /></button></div>
      <form className="profile-form" onSubmit={(event) => void submit(event)}>
        <div className="profile-summary"><div className="settings-avatar">{user.name.split(' ').map((part) => part[0]).slice(0, 2).join('').toUpperCase() || 'U'}</div><div><strong>{user.name}</strong><span>@{user.username} · {user.role}</span></div></div>
        <label>Display name<input name="name" defaultValue={user.name} required /></label>
        <label>Email<input name="email" type="email" defaultValue={user.email} placeholder="name@company.com" /></label>
        <label>Contact number<input name="phone" defaultValue={user.phone} placeholder="+63 900 000 0000" /></label>
        <label>Background theme<select name="theme" defaultValue={normalizeAppTheme(user.theme)}>{THEME_OPTIONS.map((theme) => <option key={theme.id} value={theme.id}>{theme.name}</option>)}</select><small>Open My Themes for Dark, Light, or Gray interface modes and client-specific backgrounds.</small></label>
        <div className="profile-password-grid">
          <label>New password <small>Optional</small><input name="newPassword" type="password" minLength={8} autoComplete="new-password" /></label>
          <label>Confirm new password<input name="confirmPassword" type="password" minLength={8} autoComplete="new-password" /></label>
        </div>
        <label>Current password <small>Required to change your email address or password</small><input name="currentPassword" type="password" autoComplete="current-password" /></label>
        {message && <div className="settings-message">{message}</div>}
        <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Close</button><button className="primary" disabled={saving}>{saving ? 'Saving…' : 'Save profile'}</button></div>
      </form>
    </div>
  </div>
}
