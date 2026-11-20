import { registerGitlab } from './gitlab'
import { registerGithub } from './github'
import { registerGitMappings } from './git-mappings'
import { registerOutbound } from './gmail-outbound'
import type { Express } from 'express'
import { type CommunicationsDeps, google, oauthStates } from './communications-common'
import { communicationsCore } from './communications-core'
import { gmailSettingsRoutes } from './communications-gmail-settings'
import { messageRoutes } from './communications-messages'
import { messageTaskRoutes } from './communications-tasks'
import { gmailRoutes } from './communications-gmail'
export {
  UNREAD_SOURCES,
  SHEETS_WRITE_SCOPE,
  SHEETS_READ_SCOPE,
  DRIVE_READ_SCOPE,
  DRIVE_LIST_SCOPE,
} from './communications-common'

export function registerCommunications(app: Express, deps: CommunicationsDeps) {
  const comms = communicationsCore(app, deps)
  gmailSettingsRoutes(app, deps, comms)
  messageRoutes(app, deps, comms)
  messageTaskRoutes(app, deps, comms)
  gmailRoutes(app, deps, comms)
  const {
    db,
    auth,
    guard,
    gmailGate,
    wrap,
    current,
    settings,
    activeAccount,
    accessGrant,
    own,
    createTaskInOrder,
    drive,
    grantFor,
  } = comms
  // Sending email from the tracker: composer status and the send call. Needs Drive's file lookup for attachments.
  registerOutbound(app, {
    db,
    auth,
    guard,
    gmailGate,
    wrap,
    current,
    google,
    settings,
    activeAccount,
    accessGrant,
    own,
    load: deps.load,
    commit: deps.commit,
    inOrder: createTaskInOrder,
    driveFile: drive.taskFile,
  })
  registerGithub(app, {
    db,
    requireAuth: deps.requireAuth,
    requireTenant: deps.requireTenant,
    guard,
    load: deps.load,
    commit: deps.commit,
    openStatus: deps.openStatus,
  })
  registerGitlab(app, {
    db,
    requireAuth: deps.requireAuth,
    requireTenant: deps.requireTenant,
    guard,
    load: deps.load,
    commit: deps.commit,
    openStatus: deps.openStatus,
  })
  // GIT Tracker: which Client and Project each repository's tickets belong to, for the whole workspace.
  registerGitMappings(app, { db, requireAuth: deps.requireAuth, requireTenant: deps.requireTenant, load: deps.load })
  const timer = setInterval(() => {
    const now = Date.now()
    for (const [key, value] of oauthStates) if (value.expires < now) oauthStates.delete(key)
  }, 60000)
  timer.unref()
  return {
    /** A Google access token for one person, and the permissions it carries. Connected trackers read Sheets with it. */
    googleAccess: grantFor,
    /** Files a document into the shared Google Drive; used by DocHub when a signature completes. */
    driveFiler: drive.filer,
    /** One person's own latest emails that are not archived, newest first: what the BA assistant may read for them. */
    async recentEmails(tenantId: string, userId: string) {
      const { data, error } = await db
        .from('user_communications')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('owner_user_id', userId)
        .eq('source', 'Gmail')
        .neq('status', 'Archived')
        .order('received_at', { ascending: false })
        .limit(25)
      if (error) throw error
      return (data || []) as any[]
    },
    /**
     * The person's own Gmail and Discord messages received since a time, newest first, for the morning brief (which
     * works out the conversations still waiting on them). Only the fields it needs; at most 400.
     */
    async waitingEmails(tenantId: string, userId: string, since: string) {
      const { data, error } = await db
        .from('user_communications')
        .select('id,source,thread_id,subject,sender,status,read_at,received_at,source_labels')
        .eq('tenant_id', tenantId)
        .eq('owner_user_id', userId)
        .in('source', ['Gmail', 'Discord'])
        .neq('status', 'Archived')
        .gte('received_at', since)
        .order('received_at', { ascending: false })
        .limit(400)
      if (error) throw error
      return (data || []) as any[]
    },
    /** One email, only when it belongs to that person. */
    async emailFor(tenantId: string, userId: string, id: string) {
      const { data, error } = await db
        .from('user_communications')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('owner_user_id', userId)
        .eq('id', id)
        .maybeSingle()
      if (error) throw error
      return (data as any) || null
    },
    async captureDiscord(message: any, tenantId: string) {
      const ids = [...new Set((message.mentions?.users ? [...message.mentions.users.keys()] : []) as string[])]
      const { data: linked, error } = await db
        .from('user_communication_settings')
        .select('user_id,discord_user_id,discord_capture_mentions')
        .eq('tenant_id', tenantId)
        .in('discord_user_id', ids.length ? ids : ['0'])
      if (error) throw error
      const recipients = (linked || []).filter(
        (x: any) => x.discord_capture_mentions && ids.includes(x.discord_user_id),
      )
      // A bot DM routes only when the sender has linked their Discord identity.
      if (!message.guildId) {
        const { data: sender, error: dmError } = await db
          .from('user_communication_settings')
          .select('user_id')
          .eq('tenant_id', tenantId)
          .eq('discord_user_id', String(message.author.id))
        if (dmError) throw dmError
        recipients.push(...(sender || []))
      }
      let count = 0
      for (const recipient of new Map<string, any>(recipients.map((x: any) => [String(x.user_id), x])).values()) {
        const { error: writeError } = await db.from('user_communications').insert({
          tenant_id: tenantId,
          owner_user_id: recipient.user_id,
          source: 'Discord',
          external_id: String(message.id),
          thread_id: String(
            message.guildId
              ? message.channel?.isThread?.()
                ? message.channelId
                : message.reference?.messageId || message.id
              : message.channelId || '',
          ),
          subject: message.guildId ? `Mention in #${message.channel?.name || 'channel'}` : 'Bot direct message',
          body: String(message.content || '').slice(0, 30000),
          sender: String(message.author?.globalName || message.author?.username || 'Discord user'),
          received_at: new Date(message.createdTimestamp || Date.now()).toISOString(),
        })
        if (writeError && writeError.code !== '23505') throw writeError
        if (!writeError) count++
      }
      return count
    },
  }
}
