import { ForgotPassword } from '../features/accounts/PasswordRecovery'
import { APP_LABEL } from '../shared/version'
import { ArrowRight, Building2, Eye, EyeOff, LockKeyhole, ShieldCheck, UserRound } from 'lucide-react'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { type GoogleAccountChoice, googleSignInClientId } from '../features/accounts/auth'
import { loadGoogle } from '../shared/googleIdentity'

type GoogleLogin = (credential: string, account?: string) => Promise<GoogleAccountChoice[] | null>

/**
 * Sign in with Google, shown when the server has a Google client set up. The person picks their Google account; the
 * server signs in the user registered with that email. An email registered in several accounts asks which one.
 */
function GoogleSignIn({ busy, onGoogleLogin }: { busy: boolean; onGoogleLogin: GoogleLogin }) {
  const [clientId, setClientId] = useState('')
  const [accounts, setAccounts] = useState<GoogleAccountChoice[]>([])
  const [problem, setProblem] = useState('')
  const credential = useRef('')
  const holder = useRef<HTMLDivElement>(null)
  const signIn = useRef(onGoogleLogin)
  signIn.current = onGoogleLogin
  useEffect(() => {
    let alive = true
    void googleSignInClientId().then(id => {
      if (alive) setClientId(id)
    })
    return () => {
      alive = false
    }
  }, [])
  useEffect(() => {
    if (!clientId) return
    let alive = true
    loadGoogle()
      .then(() => {
        if (!alive || !holder.current) return
        const google = (window as any).google
        google.accounts.id.initialize({
          client_id: clientId,
          callback: (response: { credential?: string }) => {
            if (!response.credential) return
            credential.current = response.credential
            void signIn.current(response.credential).then(choices => setAccounts(choices || []))
          },
          auto_select: false,
          cancel_on_tap_outside: true,
        })
        google.accounts.id.renderButton(holder.current, {
          theme: 'outline',
          size: 'large',
          text: 'continue_with',
          width: Math.min(400, holder.current.offsetWidth || 320),
        })
      })
      .catch(error => {
        if (alive) setProblem(error instanceof Error ? error.message : 'Google sign-in could not load.')
      })
    return () => {
      alive = false
    }
  }, [clientId])
  if (!clientId) return null
  return (
    <div className="auth-google">
      <div ref={holder} />
      {accounts.length > 0 && (
        <div className="auth-google-accounts" role="group" aria-label="Choose the account to open">
          <span>Your email is in more than one account. Choose one:</span>
          {accounts.map(account => (
            <button
              key={account.slug}
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() =>
                void signIn.current(credential.current, account.slug).then(choices => setAccounts(choices || []))
              }
            >
              {account.name}
            </button>
          ))}
        </div>
      )}
      {problem && <small role="alert">{problem}</small>}
    </div>
  )
}

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
  onGoogleLogin,
}: {
  busy: boolean
  error: string
  onLogin: (account: string, username: string, password: string) => Promise<void>
  onGoogleLogin: GoogleLogin
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
          <GoogleSignIn busy={busy} onGoogleLogin={onGoogleLogin} />
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
