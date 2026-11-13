import type { AppState } from '../../app/useAppState'
import { useState } from 'react'
import { SeedsBadge, type SourceFilter, SourceFilterSelect, sourceMatches } from '../seeds/SeedsPage'
import { Mail, Pencil, Plus, Sprout } from 'lucide-react'
import { isArchived, isClosedProject } from '../tasks/lifecycle'
import { Empty, StatusChip } from '../../shared/ui/Chips'
import { niceDate } from '../../shared/dates'
import type { Project } from '../../shared/types'
import { StatusReportDialog } from '../ai/StatusReportDialog'

/** Projects screen. It reads the app state; see app/useAppState. */
export function ProjectsPage({ app }: { app: AppState }) {
  const {
    canWrite,
    clientName,
    currentUser,
    setMovingToSeeds,
    hasModule,
    openItems,
    projectArchiveFilter,
    setEditingRecord,
    setModal,
    setProjectArchiveFilter,
    setSelectedProjectClientId,
    setSelectedProjectId,
    store,
  } = app
  const [source, setSource] = useState<SourceFilter>('seeds')
  const [reportFor, setReportFor] = useState<Project | null>(null)
  const shown = store.projects.filter(
    project =>
      (!store.seeds?.cutoverAt || sourceMatches(source, project)) &&
      // Projects closed in Seeds (resolved, completed…) count as archived here.
      (projectArchiveFilter === 'all' || isClosedProject(project) === (projectArchiveFilter === 'archived')),
  )
  return (
    <section className="page-stack">
      <div className="section-actions">
        <p className="page-intro">
          Projects are global delivery containers. Client association lives on tasks, so one project can serve multiple
          clients without mixing their client views.
        </p>
        {canWrite && (
          <button className="primary" onClick={() => setModal('project')}>
            <Plus size={18} /> New project
          </button>
        )}
      </div>
      <SourceFilterSelect app={app} value={source} onChange={setSource} />
      <label className="lifecycle-filter">
        Show projects
        <select value={projectArchiveFilter} onChange={e => setProjectArchiveFilter(e.target.value)}>
          <option value="active">Active</option>
          <option value="archived">Archived / Inactive</option>
          <option value="all">All</option>
        </select>
      </label>
      <div className="panel table-panel">
        <table>
          <thead>
            <tr>
              <th>Project</th>
              <th>Clients with tasks</th>
              <th>Status</th>
              <th>Target</th>
              <th>Open tasks</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 ? (
              <tr>
                <td colSpan={6}>
                  <Empty text="No projects in this view. Choose another filter or create a project." />
                </td>
              </tr>
            ) : (
              shown.map(project => {
                const clientIds = project.clientId
                  ? [project.clientId]
                  : [
                      ...new Set(
                        store.items
                          .filter(item => item.projectId === project.id && item.clientId)
                          .map(item => item.clientId as string),
                      ),
                    ]
                const clientLabel = clientIds.length
                  ? clientIds.map(id => clientName(id)).join(', ')
                  : 'No client tasks yet'
                return (
                  <tr key={project.id}>
                    <td>
                      <button
                        className="table-link project-name-link"
                        type="button"
                        onClick={() => {
                          setSelectedProjectClientId(null)
                          setSelectedProjectId(project.id)
                        }}
                      >
                        <strong>
                          {project.name} <SeedsBadge record={project} />
                        </strong>
                        <small>{project.summary || 'Open project dashboard'}</small>
                      </button>
                    </td>
                    <td>{clientLabel}</td>
                    <td>
                      <StatusChip value={isArchived(project) ? 'Archived · Inactive' : project.status} />
                    </td>
                    <td>{niceDate(project.targetDate)}</td>
                    <td>{openItems.filter(item => item.projectId === project.id).length}</td>
                    <td>
                      {canWrite && hasModule('projects') && (
                        <button
                          className="secondary compact"
                          onClick={() => setEditingRecord({ kind: 'projects', id: project.id })}
                        >
                          <Pencil size={14} /> Edit project
                        </button>
                      )}
                      {/* A weekly update for the client or the team, drafted from the project's work. */}
                      {!project.accessLimited && !isArchived(project) && (
                        <button type="button" className="secondary compact" onClick={() => setReportFor(project)}>
                          <Mail size={14} /> Status report
                        </button>
                      )}
                      {/* While moving to Seeds: an Administrator moves a Before Seeds project's tasks to a Seeds project. */}
                      {currentUser?.role === 'Administrator' &&
                        store.seeds?.cutoverAt &&
                        project.beforeSeeds &&
                        !isArchived(project) && (
                          <button
                            className="secondary compact"
                            onClick={() => setMovingToSeeds({ fromProjectId: project.id })}
                          >
                            <Sprout size={14} /> Move to Seeds…
                          </button>
                        )}
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>
      {reportFor && <StatusReportDialog project={reportFor} store={store} onClose={() => setReportFor(null)} />}
    </section>
  )
}
