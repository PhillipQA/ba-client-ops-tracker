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
function GoogleSignIn({
  busy,
  account,
  onGoogleLogin,
}: {
  busy: boolean
  /** The account chosen in step 1: Google signs in to a user of that account only. */
  account: string
  onGoogleLogin: GoogleLogin
}) {
  const [clientId, setClientId] = useState('')
  const [accounts, setAccounts] = useState<GoogleAccountChoice[]>([])
  const [problem, setProblem] = useState('')
  const credential = useRef('')
  const holder = useRef<HTMLDivElement>(null)
  const signIn = useRef(onGoogleLogin)
  signIn.current = onGoogleLogin
  const chosen = useRef(account)
  chosen.current = account
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
            void signIn
              .current(response.credential, chosen.current || undefined)
              .then(choices => setAccounts(choices || []))
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
      <div className="auth-divider" aria-hidden="true">
        <span>OR</span>
      </div>
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

/**
 * Sign-in in two steps, as the same email can be a user in several accounts:
 * 1. Account: which account to sign in to. Nothing is checked yet, so this step gives no hint whether it exists.
 * 2. User and password, or Google, for a user of that account. Account, user and password are checked together, with
 *    one answer for any mistake ("Incorrect account, user, or password").
 * A remembered account opens straight on step 2.
 */
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
  // Step 2 opens with the account as typed (a remembered one at once). `back` slides step 1 in from the left.
  const [chosen, setChosen] = useState(() => (rememberedLogin ? account.trim() : ''))
  const [back, setBack] = useState(false)
  if (forgot) return <ForgotPassword account={chosen || account} username={username} onBack={() => setForgot(false)} />

  const continueToSignIn = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const typed = account.trim()
    if (!typed) return
    setChosen(typed)
    setBack(false)
  }
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!chosen) return
    const form = new FormData(event.currentTarget)
    const nextUsername = String(form.get('username') || '').trim()
    if (remember) {
      localStorage.setItem('client-ops-login-remember', '1')
      localStorage.setItem('client-ops-login-account', chosen)
      localStorage.setItem('client-ops-login-user', nextUsername)
    } else {
      localStorage.removeItem('client-ops-login-remember')
      localStorage.removeItem('client-ops-login-account')
      localStorage.removeItem('client-ops-login-user')
    }
    void onLogin(chosen, nextUsername, String(form.get('password') || ''))
  }
  const changeAccount = () => {
    setBack(true)
    setChosen('')
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
              <span>{chosen ? 'Sign in to your workspace' : 'Which account are you signing in to?'}</span>
            </div>
          </div>
          <ol className="auth-steps" aria-label="Sign-in steps">
            <li className={chosen ? 'done' : 'on'} aria-current={chosen ? undefined : 'step'}>
              <span>1</span> Account
            </li>
            <li className={chosen ? 'on' : ''} aria-current={chosen ? 'step' : undefined}>
              <span>2</span> Sign in
            </li>
          </ol>
          {!chosen ? (
            <div key="account" className={`auth-step${back ? ' from-left' : ''}`}>
              <form className="auth-form auth-form-modern" onSubmit={continueToSignIn}>
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
                      autoFocus
                      required
                    />
                  </div>
                </label>
                <button className="primary auth-submit auth-submit-modern">
                  <span>Continue</span>
                  <ArrowRight size={18} />
                </button>
              </form>
            </div>
          ) : (
            <div key="sign-in" className="auth-step">
              <div className="auth-account-chip">
                <Building2 size={16} aria-hidden="true" />
                <span>
                  Signing in to <strong>{chosen}</strong>
                </span>
                <button className="auth-inline-link" type="button" disabled={busy} onClick={changeAccount}>
                  Change
                </button>
              </div>
              <form className="auth-form auth-form-modern" onSubmit={submit}>
                <label>
                  <span>User</span>
                  <div className="auth-input-shell">
                    <UserRound size={18} />
                    <input
                      name="username"
                      value={username}
                      onChange={event => setUsername(event.target.value)}
                      autoComplete="username"
                      autoFocus={!username}
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
                      autoFocus={Boolean(username)}
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
              <GoogleSignIn busy={busy} account={chosen} onGoogleLogin={onGoogleLogin} />
            </div>
          )}
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

/**
 * Internal Admin sign-in, at /internal_admin only: the platform control plane, kept apart from workspace sign-in.
 * There is no account to choose and no Google sign-in.
 */
export function InternalAdminLogin({
  busy,
  error,
  onLogin,
}: {
  busy: boolean
  error: string
  onLogin: (username: string, password: string) => Promise<void>
}) {
  const [forgot, setForgot] = useState(false)
  const [username, setUsername] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  if (forgot) return <ForgotPassword account="internal_admin" username={username} onBack={() => setForgot(false)} />
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    void onLogin(String(form.get('username') || '').trim(), String(form.get('password') || ''))
  }
  return (
    <div className="auth-shell auth-shell-recovery">
      <div className="auth-card account-login-card auth-internal-card">
        <div className="auth-brand auth-brand-modern">
          <img className="auth-app-icon" src="/ba-app-icon.png" alt="" />
          <div className="auth-brand-copy">
            <strong>Internal Admin</strong>
            <span>Client Ops Tracker platform administration</span>
          </div>
        </div>
        <form className="auth-form auth-form-modern" onSubmit={submit}>
          <label>
            <span>User</span>
            <div className="auth-input-shell">
              <UserRound size={18} />
              <input
                name="username"
                value={username}
                onChange={event => setUsername(event.target.value)}
                autoComplete="username"
                autoFocus
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
            <a className="auth-inline-link" href="/">
              Workspace sign-in
            </a>
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
      </div>
    </div>
  )
}
