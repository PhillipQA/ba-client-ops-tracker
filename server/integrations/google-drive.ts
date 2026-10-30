import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { Express, Request, Response, NextFunction } from 'express'
import { decryptSecret, encryptSecret, IntegrationError } from './tenant-integrations'
import { archivedWorkReason, LifecycleError } from '../../src/features/tasks/lifecycle'
import { attachmentContentType } from './gmail-content'

/**
 * One shared Google Drive per account. An account administrator connects it with
 * the account's existing Gmail OAuth client. Users save Gmail attachments into
 * <root>/<Client>/<Project>/<Task>/<Subtask>. File contents pass through memory only;
 * the database keeps the encrypted connection and the folder id used for each record.
 * Every call allows shared drives, so the root folder keeps working if it is moved into one.
 */
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
export const DRIVE_ROOT_NAME = 'BA Client Ops Tracker'
const FOLDER = 'application/vnd.google-apps.folder'
const SPREADSHEET = 'application/vnd.google-apps.spreadsheet'
const DRIVE = 'https://www.googleapis.com/drive/v3'
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3'
const COOKIE = 'ba_drive_oauth'
const TABLE = 'tenant_drive_accounts'
const KIND = 'drive-refresh' as const
const MIGRATION = 'Apply database migration schema-v23-drive-attachments.sql, then retry.'
const MAX_FILES_PER_TASK = 200

type Middleware = (req: Request, res: Response, next: NextFunction) => any
export type DriveTarget = {
  id: string
  title: string
  kind: 'Task' | 'Subtask'
  parentTaskId?: string
  clientName: string
  projectName: string
}
export type DriveFolderStep = { key: string; name: string }
export type TaskDriveFile = {
  id: string
  name: string
  url: string
  mimeType: string
  size: number
  savedAt: string
  savedBy: string
  savedByName: string
  source?: 'gmail' | 'generated' | 'dochub'
}

/** Drive allows almost any name; strip control characters and keep it readable. */
export function driveName(value: unknown, fallback = 'Untitled') {
  const clean = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
  return clean || fallback
}

/** Every task ever created from a message: the private list, plus the older single badge. */
export function linkedTaskIds(message: any): string[] {
  const ids = [...(Array.isArray(message?.linked_task_ids) ? message.linked_task_ids : []), message?.linked_task_id]
  return [...new Set(ids.filter((id: unknown): id is string => typeof id === 'string' && id.length > 0))]
}

/** Tasks the attachment may be filed under: tasks made from the message and their subtasks, never archived or closed work. */
export function driveTargets(state: any, taskIds: string[]): DriveTarget[] {
  const items: any[] = Array.isArray(state?.items) ? state.items : []
  const byId = new Map(items.map(item => [String(item?.id), item]))
  const name = (list: any[] | undefined, id?: string) => (list || []).find((x: any) => x.id === id)?.name || ''
  const target = (item: any): DriveTarget => ({
    id: String(item.id),
    title: driveName(item.title),
    kind: item.parentTaskId ? 'Subtask' : 'Task',
    ...(item.parentTaskId ? { parentTaskId: String(item.parentTaskId) } : {}),
    clientName: name(state?.clients, item.clientId),
    projectName: name(state?.projects, item.projectId),
  })
  // Closed or resolved work is not offered, by the account's own task statuses (Resolved and Closed when none are set).
  const statuses: any[] = Array.isArray(state?.taskSettings?.statuses) ? state.taskSettings.statuses : []
  const closed = (status: unknown) => {
    const known = statuses.find((entry: any) => entry?.label === status)
    return known ? Boolean(known.closed) : status === 'Resolved' || status === 'Closed'
  }
  const usable = (item: any) => item && !archivedWorkReason(state, item) && !closed(item.status)
  const seen = new Set<string>(),
    result: DriveTarget[] = []
  const add = (item: any) => {
    if (usable(item) && !seen.has(String(item.id))) {
      seen.add(String(item.id))
      result.push(target(item))
    }
  }
  for (const id of taskIds) {
    const item = byId.get(id)
    if (!item) continue
    add(item)
    if (!item.parentTaskId)
      items
        .filter(child => child?.parentTaskId === item.id)
        .sort((a, b) => (a.subtaskOrder ?? 0) - (b.subtaskOrder ?? 0))
        .forEach(add)
  }
  return result
}

