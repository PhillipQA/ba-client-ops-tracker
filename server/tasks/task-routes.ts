import type express from 'express'
import type { Express } from 'express'
import { randomUUID } from 'node:crypto'
import { archivedWorkReason, LifecycleError } from '../../src/features/tasks/lifecycle'
import { moduleAllowed, requireAuth, requireTenantWorkspace, type SessionUser } from '../core/auth'
import { followUpTimeZone } from '../core/config'
import { db } from '../core/database'
import {
  authoritativeWorkEvents,
  commitTenantState,
  ensureTenantFollowUpsCurrent,
  loadTenantState,
  notificationsForUser,
  tenantIdForUser,
} from '../core/tenant-state'
import { dateKeyInTimeZone } from '../services/follow-up-rollover'
import { reconcileNotifications } from '../services/notification-engine'
import { addTimeEntry, removeTimeEntry } from '../services/time-entries'
import { seedsTimeRule } from '../../src/features/tasks/effort'
import { visibleTask } from '../services/visibility'
import type { DriveFiler } from '../integrations/google-drive'
import { evidenceInDatabase, evidenceInDrive, moveEvidenceToDrive } from './evidence-storage'

const TASK_EVIDENCE_BUCKET = 'task-evidence'

const TASK_EVIDENCE_MAX_BYTES = 10 * 1024 * 1024

const TASK_EVIDENCE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/bmp',
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/zip',
  'application/x-zip-compressed',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
])

function taskEvidenceWriteAllowed(user: SessionUser) {
  return user.role !== 'Viewer' && moduleAllowed(user, 'items')
}

function taskEvidenceReadAllowed(user: SessionUser) {
  return moduleAllowed(user, 'items')
}

