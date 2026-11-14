/**
 * The Memory panel of the BA Assistant: the notes this person asked it to keep or that it learned from their chats,
 * and its one-line notes on earlier conversations, to read, add to and delete. Only they see them. The notes go with
 * each of their questions, so they are short and few (see memory.ts).
 */
import { type FormEvent, useEffect, useState } from 'react'
import { Brain, LoaderCircle, Trash2, X } from 'lucide-react'
import { requestJson } from '../../shared/http'
import { cleanChats, cleanNotes, MEMORY_LIMITS, type ChatRecap, type MemoryNote } from './memory'

type Held = { notes: MemoryNote[]; chats: ChatRecap[] }
const held = (body: { notes?: unknown; chats?: unknown }): Held => ({
  notes: cleanNotes(body.notes),
  chats: cleanChats(body.chats),
})

export const memoryApi = {
  list: async () => held(await requestJson('/api/assistant/memory', { noStore: true })),
  add: async (text: string) =>
    cleanNotes(
      (await requestJson('/api/assistant/memory', { body: { text }, fallback: 'That could not be remembered.' })).notes,
    ),
  remove: async (id: string) =>
    cleanNotes(
      (
        await requestJson(`/api/assistant/memory/${encodeURIComponent(id)}`, {
          method: 'DELETE',
          fallback: 'That note could not be deleted.',
        })
      ).notes,
    ),
  /** Forgets one conversation recap, or all of them (`all`). */
  forgetChat: async (id: string) =>
    cleanChats(
      (
        await requestJson(`/api/assistant/memory/chats/${encodeURIComponent(id)}`, {
          method: 'DELETE',
          fallback: 'That could not be forgotten.',
        })
      ).chats,
    ),
}

export default function AssistantMemory({
  version,
  learn,
  onLearn,
  onClose,
}: {
  version: number
  /** Whether the assistant learns from this person's chats (notes it picks up, and a line on each conversation). */
  learn: boolean
  onLearn: (on: boolean) => void
  onClose: () => void
}) {
  const [notes, setNotes] = useState<MemoryNote[] | null>(null)
  const [chats, setChats] = useState<ChatRecap[]>([])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // Read again when an answer changed the memory (version).
  useEffect(() => {
    let current = true
    memoryApi
      .list()
      .then(all => {
        if (!current) return
        setNotes(all.notes)
        setChats(all.chats)
      })
      .catch(failure => current && setError(failure instanceof Error ? failure.message : 'Memory could not be read.'))
    return () => {
      current = false
    }
  }, [version])

  const change = async (work: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try {
      await work()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Memory could not be changed.')
    } finally {
      setBusy(false)
    }
  }
  const add = (event: FormEvent) => {
    event.preventDefault()
    if (!text.trim()) return
    void change(async () => {
      setNotes(await memoryApi.add(text))
      setText('')
    })
  }
  const shownChats = [...chats].reverse()

  return (
    <div className="ai-memory" role="region" aria-label="What the assistant remembers">
      <div className="ai-memory-head">
        <strong>
          <Brain size={14} aria-hidden="true" /> What I remember for you
        </strong>
        <button type="button" className="ai-memory-icon" onClick={onClose} aria-label="Close memory">
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      <p className="ai-memory-hint">
        Only you see these. They go with your questions, so keep them short. You can also say “remember that …” or
        “forget …” in the chat.
      </p>
      <label className="ai-memory-learn">
        <input type="checkbox" checked={learn} onChange={event => onLearn(event.target.checked)} />
        <span>
          Learn from my chats: pick up lasting preferences and facts from what I write, and keep a line on each
          conversation.
        </span>
      </label>
      {error && (
        <p className="ai-memory-error" role="alert">
          {error}
        </p>
      )}
      {!notes && !error && (
        <p className="ai-memory-hint" role="status">
          <LoaderCircle size={12} className="spin" aria-hidden="true" /> Reading…
        </p>
      )}
      {notes && notes.length === 0 && <p className="ai-memory-hint">Nothing yet.</p>}
      {notes && notes.length > 0 && (
        <ul>
          {notes.map(note => (
            <li key={note.id}>
              <span>
                {note.text}
                {note.source === 'learned' && <em className="ai-memory-tag">learned</em>}
              </span>
              <button
                type="button"
                className="ai-memory-icon"
                disabled={busy}
                onClick={() => void change(async () => setNotes(await memoryApi.remove(note.id)))}
                aria-label={`Forget: ${note.text}`}
                title="Forget this"
              >
                <Trash2 size={13} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={add}>
        <input
          value={text}
          onChange={event => setText(event.target.value)}
          maxLength={MEMORY_LIMITS.chars}
          placeholder="e.g. Client X always needs Product Y on time entries"
          aria-label="Something to remember"
        />
        <button type="submit" className="secondary compact" disabled={busy || !text.trim()}>
          Remember
        </button>
      </form>
      {shownChats.length > 0 && (
        <details className="ai-memory-chats">
          <summary>
            Earlier conversations ({shownChats.length})
            <button
              type="button"
              className="ai-memory-forget-all"
              disabled={busy}
              onClick={event => {
                event.preventDefault()
                if (window.confirm('Forget all earlier conversations? Your notes above are kept.'))
                  void change(async () => setChats(await memoryApi.forgetChat('all')))
              }}
            >
              Forget all
            </button>
          </summary>
          <ul>
            {shownChats.map(chat => (
              <li key={chat.id}>
                <span>
                  <em className="ai-memory-tag">{chat.at.slice(0, 10)}</em> {chat.text}
                </span>
                <button
                  type="button"
                  className="ai-memory-icon"
                  disabled={busy}
                  onClick={() => void change(async () => setChats(await memoryApi.forgetChat(chat.id)))}
                  aria-label={`Forget the conversation of ${chat.at.slice(0, 10)}`}
                  title="Forget this conversation"
                >
                  <Trash2 size={13} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}
