import './core/env'
import { createDocHubService, registerDocHubRoutes, registerDocHubWebhook } from './integrations/dochub'
import { registerBrdRoutes } from './documents/brd-documents'
import { registerFsdRoutes } from './documents/fsd-documents'
import { registerTestCaseRoutes } from './documents/testcase-documents'
import { registerRtmAiRoutes } from './documents/rtm-ai'
import { registerSignoffRoutes } from './documents/signoff-documents'
import { registerAccountUsers } from './accounts/account-users'
import express from 'express'
import path from 'node:path'
import { registerStaticSite } from './platform/static-site'
import { requirePlatformAdmin } from './platform/platform-auth'
import { registerPlatformSettings } from './platform/platform-settings'
import { registerIntegrationRoutes } from './integrations/tenant-integrations'
import { registerAiAgentRoutes } from './ai/ai-agent-manager'
import { createServer as createViteServer } from 'vite'
import { dateKeyInTimeZone } from './services/follow-up-rollover'
import { reconcileNotifications } from './services/notification-engine'
import { registerGoogleCalendarRoutes } from './integrations/google-calendar'
import { registerCommunications } from './integrations/communications'
import { registerTrackerRoutes } from './trackers/trackers'
import { registerEmailTemplateRoutes } from './integrations/email-templates'
import { registerCustomReportRoutes } from './reports/custom-reports'
import { registerTrackerTemplateRoutes } from './trackers/tracker-templates'
import { authRequestDiagnostics, configureHttpServer } from './auth/auth-transport'
import { securityHeaders } from './auth/security-headers'
import { followUpTimeZone, isProduction, port, projectRoot } from './core/config'
import { supabaseAdmin } from './core/database'
import {
  bootstrapPasswordUsable,
  requireAuth,
  requireTenantWorkspace,
  safeUser,
  secureHashPassword,
  sessionFromRequest,
  sessions,
} from './core/auth'
import {
  authoritativeWorkEvents,
  commitTenantState,
  loadTenantState,
  normalizedSchemaStatus,
  onTenantCommitted,
  organizationById,
  verifyTenantUserPassword,
} from './core/tenant-state'
import { aiAgents, integrations } from './core/services'
import {
  bxiCoreBootstrapPassword,
  defaultTaskSettings,
  internalAdminBootstrapPassword,
  openTaskStatus,
} from './core/constants'
import {
  discordRuntimes,
  discordStatusPayload,
  discordUserWindows,
  reconcileDiscord,
  reconnectDiscord,
  registerDiscordRoutes,
  setDiscordCapture,
} from './integrations/discord'
import { loginLimiter } from './auth/rate-limits'
import { registerAuthRoutes } from './auth/auth-routes'
import { registerStoreRoutes } from './workspace/store-routes'
import { registerInternalAdminRoutes } from './platform/internal-admin'
import { registerAssistantRoutes } from './ai/assistant-routes'
import { registerDrfRoutes } from './documents/drf-documents'
import { registerTaskRoutes } from './tasks/task-routes'

const app = express()

// Render and similar hosts terminate TLS at a trusted reverse proxy.
app.set('trust proxy', 1)
app.disable('x-powered-by')
app.use(securityHeaders({ production: isProduction }))

app.use('/api/auth', authRequestDiagnostics)

const docHubDeps: Parameters<typeof createDocHubService>[0] = {
  db: supabaseAdmin,
  requireAuth,
  requireTenant: requireTenantWorkspace,
  organizationById,
  load: loadTenantState,
  commit: commitTenantState,
}
const docHubService = createDocHubService(docHubDeps)
registerDocHubWebhook(app, docHubDeps, docHubService)
app.use(express.json({ limit: '24mb' }))

registerAuthRoutes(app)

registerStoreRoutes(app)

registerInternalAdminRoutes(app)

registerAssistantRoutes(app)

registerBrdRoutes(app, {
  db: supabaseAdmin,
  requireAuth,
  requireTenant: requireTenantWorkspace,
  aiAgents,
  templatePath: path.join(projectRoot, 'templates', 'brd-template.docx'),
})

registerFsdRoutes(app, {
  db: supabaseAdmin,
  requireAuth,
  requireTenant: requireTenantWorkspace,
  aiAgents,
  logoPath: path.join(projectRoot, 'templates', 'fsd-logo.png'),
})

registerTestCaseRoutes(app, { requireAuth, requireTenant: requireTenantWorkspace, aiAgents })
registerRtmAiRoutes(app, { requireAuth, requireTenant: requireTenantWorkspace, aiAgents, load: loadTenantState })
// Connected Google Sheets read as the person who connected them, through the same Google sign-in as Gmail (registered below).
const trackers = registerTrackerRoutes(app, {
  db: supabaseAdmin,
  requireAuth,
  requireTenant: requireTenantWorkspace,
  load: loadTenantState,
  googleAccess: (tenantId, userId) => communications.googleAccess(tenantId, userId),
  // Looked up when a Sheet is made: the Drive is set up further down, with the rest of communications.
  drive: {
    ready: tenantId => communications.driveFiler.ready(tenantId),
    sheet: job => {
      const make = communications.driveFiler.sheet
      if (!make) throw new Error('Google Drive is not available.')
      return make(job)
    },
  },
})
// A completed or reopened task updates the tracker rows linked to it, and their Sheet when the column comes from one.
onTenantCommitted((tenantId, before, after, actor) => trackers.onWorkspaceSaved(tenantId, before, after, actor))
registerEmailTemplateRoutes(app, { db: supabaseAdmin, requireAuth, requireTenant: requireTenantWorkspace })
registerCustomReportRoutes(app, { db: supabaseAdmin, requireAuth, requireTenant: requireTenantWorkspace })
registerTrackerTemplateRoutes(app, { db: supabaseAdmin, requireAuth, requireTenant: requireTenantWorkspace })