function safeEvidenceFileName(value: unknown) {
  const source = typeof value === 'string' ? value.trim() : ''
  const fileName = source.split(/[\\/]/).pop() || 'evidence-file'
  return (
    fileName
      .replace(/[<>:"|?*\u0000-\u001f]/g, '_')
      .replace(/\s+/g, ' ')
      .slice(0, 140) || 'evidence-file'
  )
}

function normalizedEvidenceMimeType(rawMimeType: unknown, fileName: string) {
  const mimeType = String(rawMimeType || '')
    .trim()
    .toLowerCase()
  if (TASK_EVIDENCE_MIME_TYPES.has(mimeType)) return mimeType
  const extension = fileName.toLowerCase().split('.').pop() || ''
  const byExtension: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    bmp: 'image/bmp',
    pdf: 'application/pdf',
    txt: 'text/plain',
    csv: 'text/csv',
    zip: 'application/zip',
    doc: 'application/msword',
    xls: 'application/vnd.ms-excel',
    ppt: 'application/vnd.ms-powerpoint',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  }
  return byExtension[extension] || mimeType || 'application/octet-stream'
}

function evidenceBase64(value: unknown) {
  const raw = typeof value === 'string' ? value.replace(/^data:[^;]+;base64,/, '').replace(/\s/g, '') : ''
  if (!raw || !/^[A-Za-z0-9+/=]+$/.test(raw)) throw new Error('The evidence file data is invalid.')
  const buffer = Buffer.from(raw, 'base64')
  if (!buffer.length) throw new Error('The evidence file is empty.')
  if (buffer.length > TASK_EVIDENCE_MAX_BYTES) throw new Error('Evidence files must be 10 MB or smaller.')
  return buffer
}

async function saveEvidenceState(current: any, next: any, actor: SessionUser, source: string) {
  const workEvents = authoritativeWorkEvents(current, next, actor)
  const existingEventIds = new Set(
    (Array.isArray(current?.workEvents) ? current.workEvents : []).map((event: any) => String(event?.id || '')),
  )
  const newEventIds = workEvents
    .filter((event: any) => !existingEventIds.has(String(event?.id || '')))
    .map((event: any) => String(event.id))
  const reconciled = reconcileNotifications(
    {
      ...next,
      schemaVersion: Math.max(6, Number(next?.schemaVersion || 0)),
      workEvents,
      notifications: Array.isArray(current?.notifications) ? current.notifications : [],
      notificationState: current?.notificationState,
    },
    { today: dateKeyInTimeZone(new Date(), followUpTimeZone), newEventIds },
  )
  const saved = await commitTenantState(tenantIdForUser(actor), reconciled.state, actor, source, current)
  return { updatedAt: saved.syncedAt, state: reconciled.state }
}

async function saveCommentState(current: any, next: any, actor: SessionUser, event: any) {
  const workEvents = [event, ...(Array.isArray(current?.workEvents) ? current.workEvents : [])].slice(0, 10_000)
  const reconciled = reconcileNotifications(
    {
      ...next,
      schemaVersion: Math.max(6, Number(next?.schemaVersion || 0)),
      workEvents,
      notifications: Array.isArray(current?.notifications) ? current.notifications : [],
      notificationState: current?.notificationState,
    },
    { today: dateKeyInTimeZone(new Date(), followUpTimeZone), newEventIds: [String(event.id)] },
  )
  const saved = await commitTenantState(tenantIdForUser(actor), reconciled.state, actor, 'task-comment-add', current)
  return { updatedAt: saved.syncedAt, state: reconciled.state }
}

async function mutateTimeEntries(
  req: express.Request,
  res: express.Response,
  mutate: (
    task: any,
    user: SessionUser,
    state: any,
  ) => ReturnType<typeof addTimeEntry> | ReturnType<typeof removeTimeEntry>,
) {
  const user = (req as express.Request & { authUser: SessionUser }).authUser
  if (!taskEvidenceWriteAllowed(user))
    return void res.status(403).json({ error: 'Task edit access is required to log time.' })
  if (!db) return void res.status(503).json({ error: 'Database is not configured.' })
  try {
    const taskId = String(req.params.taskId || '')
    const state = await ensureTenantFollowUpsCurrent(String(tenantIdForUser(user)))
    const current = state.data && typeof state.data === 'object' ? state.data : null
    if (!current) return void res.status(404).json({ error: 'Tracker data is not available.' })
    const items = Array.isArray(current.items) ? current.items : []
    const task = visibleTask(current, user, taskId, 'write')
    if (!task || (task.source === 'Discord' && task.externalSourceId))
      return void res.status(404).json({ error: 'Task or Subtask was not found.' })
    const locked = archivedWorkReason(current, task)
    if (locked) return void res.status(409).json({ error: locked })
    const result = mutate(task, user, current)
    if (!result.ok) return void res.status(result.status).json({ error: result.error })
    const next = {
      ...current,
      items: items.map((candidate: any) => (String(candidate?.id || '') === taskId ? result.value.task : candidate)),
    }
    const saved = await commitTenantState(tenantIdForUser(user), next, user, 'task-time-entry', current)
    res.json({ item: result.value.task, entry: result.value.entry, updatedAt: saved.syncedAt })
  } catch (error) {
    console.error('Time entry save failed:', error)
    res
      .status(error instanceof LifecycleError ? error.status : 500)
      .json({ error: error instanceof Error ? error.message : 'Time entry could not be saved.' })
  }
}

/**
 * Task comments, time entries and evidence files.
 *
 * Evidence goes to the account's shared Google Drive, in the task's Client / Project / Task / Subtask folder, when
 * Drive is connected; otherwise it is kept in the database (tracker_evidence_files), as before Drive. Each evidence
 * entry says where its file is (driveFileId, or storagePath), so both kinds open and remove the same way. An
 * Administrator moves the files still in the database to Drive with /api/tasks/evidence/move-to-drive.
 */
export function registerTaskRoutes(app: Express, deps: { drive?: () => DriveFiler | undefined } = {}) {
  /** The Drive filer when the account's Drive is connected and can keep evidence; null otherwise. */
  const evidenceDrive = async (tenantId: string) => {
    const drive = deps.drive?.()
    if (!drive?.store || !drive.read || !drive.trash) return null
    return (await drive.ready(tenantId).catch(() => false)) ? drive : null
  }
  /** The Drive filer for evidence already in Drive, or an error the person can act on. */
  const driveForStored = async (tenantId: string) => {
    const drive = await evidenceDrive(tenantId)
    if (!drive)
      throw Object.assign(
        new Error('This evidence is in Google Drive, which is not connected right now. Ask your administrator.'),
        { status: 409 },
      )
    return drive
  }
  const kindOf = (task: any) => (task.parentTaskId ? 'subtask' : 'task')

  app.post('/api/tasks/:taskId/comments', requireAuth, requireTenantWorkspace, async (req, res) => {
    const user = (req as express.Request & { authUser: SessionUser }).authUser
    if (!taskEvidenceWriteAllowed(user))
      return void res.status(403).json({ error: 'Task edit access is required to add comments.' })
    if (!db) return void res.status(503).json({ error: 'Database is not configured.' })
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : ''
    if (!text) return void res.status(400).json({ error: 'Comment text is required.' })
    if (text.length > 2000) return void res.status(400).json({ error: 'Comments must be 2,000 characters or fewer.' })
    try {
      const taskId = String(req.params.taskId || '')
      const state = await ensureTenantFollowUpsCurrent(String(tenantIdForUser(user)))
      const current = state.data && typeof state.data === 'object' ? state.data : null
      if (!current) return void res.status(404).json({ error: 'Tracker data is not available.' })
      const items = Array.isArray(current.items) ? current.items : []
      const task = visibleTask(current, user, taskId, 'write')
      if (!task) return void res.status(404).json({ error: 'Task or Subtask was not found.' })
      const locked = archivedWorkReason(current, task)
      if (locked) return void res.status(409).json({ error: locked })
      const occurredAt = new Date().toISOString()
      const comment = {
        id: randomUUID(),
        text,
        createdAt: occurredAt,
        createdBy: user.id,
        createdByName: user.name || user.username,
        kind: 'User',
      }
      const updatedTask = {
        ...task,
        comments: [...(Array.isArray(task.comments) ? task.comments : []), comment].slice(-500),
      }
      const event = {
        id: randomUUID(),
        occurredAt,
        date: dateKeyInTimeZone(new Date(occurredAt), followUpTimeZone),
        actorUserId: user.id,
        actorName: user.name,
        actorRole: user.role,
        assignedToUserId: task.assignedToUserId || undefined,
        assignedToName: (Array.isArray(current.accounts) ? current.accounts : []).find(
          (account: any) => String(account?.id || '') === String(task.assignedToUserId || ''),
        )?.name,
        clientId: task.clientId || undefined,
        projectId: task.projectId || undefined,
        taskId: String(task.id),
        parentTaskId: task.parentTaskId || undefined,
        itemTitle: String(task.title || 'Untitled work item'),
        itemKind: task.parentTaskId ? 'Subtask' : 'Task',
        action: 'comment_added',
        summary: `${user.name} commented on “${String(task.title || 'Untitled work item')}”: ${text.slice(0, 240)}`,
      }
      const next = {
        ...current,
        items: items.map((candidate: any) => (String(candidate?.id || '') === taskId ? updatedTask : candidate)),
      }
      const saved = await saveCommentState(current, next, user, event)
      res.json({
        item: updatedTask,
        notifications: notificationsForUser(saved.state, user.id),
        updatedAt: saved.updatedAt,
      })
    } catch (error) {
      console.error('Task comment save failed:', error)
      res
        .status(error instanceof LifecycleError ? error.status : 500)
        .json({ error: error instanceof Error ? error.message : 'Comment could not be saved.' })
    }
  })

  app.post('/api/tasks/:taskId/time-entries', requireAuth, requireTenantWorkspace, (req, res) =>
    mutateTimeEntries(req, res, (task, user, state) =>
      addTimeEntry(task, req.body, user, new Date(), randomUUID(), seedsTimeRule(state, task)),
    ),
  )

  app.delete('/api/tasks/:taskId/time-entries/:entryId', requireAuth, requireTenantWorkspace, (req, res) =>
    mutateTimeEntries(req, res, (task, user) => removeTimeEntry(task, String(req.params.entryId || ''), user)),
  )

  app.post('/api/tasks/:taskId/evidence', requireAuth, requireTenantWorkspace, async (req, res) => {
    const user = (req as express.Request & { authUser: SessionUser }).authUser
    if (!taskEvidenceWriteAllowed(user))
      return void res.status(403).json({ error: 'Task edit access is required to upload evidence.' })
    if (!db) return void res.status(503).json({ error: 'Database is not configured.' })

    const taskId = String(req.params.taskId || '')
    const fileName = safeEvidenceFileName(req.body?.fileName)
    const mimeType = normalizedEvidenceMimeType(req.body?.mimeType, fileName)
    if (!TASK_EVIDENCE_MIME_TYPES.has(mimeType))
      return void res.status(400).json({ error: 'This evidence file type is not supported.' })

    let fileBuffer: Buffer
    try {
      fileBuffer = evidenceBase64(req.body?.dataBase64)
    } catch (error) {
      return void res
        .status(400)
        .json({ error: error instanceof Error ? error.message : 'The evidence file is invalid.' })
    }

    try {
      const state = await loadTenantState(tenantIdForUser(user))
      const current = state.data && typeof state.data === 'object' ? state.data : null
      if (!current) return void res.status(404).json({ error: 'Tracker data is not available.' })
      const items = Array.isArray(current.items) ? current.items : []
      const task = visibleTask(current, user, taskId, 'write')
      if (!task || (task.source === 'Discord' && task.externalSourceId))
        return void res.status(404).json({ error: 'Task or subtask was not found.' })
      const locked = archivedWorkReason(current, task)
      if (locked) return void res.status(409).json({ error: locked })

      const evidenceId = randomUUID()
      const tenantId = String(tenantIdForUser(user))
      // To the task's Drive folder when Drive is connected, else the database.
      const drive = await evidenceDrive(tenantId)
      let storagePath = ''
      let stored: { fileId: string; url: string } | null = null
      if (drive) stored = await drive.store!({ tenantId, taskId, name: fileName, mimeType, bytes: fileBuffer })
      else {
        storagePath = `organizations/${tenantId}/subtasks/${taskId}/${evidenceId}-${fileName}`
        const { error: uploadError } = await db.storage.from(TASK_EVIDENCE_BUCKET).upload(storagePath, fileBuffer, {
          contentType: mimeType,
          cacheControl: '3600',
          upsert: false,
        })
        if (uploadError) throw uploadError
      }

      const evidence = {
        id: evidenceId,
        fileName,
        mimeType,
        fileSize: fileBuffer.length,
        storagePath,
        ...(stored ? { driveFileId: stored.fileId, driveUrl: stored.url } : {}),
        uploadedAt: new Date().toISOString(),
        uploadedBy: user.id,
        uploadedByName: user.name || user.username,
        kind: mimeType.startsWith('image/') ? 'Screenshot' : 'File',
      }
      const updatedTask = { ...task, evidence: [...(Array.isArray(task.evidence) ? task.evidence : []), evidence] }
      const activity = {
        id: randomUUID(),
        clientId: task.clientId || undefined,
        projectId: task.projectId || undefined,
        date: new Date().toISOString().slice(0, 10),
        text: `Attached evidence to ${kindOf(task)} "${task.title}": ${fileName}`,
      }
      const next = {
        ...current,
        items: items.map((candidate: any) => (String(candidate?.id || '') === taskId ? updatedTask : candidate)),
        activity: [activity, ...(Array.isArray(current.activity) ? current.activity : [])],
      }

      try {
        const saved = await saveEvidenceState(current, next, user, 'task-evidence-upload')
        res.json({
          item: updatedTask,
          activity,
          notifications: notificationsForUser(saved.state, user.id),
          updatedAt: saved.updatedAt,
        })
      } catch (saveError) {
        if (stored) await drive!.trash!(tenantId, stored.fileId).catch(() => undefined)
        else
          await db.storage
            .from(TASK_EVIDENCE_BUCKET)
            .remove([storagePath])
            .catch(() => undefined)
        throw saveError
      }
    } catch (error) {
      console.error('Task evidence upload failed:', error)
      res
        .status(error instanceof LifecycleError ? error.status : 500)
        .json({ error: error instanceof Error ? error.message : 'Task evidence upload failed.' })
    }
  })

  app.delete('/api/tasks/:taskId/evidence/:evidenceId', requireAuth, requireTenantWorkspace, async (req, res) => {
    const user = (req as express.Request & { authUser: SessionUser }).authUser
    if (!taskEvidenceWriteAllowed(user))
      return void res.status(403).json({ error: 'Task edit access is required to remove evidence.' })
    if (!db) return void res.status(503).json({ error: 'Database is not configured.' })

    try {
      const taskId = String(req.params.taskId || '')
      const evidenceId = String(req.params.evidenceId || '')
      const state = await loadTenantState(tenantIdForUser(user))
      const current = state.data && typeof state.data === 'object' ? state.data : null
      if (!current) return void res.status(404).json({ error: 'Tracker data is not available.' })
      const items = Array.isArray(current.items) ? current.items : []
      const task = visibleTask(current, user, taskId, 'write')
      if (!task) return void res.status(404).json({ error: 'Task or subtask was not found.' })
      const locked = archivedWorkReason(current, task)
      if (locked) return void res.status(409).json({ error: locked })
      const evidence = (Array.isArray(task.evidence) ? task.evidence : []).find(
        (entry: any) => String(entry?.id || '') === evidenceId,
      )
      if (!evidence) return void res.status(404).json({ error: 'Evidence was not found.' })

      const updatedTask = {
        ...task,
        evidence: (Array.isArray(task.evidence) ? task.evidence : []).filter(
          (entry: any) => String(entry?.id || '') !== evidenceId,
        ),
      }
      const activity = {
        id: randomUUID(),
        clientId: task.clientId || undefined,
        projectId: task.projectId || undefined,
        date: new Date().toISOString().slice(0, 10),
        text: `Removed evidence from ${kindOf(task)} "${task.title}": ${evidence.fileName || 'file'}`,
      }
      const next = {
        ...current,
        items: items.map((candidate: any) => (String(candidate?.id || '') === taskId ? updatedTask : candidate)),
        activity: [activity, ...(Array.isArray(current.activity) ? current.activity : [])],
      }
      const saved = await saveEvidenceState(current, next, user, 'task-evidence-delete')
      // The file goes too: to the Drive trash (restorable for 30 days), or out of the database.
      if (evidence.driveFileId) {
        const tenantId = String(tenantIdForUser(user))
        const drive = await evidenceDrive(tenantId)
        if (drive?.trash)
          await drive
            .trash(tenantId, String(evidence.driveFileId))
            .catch((error: any) => console.warn('Task evidence Drive cleanup warning:', error?.message || error))
      } else {
        const { error: removeError } = await db.storage
          .from(TASK_EVIDENCE_BUCKET)
          .remove([String(evidence.storagePath || '')])
        if (removeError) console.warn('Task evidence storage cleanup warning:', removeError.message)
      }
      res.json({
        item: updatedTask,
        activity,
        notifications: notificationsForUser(saved.state, user.id),
        updatedAt: saved.updatedAt,
      })
    } catch (error) {
      console.error('Task evidence delete failed:', error)
      res
        .status(error instanceof LifecycleError ? error.status : 500)
        .json({ error: error instanceof Error ? error.message : 'Task evidence delete failed.' })
    }
  })

  app.get('/api/tasks/:taskId/evidence/:evidenceId', requireAuth, requireTenantWorkspace, async (req, res) => {
    const user = (req as express.Request & { authUser: SessionUser }).authUser
    if (!taskEvidenceReadAllowed(user))
      return void res.status(403).json({ error: 'Task access is required to view evidence.' })
    if (!db) return void res.status(503).json({ error: 'Database is not configured.' })

    try {
      const taskId = String(req.params.taskId || '')
      const evidenceId = String(req.params.evidenceId || '')
      const state = await loadTenantState(tenantIdForUser(user))
      const task = visibleTask(state.data, user, taskId)
      if (!task) return void res.status(404).json({ error: 'Task or subtask was not found.' })
      const evidence = (Array.isArray(task.evidence) ? task.evidence : []).find(
        (entry: any) => String(entry?.id || '') === evidenceId,
      )
      if (!evidence?.storagePath && !evidence?.driveFileId)
        return void res.status(404).json({ error: 'Evidence was not found.' })

      let buffer: Buffer
      if (evidence.driveFileId) {
        const tenantId = String(tenantIdForUser(user))
        const drive = await driveForStored(tenantId)
        buffer = await drive.read!(tenantId, String(evidence.driveFileId), TASK_EVIDENCE_MAX_BYTES + 1024)
      } else {
        const { data, error } = await db.storage.from(TASK_EVIDENCE_BUCKET).download(String(evidence.storagePath))
        if (error || !data) throw error || new Error('Evidence could not be downloaded.')
        buffer = Buffer.from(await data.arrayBuffer())
      }
      const mimeType = String(evidence.mimeType || 'application/octet-stream')
      const inline = mimeType.startsWith('image/') || mimeType === 'application/pdf'
      const encodedName = encodeURIComponent(String(evidence.fileName || 'evidence-file')).replace(/'/g, '%27')
      res.setHeader('Content-Type', mimeType)
      res.setHeader('Content-Length', String(buffer.length))
      res.setHeader('Cache-Control', 'private, no-store')
      res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodedName}`)
      res.send(buffer)
    } catch (error: any) {
      console.error('Task evidence download failed:', error)
      res
        .status(Number(error?.status) || 500)
        .json({ error: error instanceof Error ? error.message : 'Task evidence download failed.' })
    }
  })

  // Moving evidence from the database to Drive: how much is left, and a batch at a time (an Administrator's job).
  const administrator = (req: express.Request, res: express.Response) => {
    const user = (req as express.Request & { authUser: SessionUser }).authUser
    if (user.role !== 'Administrator') {
      res.status(403).json({ error: 'Only an Administrator can move evidence to Google Drive.' })
      return null
    }
    if (!db) {
      res.status(503).json({ error: 'Database is not configured.' })
      return null
    }
    return user
  }

  app.get('/api/tasks/evidence/storage', requireAuth, requireTenantWorkspace, async (req, res) => {
    const user = administrator(req, res)
    if (!user) return
    try {
      const tenantId = String(tenantIdForUser(user))
      const state = (await loadTenantState(tenantId)).data
      res.json({
        inDatabase: evidenceInDatabase(state).length,
        inDrive: evidenceInDrive(state),
        driveReady: Boolean(await evidenceDrive(tenantId)),
      })
    } catch (error) {
      console.error('Evidence storage summary failed:', error)
      res.status(500).json({ error: 'Evidence storage could not be read.' })
    }
  })

  app.post('/api/tasks/evidence/move-to-drive', requireAuth, requireTenantWorkspace, async (req, res) => {
    const user = administrator(req, res)
    if (!user) return
    const tenantId = String(tenantIdForUser(user))
    const drive = await evidenceDrive(tenantId)
    if (!drive) return void res.status(409).json({ error: 'Connect Google Drive in Settings › Integrations first.' })
    try {
      const batch = evidenceInDatabase((await loadTenantState(tenantId)).data).slice(0, EVIDENCE_MOVE_BATCH)
      // Each file: read from the database, put in its task's Drive folder. Nothing is changed in the database yet.
      const moved: { taskId: string; id: string; fileId: string; url: string; storagePath: string }[] = []
      const failed: { fileName: string; error: string }[] = []
      for (const { task, entry } of batch) {
        try {
          const { data, error } = await db.storage.from(TASK_EVIDENCE_BUCKET).download(String(entry.storagePath))
          if (error || !data) throw error || new Error('The file is missing from the database.')
          const bytes = Buffer.from(await data.arrayBuffer())
          const stored = await drive.store!({
            tenantId,
            taskId: String(task.id),
            name: String(entry.fileName || 'evidence'),
            mimeType: String(entry.mimeType || 'application/octet-stream'),
            bytes,
          })
          moved.push({
            taskId: String(task.id),
            id: String(entry.id),
            fileId: stored.fileId,
            url: stored.url,
            storagePath: String(entry.storagePath),
          })
        } catch (error: any) {
          failed.push({ fileName: String(entry.fileName || 'file'), error: error?.message || 'Not moved.' })
        }
      }
      // Then each evidence entry points to Drive, as the system (archived work included), and only after that are
      // the database copies removed. If saving fails, the Drive copies go to the trash and nothing else changes.
      if (moved.length) {
        try {
          await commitEvidenceMoves(tenantId, moved)
        } catch (error) {
          for (const file of moved) await drive.trash!(tenantId, file.fileId).catch(() => undefined)
          throw error
        }
        const { error: removeError } = await db.storage
          .from(TASK_EVIDENCE_BUCKET)
          .remove(moved.map(file => file.storagePath))
        if (removeError) console.warn('Evidence database cleanup warning:', removeError.message)
      }
      const remaining = evidenceInDatabase((await loadTenantState(tenantId)).data).length
      res.json({ moved: moved.length, failed, remaining })
    } catch (error) {
      console.error('Moving evidence to Drive failed:', error)
      res
        .status(error instanceof LifecycleError ? error.status : 500)
        .json({ error: error instanceof Error ? error.message : 'Evidence could not be moved to Google Drive.' })
    }
  })
}

const EVIDENCE_MOVE_BATCH = 20

/** Points moved evidence entries to their Drive copies, retrying when someone saved meanwhile. */
async function commitEvidenceMoves(
  tenantId: string,
  moved: { taskId: string; id: string; fileId: string; url: string }[],
) {
  for (let attempt = 0; ; attempt++) {
    const current = (await loadTenantState(tenantId)).data
    if (!current) throw new Error('Tracker data is not available.')
    const next = moveEvidenceToDrive(current, moved)
    try {
      await commitTenantState(tenantId, next, null, 'task-evidence-move-to-drive', current)
      return
    } catch (error) {
      if (!(error instanceof LifecycleError) || attempt >= 3) throw error
    }
  }
}
