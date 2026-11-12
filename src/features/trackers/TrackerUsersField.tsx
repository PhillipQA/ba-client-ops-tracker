import { useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { TRACKER_MEMBERS } from './trackerFolders'

type Person = { id: string; name: string }

/**
 * A tracker's users, in its details. The creator and the people on its projects come automatically (from Seeds, or
 * an Administrator's assignments); the creator or an Administrator can add anyone else. The tracker shows in each
 * user's folder.
 */
export default function TrackerUsersField({
  people,
  automatic,
  value,
  onChange,
  canChange,
}: {
  /** Active people on the account. */
  people: Person[]
  /** Users who come automatically, with why: the creator or a project. */
  automatic: { id: string; why: string }[]
  /** People added by hand. */
  value: string[]
  onChange: (ids: string[]) => void
  canChange: boolean
}) {
  const [query, setQuery] = useState('')
  const name = (id: string) => people.find(person => person.id === id)?.name || 'Former user'
  const taken = useMemo(() => new Set([...automatic.map(user => user.id), ...value]), [automatic, value])
  const matches = useMemo(() => {
    const wanted = query.trim().toLowerCase()
    return [...people]
      .filter(person => !taken.has(person.id) && (!wanted || person.name.toLowerCase().includes(wanted)))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 8)
  }, [people, query, taken])
  const full = value.length >= TRACKER_MEMBERS
  const add = (id: string) => {
    if (!full) onChange([...value, id])
    setQuery('')
  }
  return (
    <div className="trk-field-block trk-clients" role="group" aria-label="Users">
      <span>Users</span>
      <p className="trk-muted-text">This tracker shows in each user’s folder on the Trackers page.</p>
      <div className="trk-client-chips">
        {automatic.map(user => (
          <span key={user.id} className="trk-client-chip trk-user-auto" title={user.why}>
            {name(user.id)} <small>· {user.why}</small>
          </span>
        ))}
        {value.map(id => (
          <span key={id} className="trk-client-chip">
            {name(id)}
            {canChange && (
              <button
                type="button"
                aria-label={`Remove ${name(id)}`}
                onClick={() => onChange(value.filter(item => item !== id))}
              >
                <X size={12} aria-hidden="true" />
              </button>
            )}
          </span>
        ))}
      </div>
      {canChange ? (
        <>
          <input
            value={query}
            disabled={full}
            placeholder={full ? `Up to ${TRACKER_MEMBERS} people` : 'Add a person: type to search'}
            aria-label="Add a person to this tracker"
            onChange={event => setQuery(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                event.preventDefault()
                if (matches[0]) add(matches[0].id)
              }
            }}
          />
          {query.trim() !== '' && (
            <div className="trk-client-options" role="listbox" aria-label="Matching people">
              {matches.map(person => (
                <button
                  type="button"
                  role="option"
                  aria-selected="false"
                  key={person.id}
                  onClick={() => add(person.id)}
                >
                  {person.name}
                </button>
              ))}
              {!matches.length && <p className="trk-muted-text">No one else matches.</p>}
            </div>
          )}
        </>
      ) : (
        <p className="trk-muted-text">Only the tracker’s creator or an Administrator can add people.</p>
      )}
    </div>
  )
}
