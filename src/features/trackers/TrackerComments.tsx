/**
 * The Comments card of a row: the conversation, and a box to add to it. Typing "@" offers the people who can see the
 * tracker; the ones mentioned are notified. Your own comments can be edited or deleted.
 */
import { MessageSquare, Pencil, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { trackerApi } from './trackerApi'
import {
  COMMENT_LIMITS,
  commentParts,
  insertMention,
  mentionChoices,
  mentionQuery,
  type Mentionable,
  type RowComment,
} from './trackerComments'
import { niceTime } from './trackerUi'

/** A text box that offers people after "@". Reports the text and the ids of the people picked. */
function CommentBox({
  people,
  initial = '',
  initialMentions = [],
  submitLabel,
  busy,
  onSubmit,
  onCancel,
}: {
  people: Mentionable[]
  initial?: string
  initialMentions?: string[]
  submitLabel: string
  busy: boolean
  onSubmit: (text: string, mentions: string[]) => void
  onCancel?: () => void
}) {
  const [text, setText] = useState(initial)
  const [picked, setPicked] = useState<string[]>(initialMentions)
  const [caret, setCaret] = useState(initial.length)
  const [at, setAt] = useState(0)
  const box = useRef<HTMLTextAreaElement>(null)
  const asking = mentionQuery(text, caret)
  const choices = asking ? mentionChoices(people, asking.query) : []
  const open = Boolean(asking) && choices.length > 0
  const pick = (person: Mentionable) => {
    if (!asking) return
    const next = insertMention(text, caret, asking.start, person.name)
    setText(next.text)
    setCaret(next.caret)
    setPicked(current => (current.includes(person.id) ? current : [...current, person.id]))
    setAt(0)
    window.requestAnimationFrame(() => {
      box.current?.focus()
      box.current?.setSelectionRange(next.caret, next.caret)
    })
  }
  const send = () => {
    if (!text.trim() || busy) return
    onSubmit(text, picked)
  }
  return (
    <div className="trk-comment-box">
      {open && (
        <ul className="trk-mention-list" aria-label="People to mention">
          {choices.map((person, index) => (
            <li key={person.id}>
              <button
                type="button"
                className={index === at ? 'on' : ''}
                // Keeps the caret in the box while a name is picked with the mouse.
                onMouseDown={event => event.preventDefault()}
                onClick={() => pick(person)}
              >
                {person.name}
              </button>
            </li>
          ))}
        </ul>
      )}
      <textarea
        ref={box}
        aria-label="Comment"
        rows={3}
        maxLength={COMMENT_LIMITS.chars}
        placeholder="Write a comment. Type @ to mention someone."
        value={text}
        onChange={event => {
          setText(event.target.value)
          setCaret(event.target.selectionStart ?? event.target.value.length)
          setAt(0)
        }}
        onSelect={event => setCaret(event.currentTarget.selectionStart ?? 0)}
        onKeyDown={event => {
          if (open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault()
            setAt(current => (current + (event.key === 'ArrowDown' ? 1 : choices.length - 1)) % choices.length)
          } else if (open && (event.key === 'Enter' || event.key === 'Tab')) {
            event.preventDefault()
            pick(choices[Math.min(at, choices.length - 1)])
          } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault()
            send()
          }
        }}
      />
      <div className="trk-comment-actions">
        <small className="trk-muted">@ notifies them · Ctrl+Enter to post</small>
        <span>
          {onCancel && (
            <button type="button" className="trk-button" onClick={onCancel} disabled={busy}>
              Cancel
            </button>
          )}
          <button type="button" className="trk-button primary" onClick={send} disabled={busy || !text.trim()}>
            {submitLabel}
          </button>
        </span>
      </div>
    </div>
  )
}