/** Folders from the root down to the task: Client / Project / Task / Subtask. Keys use ids so renames keep the same folder. */
export function driveFolderPath(state: any, taskId: string): DriveFolderStep[] {
  const items: any[] = Array.isArray(state?.items) ? state.items : []
  const task = items.find(item => item?.id === taskId)
  if (!task) throw new IntegrationError('Task not found.', 404)
  const parent = task.parentTaskId ? items.find(item => item?.id === task.parentTaskId) : undefined
  const owner = parent || task
  const clientId = String(owner.clientId || 'none'),
    projectId = String(owner.projectId || 'none')
  const client = (state?.clients || []).find((x: any) => x.id === owner.clientId)
  const project = (state?.projects || []).find((x: any) => x.id === owner.projectId)
  return [
    { key: `client:${clientId}`, name: driveName(client?.name, 'No client') },
    { key: `project:${clientId}:${projectId}`, name: driveName(project?.name, 'No project') },
    ...(parent ? [{ key: `task:${parent.id}`, name: driveName(parent.title) }] : []),
    { key: `task:${task.id}`, name: driveName(task.title) },
  ]
}

/** Folders for a file that belongs to a client or project but to no task: Client / Project. Same keys as task paths, so the folders are shared. */
export function driveContextPath(state: any, clientId?: string, projectId?: string): DriveFolderStep[] {
  const client = (state?.clients || []).find((x: any) => x.id === clientId)
  const project = (state?.projects || []).find((x: any) => x.id === projectId)
  if (!clientId) throw new IntegrationError('Link a task or choose a client so the file has a Drive folder.', 409)
  return [
    { key: `client:${clientId}`, name: driveName(client?.name, 'No client') },
    ...(projectId ? [{ key: `project:${clientId}:${projectId}`, name: driveName(project?.name, 'No project') }] : []),
  ]
}

/**
 * Folders for a Google Sheet made from a tracker: Client / Project, the same folders as attachments. A tracker with
 * several clients goes under its first; one with no client under "No client".
 */
export function driveSheetPath(state: any, clientId?: string, projectId?: string): DriveFolderStep[] {
  if (clientId) return driveContextPath(state, clientId, projectId)
  const project = (state?.projects || []).find((x: any) => x.id === projectId)
  return [
    { key: 'client:none', name: 'No client' },
    ...(projectId ? [{ key: `project:none:${projectId}`, name: driveName(project?.name, 'No project') }] : []),
  ]
}

export function driveFileUrl(id: string) {
  return `https://drive.google.com/file/d/${encodeURIComponent(id)}/view`
}
export function driveFolderUrl(id: string) {
  return `https://drive.google.com/drive/folders/${encodeURIComponent(id)}`
}

/** Thin Drive REST client. Errors keep the upstream status so callers can recover from deleted folders. */
export function driveClient(token: string) {
  const call = async (url: string, init: RequestInit = {}, timeout = 30000) => {
    const response = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) },
      redirect: 'error',
      signal: AbortSignal.timeout(timeout),
    })
    const text = await response.text()
    let data: any = {}
    try {
      data = text ? JSON.parse(text) : {}
    } catch {
      data = {}
    }
    if (!response.ok) {
      const message = String(data.error?.message || 'Google Drive request failed.')
      const status =
        response.status === 429 || (response.status === 403 && /rate.?limit|quota/i.test(message)) ? 429 : 502
      throw Object.assign(
        new IntegrationError(
          status === 429 ? 'Google Drive is busy. Wait a minute, then try again.' : `Google Drive: ${message}`,
          status,
        ),
        { upstreamStatus: response.status },
      )
    }
    return { data, response }
  }
  return {
    async createFolder(name: string, parentId?: string) {
      const { data } = await call(`${DRIVE}/files?fields=id&supportsAllDrives=true`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, mimeType: FOLDER, ...(parentId ? { parents: [parentId] } : {}) }),
      })
      if (!data.id) throw new IntegrationError('Google Drive did not return the new folder.', 502)
      return String(data.id)
    },
    /** A folder that still exists (not trashed), renamed to match the record if needed. Null when it is gone. */
    async existingFolder(id: string, name: string) {
      try {
        const { data } = await call(
          `${DRIVE}/files/${encodeURIComponent(id)}?fields=id,name,trashed,mimeType&supportsAllDrives=true`,
        )
        if (data.trashed || data.mimeType !== FOLDER) return null
        if (data.name !== name)
          await call(`${DRIVE}/files/${encodeURIComponent(id)}?fields=id&supportsAllDrives=true`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
          })
        return id
      } catch (error) {
        if ((error as any)?.upstreamStatus === 404) return null
        throw error
      }
    },
    /** File bytes, refused above maxBytes. Never stored by the app. */
    async download(id: string, maxBytes: number) {
      let response: Response
      try {
        response = await fetch(`${DRIVE}/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`, {
          headers: { Authorization: `Bearer ${token}` },
          redirect: 'error',
          signal: AbortSignal.timeout(60000),
        })
      } catch {
        throw new IntegrationError('Google Drive could not be reached. Try again.', 502)
      }
      if (response.status === 404)
        throw new IntegrationError(
          'This file is no longer in Google Drive. It may have been deleted or moved to the trash.',
          404,
        )
      if (!response.ok)
        throw new IntegrationError('Google Drive could not provide this file.', response.status === 429 ? 429 : 502)
      if (Number(response.headers.get('content-length') || 0) > maxBytes)
        throw new IntegrationError('This file is too large.', 413)
      const bytes = Buffer.from(await response.arrayBuffer())
      if (!bytes.length || bytes.length > maxBytes)
        throw new IntegrationError(bytes.length ? 'This file is too large.' : 'This file is empty.', 413)
      return bytes
    },
    /** An empty Google Sheet in a folder. */
    async createSheet(name: string, parentId: string) {
      const { data } = await call(`${DRIVE}/files?fields=id&supportsAllDrives=true`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, mimeType: SPREADSHEET, parents: [parentId] }),
      })
      if (!data.id) throw new IntegrationError('Google Drive did not return the new Sheet.', 502)
      return String(data.id)
    },
    /** Lets one person edit a file, without an email from Google. */
    async shareWith(id: string, email: string) {
      await call(
        `${DRIVE}/files/${encodeURIComponent(id)}/permissions?fields=id&supportsAllDrives=true&sendNotificationEmail=false`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: 'writer', type: 'user', emailAddress: email }),
        },
      )
    },
    async upload(parentId: string, name: string, mimeType: string, file: Buffer) {
      const { response } = await call(`${UPLOAD}/files?uploadType=resumable&fields=id&supportsAllDrives=true`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': mimeType,
          'X-Upload-Content-Length': String(file.length),
        },
        body: JSON.stringify({ name, parents: [parentId] }),
      })
      const session = response.headers.get('location') || ''
      if (!session.startsWith(`${UPLOAD}/files`))
        throw new IntegrationError('Google Drive did not start the upload.', 502)
      const { data } = await call(
        session,
        { method: 'PUT', headers: { 'Content-Type': mimeType }, body: new Uint8Array(file) },
        120000,
      )
      if (!data.id) throw new IntegrationError('Google Drive did not return the saved file.', 502)
      return String(data.id)
    },
  }
}
type DriveClient = ReturnType<typeof driveClient>

