import type express from 'express'
import type { Express } from 'express'
import { randomBytes } from 'node:crypto'
import {
  bootstrapPasswordUsable,
  isBcryptHash,
  type OrganizationInfo,
  passwordHash,
  requireAuth,
  safeEqualText,
  safePlatformUser,
  safeUser,
  secureHashPassword,
  sessionCookie,
  sessionFromRequest,
  sessions,
  verifyPassword,
} from '../core/auth'
import {
  ALL_MODULES,
  BXI_CORE_ORG_ID,
  BXI_CORE_ORG_NAME,
  BXI_CORE_ORG_SLUG,
  bxiCoreBootstrapPassword,
  INTERNAL_ADMIN_ACCOUNT_KEY,
  internalAdminBootstrapPassword,
  PASSWORD_BOOTSTRAP_MARKER,
} from '../core/constants'
import { db } from '../core/database'
import { withAccess } from '../services/access-cache'
import {
  loadLegacyTrackerState,
  loadTenantState,
  multiTenantSchemaReady,
  organizationByLoginKey,
  platformAuthSchemaReady,
  saveTenantState,
  updateTenantAccountSnapshot,
} from '../core/tenant-state'
import type { LoginIdentity } from './login-limiter'
import { recoveryMailer, recoveryMessage, recoveryUnavailable, validRecoveryEmail } from './password-recovery-email'
import { loginLimiter, recoveryRequestLimiter, recoverySubmitLimiter } from './rate-limits'
import { SESSION_MAX_AGE_SECONDS } from './session-store'

function loginIdentity(req: express.Request): LoginIdentity {
  return {
    ip: req.ip || req.socket.remoteAddress || 'unknown',
    account: typeof req.body?.account === 'string' ? req.body.account : '',
    username: typeof req.body?.username === 'string' ? req.body.username : '',
  }
}

function setLoginRateHeaders(res: express.Response, rate: { limit: number; remaining: number; resetAt: number }) {
  res.setHeader('RateLimit-Limit', String(rate.limit))
  res.setHeader('RateLimit-Remaining', String(rate.remaining))
  res.setHeader('RateLimit-Reset', String(Math.ceil(rate.resetAt / 1000)))
}

function enforceLoginFailureLimit(req: express.Request, res: express.Response, next: express.NextFunction) {
  const result = loginLimiter.check(loginIdentity(req))
  if (result.rate) setLoginRateHeaders(res, result.rate)
  if (!result.blocked) {
    next()
    return
  }
  res.setHeader('Retry-After', String(result.retryAfterSeconds))
  res.status(429).json({
    error: `Too many failed login attempts. Please try again in ${Math.ceil(result.retryAfterSeconds / 60)} minute${result.retryAfterSeconds > 60 ? 's' : ''}.`,
  })
}

function rejectInvalidLogin(req: express.Request, res: express.Response) {
  setLoginRateHeaders(res, loginLimiter.recordFailure(loginIdentity(req)))
  res.status(401).json({ error: 'Invalid account, user, or password.' })
}

function clearLoginFailures(req: express.Request) {
  loginLimiter.recordSuccess(loginIdentity(req))
}

const sendRecoveryEmail = recoveryMailer()

