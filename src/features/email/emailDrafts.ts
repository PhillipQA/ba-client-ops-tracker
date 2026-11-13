// Email drafts, like Gmail's: every email being written is saved as you type, so closing the tab, signing out or
// leaving for Google's permission page does not lose it. Drafts come back as minimized windows. They are kept in this
// browser, per person; attached files from the computer are not kept (they can be large), Drive files are.
import type { ComposePrefill } from './composeEvent'

export type SavedDraft = {
  id: string
  updatedAt: string
  to: string
  cc: string
  bcc: string
  subject: string
  message: string
  taskIds: string[]
  driveFiles: NonNullable<ComposePrefill['driveFiles']>
  replyToId?: string
  autoCc?: boolean
  /** Files from the computer that were attached when it was saved: they must be attached again. */
  droppedUploads?: string[]
}

/** At most this many drafts (and email windows) at once, like Gmail's compose windows. */
export const MAX_DRAFTS = 3
const LIMITS = { field: 2000, subject: 300, message: 60000, taskIds: 50, driveFiles: 20 } as const

export const draftKey = (user: { id: string; organizationId?: string }) =>
  `email-drafts:${user.organizationId || ''}:${user.id}`

const text = (value: unknown, max: number) => (typeof value === 'string' ? value.slice(0, max) : '')

/** A stored draft as it can be trusted: known fields only, within limits. Null when it is not a draft. */
export function cleanDraft(raw: unknown): SavedDraft | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  const id = text(value.id, 80)
  if (!id) return null
  const draft: SavedDraft = {
    id,
    updatedAt: text(value.updatedAt, 40) || new Date(0).toISOString(),
    to: text(value.to, LIMITS.field),
    cc: text(value.cc, LIMITS.field),
    bcc: text(value.bcc, LIMITS.field),
    subject: text(value.subject, LIMITS.subject),
    message: text(value.message, LIMITS.message),
    taskIds: (Array.isArray(value.taskIds) ? value.taskIds : [])
      .filter((item): item is string => typeof item === 'string' && Boolean(item))
      .slice(0, LIMITS.taskIds),
    driveFiles: (Array.isArray(value.driveFiles) ? value.driveFiles : [])
      .filter(
        (file: any) =>
          file && typeof file.taskId === 'string' && typeof file.fileId === 'string' && typeof file.name === 'string',
      )
      .slice(0, LIMITS.driveFiles)
      .map((file: any) => ({
        taskId: file.taskId,
        fileId: file.fileId,
        name: file.name,
        size: Number(file.size) || 0,
      })),
  }
  if (typeof value.replyToId === 'string' && value.replyToId) draft.replyToId = value.replyToId
  if (value.autoCc === true) draft.autoCc = true
  const dropped = (Array.isArray(value.droppedUploads) ? value.droppedUploads : [])
    .filter((name): name is string => typeof name === 'string')
    .slice(0, 20)
  if (dropped.length) draft.droppedUploads = dropped
  return draft
}

/** Whether a draft holds anything worth keeping. A message that is only the signature does not count. */
export function hasContent(draft: Pick<SavedDraft, 'to' | 'cc' | 'bcc' | 'subject' | 'message'>, signature = '') {
  const message = draft.message.trim()
  const onlySignature = !message || (signature.trim() !== '' && message === signature.trim())
  return Boolean(draft.to.trim() || draft.cc.trim() || draft.bcc.trim() || draft.subject.trim() || !onlySignature)
}

/** The saved drafts, newest first, at most MAX_DRAFTS. */
export function readDrafts(storage: Pick<Storage, 'getItem'> | undefined, key: string): SavedDraft[] {
  try {
    const parsed = JSON.parse(storage?.getItem(key) || '[]')
    return (Array.isArray(parsed) ? parsed : [])
      .map(cleanDraft)
      .filter((draft): draft is SavedDraft => Boolean(draft))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, MAX_DRAFTS)
  } catch {
    return []
  }
}

/** Saves one draft (replacing the one with its id). Answers false when the browser would not store it. */
export function saveDraft(storage: Pick<Storage, 'getItem' | 'setItem'> | undefined, key: string, draft: SavedDraft) {
  const clean = cleanDraft(draft)
  if (!storage || !clean) return false
  const others = readDrafts(storage, key).filter(item => item.id !== clean.id)
  try {
    storage.setItem(key, JSON.stringify([clean, ...others].slice(0, MAX_DRAFTS)))
    return true
  } catch {
    return false
  }
}

export function removeDraft(storage: Pick<Storage, 'getItem' | 'setItem'> | undefined, key: string, id: string) {
  if (!storage) return
  const left = readDrafts(storage, key).filter(item => item.id !== id)
  try {
    storage.setItem(key, JSON.stringify(left))
  } catch {
    /* Nothing more to do: it is only a draft. */
  }
}

/** What a saved draft opens the composer with. */
export function draftPrefill(draft: SavedDraft): ComposePrefill {
  return {
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    subject: draft.subject,
    message: draft.message,
    taskIds: draft.taskIds,
    driveFiles: draft.driveFiles,
    ...(draft.replyToId ? { replyToId: draft.replyToId } : {}),
    ...(draft.autoCc ? { autoCc: true } : {}),
    ...(draft.droppedUploads?.length
      ? {
          notice: `Attach again from your computer: ${draft.droppedUploads.join(', ')}. Files from your computer are not kept in drafts.`,
        }
      : {}),
  }
}
