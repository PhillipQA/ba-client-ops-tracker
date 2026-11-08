import { ForgotPassword } from '../features/accounts/PasswordRecovery'
import { APP_LABEL } from '../shared/version'
import { ArrowRight, Building2, Eye, EyeOff, LockKeyhole, ShieldCheck, UserRound } from 'lucide-react'
import { type FormEvent, useState } from 'react'

export function AuthSplash() {
  return (
    <div className="auth-shell auth-shell-recovery">
      <div className="auth-card auth-loading">
        <div className="auth-brand">
          <img className="auth-brand-logo" src="/client-ops-logo.png" alt="Client Ops Tracker" />
        </div>
        <div className="auth-spinner" />
        <p>Checking your session…</p>
      </div>
    </div>
  )
}

export function LoginScreen({
  busy,
  error,
  onLogin,
}: {
  busy: boolean
  error: string
  onLogin: (account: string, username: string, password: string) => Promise<void>
}) {
  const [forgot, setForgot] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const rememberedLogin = localStorage.getItem('client-ops-login-remember') === '1'
  const [remember, setRemember] = useState(rememberedLogin)
  const [account, setAccount] = useState(() =>
    rememberedLogin ? localStorage.getItem('client-ops-login-account') || '' : '',
  )
  const [username, setUsername] = useState(() =>
    rememberedLogin ? localStorage.getItem('client-ops-login-user') || '' : '',
  )
  if (forgot) return <ForgotPassword account={account} username={username} onBack={() => setForgot(false)} />
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const nextAccount = String(form.get('account') || '').trim()
    const nextUsername = String(form.get('username') || '').trim()
    if (remember) {
      localStorage.setItem('client-ops-login-remember', '1')
      localStorage.setItem('client-ops-login-account', nextAccount)
      localStorage.setItem('client-ops-login-user', nextUsername)
    } else {
      localStorage.removeItem('client-ops-login-remember')
      localStorage.removeItem('client-ops-login-account')
      localStorage.removeItem('client-ops-login-user')
    }
    void onLogin(nextAccount, nextUsername, String(form.get('password') || ''))
  }
  return (
    <div className="auth-shell auth-shell-login">
      <aside className="auth-login-visual" aria-hidden="true">
        <img src="/login-hero.webp" alt="" />
      </aside>
      <main className="auth-login-panel">
        <div className="auth-version">v{APP_LABEL}</div>
        <div className="auth-card account-login-card auth-card-modern">
          <div className="auth-brand auth-brand-modern">
            <img className="auth-app-icon" src="/ba-app-icon.png" alt="" />
            <div className="auth-brand-copy">
              <strong>Client Ops Tracker</strong>
              <span>Sign in to your workspace</span>
            </div>
          </div>
          <form className="auth-form auth-form-modern" onSubmit={submit}>
            <label>
              <span>Account</span>
              <div className="auth-input-shell">
                <Building2 size={18} />
                <input
                  name="account"
                  value={account}
                  onChange={event => setAccount(event.target.value)}
                  autoComplete="organization"
                  placeholder="BXI-Core or customer account"
                  required
                />
              </div>
            </label>
            <label>
              <span>User</span>
              <div className="auth-input-shell">
                <UserRound size={18} />
                <input
                  name="username"
                  value={username}
                  onChange={event => setUsername(event.target.value)}
                  autoComplete="username"
                  required
                />
              </div>
            </label>
            <label>
              <span>Password</span>
              <div className="auth-input-shell">
                <LockKeyhole size={18} />
                <input
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  required
                />
                <button
                  className="auth-password-toggle"
                  type="button"
                  onClick={() => setShowPassword(value => !value)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </label>
            <div className="auth-form-options">
              <label className="auth-remember">
                <input type="checkbox" checked={remember} onChange={event => setRemember(event.target.checked)} />
                <span>Remember me</span>
              </label>
              <button className="auth-inline-link" type="button" disabled={busy} onClick={() => setForgot(true)}>
                Forgot password?
              </button>
            </div>
            {error && (
              <div className="auth-error" role="alert">
                {error}
              </div>
            )}
            <button className="primary auth-submit auth-submit-modern" disabled={busy}>
              {busy ? (
                'Signing in…'
              ) : (
                <>
                  <span>Sign in</span>
                  <ArrowRight size={18} />
                </>
              )}
            </button>
          </form>
          <div className="auth-divider" aria-hidden="true">
            <span>OR</span>
          </div>
          <div className="auth-security-note">
            <ShieldCheck size={21} />
            <div>
              <strong>Secure. Simple. Productive.</strong>
              <span>Your client operations, always within reach.</span>
            </div>
          </div>
        </div>
        <div className="auth-copyright">© 2026 Client Ops Tracker. All rights reserved.</div>
      </main>
    </div>
  )
}
