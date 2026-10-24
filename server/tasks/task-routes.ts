import type express from 'express'
import type { Express } from 'express'
import { randomUUID } from 'node:crypto'
import { archivedWorkReason, LifecycleError } from '../../src/features/tasks/lifecycle'
import { moduleAllowed, requireAuth, requireTenantWorkspace, type SessionUser } from '../core/auth'
import { followUpTimeZone } from '../core/config'
import { supabaseAdmin } from '../core/database'
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

let taskEvidenceBucketReady = false

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

async function ensureTaskEvidenceBucket() {
  if (!supabaseAdmin) throw new Error('Database is not configured.')
  if (taskEvidenceBucketReady) return
  const { data: buckets, error: listError } = await supabaseAdmin.storage.listBuckets()
  if (listError) throw listError
  if (
    !(buckets || []).some((bucket: any) => bucket.id === TASK_EVIDENCE_BUCKET || bucket.name === TASK_EVIDENCE_BUCKET)
  ) {
    const { error: createError } = await supabaseAdmin.storage.createBucket(TASK_EVIDENCE_BUCKET, {
      public: false,
      fileSizeLimit: TASK_EVIDENCE_MAX_BYTES,
      allowedMimeTypes: [...TASK_EVIDENCE_MIME_TYPES],
    })
    if (createError) throw createError
  }
  taskEvidenceBucketReady = true
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
  mutate: (task: any, user: SessionUser) => ReturnType<typeof addTimeEntry> | ReturnType<typeof removeTimeEntry>,
) {
  const user = (req as express.Request & { authUser: SessionUser }).authUser
  if (!taskEvidenceWriteAllowed(user))
    return void res.status(403).json({ error: 'Task edit access is required to log time.' })
  if (!supabaseAdmin) return void res.status(503).json({ error: 'Database is not configured.' })
  try {
    const taskId = String(req.params.taskId || '')
    const state = await ensureTenantFollowUpsCurrent(String(tenantIdForUser(user)))
    const current = state.data && typeof state.data === 'object' ? state.data : null
    if (!current) return void res.status(404).json({ error: 'Tracker data is not available.' })
    const items = Array.isArray(current.items) ? current.items : []
    const task = items.find((candidate: any) => String(candidate?.id || '') === taskId)
    if (!task || (task.source === 'Discord' && task.externalSourceId))
      return void res.status(404).json({ error: 'Task or Subtask was not found.' })
    const locked = archivedWorkReason(current, task)
    if (locked) return void res.status(409).json({ error: locked })
    const result = mutate(task, user)
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

/** Task comments, time entries and evidence files. */
export function registerTaskRoutes(app: Express) {
  app.post('/api/tasks/:taskId/comments', requireAuth, requireTenantWorkspace, async (req, res) => {
    const user = (req as express.Request & { authUser: SessionUser }).authUser
    if (!taskEvidenceWriteAllowed(user))
      return void res.status(403).json({ error: 'Task edit access is required to add comments.' })
    if (!supabaseAdmin) return void res.status(503).json({ error: 'Database is not configured.' })
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : ''
    if (!text) return void res.status(400).json({ error: 'Comment text is required.' })
    if (text.length > 2000) return void res.status(400).json({ error: 'Comments must be 2,000 characters or fewer.' })
    try {
      const taskId = String(req.params.taskId || '')
      const state = await ensureTenantFollowUpsCurrent(String(tenantIdForUser(user)))
      const current = state.data && typeof state.data === 'object' ? state.data : null
      if (!current) return void res.status(404).json({ error: 'Tracker data is not available.' })
      const items = Array.isArray(current.items) ? current.items : []
      const task = items.find((candidate: any) => String(candidate?.id || '') === taskId)
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
    mutateTimeEntries(req, res, (task, user) => addTimeEntry(task, req.body, user, new Date(), randomUUID())),
  )

  app.delete('/api/tasks/:taskId/time-entries/:entryId', requireAuth, requireTenantWorkspace, (req, res) =>
    mutateTimeEntries(req, res, (task, user) => removeTimeEntry(task, String(req.params.entryId || ''), user)),
  )

  app.post('/api/tasks/:taskId/evidence', requireAuth, requireTenantWorkspace, async (req, res) => {
    const user = (req as express.Request & { authUser: SessionUser }).authUser
    if (!taskEvidenceWriteAllowed(user))
      return void res.status(403).json({ error: 'Task edit access is required to upload evidence.' })
    if (!supabaseAdmin) return void res.status(503).json({ error: 'Database is not configured.' })

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
      const task = items.find((candidate: any) => String(candidate?.id || '') === taskId)
      if (!task) return void res.status(404).json({ error: 'Subtask was not found.' })
      const locked = archivedWorkReason(current, task)
      if (locked) return void res.status(409).json({ error: locked })
      if (!task.parentTaskId)
        return void res.status(400).json({ error: 'Evidence uploads are currently available for subtasks only.' })

      await ensureTaskEvidenceBucket()
      const evidenceId = randomUUID()
      const storagePath = `organizations/${tenantIdForUser(user)}/subtasks/${taskId}/${evidenceId}-${fileName}`
      const { error: uploadError } = await supabaseAdmin.storage
        .from(TASK_EVIDENCE_BUCKET)
        .upload(storagePath, fileBuffer, {
          contentType: mimeType,
          cacheControl: '3600',
          upsert: false,
        })
      if (uploadError) throw uploadError

      const evidence = {
        id: evidenceId,
        fileName,
        mimeType,
        fileSize: fileBuffer.length,
        storagePath,
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
        text: `Attached evidence to subtask "${task.title}": ${fileName}`,
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
        await supabaseAdmin.storage
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
    if (!supabaseAdmin) return void res.status(503).json({ error: 'Database is not configured.' })

    try {
      const taskId = String(req.params.taskId || '')
      const evidenceId = String(req.params.evidenceId || '')
      const state = await loadTenantState(tenantIdForUser(user))
      const current = state.data && typeof state.data === 'object' ? state.data : null
      if (!current) return void res.status(404).json({ error: 'Tracker data is not available.' })
      const items = Array.isArray(current.items) ? current.items : []
      const task = items.find((candidate: any) => String(candidate?.id || '') === taskId)
      if (!task || !task.parentTaskId) return void res.status(404).json({ error: 'Subtask was not found.' })
      const locked = archivedWorkReason(current, task)
      if (locked) return void res.status(409).json({ error: locked })
      const evidence = (Array.isArray(task.evidence) ? task.evidence : []).find(
        (entry: any) => String(entry?.id || '') === evidenceId,
      )
      if (!evidence) return void res.status(404).json({ error: 'Evidence was not found.' })

      await ensureTaskEvidenceBucket()
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
        text: `Removed evidence from subtask "${task.title}": ${evidence.fileName || 'file'}`,
      }
      const next = {
        ...current,
        items: items.map((candidate: any) => (String(candidate?.id || '') === taskId ? updatedTask : candidate)),
        activity: [activity, ...(Array.isArray(current.activity) ? current.activity : [])],
      }
      const saved = await saveEvidenceState(current, next, user, 'task-evidence-delete')
      const { error: removeError } = await supabaseAdmin.storage
        .from(TASK_EVIDENCE_BUCKET)
        .remove([String(evidence.storagePath || '')])
      if (removeError) console.warn('Task evidence storage cleanup warning:', removeError.message)
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
    if (!supabaseAdmin) return void res.status(503).json({ error: 'Database is not configured.' })

    try {
      const taskId = String(req.params.taskId || '')
      const evidenceId = String(req.params.evidenceId || '')
      const state = await loadTenantState(tenantIdForUser(user))
      const items = Array.isArray(state.data?.items) ? state.data.items : []
      const task = items.find((candidate: any) => String(candidate?.id || '') === taskId)
      if (!task || !task.parentTaskId) return void res.status(404).json({ error: 'Subtask was not found.' })
      const evidence = (Array.isArray(task.evidence) ? task.evidence : []).find(
        (entry: any) => String(entry?.id || '') === evidenceId,
      )
      if (!evidence?.storagePath) return void res.status(404).json({ error: 'Evidence was not found.' })

      await ensureTaskEvidenceBucket()
      const { data, error } = await supabaseAdmin.storage
        .from(TASK_EVIDENCE_BUCKET)
        .download(String(evidence.storagePath))
      if (error || !data) throw error || new Error('Evidence could not be downloaded.')
      const buffer = Buffer.from(await data.arrayBuffer())
      const mimeType = String(evidence.mimeType || 'application/octet-stream')
      const inline = mimeType.startsWith('image/') || mimeType === 'application/pdf'
      const encodedName = encodeURIComponent(String(evidence.fileName || 'evidence-file')).replace(/'/g, '%27')
      res.setHeader('Content-Type', mimeType)
      res.setHeader('Content-Length', String(buffer.length))
      res.setHeader('Cache-Control', 'private, no-store')
      res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodedName}`)
      res.send(buffer)
    } catch (error) {
      console.error('Task evidence download failed:', error)
      res.status(500).json({ error: error instanceof Error ? error.message : 'Task evidence download failed.' })
    }
  })
}
