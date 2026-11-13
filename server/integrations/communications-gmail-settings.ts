/**
 * Routes for the account's Gmail app settings (Administrators and Internal Admin).
 */
import { randomUUID } from 'node:crypto'
import type { Express } from 'express'
import { IntegrationError, encryptionKey, decryptSecret, encryptSecret } from './tenant-integrations'
import {
  CALLBACK,
  type CommunicationsDeps,
  type GmailCredentials,
  origin,
  validateCredentials,
} from './communications-common'
import type { CommunicationsCore } from './communications-core'

export function gmailSettingsRoutes(app: Express, deps: CommunicationsDeps, comms: CommunicationsCore) {
  const { wrap, account, saveAccount, auth, accountGate, current } = comms
  app.get(
    '/api/internal-admin/organizations/:organizationId/gmail',
    deps.requireAuth,
    deps.requirePlatformAdmin,
    wrap(async (req, res) => {
      const id = String(req.params.organizationId)
      if (!(await deps.organizationById(id))) throw new IntegrationError('Account not found.', 404)
      const row = await account(id)
      res.json({ enabled: Boolean(row?.platform_enabled), configured: Boolean(row?.encrypted_config) })
    }),
  )
  app.put(
    '/api/internal-admin/organizations/:organizationId/gmail',
    deps.requireAuth,
    deps.requirePlatformAdmin,
    wrap(async (req, res) => {
      const id = String(req.params.organizationId)
      if (!(await deps.organizationById(id))) throw new IntegrationError('Account not found.', 404)
      if (typeof req.body?.enabled !== 'boolean') throw new IntegrationError('Specify whether Gmail is enabled.')
      await saveAccount(id, { platform_enabled: req.body.enabled })
      res.json({ ok: true })
    }),
  )
  app.get(
    '/api/account/gmail',
    ...auth,
    accountGate,
    wrap(async (req, res) => {
      const user = current(req),
        row = await account(user.organizationId)
      let encryptionReady = true
      try {
        encryptionKey()
      } catch {
        encryptionReady = false
      }
      const credentials =
        row?.encrypted_config && encryptionReady
          ? (JSON.parse(decryptSecret(row.encrypted_config, user.organizationId, 'gmail-oauth')) as GmailCredentials)
          : null
      res.json({
        platformEnabled: Boolean(row?.platform_enabled),
        configured: Boolean(row?.encrypted_config),
        enabled: Boolean(row?.account_enabled),
        encryptionReady,
        clientId: credentials?.clientId || '',
        redirectUri: credentials?.redirectUri || '',
        expectedRedirectUri: `${origin(req)}${CALLBACK}`,
      })
    }),
  )
  app.put(
    '/api/account/gmail',
    ...auth,
    accountGate,
    wrap(async (req, res) => {
      if (typeof req.body?.enabled !== 'boolean')
        throw new IntegrationError('Specify whether Gmail is enabled for this account.')
      const user = current(req),
        previous = await account(user.organizationId)
      if (!previous?.platform_enabled)
        throw new IntegrationError('Internal Admin must enable Gmail for this account first.', 403)
      const replacing = Boolean(req.body?.oauthJson || req.body?.clientId || req.body?.clientSecret)
      if (!replacing && !previous.encrypted_config)
        throw new IntegrationError('Upload a Google Web OAuth JSON file or enter both credentials.')
      const patch: any = { account_enabled: req.body.enabled }
      if (replacing) {
        const credentials = validateCredentials(req.body, origin(req))
        patch.encrypted_config = encryptSecret(JSON.stringify(credentials), user.organizationId, 'gmail-oauth')
        patch.revision = randomUUID()
      }
      await saveAccount(user.organizationId, patch)
      res.json({ ok: true, reconnectRequired: replacing })
    }),
  )
  app.delete(
    '/api/account/gmail',
    ...auth,
    accountGate,
    wrap(async (req, res) => {
      const user = current(req)
      await saveAccount(user.organizationId, { encrypted_config: null, account_enabled: false, revision: randomUUID() })
      res.json({ ok: true })
    }),
  )
}