/** Resolve or create each folder on the path. Returns the task folder and the updated map; a deleted folder is recreated. */
export async function ensureDrivePath(
  drive: DriveClient,
  rootId: string,
  folders: Record<string, string>,
  path: DriveFolderStep[],
) {
  const map = { ...folders }
  let parent = rootId
  for (const step of path) {
    const known = map[step.key]
    const id =
      (known && (await drive.existingFolder(known, step.name))) || (await drive.createFolder(step.name, parent))
    map[step.key] = id
    parent = id
  }
  return { folderId: parent, folders: map }
}

export type FileJob = {
  tenantId: string
  name: string
  mimeType: string
  bytes: Buffer
  taskId?: string
  clientId?: string
  projectId?: string
  user: { id: string; name: string } | null
  commit?: (id: string, next: any, user: any, source: string, current: any) => Promise<any>
  source: 'gmail' | 'generated' | 'dochub'
}
export type FileResult = { file: TaskDriveFile; path: string[]; task?: any; duplicate: boolean }
export type SheetJob = {
  tenantId: string
  title: string
  clientId?: string
  projectId?: string
  /** The Google account that will fill and sync the Sheet; it is made an editor. */
  editorEmail: string
}
export type DriveFiler = {
  ready: (tenantId: string) => Promise<boolean>
  file: (job: FileJob) => Promise<FileResult>
  /** An empty Google Sheet in the account Drive, under Client / Project, that the editor can fill. */
  sheet?: (job: SheetJob) => Promise<{ spreadsheetId: string; path: string[] }>
}

type Deps = {
  db: any
  auth: Middleware[]
  guard: Middleware
  accountGate: Middleware
  gmailGate: Middleware
  wrap: (fn: (req: Request, res: Response) => Promise<any>) => Middleware
  current: (req: Request) => any
  liveUser: (user: any, settingsAccess?: boolean) => Promise<string>
  activeAccount: (
    tenantId: string,
  ) => Promise<{ row: any; credentials: { clientId: string; clientSecret: string; redirectUri: string } }>
  google: (url: string, init: RequestInit, timeout?: number) => Promise<any>
  origin: (req: Request) => string
  callbackPath: string
  sessionFromRequest: (req: Request) => { token: string; user: any }
  sessionByToken: (token: string) => any
  own: (req: Request, id: string) => Promise<any>
  attachment: (req: Request, message: any, index: number) => Promise<{ name: string; mimeType: string; file: Buffer }>
  load: (id: string) => Promise<any>
  commit: (id: string, next: any, user: any, source: string, current: any) => Promise<any>
  inOrder: (tenantId: string, job: () => Promise<void>) => Promise<void>
}

