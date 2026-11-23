import { useEffect, useState } from 'react'
import { saveClash } from './cloudStore'
import type { ClashChoice } from './conflictChoice'

type Clash = NonNullable<ReturnType<typeof saveClash>>

function shown(value: unknown) {
  if (value === undefined || value === null || value === '') return '(empty)'
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > 120 ? `${text.slice(0, 117)}…` : text
}

function side(record: unknown, field: string | undefined) {
  if (record === undefined) return 'Deleted'
  if (!field || !record || typeof record !== 'object') return shown(record)
  let value: unknown = record
  for (const part of field.split(/\.|\[|\]/).filter(Boolean))
    value =
      Array.isArray(value)
        ? value.find(entry => entry && typeof entry === 'object' && String((entry as { id?: unknown }).id) === part)
        : value && typeof value === 'object'
          ? (value as Record<string, unknown>)[part]
          : undefined
  return shown(value)
}

/**
 * Inside the Save conflict box: when the conflict is about one record, the person keeps their version of it or takes
 * the other one, and saving resumes (Phase 4B). Several clashing records are asked about one by one.
 */
export function ConflictChoice({
  conflict,
  settle,
}: {
  conflict: string
  settle: (choice: ClashChoice) => Promise<Clash | undefined>
}) {
  const [clash, setClash] = useState<Clash | undefined>(() => saveClash())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (conflict) setClash(saveClash())
  }, [conflict])
  if (!clash) return null
  const choose = async (choice: ClashChoice) => {
    setBusy(true)
    setError('')
    try {
      setClash(await settle(choice))
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The choice could not be saved.')
      setClash(saveClash())
    } finally {
      setBusy(false)
    }
  }
  const what = clash.id === undefined ? 'this setting' : `“${clash.label}”`
  return (
    <div className="conflict-choice" aria-label="Choose a version">
      <p>
        You and someone else both changed {what}
        {clash.field ? ` (${clash.field})` : ''}. Choose which version to keep; your other edits are saved either way.
      </p>
      <dl>
        <dt>Yours</dt>
        <dd>{side(clash.mine, clash.field)}</dd>
        <dt>Theirs</dt>
        <dd>{side(clash.theirs, clash.field)}</dd>
      </dl>
      <div className="conflict-choice-actions">
        <button type="button" disabled={busy} onClick={() => void choose('mine')}>
          Keep mine
        </button>
        <button type="button" className="secondary" disabled={busy} onClick={() => void choose('theirs')}>
          Use theirs
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
    </div>
  )
}