registerSignoffRoutes(app, {
  db: supabaseAdmin,
  requireAuth,
  requireTenant: requireTenantWorkspace,
  templatePath: path.join(projectRoot, 'templates', 'signoff-template.docx'),
  goLiveTemplatePath: path.join(projectRoot, 'templates', 'golive-template.docx'),
  templatePaths: {
    uat: path.join(projectRoot, 'templates', 'uat-template.docx'),
    uatdeploy: path.join(projectRoot, 'templates', 'uatdeploy-template.docx'),
    training: path.join(projectRoot, 'templates', 'training-template.docx'),
  },
})

registerDrfRoutes(app)

registerDiscordRoutes(app)

registerAccountUsers(app, {
  requireAuth,
  requireTenant: requireTenantWorkspace,
  organizationById,
  load: loadTenantState,
  commit: commitTenantState,
  hashPassword: secureHashPassword,
  verifyCurrentPassword: verifyTenantUserPassword,
  refreshSessions(organizationId, account, organization, passwordChanged) {
    for (const [token, session] of sessions) {
      if (session.organizationId !== organizationId || session.id !== account.id) continue
      if (account.status !== 'Active' || passwordChanged) sessions.delete(token)
      else sessions.set(token, safeUser(account, organization))
    }
  },
})
registerPlatformSettings(app, {
  db: supabaseAdmin,
  requireAuth,
  requirePlatformAdmin,
  organizationById,
  loadTenantState,
  normalizedSchemaStatus,
  defaultTaskSettings,
  commitTenantState,
  integrations,
})
registerDocHubRoutes(app, docHubDeps, docHubService)
registerIntegrationRoutes(app, {
  db: supabaseAdmin,
  requireAuth,
  requireTenant: requireTenantWorkspace,
  organizationById,
  store: integrations,
  reconnect: reconnectDiscord,
  status: discordStatusPayload,
})
registerAiAgentRoutes(app, { requireAuth, requireTenant: requireTenantWorkspace, organizationById, manager: aiAgents })
registerGoogleCalendarRoutes(app, {
  db: supabaseAdmin,
  requireAuth,
  requireTenant: requireTenantWorkspace,
  requirePlatformAdmin,
  organizationById,
  sessionFromRequest,
  sessionByToken: token => sessions.get(token) || null,
})

const communications = registerCommunications(app, {
  db: supabaseAdmin,
  requireAuth,
  requireTenant: requireTenantWorkspace,
  sessionFromRequest,
  sessionByToken: token => sessions.get(token) || null,
  requirePlatformAdmin,
  organizationById,
  load: loadTenantState,
  commit: (id, next, user, reason, current) => {
    const workEvents = authoritativeWorkEvents(current, next, user)
    const priorIds = new Set(
      (Array.isArray(current.workEvents) ? current.workEvents : []).map((event: any) => String(event.id)),
    )
    const newEventIds = workEvents
      .filter((event: any) => !priorIds.has(String(event.id)))
      .map((event: any) => String(event.id))
    const notified = reconcileNotifications(
      { ...next, workEvents },
      { today: dateKeyInTimeZone(new Date(), followUpTimeZone), newEventIds },
    ).state
    return commitTenantState(id, notified, user, reason, current)
  },
  openStatus: openTaskStatus,
})

// Fully signed DocHub documents are filed into the shared Google Drive by the same filer.
docHubDeps.driveFiler = communications.driveFiler
// Discord messages are saved through the same communications store.
setDiscordCapture((message, organizationId) => communications.captureDiscord(message, organizationId))

registerTaskRoutes(app)

if (!isProduction) {
  const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' })
  app.use(vite.middlewares)
} else {
  const dist = path.join(projectRoot, 'dist')
  registerStaticSite(app, dist)
}

const server = app.listen(port, () => {
  console.log(`BA Client Ops Tracker running on http://localhost:${port}`)
  console.log(`HTTP timeouts: keepAlive=${server.keepAliveTimeout}ms, headers=${server.headersTimeout}ms`)
  if (isProduction && !bootstrapPasswordUsable(internalAdminBootstrapPassword)) {
    console.warn(
      'SECURITY: INTERNAL_ADMIN_BOOTSTRAP_PASSWORD is not configured with 12+ characters. It is required only while the Internal Admin account is in bootstrap state.',
    )
  }
  if (isProduction && !bootstrapPasswordUsable(bxiCoreBootstrapPassword)) {
    console.warn(
      'SECURITY: BXI_CORE_BOOTSTRAP_PASSWORD is not configured with 12+ characters. It is required only while the initial BXI-Core Admin account is in bootstrap state.',
    )
  }
  void reconcileDiscord()
})
configureHttpServer(server)

// Expired sessions and old login-failure counters are dropped even if nobody presents them again.
const housekeepingTimer = setInterval(() => {
  sessions.prune()
  loginLimiter.prune()
}, 5 * 60_000)
housekeepingTimer.unref()

const discordTimer = setInterval(() => {
  const now = Date.now()
  for (const [id, value] of discordUserWindows) if (now - value.startedAt > 60000) discordUserWindows.delete(id)
}, 30000)
discordTimer.unref()
process.on('SIGTERM', () => {
  clearInterval(discordTimer)
  for (const runtime of discordRuntimes.values()) void runtime.client.destroy()
  process.exit(0)
})
