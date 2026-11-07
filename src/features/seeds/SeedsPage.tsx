/**
 * The Seeds page: Clients, Projects and Tasks as tabs, plus Sync. Seeds decides which clients and projects each
 * person sees; this app keeps the subtasks, emails, trackers, documents and time.
 */
import { AlertTriangle, CheckCircle2, Link2, RefreshCw, Sprout, X } from 'lucide-react'
import { useState } from 'react'
import type { AppState } from '../../app/useAppState'
import type { View } from '../../app/navigation'
import type { SeedsMatch } from '../../shared/seeds'
import { decideMatch, syncSeeds } from './seedsApi'
import './seeds.css'

export const SEEDS_TABS: { id: Extract<View, 'clients' | 'projects' | 'items' | 'seeds'>; label: string }[] = [
  { id: 'clients', label: 'Clients' },
  { id: 'projects', label: 'Projects' },
  { id: 'items', label: 'Tasks' },
  { id: 'seeds', label: 'Sync' },
]
export const SEEDS_VIEWS = new Set<View>(SEEDS_TABS.map(tab => tab.id))

const when = (value?: string) => (value ? new Date(value).toLocaleString() : 'never')

/** Tabs across the top of Clients, Projects, Tasks and Sync, and a notice when Seeds cannot be read. */
export function SeedsTabs({ app }: { app: AppState }) {
  const { view, setView, hasModule, store } = app
  const seeds = store.seeds
  const tabs = SEEDS_TABS.filter(tab => tab.id === 'seeds' || hasModule(tab.id))
  return (
    <div className="seeds-tabs-wrap">
      <div className="seeds-tabs" role="tablist" aria-label="Seeds">
        <span className="seeds-tabs-brand">
          <Sprout size={16} aria-hidden="true" /> Seeds
        </span>
        {tabs.map(tab => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={view === tab.id}
            className={view === tab.id ? 'seeds-tab active' : 'seeds-tab'}
            onClick={() => {
              app.setSelectedClientId(null)
              app.setSelectedProjectId(null)
              setView(tab.id)
            }}
          >
            {tab.label}
            {tab.id === 'seeds' && Boolean(seeds?.pendingMatches?.length) && (
              <b className="seeds-tab-count">{seeds?.pendingMatches.length}</b>
            )}
          </button>
        ))}
      </div>
      {seeds?.connected && seeds.lastError && (
        <p className="seeds-banner" role="status">
          <AlertTriangle size={16} aria-hidden="true" /> Seeds could not be read ({seeds.lastError}) Showing access from
          the last sync, {when(seeds.lastSuccessAt)}.
        </p>
      )}
    </div>
  )
}