export function registerDrive(app: Express, deps: Deps) {
  const { db, auth, guard, accountGate, gmailGate, wrap, current } = deps
  const pending = new Map<
    string,
    {
      tenantId: string
      userId: string
      token: string
      verifier: string
      cookie: string
      revision: string
      expires: number
    }
  >()
  const tokens = new Map<string, { token: string; expires: number; revision: string }>()

  const connection = async (tenantId: string) => {
    const { data, error } = await db.from(TABLE).select('*').eq('tenant_id', tenantId).maybeSingle()
    if (error) throw new IntegrationError(MIGRATION, 503)
    return data
  }
  const saveFolders = async (tenantId: string, patch: any) => {
    const { error } = await db
      .from(TABLE)
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('tenant_id', tenantId)
    if (error) throw new IntegrationError(MIGRATION, 503)
  }
  const gmailRevision = async (tenantId: string) => {
    try {
      return String((await deps.activeAccount(tenantId)).row.revision)
    } catch {
      return ''
    }
  }

  /** A live Drive connection made with the account's current OAuth client. */
  const liveConnection = async (tenantId: string) => {
    const row = await connection(tenantId)
    if (!row)
      throw new IntegrationError(
        'Ask your account administrator to connect Google Drive in Settings → Integrations.',
        409,
      )
    const config = await deps.activeAccount(tenantId)
    if (String(config.row.revision) !== String(row.gmail_config_revision))
      throw new IntegrationError(
        'The account Google OAuth client changed. Ask your account administrator to reconnect Google Drive.',
        409,
      )
    return { row, config }
  }
  const accessToken = async (tenantId: string, row: any, config: Awaited<ReturnType<Deps['activeAccount']>>) => {
    const cached = tokens.get(tenantId)
    if (cached && cached.expires > Date.now() + 60000 && cached.revision === String(row.gmail_config_revision))
      return cached.token
    const refresh = decryptSecret(row.encrypted_refresh_token, tenantId, KIND)
    try {
      const grant = await deps.google('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: config.credentials.clientId,
          client_secret: config.credentials.clientSecret,
          refresh_token: refresh,
          grant_type: 'refresh_token',
        }),
      })
      const token = String(grant.access_token || '')
      if (!token) throw new IntegrationError('Google Drive did not return an access token.', 502)
      tokens.set(tenantId, {
        token,
        expires: Date.now() + Number(grant.expires_in || 3000) * 1000,
        revision: String(row.gmail_config_revision),
      })
      return token
    } catch (error) {
      const status = (error as any)?.upstreamStatus
      if (status === 400 || status === 401)
        throw new IntegrationError(
          'Google Drive access was revoked. Ask your account administrator to reconnect Google Drive.',
          409,
        )
      throw error
    }
  }
  const canWriteTasks = (user: any) =>
    user.role !== 'Viewer' && (user.role === 'Administrator' || user.modules?.includes('items'))

  /**
   * Put one file into the shared Drive under Client / Project / Task / Subtask and list it on the task.
   * Without a task, the file goes to the Client / Project folder and nothing is listed on a task.
   * A null user means the system acts (DocHub finishing a signature).
   */
  const fileInDrive = async (job: FileJob): Promise<FileResult> => {
    const { tenantId } = job
    const before = (await deps.load(tenantId)).data
    if (!before) throw new IntegrationError('Workspace data is unavailable.', 503)
    const task = job.taskId ? (before.items || []).find((item: any) => item.id === job.taskId) : undefined
    if (job.taskId && !task && !job.clientId)
      throw new IntegrationError('The task for this file no longer exists.', 404)
    const steps = task ? driveFolderPath(before, task.id) : driveContextPath(before, job.clientId, job.projectId)
    const path = steps.map(step => step.name)
    if (task) {
      const files: any[] = Array.isArray(task.driveFiles) ? task.driveFiles : []
      const duplicate = files.find(file => file.name === job.name && file.size === job.bytes.length)
      if (duplicate) return { file: duplicate, path, task, duplicate: true }
      if (files.length >= MAX_FILES_PER_TASK)
        throw new IntegrationError(`A task can list up to ${MAX_FILES_PER_TASK} Drive files.`)
    }
    const { row, config } = await liveConnection(tenantId)
    const drive = driveClient(await accessToken(tenantId, row, config))
    const rootId =
      (row.root_folder_id && (await drive.existingFolder(row.root_folder_id, DRIVE_ROOT_NAME))) ||
      (await drive.createFolder(DRIVE_ROOT_NAME))
    const resolved = await ensureDrivePath(drive, rootId, rootId === row.root_folder_id ? row.folders || {} : {}, steps)
    await saveFolders(tenantId, { root_folder_id: rootId, folders: resolved.folders })
    const fileId = await drive.upload(resolved.folderId, driveName(job.name, 'attachment'), job.mimeType, job.bytes)
    const entry: TaskDriveFile = {
      id: fileId,
      name: job.name,
      url: driveFileUrl(fileId),
      mimeType: job.mimeType,
      size: job.bytes.length,
      savedAt: new Date().toISOString(),
      savedBy: job.user?.id || 'system:dochub',
      savedByName: job.user?.name || 'DocHub',
      source: job.source,
    }
    if (!task) return { file: entry, path, duplicate: false }
    // Re-read after the upload so edits made meanwhile are kept.
    for (let attempt = 0; ; attempt++) {
      const latest = (await deps.load(tenantId)).data
      const fresh = latest?.items?.find((item: any) => item.id === task.id)
      if (!latest || !fresh)
        throw Object.assign(
          new IntegrationError(
            'The file was saved to Google Drive, but the task was removed before it could be linked.',
            409,
          ),
          { code: 'TASK_REMOVED', file: entry },
        )
      const updated = { ...fresh, driveFiles: [...(Array.isArray(fresh.driveFiles) ? fresh.driveFiles : []), entry] }
      const activity = {
        id: randomUUID(),
        clientId: fresh.clientId || undefined,
        projectId: fresh.projectId || undefined,
        date: entry.savedAt.slice(0, 10),
        text: `Saved “${entry.name}” to Google Drive for ${fresh.parentTaskId ? 'subtask' : 'task'} "${fresh.title}"`,
      }
      try {
        await (job.commit || deps.commit)(
          tenantId,
          {
            ...latest,
            items: latest.items.map((item: any) => (item.id === task.id ? updated : item)),
            activity: [activity, ...(latest.activity || [])],
          },
          job.user ? { ...job.user } : null,
          job.source === 'gmail' ? 'drive-attachment' : 'drive-document',
          latest,
        )
        return { file: entry, path, task: updated, duplicate: false }
      } catch (error) {
        if (!(error instanceof LifecycleError) || attempt >= 3) throw error
      }
    }
  }
  /** Whether Drive is connected with the current OAuth client, without raising. */
  const driveReady = async (tenantId: string) => {
    try {
      await liveConnection(tenantId)
      return true
    } catch {
      return false
    }
  }
  /** Bytes of a file the tracker saved on a task. Only files listed on that task can be fetched; nothing is stored. */
  const taskFile = async (tenantId: string, taskId: string, fileId: string, maxBytes: number) => {
    const state = (await deps.load(tenantId)).data
    const task = (state?.items || []).find((item: any) => item.id === taskId)
    const entry = (Array.isArray(task?.driveFiles) ? task.driveFiles : []).find((file: any) => file.id === fileId)
    if (!entry) throw new IntegrationError('This file is not saved on that task.', 404)
    const { row, config } = await liveConnection(tenantId)
    const bytes = await driveClient(await accessToken(tenantId, row, config)).download(fileId, maxBytes)
    return {
      name: String(entry.name || 'attachment'),
      mimeType: attachmentContentType(String(entry.mimeType || '')),
      bytes,
    }
  }

  // Account settings
  app.get(
    '/api/account/drive',
    ...auth,
    accountGate,
    wrap(async (req, res) => {
      const tenantId = current(req).organizationId,
        row = await connection(tenantId),
        revision = await gmailRevision(tenantId)
      res.json({
        gmailReady: Boolean(revision),
        connected: Boolean(row),
        email: row?.drive_email || '',
        rootFolderUrl: row?.root_folder_id ? driveFolderUrl(row.root_folder_id) : '',
        reconnectRequired: Boolean(row) && Boolean(revision) && revision !== String(row.gmail_config_revision),
      })
    }),
  )
  app.post(
    '/api/account/drive/connect',
    ...auth,
    accountGate,
    wrap(async (req, res) => {
      const user = current(req),
        session = deps.sessionFromRequest(req),
        config = await deps.activeAccount(user.organizationId)
      await connection(user.organizationId) // Fail before Google if the migration is missing.
      if (!session.token || config.credentials.redirectUri !== `${deps.origin(req)}${deps.callbackPath}`)
        throw new IntegrationError(
          'The Gmail OAuth callback address changed. Update the account Gmail settings first.',
          409,
        )
      for (const [key, value] of pending)
        if (value.tenantId === user.organizationId || value.expires < Date.now()) pending.delete(key)
      if (pending.size > 1000) throw new IntegrationError('Too many pending Drive connections. Try again shortly.', 429)
      const verifier = randomBytes(32).toString('base64url'),
        state = randomBytes(32).toString('hex'),
        cookie = randomBytes(32).toString('hex')
      pending.set(state, {
        tenantId: user.organizationId,
        userId: user.id,
        token: session.token,
        verifier,
        cookie,
        revision: String(config.row.revision),
        expires: Date.now() + 600000,
      })
      res.cookie(COOKIE, cookie, {
        httpOnly: true,
        secure: deps.origin(req).startsWith('https:'),
        sameSite: 'lax',
        path: deps.callbackPath,
        maxAge: 600000,
      })
      const query = new URLSearchParams({
        client_id: config.credentials.clientId,
        redirect_uri: config.credentials.redirectUri,
        response_type: 'code',
        scope: `${DRIVE_SCOPE} https://www.googleapis.com/auth/userinfo.email`,
        access_type: 'offline',
        prompt: 'consent select_account',
        state,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
      })
      res.json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${query}` })
    }),
  )
  app.delete(
    '/api/account/drive',
    ...auth,
    accountGate,
    wrap(async (req, res) => {
      const tenantId = current(req).organizationId,
        row = await connection(tenantId)
      if (row?.encrypted_refresh_token) {
        try {
          const token = decryptSecret(row.encrypted_refresh_token, tenantId, KIND)
          await fetch('https://oauth2.googleapis.com/revoke', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token }),
            signal: AbortSignal.timeout(10000),
            redirect: 'error',
          })
        } catch {
          /* Disconnect locally even if revocation is temporarily unavailable. */
        }
      }
      const { error } = await db.from(TABLE).delete().eq('tenant_id', tenantId)
      if (error) throw new IntegrationError(MIGRATION, 503)
      tokens.delete(tenantId)
      res.json({ disconnected: true })
    }),
  )

  /** Shares the Gmail OAuth callback address, so no extra redirect URI is needed in Google Cloud. */
  const handles = (state: unknown) => typeof state === 'string' && pending.has(state)
  const callback = async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Referrer-Policy', 'no-referrer')
    let result = 'error'
    try {
      const state = String(req.query.state || ''),
        saved = pending.get(state)
      const cookie =
        (req.headers.cookie || '')
          .split(';')
          .map(x => x.trim())
          .find(x => x.startsWith(`${COOKIE}=`))
          ?.slice(COOKIE.length + 1) || ''
      if (
        !saved ||
        saved.expires < Date.now() ||
        !/^[a-f0-9]{64}$/.test(cookie) ||
        !timingSafeEqual(Buffer.from(cookie), Buffer.from(saved.cookie))
      )
        throw new Error('Invalid state')
      pending.delete(state)
      const check = async () => {
        const user = deps.sessionByToken(saved.token)
        if (!user || user.id !== saved.userId || user.organizationId !== saved.tenantId)
          throw new Error('Session expired')
        await deps.liveUser(user, true)
        const config = await deps.activeAccount(saved.tenantId)
        if (
          String(config.row.revision) !== saved.revision ||
          config.credentials.redirectUri !== `${deps.origin(req)}${deps.callbackPath}`
        )
          throw new Error('OAuth settings changed')
        return config
      }
      const config = await check()
      if (req.query.error) {
        result = 'denied'
        throw new Error('Denied')
      }
      if (typeof req.query.code !== 'string' || req.query.code.length > 4096) throw new Error('Missing code')
      const grant = await deps.google('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: req.query.code,
          client_id: config.credentials.clientId,
          client_secret: config.credentials.clientSecret,
          redirect_uri: config.credentials.redirectUri,
          code_verifier: saved.verifier,
          grant_type: 'authorization_code',
        }),
      })
      if (
        !grant.access_token ||
        !grant.refresh_token ||
        !String(grant.scope || '')
          .split(' ')
          .includes(DRIVE_SCOPE)
      ) {
        result = 'denied'
        throw new Error('Drive access not granted')
      }
      const identity = await deps.google('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${grant.access_token}` },
      })
      if (!identity.email || identity.email_verified !== true) throw new Error('Unverified identity')
      await check()
      const previous = await connection(saved.tenantId)
      const sameDrive = previous?.drive_email?.toLowerCase() === String(identity.email).toLowerCase()
      const drive = driveClient(String(grant.access_token))
      const kept =
        sameDrive && previous?.root_folder_id
          ? await drive.existingFolder(previous.root_folder_id, DRIVE_ROOT_NAME)
          : null
      const rootId = kept || (await drive.createFolder(DRIVE_ROOT_NAME))
      const record = {
        tenant_id: saved.tenantId,
        drive_email: String(identity.email),
        encrypted_refresh_token: encryptSecret(String(grant.refresh_token), saved.tenantId, KIND),
        gmail_config_revision: saved.revision,
        root_folder_id: rootId,
        folders: kept ? previous.folders || {} : {},
        connected_by: saved.userId,
        updated_at: new Date().toISOString(),
      }
      const { error } = await db.from(TABLE).upsert(record, { onConflict: 'tenant_id' })
      if (error) throw error
      tokens.delete(saved.tenantId)
      result = 'connected'
    } catch {
      /* Never log authorization codes, tokens or provider details. */
    }
    res.clearCookie(COOKIE, { path: deps.callbackPath, httpOnly: true, sameSite: 'lax' })
    res.redirect(303, `/#drive=${result}`)
  }
  const timer = setInterval(() => {
    const now = Date.now()
    for (const [key, value] of pending) if (value.expires < now) pending.delete(key)
  }, 60000)
  timer.unref()

  // Work Hub
  app.get(
    '/api/communications/drive',
    ...auth,
    guard,
    gmailGate,
    wrap(async (req, res) => {
      const user = current(req)
      let available = false
      try {
        await liveConnection(user.organizationId)
        available = canWriteTasks(user)
      } catch {
        available = false
      }
      res.json({ available })
    }),
  )
  /** A task is linked to the message that was open when it was created, but a thread shows every message in it, each with its own attachments. So the whole thread, owned by this user, counts. */
  const threadTaskIds = async (message: any, tenantId: string, userId: string) => {
    const own = linkedTaskIds(message)
    if (!message?.thread_id) return own
    try {
      const { data, error } = await db
        .from('user_communications')
        .select('linked_task_id,linked_task_ids')
        .eq('tenant_id', tenantId)
        .eq('owner_user_id', userId)
        .eq('source', message.source)
        .eq('thread_id', message.thread_id)
        .limit(500)
      if (error) return own
      return [...new Set([...own, ...(data || []).flatMap((row: any) => linkedTaskIds(row))])]
    } catch {
      return own
    }
  }
  app.get(
    '/api/communications/:id/drive-targets',
    ...auth,
    guard,
    gmailGate,
    wrap(async (req, res) => {
      const user = current(req),
        message = await deps.own(req, String(req.params.id)),
        state = (await deps.load(user.organizationId)).data
      if (!state) throw new IntegrationError('Workspace data is unavailable.', 503)
      res.json({ targets: driveTargets(state, await threadTaskIds(message, user.organizationId, user.id)) })
    }),
  )
  app.post(
    '/api/communications/:id/attachments/:index/drive',
    ...auth,
    guard,
    gmailGate,
    wrap(async (req, res) => {
      const user = current(req),
        tenantId = user.organizationId
      if (!canWriteTasks(user)) throw new IntegrationError('Task write access is required.', 403)
      const message = await deps.own(req, String(req.params.id))
      const taskId = typeof req.body?.taskId === 'string' ? req.body.taskId : ''
      const index = Number(req.params.index)
      if (!taskId) throw new IntegrationError('Choose a task or subtask.')
      await deps.inOrder(tenantId, async () => {
        const before = (await deps.load(tenantId)).data
        if (!before) throw new IntegrationError('Workspace data is unavailable.', 503)
        if (!driveTargets(before, await threadTaskIds(message, tenantId, user.id)).some(target => target.id === taskId))
          throw new IntegrationError('Choose an active task or subtask created from this email.', 404)
        await liveConnection(tenantId)
        const download = await deps.attachment(req, message, index)
        try {
          const result = await fileInDrive({
            tenantId,
            name: download.name,
            mimeType: download.mimeType,
            bytes: download.file,
            taskId,
            user: { id: user.id, name: String(user.name || user.username || 'User') },
            source: 'gmail',
          })
          if (result.duplicate) {
            res.status(409).json({
              code: 'ALREADY_SAVED',
              error: `“${download.name}” is already saved to this ${result.task?.parentTaskId ? 'subtask' : 'task'}.`,
              file: result.file,
            })
            return
          }
          res.status(201).json({ file: result.file, task: result.task })
        } catch (error) {
          if ((error as any)?.code === 'TASK_REMOVED') {
            res.status(409).json({ code: 'TASK_REMOVED', error: (error as Error).message, file: (error as any).file })
            return
          }
          throw error
        }
      })
    }),
  )

  // Document Creation: pick a COR already in Drive, and file generated documents.
  const documentUser: Middleware = (req, res, next) => {
    const user = current(req)
    if (user.role === 'Viewer' || !user.modules?.includes('documents')) {
      res.status(403).json({ error: 'Document Creation write access is required.' })
      return
    }
    res.setHeader('Cache-Control', 'no-store')
    next()
  }
  const DOCUMENT_TYPES: Record<string, string> = {
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    zip: 'application/zip',
  }
  const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024
  app.get(
    '/api/documents/drive',
    ...auth,
    documentUser,
    wrap(async (req, res) => {
      res.json({ available: await driveReady(current(req).organizationId) })
    }),
  )
  // Stream a file the tracker saved to a task folder. Only files listed on a task can be fetched.
  app.get(
    '/api/documents/drive/file',
    ...auth,
    documentUser,
    wrap(async (req, res) => {
      const tenantId = current(req).organizationId,
        taskId = String(req.query.taskId || ''),
        fileId = String(req.query.fileId || '')
      const maxBytes = Math.min(Number(req.query.maxBytes) || MAX_DOCUMENT_BYTES, MAX_DOCUMENT_BYTES)
      const file = await taskFile(tenantId, taskId, fileId, maxBytes)
      res.setHeader('Content-Type', file.mimeType)
      res.setHeader('Content-Length', String(file.bytes.length))
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.send(file.bytes)
    }),
  )
  // File a generated BRD, FSD, test case suite or similar document under a task or subtask.
  app.post(
    '/api/documents/drive/save',
    ...auth,
    documentUser,
    wrap(async (req, res) => {
      const user = current(req),
        tenantId = user.organizationId
      if (!canWriteTasks(user)) throw new IntegrationError('Task write access is required.', 403)
      const taskId = typeof req.body?.taskId === 'string' ? req.body.taskId : '',
        encoded = String(req.body?.fileData || '')
      const name = driveName(String(req.body?.fileName || '').replace(/[\\/\r\n]/g, '_'), '').slice(0, 180),
        ext = name.split('.').pop()?.toLowerCase() || ''
      if (!taskId) throw new IntegrationError('Choose a task or subtask.')
      if (!name || !DOCUMENT_TYPES[ext] || encoded.length > 21 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))
        throw new IntegrationError('Use a generated PDF, DOCX, XLSX or ZIP up to 15 MB.')
      const bytes = Buffer.from(encoded, 'base64')
      if (!bytes.length || bytes.length > MAX_DOCUMENT_BYTES)
        throw new IntegrationError('Document must be between 1 byte and 15 MB.')
      if (ext === 'pdf' ? bytes.subarray(0, 5).toString() !== '%PDF-' : bytes.subarray(0, 2).toString() !== 'PK')
        throw new IntegrationError('This does not look like a valid document.')
      await deps.inOrder(tenantId, async () => {
        const before = (await deps.load(tenantId)).data
        const task = (before?.items || []).find((item: any) => item.id === taskId)
        if (!task) throw new IntegrationError('Select an existing task or subtask.', 404)
        const reason = archivedWorkReason(before, task)
        if (reason) throw new IntegrationError(reason, 409)
        try {
          const result = await fileInDrive({
            tenantId,
            name,
            mimeType: DOCUMENT_TYPES[ext],
            bytes,
            taskId,
            user: { id: user.id, name: String(user.name || user.username || 'User') },
            source: 'generated',
          })
          if (result.duplicate) {
            res.status(409).json({
              code: 'ALREADY_SAVED',
              error: `“${name}” is already saved to this ${task.parentTaskId ? 'subtask' : 'task'}.`,
              file: result.file,
              path: result.path,
            })
            return
          }
          res.status(201).json({ file: result.file, path: result.path })
        } catch (error) {
          if ((error as any)?.code === 'TASK_REMOVED') {
            res.status(409).json({ code: 'TASK_REMOVED', error: (error as Error).message, file: (error as any).file })
            return
          }
          throw error
        }
      })
    }),
  )
  /** A tracker's new Google Sheet in the account Drive, owned by the Drive's account and shared with its maker. */
  const sheetInDrive = async (job: SheetJob) => {
    const { tenantId } = job
    const state = (await deps.load(tenantId)).data
    if (!state) throw new IntegrationError('Workspace data is unavailable.', 503)
    const steps = driveSheetPath(state, job.clientId, job.projectId)
    const { row, config } = await liveConnection(tenantId)
    const drive = driveClient(await accessToken(tenantId, row, config))
    const rootId =
      (row.root_folder_id && (await drive.existingFolder(row.root_folder_id, DRIVE_ROOT_NAME))) ||
      (await drive.createFolder(DRIVE_ROOT_NAME))
    const resolved = await ensureDrivePath(drive, rootId, rootId === row.root_folder_id ? row.folders || {} : {}, steps)
    await saveFolders(tenantId, { root_folder_id: rootId, folders: resolved.folders })
    const spreadsheetId = await drive.createSheet(driveName(job.title, 'Tracker'), resolved.folderId)
    // The Drive's own account already owns it; anyone else is made an editor so their Google account can sync it.
    if (job.editorEmail && job.editorEmail.toLowerCase() !== String(row.drive_email || '').toLowerCase())
      await drive.shareWith(spreadsheetId, job.editorEmail)
    return { spreadsheetId, path: [DRIVE_ROOT_NAME, ...steps.map(step => step.name)] }
  }
  const filer: DriveFiler = { ready: driveReady, file: fileInDrive, sheet: sheetInDrive }
  return { handles, callback, filer, taskFile }
}
