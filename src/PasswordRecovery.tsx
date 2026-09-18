import { useState, type FormEvent, type ReactNode } from 'react'
import { LockKeyhole, Mail } from 'lucide-react'

async function recoveryRequest(path: string, body: object) {
  const response = await fetch(path, {
    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(result.error || 'Unable to complete your request. Please try again.')
  return String(result.message || '')
}

function RecoveryCard({ title, description, children, email = false }: { title: string; description: string; children: ReactNode; email?: boolean }) {
  return <div className="auth-shell"><div className="auth-card account-login-card">
    <div className="auth-brand"><img className="auth-brand-logo" src="/client-ops-logo.png" alt="Client Ops Tracker" /></div>
    <div className="auth-copy"><span className="auth-icon">{email ? <Mail size={22} /> : <LockKeyhole size={22} />}</span><div><h1>{title}</h1><p>{description}</p></div></div>
    {children}
  </div></div>
}

export function ForgotPassword({ account, username, onBack }: { account: string; username: string; onBack: () => void }) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy) return
    const form = new FormData(event.currentTarget)
    setBusy(true); setError('')
    try {
      setMessage(await recoveryRequest('/api/auth/forgot-password', {
        account: String(form.get('account') || '').trim(), username: String(form.get('username') || '').trim(), email: String(form.get('email') || '').trim(),
      }))
    } catch (err) { setError(err instanceof Error ? err.message : 'Unable to request a reset link.') }
    finally { setBusy(false) }
  }
  return <RecoveryCard title="Forgot password?" description="Enter your account details and we’ll email you a link to reset your password." email>
    {message ? <div className="auth-message" role="status">{message}</div> : <form className="auth-form" onSubmit={(event) => void submit(event)}>
      <label>Account<input name="account" defaultValue={account} autoComplete="organization" maxLength={200} required /></label>
      <label>User<input name="username" defaultValue={username} autoComplete="username" maxLength={200} required /></label>
      <label>Registered email<input name="email" type="email" autoComplete="email" maxLength={254} required /></label>
      {error && <div className="auth-error" role="alert">{error}</div>}
      <button className="primary auth-submit" disabled={busy}>{busy ? 'Requesting link…' : 'Send reset link'}</button>
    </form>}
    <button className="auth-text-button" type="button" disabled={busy} onClick={onBack}>Back to sign in</button>
  </RecoveryCard>
}

export function ResetPassword({ token, onBack }: { token: string; onBack: () => void }) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy) return
    const form = new FormData(event.currentTarget)
    const password = String(form.get('password') || '')
    if (password !== String(form.get('confirmation') || '')) return void setError('The passwords do not match.')
    setBusy(true); setError('')
    try { setMessage(await recoveryRequest('/api/auth/reset-password', { token, password })) }
    catch (err) { setError(err instanceof Error ? err.message : 'Unable to reset your password.') }
    finally { setBusy(false) }
  }
  return <RecoveryCard title={message ? 'Password reset' : 'Choose a new password'} description={message ? 'You can now sign in with your new password.' : 'Use between 8 and 128 characters for your new password.'}>
    {message ? <div className="auth-message" role="status">{message}</div> : <form className="auth-form" onSubmit={(event) => void submit(event)}>
      <label>New password<input name="password" type="password" autoComplete="new-password" minLength={8} maxLength={128} required /></label>
      <label>Confirm new password<input name="confirmation" type="password" autoComplete="new-password" minLength={8} maxLength={128} required /></label>
      {error && <div className="auth-error" role="alert">{error}</div>}
      <button className="primary auth-submit" disabled={busy}>{busy ? 'Resetting password…' : 'Reset password'}</button>
    </form>}
    <button className="auth-text-button" type="button" disabled={busy} onClick={onBack}>Back to sign in</button>
  </RecoveryCard>
}