export function SeedsSyncPage({ app }: { app: AppState }) {
  const { store } = app
  const seeds = store.seeds
  const access = store.access
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState('')

  const run = async (label: string, action: () => Promise<{ ok: boolean; error?: string; pending?: number }>) => {
    setBusy(label)
    setMessage('')
    try {
      const result = await action()
      setMessage(
        result.ok
          ? `Synced.${result.pending ? ` ${result.pending} match${result.pending === 1 ? '' : 'es'} to confirm.` : ''}`
          : result.error || 'Seeds could not be read.',
      )
      await app.refreshWorkspace(true)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Seeds is unavailable right now.')
    } finally {
      setBusy('')
    }
  }

  // Parent tasks under a Seeds project that Seeds does not have: they keep working, marked so a PM can sort them.
  const seedsProjects = new Set(store.projects.filter(project => project.seedsId).map(project => project.id))
  const notInSeeds = store.items.filter(
    item =>
      !item.parentTaskId && !item.seedsId && item.projectId && seedsProjects.has(item.projectId) && !item.archived,
  )
  const counts = seeds?.counts

  return (
    <section className="page-stack seeds-page">
      <div className="panel seeds-status">
        <div className="panel-heading">
          <div>
            <h2>Seeds sync</h2>
            <p>
              {seeds?.connected
                ? `Last synced ${when(seeds.lastSuccessAt)}. Syncs on its own every 30 minutes.`
                : 'Seeds is not connected yet. An Administrator adds the Seeds API key in Settings › Integrations, and sync starts on its own.'}
            </p>
          </div>
          <span className={seeds?.connected ? (seeds.lastError ? 'role-badge warn' : 'role-badge ok') : 'role-badge'}>
            {seeds?.connected ? (seeds.lastError ? 'Needs attention' : 'Connected') : 'Not connected'}
          </span>
        </div>
        {counts && (
          <dl className="seeds-counts">
            {(['clients', 'projects', 'tasks', 'people', 'assignments'] as const).map(key => (
              <div key={key}>
                <dt>{key[0].toUpperCase() + key.slice(1)}</dt>
                <dd>{counts[key]}</dd>
              </div>
            ))}
          </dl>
        )}
        <p className="seeds-access-line">
          {access?.strictVisibility
            ? `Per-person visibility is on. ${access.roles.length ? `You are ${access.roles.join(', ')} on ${access.assignments.length} client${access.assignments.length === 1 ? '' : 's'} or project${access.assignments.length === 1 ? '' : 's'}.` : 'You have no assignments yet, so client work stays hidden.'}`
            : 'Per-person visibility is off: everyone in this account sees all clients.'}
        </p>
        {seeds?.connected && seeds.canReview && (
          <div className="integration-actions">
            <button
              type="button"
              className="primary"
              disabled={Boolean(busy)}
              onClick={() => void run('sync', syncSeeds)}
            >
              <RefreshCw size={16} className={busy === 'sync' ? 'spin' : undefined} /> Sync now
            </button>
          </div>
        )}
        {message && (
          <p role="status" className="settings-message">
            {message}
          </p>
        )}
      </div>

      {Boolean(seeds?.pendingMatches?.length) && (
        <div className="panel">
          <h2>Confirm these matches</h2>
          <p>These Seeds names are close to records already here. Confirm to link them, or keep them separate.</p>
          <ul className="seeds-list">
            {seeds?.pendingMatches.map((match: SeedsMatch) => (
              <li key={match.id}>
                <div>
                  <small>{match.kind === 'task' ? 'Task' : match.kind === 'project' ? 'Project' : 'Client'}</small>
                  <strong>{match.seedsName}</strong>
                  {match.contractNumber && <small> · {match.contractNumber}</small>}
                  <span className="seeds-arrow">in Seeds looks like</span>
                  <strong>{match.appName}</strong>
                  <span className="seeds-arrow">here</span>
                </div>
                <div className="seeds-row-actions">
                  <button
                    type="button"
                    className="primary"
                    disabled={Boolean(busy)}
                    onClick={() => void run(match.id, () => decideMatch(match.id, 'confirm'))}
                  >
                    <Link2 size={15} /> Same, link them
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={Boolean(busy)}
                    onClick={() => void run(match.id, () => decideMatch(match.id, 'reject'))}
                  >
                    <X size={15} /> Not the same
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {notInSeeds.length > 0 && (
        <div className="panel">
          <h2>Not in Seeds</h2>
          <p>
            Tasks under Seeds projects that Seeds does not list. They keep working; add them in Seeds (or rename them to
            match) so time rolls up to the right Seeds task.
          </p>
          <ul className="seeds-list">
            {notInSeeds.slice(0, 50).map(item => (
              <li key={item.id}>
                <div>
                  <strong>{item.title}</strong>
                  <small> · {app.projectName(item.projectId)}</small>
                </div>
                <button type="button" className="secondary" onClick={() => app.openTaskEditor(item.id)}>
                  Open
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {Boolean(seeds?.unmatchedPeople?.length) && (
        <div className="panel">
          <h2>People in Seeds without an account here</h2>
          <p>
            Seeds people are matched to users by email. Add these people in Users &amp; Permissions to give them access.
          </p>
          <ul className="seeds-list">
            {seeds?.unmatchedPeople.map(person => (
              <li key={person.id}>
                <div>
                  <strong>{person.name || person.email}</strong>
                  <small> · {person.email}</small>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {seeds?.connected && !seeds.lastError && !seeds.pendingMatches?.length && !notInSeeds.length && (
        <p className="seeds-all-good">
          <CheckCircle2 size={16} aria-hidden="true" /> Everything here matches Seeds.
        </p>
      )}
    </section>
  )
}

/** "Seeds" chip with the contract number, for linked clients, projects and tasks. */
export function SeedsBadge({
  record,
}: {
  record: { seedsId?: string; contractNumber?: string; seedsArchived?: boolean }
}) {
  if (!record.seedsId) return null
  return (
    <span
      className="seeds-badge"
      title={record.seedsArchived ? 'Archived in Seeds' : 'From Seeds: the name follows Seeds'}
    >
      <Sprout size={12} aria-hidden="true" />
      {record.contractNumber || 'Seeds'}
      {record.seedsArchived ? ' · archived' : ''}
    </span>
  )
}
