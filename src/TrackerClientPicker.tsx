import { useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { TRACKER_CLIENTS } from './trackerModel'

/** Chooses the clients a tracker follows. A tracker can follow several, for example a roll-out shared by many clients. */
export default function TrackerClientPicker({ clients, value, onChange, label = 'Clients' }: { clients: { id: string; name: string }[]; value: string[]; onChange: (ids: string[]) => void; label?: string }) {
  const [query, setQuery] = useState('')
  const name = (id: string) => clients.find(client => client.id === id)?.name || 'Unknown client'
  const matches = useMemo(() => {
    const wanted = query.trim().toLowerCase()
    return clients.filter(client => !value.includes(client.id) && (!wanted || client.name.toLowerCase().includes(wanted))).slice(0, 8)
  }, [clients, query, value])
  const full = value.length >= TRACKER_CLIENTS
  const add = (id: string) => { if (!full) onChange([...value, id]); setQuery('') }
  return <div className="trk-field-block trk-clients" role="group" aria-label={label}>
    <span>{label}</span>
    <div className="trk-client-chips">
      {value.map(id => <span key={id} className="trk-client-chip">{name(id)}<button type="button" aria-label={`Remove ${name(id)}`} onClick={() => onChange(value.filter(item => item !== id))}><X size={12} aria-hidden="true" /></button></span>)}
      {!value.length && <span className="trk-muted">No client yet</span>}
    </div>
    <input value={query} disabled={full} placeholder={full ? `Up to ${TRACKER_CLIENTS} clients` : clients.length ? 'Add a client: type to search' : 'There are no clients yet'} aria-label={`Add a client to ${label.toLowerCase()}`}
      onChange={event => setQuery(event.target.value)}
      onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); if (matches[0]) add(matches[0].id) } }} />
    {query.trim() !== '' && <div className="trk-client-options" role="listbox" aria-label="Matching clients">
      {matches.map(client => <button type="button" role="option" aria-selected="false" key={client.id} onClick={() => add(client.id)}>{client.name}</button>)}
      {!matches.length && <p className="trk-muted-text">No client matches.</p>}
    </div>}
    {query.trim() === '' && clients.length > 0 && clients.length <= 12 && !full && <div className="trk-client-quick">
      {clients.filter(client => !value.includes(client.id)).map(client => <button type="button" key={client.id} onClick={() => add(client.id)}>+ {client.name}</button>)}
    </div>}
  </div>
}
