import type { AppState, SignedInUser } from '../../app/useAppState'
import { ChevronRight, Clock3, LayoutGrid, List, Pencil, Plus, Search, Table2, Users } from 'lucide-react'
import { StatusChip } from '../../shared/ui/Chips'
import { isArchived } from '../tasks/lifecycle'
import { niceDate } from '../../shared/dates'

/** Clients screen. It reads the app state; see app/useAppState. */
export function ClientsPage({ app }: { app: AppState }) {
  const {
    canWrite,
    chooseClientLayout,
    clientArchiveFilter,
    clientLayout,
    clientSearch,
    clientSort,
    setClientArchiveFilter,
    setClientSearch,
    setClientSort,
    setEditingRecord,
    setModal,
    setSelectedClientId,
    visibleClients,
  } = app
  return (
    <section className="page-stack">
      <div className="section-actions">
        <p className="page-intro">
          Clients hold relationship context. Projects are global; client association happens on each task.
        </p>
        {canWrite && (
          <button className="primary" onClick={() => setModal('client')}>
            <Plus size={18} /> New client
          </button>
        )}
      </div>
      <div className="client-controls">
        <label className="lifecycle-filter">
          Show clients
          <select value={clientArchiveFilter} onChange={e => setClientArchiveFilter(e.target.value)}>
            <option value="active">Active</option>
            <option value="archived">Archived / Inactive</option>
            <option value="all">All</option>
          </select>
        </label>
        <label className="client-search">
          <Search size={16} />
          <input
            type="search"
            value={clientSearch}
            onChange={e => setClientSearch(e.target.value)}
            placeholder="Search clients, contacts, email"
            aria-label="Search clients"
          />
        </label>
        <label className="lifecycle-filter">
          Sort by
          <select value={clientSort} onChange={e => setClientSort(e.target.value)}>
            <option value="name">Name A–Z</option>
            <option value="name-desc">Name Z–A</option>
            <option value="open-tasks">Most open tasks</option>
            <option value="follow-up">Next follow-up</option>
          </select>
        </label>
        <div className="client-layout-switch" role="group" aria-label="Client layout">
          <button
            type="button"
            aria-pressed={clientLayout === 'tiles'}
            onClick={() => chooseClientLayout('tiles')}
            title="Tiles"
          >
            <LayoutGrid size={16} />
            <span>Tiles</span>
          </button>
          <button
            type="button"
            aria-pressed={clientLayout === 'list'}
            onClick={() => chooseClientLayout('list')}
            title="List"
          >
            <List size={16} />
            <span>List</span>
          </button>
          <button
            type="button"
            aria-pressed={clientLayout === 'table'}
            onClick={() => chooseClientLayout('table')}
            title="Table"
          >
            <Table2 size={16} />
            <span>Table</span>
          </button>
        </div>
      </div>
      <p className="client-result-count">
        {visibleClients.length} client{visibleClients.length === 1 ? '' : 's'} shown
      </p>
      {visibleClients.length === 0 ? (
        <div className="panel empty-start-card">
          <Users size={24} />
          <div>
            <h3>No clients found</h3>
            <p>Try another search or status filter.</p>
          </div>
        </div>
      ) : clientLayout === 'table' ? (
        <div className="panel table-panel client-table-panel">
          <table>
            <thead>
              <tr>
                <th>Client</th>
                <th>Contact</th>
                <th>Status</th>
                <th>Projects</th>
                <th>Open tasks</th>
                <th>Next follow-up</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleClients.map(({ client, projectCount, openTaskCount, next }) => (
                <tr key={client.id}>
                  <td>
                    <button type="button" className="table-link" onClick={() => setSelectedClientId(client.id)}>
                      <strong>{client.name}</strong>
                    </button>
                  </td>
                  <td>
                    <span>{client.contact}</span>
                    <small className="client-table-email">{client.email}</small>
                  </td>
                  <td>
                    <StatusChip value={isArchived(client) ? 'Archived · Inactive' : client.status} />
                  </td>
                  <td>{projectCount}</td>
                  <td>{openTaskCount}</td>
                  <td>
                    {next ? (
                      <span title={next.title}>
                        {niceDate(next.followUpDate)}
                        <small className="client-table-email">{next.title}</small>
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>
                    {canWrite && (
                      <button
                        type="button"
                        className="secondary compact"
                        onClick={() => setEditingRecord({ kind: 'clients', id: client.id })}
                      >
                        <Pencil size={14} /> Edit
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className={`client-grid ${clientLayout === 'list' ? 'client-grid-list' : ''}`}>
          {visibleClients.map(({ client, projectCount, openTaskCount, next }) => (
            <div key={client.id} className="client-card-wrap">
              <button className="client-card" onClick={() => setSelectedClientId(client.id)}>
                <div className="card-top">
                  <div className="client-avatar">{client.name.slice(0, 2).toUpperCase()}</div>
                  <StatusChip value={isArchived(client) ? 'Archived · Inactive' : client.status} />
                  <ChevronRight size={18} />
                </div>
                <div className="client-identity">
                  <h3>{client.name}</h3>
                  <p>
                    {client.contact} · {client.email}
                  </p>
                </div>
                <div className="card-stats">
                  <span>
                    <b>{projectCount}</b> projects
                  </span>
                  <span>
                    <b>{openTaskCount}</b> open tasks
                  </span>
                </div>
                <div className="next-line">
                  <Clock3 size={15} />
                  <span>
                    {next ? `Next: ${niceDate(next.followUpDate)} — ${next.title}` : 'No follow-up scheduled'}
                  </span>
                </div>
              </button>
              {canWrite && (
                <button
                  className="secondary compact client-card-edit"
                  onClick={() => setEditingRecord({ kind: 'clients', id: client.id })}
                >
                  <Pencil size={14} /> Edit client
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