export default function TrackerComments({
  trackerId,
  rowId,
  currentUserId,
  isAdmin,
  canComment,
  onCount,
}: {
  trackerId: string
  rowId: string
  currentUserId: string
  isAdmin: boolean
  canComment: boolean
  /** Tells the grid how many comments the row has now. */
  onCount?: (rowId: string, count: number) => void
}) {
  const [comments, setComments] = useState<RowComment[] | null>(null)
  const [people, setPeople] = useState<Mentionable[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState('')
  const [draftKey, setDraftKey] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setComments(null)
    setEditing('')
    trackerApi
      .comments(trackerId, rowId, controller.signal)
      .then(result => {
        setComments(result.comments)
        setPeople(result.mentionable)
        setError('')
      })
      .catch(failure => {
        if (failure?.name !== 'AbortError') setError('The comments could not be loaded.')
      })
    return () => controller.abort()
  }, [trackerId, rowId])

  const run = async (work: () => Promise<RowComment[]>) => {
    setBusy(true)
    setError('')
    try {
      const next = await work()
      setComments(next)
      onCount?.(rowId, next.length)
      return true
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'That did not save. Try again.')
      return false
    } finally {
      setBusy(false)
    }
  }
  const names = people.map(person => person.name)
  const list = comments || []

  return (
    <section className="trk-card" aria-label="Comments">
      <h3>
        <MessageSquare size={14} aria-hidden="true" /> Comments{list.length ? ` · ${list.length}` : ''}
      </h3>
      {error && <p className="trk-field-error">{error}</p>}
      {!comments && !error && <p className="trk-muted-text">Loading…</p>}
      {comments && !list.length && <p className="trk-muted-text">No comments yet.</p>}
      {list.length > 0 && (
        <ol className="trk-comments">
          {list.map(comment =>
            editing === comment.id ? (
              <li key={comment.id}>
                <CommentBox
                  people={people}
                  initial={comment.text}
                  initialMentions={comment.mentions}
                  submitLabel="Save"
                  busy={busy}
                  onCancel={() => setEditing('')}
                  onSubmit={(text, mentions) =>
                    void run(async () => {
                      const saved = (await trackerApi.editComment(trackerId, comment.id, { text, mentions })).comment
                      setEditing('')
                      return list.map(item => (item.id === saved.id ? saved : item))
                    })
                  }
                />
              </li>
            ) : (
              <li key={comment.id} className={comment.mentions.includes(currentUserId) ? 'mentions-me' : ''}>
                <span className="trk-comment-head">
                  <strong>{comment.authorName || 'Someone'}</strong>
                  <time dateTime={comment.at}>
                    {niceTime(comment.at)}
                    {comment.editedAt ? ' · edited' : ''}
                  </time>
                  {canComment && (comment.authorId === currentUserId || isAdmin) && (
                    <span className="trk-comment-tools">
                      {comment.authorId === currentUserId && (
                        <button type="button" aria-label="Edit comment" onClick={() => setEditing(comment.id)}>
                          <Pencil size={12} />
                        </button>
                      )}
                      <button
                        type="button"
                        aria-label="Delete comment"
                        disabled={busy}
                        onClick={() => {
                          if (!window.confirm('Delete this comment?')) return
                          void run(async () => {
                            await trackerApi.deleteComment(trackerId, comment.id)
                            return list.filter(item => item.id !== comment.id)
                          })
                        }}
                      >
                        <Trash2 size={12} />
                      </button>
                    </span>
                  )}
                </span>
                <p>
                  {commentParts(comment.text, names).map((part, index) =>
                    part.mention ? (
                      // biome-ignore lint/suspicious/noArrayIndexKey: parts of one comment never reorder
                      <b key={index} className="trk-mention">
                        {part.text}
                      </b>
                    ) : (
                      // biome-ignore lint/suspicious/noArrayIndexKey: parts of one comment never reorder
                      <span key={index}>{part.text}</span>
                    ),
                  )}
                </p>
              </li>
            ),
          )}
        </ol>
      )}
      {canComment && comments && (
        <CommentBox
          key={draftKey}
          people={people}
          submitLabel="Post"
          busy={busy}
          onSubmit={(text, mentions) =>
            void run(async () => {
              const added = (await trackerApi.addComment(trackerId, rowId, { text, mentions })).comment
              setDraftKey(key => key + 1)
              return [...list, added]
            })
          }
        />
      )}
    </section>
  )
}
