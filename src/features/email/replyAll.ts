// Reply all, shared by Work Hub and by the task's email buttons (DocHub signed PDFs, Drive files): when the work has a
// linked email, a file is sent as a reply to everyone on that email, in its Gmail conversation, rather than as a new
// email.
import { composeEmail, type ComposePrefill } from './composeEvent'
import { extractAddress, quoteReply, replySubject } from './emailCompose'

export type ReplyableEmail = {
  id: string
  subject: string
  sender: string
  body: string
  received_at: string
  source?: string
  source_labels?: string[]
}

/**
 * A reply to everyone on one received email: the sender gets it and everyone else on the email is copied. Gmail is
 * asked at this moment, so older saved emails work too.
 */
export async function replyAllPrefill(received: ReplyableEmail, taskIds: string[]): Promise<ComposePrefill> {
  let to = extractAddress(received.sender),
    cc = '',
    notice = ''
  try {
    const response = await fetch(`/api/communications/${encodeURIComponent(received.id)}/reply-recipients`, {
      credentials: 'same-origin',
    })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(String(result.error || ''))
    if (Array.isArray(result.to) && result.to.length) {
      to = result.to.join(', ')
      cc = Array.isArray(result.cc) ? result.cc.join(', ') : ''
    }
  } catch {
    notice =
      'The other people on the original email could not be read from Gmail, so only the sender was added. Add anyone else to Cc yourself.'
  }
  return {
    replyToId: received.id,
    to,
    cc,
    autoCc: Boolean(cc),
    notice,
    subject: replySubject(received.subject),
    message: quoteReply(received.sender, received.received_at, received.body),
    taskIds,
  }
}

const sentByMe = (email: ReplyableEmail) => Boolean(email.source_labels?.includes('SENT'))
const json = async <T>(url: string): Promise<T> => {
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(String(body.error || 'Request failed.'))
  return body as T
}

/**
 * The email to reply to for some work: the newest Gmail email linked to it (or to its parent task or subtasks),
 * then the latest message in that
 * conversation from someone else (not a copy of your own sent reply). Null when nothing is linked.
 */
export async function latestLinkedEmail(workIds: string[]): Promise<ReplyableEmail | null> {
  const ids = [...new Set(workIds.filter(Boolean))].slice(0, 50)
  if (!ids.length) return null
  const linked = await json<{ items: ReplyableEmail[] }>(
    `/api/communications?taskIds=${encodeURIComponent(ids.join(','))}&family=1`,
  )
  const newest = (linked.items || []).find(email => email.source === 'Gmail')
  if (!newest) return null
  // The thread comes oldest first, 50 a page: the last page holds the latest messages.
  const first = await json<{ items: ReplyableEmail[]; total: number }>(
    `/api/communications/${encodeURIComponent(newest.id)}/thread?page=1`,
  )
  const pages = Math.max(1, Math.ceil((first.total || 0) / 50))
  const last =
    pages > 1
      ? await json<{ items: ReplyableEmail[] }>(
          `/api/communications/${encodeURIComponent(newest.id)}/thread?page=${pages}`,
        )
      : first
  const thread = (last.items || []).filter(email => email.source === 'Gmail')
  return [...thread].reverse().find(email => !sentByMe(email)) || (sentByMe(newest) ? null : newest)
}

/**
 * Emails a file of some work. With a linked email: Reply all on it, with the file attached. Without one (or when
 * Work Hub cannot be read): a new email, as before.
 */
export async function emailWorkFile(options: {
  /** The tasks or subtasks the email is filed under; their linked email (or their parent's) is answered. */
  taskIds: string[]
  driveFiles: NonNullable<ComposePrefill['driveFiles']>
  subject: string
}) {
  let received: ReplyableEmail | null = null
  try {
    received = await latestLinkedEmail(options.taskIds)
  } catch {
    received = null
  }
  if (!received) {
    composeEmail({ taskIds: options.taskIds, driveFiles: options.driveFiles, subject: options.subject })
    return
  }
  const reply = await replyAllPrefill(received, options.taskIds)
  composeEmail({ ...reply, driveFiles: options.driveFiles })
}
