import type { AppState } from '../../app/useAppState'
import { FilterBar, TaskTable } from './TaskTable'
import { waitingOnOptions } from './waitingOn'
import ClientSelect from '../../shared/ui/SearchSelect'
import { Archive, CalendarDays, Columns3, GanttChart, Plus, Save, Table2, Trash2 } from 'lucide-react'
import { useState } from 'react'
import './taskViews.css'
import TaskBoard from './TaskBoard'
import TaskCalendar from './TaskCalendar'
import TaskTimeline from './TaskTimeline'
import { type SavedTaskView, viewSummary } from './taskViews'
import { useSavedTaskViews } from './useSavedTaskViews'
import { type SourceFilter, sourceMatches } from '../seeds/SeedsPage'
import { isClosedProject } from './lifecycle'
import { isBeforeSeedsWork } from '../../shared/seeds'

/**
 * Tasks screen. It reads the app state; see app/useAppState. One filtered list, shown as a Table, Board, Calendar or
 * Timeline; your saved views keep a set of filters with a layout under a name.
 */
export function TasksPage({ app }: { app: AppState }) {
  const {
    archiveTask,
    archivedTaskCount,
    authUser,
    reopenTask,
    setTaskArchiveView,
    taskArchiveView,
    boardGroup,
    boardShowSubtasks,
    canWrite,
    canWriteTasks,
    chooseTaskView,
    deleteTask,
    filteredTasks: allFiltered,
    openSubtaskCreator,
    openTaskEditor,
    query,
    reorderSubtasks,
    resolveItem,
    setModal,
    setQuery,
    setTaskClientFilter,
    setTaskDateFilter,
    setTaskProjectFilter,
    setTaskPreset,
    setTaskStatusFilter,
    setWaitingFilter,
    store,
    taskClientFilter,
    taskDateFilter,
    taskCalendarDate,
    taskLayout,
    taskProjectFilter,
    taskStatusFilter,
    today,
    updateTaskStatus,
    updateTaskWaitingOn,
    waitingFilter,
  } = app
  // Once Seeds is on, tasks are in the same folders as their project (or, with no project, their client): From Seeds
  // or Before Seeds. Tasks with neither count as From Seeds.
  const [folder, setFolder] = useState<SourceFilter>('seeds')
  // Saved views: the chosen one, and the name being typed for a new one (null when not saving).
  const saved = useSavedTaskViews(authUser ? `${authUser.organizationId || ''}:${authUser.id}` : '')
  const [viewId, setViewId] = useState('')
  const [naming, setNaming] = useState<string | null>(null)
  const current = (): Omit<SavedTaskView, 'id' | 'name'> => ({
    layout: taskLayout,
    group: boardGroup,
    subtasks: boardShowSubtasks,
    calendarDate: taskCalendarDate,
    filters: {
      query,
      status: taskStatusFilter,
      client: taskClientFilter,
      project: taskProjectFilter,
      date: taskDateFilter,
      waiting: waitingFilter,
    },
  })
  const chosenView = saved.views.find(view => view.id === viewId)
  const changedFromView =
    chosenView &&
    JSON.stringify({ ...chosenView, id: '', name: '' }) !== JSON.stringify({ ...current(), id: '', name: '' })
  const applyView = (view: SavedTaskView) => {
    setQuery(view.filters.query)
    setTaskStatusFilter(view.filters.status)
    setTaskClientFilter(view.filters.client)
    setTaskProjectFilter(view.filters.project)
    setTaskDateFilter(view.filters.date)
    setWaitingFilter(view.filters.waiting)
    chooseTaskView({ layout: view.layout, group: view.group, subtasks: view.subtasks, calendarDate: view.calendarDate })
  }
  const saveNew = async () => {
    const name = (naming || '').trim()
    if (!name) return
    const id = `view-${Date.now().toString(36)}`
    const rest = saved.views.filter(view => view.name.toLowerCase() !== name.toLowerCase())
    if (await saved.save([...rest, { id, name, ...current() }])) {
      setViewId(id)
      setNaming(null)
    }
  }
  const openTask = canWriteTasks ? openTaskEditor : undefined
  const cutover = Boolean(store.seeds?.cutoverAt)
  const filteredTasks = cutover
    ? allFiltered.filter(item =>
        sourceMatches(folder, { beforeSeeds: isBeforeSeedsWork(item, store.projects, store.clients) }),
      )
    : allFiltered
  // The client and project pickers follow the folder too.
  const folderClients = cutover ? store.clients.filter(client => sourceMatches(folder, client)) : store.clients
  // Projects closed in Seeds (resolved, completed…) drop out of the Project filter unless one is chosen.
  const folderProjects = store.projects.filter(
    project =>
      (!cutover || sourceMatches(folder, project)) && (!isClosedProject(project) || project.id === taskProjectFilter),
  )
  return (
    <section className="page-stack">
      <div className="panel">
        <div className="panel-heading">
          <div>
            <h2>{taskArchiveView === 'archived' ? 'Archived tasks' : 'All tasks'}</h2>
            <p>
              {taskArchiveView === 'archived'
                ? 'Closed tasks that were put away, with their subtasks. Reopen one to bring it back to Tasks.'
                : 'Tasks, requirements, issues, inquiries, decisions, and follow-ups in one searchable list.'}
            </p>
          </div>
          <span className="count-pill">
            {filteredTasks.length} shown · {store.items.length} total
          </span>
          {canWrite && taskArchiveView !== 'archived' && (
            <button
              type="button"
              className="primary"
              data-tour="add-task"
              onClick={() => {
                setTaskPreset(null)
                setModal('item')
              }}
            >
              <Plus size={18} /> New task
            </button>
          )}
          <div className="client-layout-switch" role="group" aria-label="Active or archived tasks">
            <button
              type="button"
              aria-pressed={taskArchiveView === 'active'}
              onClick={() => setTaskArchiveView('active')}
            >
              <span>Active</span>
            </button>
            <button
              type="button"
              aria-pressed={taskArchiveView === 'archived'}
              onClick={() => setTaskArchiveView('archived')}
              title="Archived tasks"
            >
              <Archive size={16} />
              <span>Archived{archivedTaskCount ? ` (${archivedTaskCount})` : ''}</span>
            </button>
          </div>
        </div>
        <div className="task-saved-views">
          <label>
            View
            <select
              value={chosenView ? viewId : ''}
              onChange={event => {
                const view = saved.views.find(candidate => candidate.id === event.target.value)
                setViewId(view?.id || '')
                if (view) applyView(view)
              }}
            >
              <option value="">{saved.views.length ? 'Choose a saved view' : 'No saved views yet'}</option>
              {saved.views.map(view => (
                <option key={view.id} value={view.id} title={viewSummary(view)}>
                  {view.name}
                </option>
              ))}
            </select>
          </label>
          {naming === null ? (
            <>
              <button type="button" className="secondary" onClick={() => setNaming('')}>
                <Save size={14} /> Save as view
              </button>
              {chosenView && changedFromView && (
                <button
                  type="button"
                  className="secondary"
                  onClick={() =>
                    void saved.save(
                      saved.views.map(view => (view.id === chosenView.id ? { ...view, ...current() } : view)),
                    )
                  }
                >
                  Update “{chosenView.name}”
                </button>
              )}
              {chosenView && (
                <button
                  type="button"
                  className="secondary"
                  aria-label={`Delete the view ${chosenView.name}`}
                  onClick={() => {
                    if (!window.confirm(`Delete the view “${chosenView.name}”? Your tasks are not changed.`)) return
                    void saved
                      .save(saved.views.filter(view => view.id !== chosenView.id))
                      .then(ok => ok && setViewId(''))
                  }}
                >
                  <Trash2 size={14} />
                </button>
              )}
            </>
          ) : (
            <form
              className="task-saved-views-name"
              onSubmit={event => {
                event.preventDefault()
                void saveNew()
              }}
            >
              <input
                aria-label="Name of the view"
                placeholder="e.g. My overdue, This week’s due"
                maxLength={60}
                value={naming}
                onChange={event => setNaming(event.target.value)}
              />
              <button type="submit" className="primary" disabled={!naming.trim()}>
                Save
              </button>
              <button type="button" className="secondary" onClick={() => setNaming(null)}>
                Cancel
              </button>
            </form>
          )}
          <span className="muted task-saved-views-note">
            {saved.error ||
              (saved.onServer
                ? 'Saves the filters below and the layout, just for you.'
                : 'Saves the filters below and the layout in this browser.')}
          </span>
        </div>
        <FilterBar
          query={query}
          setQuery={setQuery}
          waiting={waitingFilter}
          setWaiting={setWaitingFilter}
          options={waitingOnOptions(store.taskSettings).map(option => option.label)}
        />
        <div className="task-filter-grid">
          {cutover && (
            <label>
              Folder
              <select
                value={folder}
                onChange={event => {
                  setFolder(event.target.value as SourceFilter)
                  setTaskClientFilter('')
                  setTaskProjectFilter('')
                }}
              >
                <option value="seeds">From Seeds</option>
                <option value="before">Before Seeds</option>
                <option value="all">All</option>
              </select>
            </label>
          )}
          <label>
            Status
            <select value={taskStatusFilter} onChange={event => setTaskStatusFilter(event.target.value)}>
              <option value="">All statuses</option>
              {[
                ...new Set([
                  ...store.taskSettings.statuses.map(status => status.label),
                  ...store.items.map(item => item.status),
                ]),
              ]
                .filter(Boolean)
                .map(status => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Client
            <ClientSelect
              clients={folderClients}
              value={taskClientFilter}
              onChange={value => {
                setTaskClientFilter(value)
                setTaskProjectFilter('')
              }}
              extra={[
                { value: '', label: 'All clients' },
                { value: '__none__', label: 'General / no client' },
              ]}
            />
          </label>
          <label>
            Project
            <select value={taskProjectFilter} onChange={event => setTaskProjectFilter(event.target.value)}>
              <option value="">All projects</option>
              <option value="__none__">No project</option>
              {folderProjects.map(project => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Due / follow-up
            <select
              value={taskDateFilter}
              onChange={event => setTaskDateFilter(event.target.value as typeof taskDateFilter)}
            >
              <option value="All">All dates</option>
              <option value="due-3">Due in next 3 days</option>
              <option value="due-7">Due in next 7 days</option>
              <option value="followup-3">Follow-up in next 3 days</option>
              <option value="followup-7">Follow-up in next 7 days</option>
              <option value="overdue">Overdue due/follow-up</option>
            </select>
          </label>
          <button
            className="secondary task-filter-clear"
            type="button"
            onClick={() => {
              setTaskClientFilter('')
              setTaskProjectFilter('')
              setTaskStatusFilter('')
              setTaskDateFilter('All')
              setWaitingFilter('All')
              setQuery('')
            }}
          >
            Clear filters
          </button>
        </div>
        <div className="task-view-toolbar">
          <div className="client-layout-switch" role="group" aria-label="Task layout">
            <button
              type="button"
              aria-pressed={taskLayout === 'table'}
              onClick={() => chooseTaskView({ layout: 'table' })}
              title="Table"
            >
              <Table2 size={16} />
              <span>Table</span>
            </button>
            <button
              type="button"
              aria-pressed={taskLayout === 'board'}
              onClick={() => chooseTaskView({ layout: 'board' })}
              title="Board"
            >
              <Columns3 size={16} />
              <span>Board</span>
            </button>
            <button
              type="button"
              aria-pressed={taskLayout === 'calendar'}
              onClick={() => chooseTaskView({ layout: 'calendar' })}
              title="Calendar"
            >
              <CalendarDays size={16} />
              <span>Calendar</span>
            </button>
            <button
              type="button"
              aria-pressed={taskLayout === 'timeline'}
              onClick={() => chooseTaskView({ layout: 'timeline' })}
              title="Timeline"
            >
              <GanttChart size={16} />
              <span>Timeline</span>
            </button>
          </div>
          {taskLayout === 'calendar' && (
            <>
              <span className="toolbar-label" id="calendar-date-label">
                Show by
              </span>
              <div className="client-layout-switch" role="group" aria-labelledby="calendar-date-label">
                <button
                  type="button"
                  aria-pressed={taskCalendarDate === 'due'}
                  onClick={() => chooseTaskView({ calendarDate: 'due' })}
                >
                  <span>Due date</span>
                </button>
                <button
                  type="button"
                  aria-pressed={taskCalendarDate === 'followUp'}
                  onClick={() => chooseTaskView({ calendarDate: 'followUp' })}
                >
                  <span>Follow-up date</span>
                </button>
              </div>
            </>
          )}
          {taskLayout === 'board' && (
            <>
              <span className="toolbar-label" id="board-group-label">
                Group by
              </span>
              <div className="client-layout-switch" role="group" aria-labelledby="board-group-label">
                <button
                  type="button"
                  aria-pressed={boardGroup === 'status'}
                  onClick={() => chooseTaskView({ group: 'status' })}
                >
                  <span>Status</span>
                </button>
                <button
                  type="button"
                  aria-pressed={boardGroup === 'waiting'}
                  onClick={() => chooseTaskView({ group: 'waiting' })}
                >
                  <span>Waiting on</span>
                </button>
              </div>
              <label className="toolbar-check">
                <input
                  type="checkbox"
                  checked={boardShowSubtasks}
                  onChange={event => chooseTaskView({ subtasks: event.target.checked })}
                />{' '}
                Show subtasks as cards
              </label>
            </>
          )}
        </div>
        {taskLayout === 'calendar' ? (
          <TaskCalendar
            items={filteredTasks}
            allItems={store.items}
            taskSettings={store.taskSettings}
            today={today}
            dateField={taskCalendarDate}
            onOpen={openTask}
          />
        ) : taskLayout === 'timeline' ? (
          <TaskTimeline
            items={filteredTasks}
            allItems={store.items}
            taskSettings={store.taskSettings}
            today={today}
            onOpen={openTask}
          />
        ) : taskLayout === 'board' ? (
          <TaskBoard
            items={filteredTasks}
            allItems={store.items}
            clients={store.clients}
            projects={store.projects}
            accounts={store.accounts}
            taskSettings={store.taskSettings}
            group={boardGroup}
            showSubtasks={boardShowSubtasks}
            today={today}
            canEdit={canWriteTasks}
            onStatusChange={updateTaskStatus}
            onWaitingChange={updateTaskWaitingOn}
            onOpen={canWriteTasks ? openTaskEditor : undefined}
          />
        ) : (
          <TaskTable
            items={filteredTasks}
            allItems={store.items}
            clients={store.clients}
            projects={store.projects}
            taskSettings={store.taskSettings}
            onResolve={resolveItem}
            onStatusChange={updateTaskStatus}
            onEdit={openTaskEditor}
            onDelete={deleteTask}
            onCreateSubtask={openSubtaskCreator}
            onReorderSubtasks={reorderSubtasks}
            canEdit={canWriteTasks}
            onArchive={archiveTask}
            onReopen={reopenTask}
          />
        )}
      </div>
    </section>
  )
}