/** Sign in, sign out and password recovery. */
export function registerAuthRoutes(app: Express) {
  app.get('/api/auth/session', (req, res) => {
    const { user } = sessionFromRequest(req)
    if (!user || user.status !== 'Active') {
      res.status(401).json({ user: null })
      return
    }
    res.json({ user })
  })

  app.post('/api/auth/login', enforceLoginFailureLimit, async (req, res) => {
    const account = typeof req.body?.account === 'string' ? req.body.account.trim() : ''
    const username = typeof req.body?.username === 'string' ? req.body.username.trim() : ''
    const password = typeof req.body?.password === 'string' ? req.body.password : ''
    if (!account || !username || !password) {
      res.status(400).json({ error: 'Account, user, and password are required.' })
      return
    }

    try {
      const accountKey = account.trim().toLowerCase().replace(/\s+/g, '_')

      // The Internal Admin control plane is intentionally separate from tenant workspaces.
      if (accountKey === INTERNAL_ADMIN_ACCOUNT_KEY) {
        if (!db || !(await platformAuthSchemaReady())) {
          res.status(409).json({
            error: 'Internal Admin authentication is not initialized. Run the latest account/security schema first.',
          })
          return
        }

        const { data: platformAccount, error: platformError } = await db
          .from('platform_users')
          .select(
            'id,account_key,username,password_hash,name,email,phone,status,must_change_password,last_login_at,deleted_at',
          )
          .ilike('account_key', INTERNAL_ADMIN_ACCOUNT_KEY)
          .ilike('username', username)
          .is('deleted_at', null)
          .maybeSingle()
        if (platformError) throw platformError
        if (!platformAccount || platformAccount.status === 'Disabled') {
          rejectInvalidLogin(req, res)
          return
        }

        let storedHash = String(platformAccount.password_hash || '')
        if (storedHash === PASSWORD_BOOTSTRAP_MARKER) {
          if (!bootstrapPasswordUsable(internalAdminBootstrapPassword)) {
            res.status(503).json({
              error:
                'Internal Admin requires a secure bootstrap password. Set INTERNAL_ADMIN_BOOTSTRAP_PASSWORD (12+ characters) in Render, then redeploy.',
            })
            return
          }
          if (!safeEqualText(password, internalAdminBootstrapPassword)) {
            rejectInvalidLogin(req, res)
            return
          }
          storedHash = await secureHashPassword(password)
          const { error: bootstrapError } = await db
            .from('platform_users')
            .update({ password_hash: storedHash, must_change_password: true, updated_at: new Date().toISOString() })
            .eq('id', platformAccount.id)
          if (bootstrapError) throw bootstrapError
        } else if (!(await verifyPassword(password, storedHash))) {
          rejectInvalidLogin(req, res)
          return
        } else if (!isBcryptHash(storedHash)) {
          storedHash = await secureHashPassword(password)
          const { error: upgradeError } = await db
            .from('platform_users')
            .update({ password_hash: storedHash, updated_at: new Date().toISOString() })
            .eq('id', platformAccount.id)
          if (upgradeError) throw upgradeError
        }

        const loggedInAt = new Date().toISOString()
        await db
          .from('platform_users')
          .update({ last_login_at: loggedInAt, updated_at: loggedInAt })
          .eq('id', platformAccount.id)
        const user = safePlatformUser({ ...platformAccount, password_hash: storedHash, last_login_at: loggedInAt })
        const token = sessions.create(user)
        clearLoginFailures(req)
        res.setHeader('Set-Cookie', sessionCookie(token, SESSION_MAX_AGE_SECONDS))
        res.json({ user, cloudConfigured: true, multiTenant: true })
        return
      }

      if (db && (await multiTenantSchemaReady())) {
        const organization = await organizationByLoginKey(account)
        if (!organization || organization.status !== 'Active') {
          rejectInvalidLogin(req, res)
          return
        }
        const { data: normalizedAccount, error: accountError } = await db
          .from('app_users')
          .select(
            'id,organization_id,username,password_hash,name,email,phone,role,modules,status,created_on,last_login_at,deleted_at',
          )
          .eq('organization_id', organization.id)
          .ilike('username', username)
          .is('deleted_at', null)
          .maybeSingle()
        if (accountError) throw accountError
        if (!normalizedAccount || normalizedAccount.status === 'Disabled') {
          rejectInvalidLogin(req, res)
          return
        }

        let storedHash = String(normalizedAccount.password_hash || '')
        if (storedHash === PASSWORD_BOOTSTRAP_MARKER) {
          const isBxiBootstrap = organization.id === BXI_CORE_ORG_ID && username.toLowerCase() === 'admin'
          if (!isBxiBootstrap || !bootstrapPasswordUsable(bxiCoreBootstrapPassword)) {
            res.status(503).json({
              error:
                'This bootstrap account requires a secure server password. Configure BXI_CORE_BOOTSTRAP_PASSWORD (12+ characters) and redeploy.',
            })
            return
          }
          if (!safeEqualText(password, bxiCoreBootstrapPassword)) {
            rejectInvalidLogin(req, res)
            return
          }
          storedHash = await secureHashPassword(password)
          const { error: bootstrapError } = await db
            .from('app_users')
            .update({ password_hash: storedHash, updated_at: new Date().toISOString() })
            .eq('id', normalizedAccount.id)
          if (bootstrapError) throw bootstrapError
          await updateTenantAccountSnapshot(organization.id, String(normalizedAccount.id), entry =>
            entry ? { ...entry, passwordHash: storedHash } : entry,
          )
        } else if (!(await verifyPassword(password, storedHash))) {
          rejectInvalidLogin(req, res)
          return
        } else if (!isBcryptHash(storedHash)) {
          storedHash = await secureHashPassword(password)
          const { error: upgradeError } = await db
            .from('app_users')
            .update({ password_hash: storedHash, updated_at: new Date().toISOString() })
            .eq('id', normalizedAccount.id)
          if (upgradeError) throw upgradeError
          await updateTenantAccountSnapshot(organization.id, String(normalizedAccount.id), entry =>
            entry ? { ...entry, passwordHash: storedHash } : entry,
          )
        }

        const loggedInAt = new Date().toISOString()
        await db
          .from('app_users')
          .update({ last_login_at: loggedInAt, updated_at: loggedInAt })
          .eq('id', normalizedAccount.id)
        const user = safeUser(
          { ...normalizedAccount, password_hash: storedHash, last_login_at: loggedInAt },
          organization,
        )
        const token = sessions.create(user)
        clearLoginFailures(req)
        // Read the workspace's access once so an Account Manager signs in straight to their four pages.
        await loadTenantState(organization.id).catch(() => undefined)
        res.setHeader('Set-Cookie', sessionCookie(token, SESSION_MAX_AGE_SECONDS))
        res.json({ user: withAccess(user), cloudConfigured: true, multiTenant: true })
        return
      }

      // Legacy BXI-Core compatibility. Existing SHA-256 hashes are accepted once and upgraded.
      if (![BXI_CORE_ORG_SLUG, BXI_CORE_ORG_NAME.toLowerCase()].includes(account.trim().toLowerCase())) {
        rejectInvalidLogin(req, res)
        return
      }
      const state = await loadLegacyTrackerState()
      const accounts = Array.isArray(state.data?.accounts) ? state.data.accounts : []
      const legacyAccount = accounts.find(
        (candidate: any) => String(candidate.username || '').toLowerCase() === username.toLowerCase(),
      )
      if (
        !legacyAccount ||
        legacyAccount.status === 'Disabled' ||
        !(await verifyPassword(password, legacyAccount.passwordHash))
      ) {
        rejectInvalidLogin(req, res)
        return
      }
      if (!isBcryptHash(legacyAccount.passwordHash)) {
        const upgradedHash = await secureHashPassword(password)
        const nextState = {
          ...state.data,
          accounts: accounts.map((entry: any) =>
            String(entry.id) === String(legacyAccount.id) ? { ...entry, passwordHash: upgradedHash } : entry,
          ),
        }
        await saveTenantState(BXI_CORE_ORG_ID, nextState, state.data)
        legacyAccount.passwordHash = upgradedHash
      }
      const legacyOrganization: OrganizationInfo = {
        id: BXI_CORE_ORG_ID,
        name: BXI_CORE_ORG_NAME,
        slug: BXI_CORE_ORG_SLUG,
        status: 'Active',
        enabledModules: [...ALL_MODULES],
      }
      const user = safeUser(legacyAccount, legacyOrganization)
      const token = sessions.create(user)
      clearLoginFailures(req)
      res.setHeader('Set-Cookie', sessionCookie(token, SESSION_MAX_AGE_SECONDS))
      res.json({ user, cloudConfigured: state.configured, multiTenant: false })
    } catch (error) {
      console.error('Login failed:', error)
      res.status(500).json({ error: 'Login failed.' })
    }
  })

  app.post('/api/auth/forgot-password', recoveryRequestLimiter, (req, res) => {
    const account = typeof req.body?.account === 'string' ? req.body.account.trim() : ''
    const username = typeof req.body?.username === 'string' ? req.body.username.trim() : ''
    const email = typeof req.body?.email === 'string' ? req.body.email.trim() : ''
    if (!account || account.length > 200 || !username || username.length > 200 || !validRecoveryEmail(email)) {
      return void res.status(400).json({ error: 'Enter your account, user, and registered email address.' })
    }
    if (!db || !sendRecoveryEmail) return void res.status(503).json({ error: recoveryUnavailable })
    // Respond before lookup/delivery so their timing cannot reveal registered accounts.
    res.json({ message: recoveryMessage })
    const database = db
    const sendEmail = sendRecoveryEmail
    void (async () => {
      const token = randomBytes(32).toString('base64url')
      const tokenHash = passwordHash(token)
      const { data, error } = await database.rpc('issue_password_reset_v7', {
        p_account: account,
        p_username: username,
        p_email: email,
        p_token_hash: tokenHash,
      })
      if (error) throw error
      if (!data) return
      try {
        if (!validRecoveryEmail(String(data.email))) throw new Error('Invalid recovery email')
        await sendEmail(String(data.email), String(data.account), token)
      } catch (error) {
        const { error: revokeError } = await database.from('password_reset_tokens').delete().eq('token_hash', tokenHash)
        if (revokeError) console.error('Could not revoke undelivered recovery token; check database availability.')
        throw error
      }
    })().catch((error: unknown) => {
      // Never log reset URLs, tokens, recipient addresses, or SMTP credentials.
      const code = String((error as { code?: string })?.code || 'DELIVERY_ERROR')
        .replace(/[^A-Z0-9_]/gi, '')
        .slice(0, 40)
      console.error(`Password recovery failed (${code}). Check SMTP settings and the database connection.`)
    })
  })

  app.post('/api/auth/reset-password', recoverySubmitLimiter, async (req, res) => {
    const token = typeof req.body?.token === 'string' ? req.body.token : ''
    const password = typeof req.body?.password === 'string' ? req.body.password : ''
    if (!/^[A-Za-z0-9_-]{43}$/.test(token))
      return void res.status(400).json({ error: 'This reset link is invalid or has expired. Request a new link.' })
    if (password.length < 8 || password.length > 128)
      return void res.status(400).json({ error: 'Use a password between 8 and 128 characters.' })
    if (!db) return void res.status(503).json({ error: recoveryUnavailable })
    try {
      const { data, error } = await db.rpc('redeem_password_reset_v7', {
        p_token_hash: passwordHash(token),
        p_password_hash: await secureHashPassword(password),
      })
      if (error) throw error
      if (!data)
        return void res.status(400).json({ error: 'This reset link is invalid or has expired. Request a new link.' })
      for (const [sessionToken, user] of sessions) {
        if (
          user.id === data.userId &&
          user.accountType === data.accountType &&
          (data.accountType === 'platform' || user.organizationId === data.organizationId)
        )
          sessions.delete(sessionToken)
      }
      const { token: browserSession } = sessionFromRequest(req)
      if (browserSession) sessions.delete(browserSession)
      res.setHeader('Set-Cookie', sessionCookie('', 0))
      res.json({ message: 'Your password has been reset. Sign in with your new password.' })
    } catch {
      console.error('Password reset could not be completed. Check database availability.')
      res.status(503).json({ error: recoveryUnavailable })
    }
  })

  app.post('/api/auth/logout', requireAuth, (req, res) => {
    const { token } = sessionFromRequest(req)
    if (token) sessions.delete(token)
    res.setHeader('Set-Cookie', sessionCookie('', 0))
    res.json({ ok: true })
  })
}
