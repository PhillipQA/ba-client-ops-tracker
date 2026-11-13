/**
 * The Memory panel of the BA Assistant: the notes this person asked it to keep, to read, add to and delete. Only they
 * see them. The notes go with each of their questions, so they are short and few (see memory.ts).
 */
import { type FormEvent, useEffect, useState } from 'react'
import { Brain, LoaderCircle, Trash2, X } from 'lucide-react'
import { requestJson } from '../../shared/http'
import { cleanNotes, MEMORY_LIMITS, type MemoryNote } from './memory'

export const memoryApi = {
  list: async () => cleanNotes((await requestJson('/api/assistant/memory', { noStore: true })).notes),
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
}

export default function AssistantMemory({ version, onClose }: { version: number; onClose: () => void }) {
  const [notes, setNotes] = useState<MemoryNote[] | null>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // Read again when an answer changed the memory (version).
  useEffect(() => {
    let current = true
    memoryApi
      .list()
      .then(list => current && setNotes(list))
      .catch(failure => current && setError(failure instanceof Error ? failure.message : 'Memory could not be read.'))
    return () => {
      current = false
    }
  }, [version])

  const change = async (work: () => Promise<MemoryNote[]>, done?: () => void) => {
    setBusy(true)
    setError('')
    try {
      setNotes(await work())
      done?.()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Memory could not be changed.')
    } finally {
      setBusy(false)
    }
  }
  const add = (event: FormEvent) => {
    event.preventDefault()
    if (text.trim())
      void change(
        () => memoryApi.add(text),
        () => setText(''),
      )
  }

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
              <span>{note.text}</span>
              <button
                type="button"
                className="ai-memory-icon"
                disabled={busy}
                onClick={() => void change(() => memoryApi.remove(note.id))}
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
        <button className="secondary compact" disabled={busy || !text.trim()}>
          Remember
        </button>
      </form>
    </div>
  )
}
