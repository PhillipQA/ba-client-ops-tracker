import type express from 'express'
import type { Express } from 'express'
import { randomUUID } from 'node:crypto'
import { validRecoveryEmail } from '../auth/password-recovery-email'
import { recoverySubmitLimiter } from '../auth/rate-limits'
import { SEEDS_EXEMPT_NEEDS_SCHEMA, seedsExemptionsById } from '../auth/seeds-exemptions'
import {
  forgetSeedsExceptionSessionsOf,
  requireAuth,
  safeUser,
  secureHashPassword,
  sessions,
  type SessionUser,
  verifyPassword,
} from '../core/auth'
import { INTERNAL_ADMIN_ACCOUNT_KEY } from '../core/constants'
import { db } from '../core/database'
import {
  cleanModules,
  cleanSlug,
  loadTenantState,
  multiTenantSchemaReady,
  organizationById,
  platformAuthSchemaReady,
  sanitizedAccountRaw,
  saveTenantState,
  updateTenantAccountSnapshot,
  usernameExists,
} from '../core/tenant-state'
import { discordRuntimes } from '../integrations/discord'
import { requirePlatformAdmin } from './platform-auth'

/** The internal admin console: organisations, users and passwords. */
export function registerInternalAdminRoutes(app: Express) {
  app.get('/api/internal-admin/dashboard', requireAuth, requirePlatformAdmin, async (_req, res) => {
    if (!db || !(await multiTenantSchemaReady()) || !(await platformAuthSchemaReady()))
      return void res.status(409).json({
        error:
          'Internal Admin needs the account tables. Check the database connection; a new database needs database/schema.sql.',
      })
    try {
      const [{ data: organizations, error: orgError }, { data: users, error: userError }] = await Promise.all([
        db
          .from('organizations')
          .select('id,name,slug,status,enabled_modules,created_at')
          .is('deleted_at', null)
          .order('name'),
        db
          .from('app_users')
          .select(
            'id,organization_id,username,name,email,phone,role,modules,status,created_on,is_platform_admin,last_login_at',
          )
          .is('deleted_at', null)
          .order('name'),
      ])
      if (orgError) throw orgError
      if (userError) throw userError
      // Read on its own so the console still loads on a database older than schema v43 (then null).
      const seedsExemptions = await seedsExemptionsById(db)
      const userRows = users || []
      const organizationRows = (organizations || []).map((row: any) => {
        const scopedUsers = userRows.filter((user: any) => String(user.organization_id || '') === String(row.id))
        return {
          id: String(row.id),
          name: row.name || '',
          slug: row.slug || '',
          status: row.status === 'Suspended' ? 'Suspended' : 'Active',
          enabledModules: cleanModules(row.enabled_modules),
          createdAt: row.created_at || '',
          userCount: scopedUsers.length,
          activeUserCount: scopedUsers.filter((user: any) => user.status !== 'Disabled').length,
        }
      })
      res.json({
        organizations: organizationRows,
        users: userRows.map((user: any) => ({
          id: String(user.id),
          organizationId: String(user.organization_id || ''),
          username: user.username || '',
          name: user.name || '',
          email: user.email || '',
          phone: user.phone || '',
          role: user.role === 'Administrator' || user.role === 'Viewer' ? user.role : 'Contributor',
          modules: cleanModules(user.modules),
          status: user.status === 'Disabled' ? 'Disabled' : 'Active',
          isPlatformAdmin: Boolean(user.is_platform_admin),
          createdAt: user.created_on || '',
          lastLoginAt: user.last_login_at || undefined,
          seedsExempt: seedsExemptions?.get(String(user.id)) === true,
        })),
        seedsExemptReady: Boolean(seedsExemptions),
        totals: {
          organizations: organizationRows.length,
          activeOrganizations: organizationRows.filter((org: any) => org.status === 'Active').length,
          users: userRows.length,
          activeUsers: userRows.filter((user: any) => user.status !== 'Disabled').length,
        },
      })
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Could not load Internal Admin.' })
    }
  })

  app.post('/api/internal-admin/organizations', requireAuth, requirePlatformAdmin, async (req, res) => {
    if (!db || !(await multiTenantSchemaReady()) || !(await platformAuthSchemaReady()))
      return void res.status(409).json({ error: 'Run the multi-tenant and account-login schemas first.' })
    const name = String(req.body?.name || '').trim()
    const slug = cleanSlug(req.body?.slug || name)
    const enabledModules = cleanModules(req.body?.enabledModules)
    const administrator = req.body?.administrator || {}
    const username = String(administrator.username || '').trim()
    const password = String(administrator.password || '')
    if (!name || !slug || !username || !password)
      return void res
        .status(400)
        .json({ error: 'Organization name, slug, administrator username, and initial password are required.' })
    if (slug === 'internal-admin' || name.trim().toLowerCase().replace(/\s+/g, '_') === INTERNAL_ADMIN_ACCOUNT_KEY)
      return void res.status(400).json({ error: 'internal_admin is reserved for the BXI-Core control plane.' })
    if (password.length < 8)
      return void res.status(400).json({ error: 'Use an initial password with at least 8 characters.' })
    try {
      const { data: duplicateSlug } = await db
        .from('organizations')
        .select('id')
        .eq('slug', slug)
        .is('deleted_at', null)
        .maybeSingle()
      if (duplicateSlug) return void res.status(409).json({ error: 'That workspace slug is already in use.' })
      const organizationId = randomUUID()
      const userId = randomUUID()
      const createdAt = new Date().toISOString().slice(0, 10)
      const modules = enabledModules
      const account = {
        id: userId,
        username,
        passwordHash: await secureHashPassword(password),
        name: String(administrator.name || username).trim(),
        email: String(administrator.email || '').trim(),
        phone: String(administrator.phone || '').trim(),
        role: 'Administrator',
        modules,
        status: 'Active',
        createdAt,
        theme: 'default',
      }
      const { error: orgError } = await db
        .from('organizations')
        .insert({ id: organizationId, name, slug, status: 'Active', enabled_modules: modules })
      if (orgError) throw orgError
      const { error: userError } = await db.from('app_users').insert({
        id: userId,
        organization_id: organizationId,
        username,
        password_hash: account.passwordHash,
        name: account.name,
        email: account.email,
        phone: account.phone,
        role: 'Administrator',
        modules,
        status: 'Active',
        created_on: createdAt,
        raw_data: sanitizedAccountRaw(account),
        is_platform_admin: false,
      })
      if (userError) {
        await db.from('organizations').delete().eq('id', organizationId)
        throw userError
      }
      const initial = await loadTenantState(organizationId)
      await saveTenantState(organizationId, { ...initial.data, accounts: [account] }, initial.data)
      res.json({ organization: { id: organizationId, name, slug, status: 'Active', enabledModules: modules } })
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Could not create tenant account.' })
    }
  })

  app.patch(
    '/api/internal-admin/organizations/:organizationId',
    requireAuth,
    requirePlatformAdmin,
    async (req, res) => {
      if (!db) return void res.status(503).json({ error: 'Database is not configured.' })
      const organizationId = String(req.params.organizationId || '')
      try {
        const current = await organizationById(organizationId)
        if (!current) return void res.status(404).json({ error: 'Account was not found.' })
        const patch: any = { updated_at: new Date().toISOString() }
        if (typeof req.body?.name === 'string' && req.body.name.trim()) patch.name = req.body.name.trim()
        if (req.body?.status === 'Active' || req.body?.status === 'Suspended') {
          patch.status = req.body.status
        }
        if (Array.isArray(req.body?.enabledModules)) patch.enabled_modules = cleanModules(req.body.enabledModules)
        const { error } = await db.from('organizations').update(patch).eq('id', organizationId)
        if (error) throw error
        if (patch.enabled_modules) {
          const { data: orgUsers, error: orgUsersError } = await db
            .from('app_users')
            .select('id,role,modules')
            .eq('organization_id', organizationId)
            .is('deleted_at', null)
          if (orgUsersError) throw orgUsersError
          for (const orgUser of orgUsers || []) {
            const modules =
              orgUser.role === 'Administrator'
                ? patch.enabled_modules
                : cleanModules(orgUser.modules).filter(module => patch.enabled_modules.includes(module))
            await db.from('app_users').update({ modules, updated_at: new Date().toISOString() }).eq('id', orgUser.id)
            await updateTenantAccountSnapshot(organizationId, String(orgUser.id), account =>
              account ? { ...account, modules } : account,
            )
          }
        }
        const organization = await organizationById(organizationId)
        if (!organization) throw new Error('Could not reload the account.')
        if (organization.status !== 'Active') {
          const runtime = discordRuntimes.get(organizationId)
          discordRuntimes.delete(organizationId)
          if (runtime) await runtime.client.destroy()
        }
        for (const [token, sessionUser] of sessions.entries()) {
          if (sessionUser.organizationId !== organizationId) continue
          if (organization.status !== 'Active') {
            sessions.delete(token)
            continue
          }
          const { data: account } = await db.from('app_users').select('*').eq('id', sessionUser.id).maybeSingle()
          if (account) sessions.set(token, safeUser(account, organization))
        }
        res.json({ ok: true })
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : 'Could not update tenant account.' })
      }
    },
  )

  app.post(
    '/api/internal-admin/organizations/:organizationId/users',
    requireAuth,
    requirePlatformAdmin,
    async (req, res) => {
      if (!db) return void res.status(503).json({ error: 'Database is not configured.' })
      const organizationId = String(req.params.organizationId || '')
      const username = String(req.body?.username || '').trim()
      const password = String(req.body?.password || '')
      const role = req.body?.role === 'Administrator' || req.body?.role === 'Viewer' ? req.body.role : 'Contributor'
      if (!username || !password)
        return void res.status(400).json({ error: 'Username and initial password are required.' })
      if (password.length < 8)
        return void res.status(400).json({ error: 'Use an initial password with at least 8 characters.' })
      try {
        const organization = await organizationById(organizationId)
        if (!organization) return void res.status(404).json({ error: 'Account was not found.' })
        if (await usernameExists(organizationId, username))
          return void res.status(409).json({ error: 'That username is already used in this account.' })
        const requestedModules = cleanModules(req.body?.modules).filter(module =>
          organization.enabledModules.includes(module),
        )
        const modules = role === 'Administrator' ? organization.enabledModules : requestedModules
        const account = {
          id: randomUUID(),
          username,
          passwordHash: await secureHashPassword(password),
          name: String(req.body?.name || username).trim(),
          email: String(req.body?.email || '').trim(),
          phone: String(req.body?.phone || '').trim(),
          role,
          modules,
          status: 'Active',
          createdAt: new Date().toISOString().slice(0, 10),
          theme: 'default',
        }
        const { error } = await db.from('app_users').insert({
          id: account.id,
          organization_id: organizationId,
          username,
          password_hash: account.passwordHash,
          name: account.name,
          email: account.email,
          phone: account.phone,
          role,
          modules,
          status: 'Active',
          created_on: account.createdAt,
          raw_data: sanitizedAccountRaw(account),
          is_platform_admin: false,
        })
        if (error) throw error
        await updateTenantAccountSnapshot(organizationId, account.id, () => account)
        res.json({ user: sanitizedAccountRaw(account) })
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : 'Could not create user.' })
      }
    },
  )

  app.patch('/api/internal-admin/users/:userId', requireAuth, requirePlatformAdmin, async (req, res) => {
    if (!db) return void res.status(503).json({ error: 'Database is not configured.' })
    const userId = String(req.params.userId || '')
    try {
      const { data: existing, error: readError } = await db
        .from('app_users')
        .select('*')
        .eq('id', userId)
        .is('deleted_at', null)
        .maybeSingle()
      if (readError) throw readError
      if (!existing) return void res.status(404).json({ error: 'User was not found.' })
      const organization = await organizationById(existing.organization_id)
      if (!organization) return void res.status(404).json({ error: 'User workspace was not found.' })
      const patch: any = { updated_at: new Date().toISOString() }
      if (typeof req.body?.name === 'string') patch.name = req.body.name.trim()
      if (typeof req.body?.email === 'string') patch.email = req.body.email.trim()
      if (typeof req.body?.phone === 'string') patch.phone = req.body.phone.trim()
      if (req.body?.role === 'Administrator' || req.body?.role === 'Contributor' || req.body?.role === 'Viewer')
        patch.role = req.body.role
      if (req.body?.status === 'Active' || req.body?.status === 'Disabled') patch.status = req.body.status
      if (Array.isArray(req.body?.modules))
        patch.modules = cleanModules(req.body.modules).filter(module => organization.enabledModules.includes(module))
      // The Seeds exception: may sign in with a password when Seeds does not list them (never with Google).
      if (typeof req.body?.seedsExempt === 'boolean') {
        if (!('seeds_exempt' in existing)) return void res.status(409).json({ error: SEEDS_EXEMPT_NEEDS_SCHEMA })
        patch.seeds_exempt = req.body.seedsExempt
      }
      const nextRole = patch.role || existing.role
      if (nextRole === 'Administrator') patch.modules = organization.enabledModules
      const { error } = await db.from('app_users').update(patch).eq('id', userId)
      if (error) throw error
      // Without the exception, their signed-in sessions answer to Seeds again from the next request.
      if (patch.seeds_exempt === false || patch.status === 'Disabled') forgetSeedsExceptionSessionsOf(userId)
      const snapshotPatch: any = {}
      for (const [dbKey, appKey] of [
        ['name', 'name'],
        ['email', 'email'],
        ['phone', 'phone'],
        ['role', 'role'],
        ['status', 'status'],
        ['modules', 'modules'],
      ] as [string, string][])
        if (patch[dbKey] !== undefined) snapshotPatch[appKey] = patch[dbKey]
      await updateTenantAccountSnapshot(String(existing.organization_id), userId, account =>
        account ? { ...account, ...snapshotPatch } : account,
      )
      for (const [token, sessionUser] of sessions.entries()) {
        if (sessionUser.id !== userId) continue
        if (patch.status === 'Disabled') sessions.delete(token)
        else {
          const { data: refreshed } = await db.from('app_users').select('*').eq('id', userId).maybeSingle()
          if (refreshed) sessions.set(token, safeUser(refreshed, organization))
        }
      }
      res.json({ ok: true })
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Could not update user.' })
    }
  })

  app.post(
    '/api/internal-admin/recovery-email',
    requireAuth,
    requirePlatformAdmin,
    recoverySubmitLimiter,
    async (req, res) => {
      if (!db) return void res.status(503).json({ error: 'Account settings are unavailable.' })
      const user = (req as express.Request & { authUser: SessionUser }).authUser
      const email = typeof req.body?.email === 'string' ? req.body.email.trim() : ''
      const currentPassword = typeof req.body?.currentPassword === 'string' ? req.body.currentPassword : ''
      if (!validRecoveryEmail(email))
        return void res.status(400).json({ error: 'Enter a valid recovery email address.' })
      try {
        const { data, error } = await db
          .from('platform_users')
          .select('id,password_hash,status')
          .eq('id', user.id)
          .is('deleted_at', null)
          .maybeSingle()
        if (error) throw error
        if (!data || data.status !== 'Active' || !(await verifyPassword(currentPassword, data.password_hash)))
          return void res.status(401).json({ error: 'Current password is incorrect.' })
        const { data: updated, error: updateError } = await db
          .from('platform_users')
          .update({ email, updated_at: new Date().toISOString() })
          .eq('id', user.id)
          .eq('password_hash', data.password_hash)
          .eq('status', 'Active')
          .is('deleted_at', null)
          .select('id')
          .maybeSingle()
        if (updateError) throw updateError
        if (!updated) return void res.status(409).json({ error: 'Your account changed. Sign in and try again.' })
        for (const [token, sessionUser] of sessions) {
          if (sessionUser.id === user.id && sessionUser.accountType === 'platform')
            sessions.set(token, { ...sessionUser, email })
        }
        res.json({ ok: true, email })
      } catch {
        res.status(500).json({ error: 'Could not save your recovery email.' })
      }
    },
  )

  app.post('/api/internal-admin/password', requireAuth, requirePlatformAdmin, async (req, res) => {
    if (!db || !(await platformAuthSchemaReady()))
      return void res.status(409).json({
        error:
          'Internal Admin sign-in is not set up. Check the database connection; a new database needs database/schema.sql.',
      })
    const user = (req as express.Request & { authUser: SessionUser }).authUser
    const currentPassword = String(req.body?.currentPassword || '')
    const newPassword = String(req.body?.newPassword || '')
    if (newPassword.length < 8)
      return void res.status(400).json({ error: 'Use a new password with at least 8 characters.' })
    try {
      const { data: platformAccount, error: readError } = await db
        .from('platform_users')
        .select('id,password_hash')
        .eq('id', user.id)
        .is('deleted_at', null)
        .maybeSingle()
      if (readError) throw readError
      if (!platformAccount || !(await verifyPassword(currentPassword, platformAccount.password_hash)))
        return void res.status(401).json({ error: 'Current password is incorrect.' })
      const updatedAt = new Date().toISOString()
      const { error } = await db
        .from('platform_users')
        .update({
          password_hash: await secureHashPassword(newPassword),
          must_change_password: false,
          password_changed_at: updatedAt,
          updated_at: updatedAt,
        })
        .eq('id', user.id)
      if (error) throw error
      for (const [token, sessionUser] of sessions.entries()) {
        if (sessionUser.id === user.id && sessionUser.accountType === 'platform')
          sessions.set(token, { ...sessionUser, mustChangePassword: false })
      }
      res.json({ ok: true })
    } catch (error) {
      res
        .status(500)
        .json({ error: error instanceof Error ? error.message : 'Could not change Internal Admin password.' })
    }
  })

  app.post('/api/internal-admin/users/:userId/password', requireAuth, requirePlatformAdmin, async (req, res) => {
    if (!db) return void res.status(503).json({ error: 'Database is not configured.' })
    const userId = String(req.params.userId || '')
    const password = String(req.body?.password || '')
    if (password.length < 8) return void res.status(400).json({ error: 'Use a password with at least 8 characters.' })
    try {
      const { data: existing, error: readError } = await db
        .from('app_users')
        .select('id,organization_id')
        .eq('id', userId)
        .is('deleted_at', null)
        .maybeSingle()
      if (readError) throw readError
      if (!existing) return void res.status(404).json({ error: 'User was not found.' })
      const nextHash = await secureHashPassword(password)
      const { error } = await db
        .from('app_users')
        .update({ password_hash: nextHash, updated_at: new Date().toISOString() })
        .eq('id', userId)
      if (error) throw error
      await updateTenantAccountSnapshot(String(existing.organization_id), userId, account =>
        account ? { ...account, passwordHash: nextHash } : account,
      )
      for (const [token, sessionUser] of sessions.entries()) if (sessionUser.id === userId) sessions.delete(token)
      res.json({ ok: true })
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Could not reset password.' })
    }
  })
}
