import type { AppState } from '../../app/useAppState'
import { FilterBar, TaskTable } from './TaskTable'
import { waitingOnOptions } from './waitingOn'
import ClientSelect from '../../shared/ui/SearchSelect'
import { Archive, Columns3, Plus, Table2 } from 'lucide-react'
import TaskBoard from './TaskBoard'

/** Tasks screen. It reads the app state; see app/useAppState. */
export function TasksPage({ app }: { app: AppState }) {
  const {
    archiveTask,
    archivedTaskCount,
    reopenTask,
    setTaskArchiveView,
    taskArchiveView,
    boardGroup,
    boardShowSubtasks,
    canWrite,
    canWriteTasks,
    chooseTaskView,
    deleteTask,
    filteredTasks,
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
    taskLayout,
    taskProjectFilter,
    taskStatusFilter,
    today,
    updateTaskStatus,
    updateTaskWaitingOn,
    waitingFilter,
  } = app
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
        <FilterBar
          query={query}
          setQuery={setQuery}
          waiting={waitingFilter}
          setWaiting={setWaitingFilter}
          options={waitingOnOptions(store.taskSettings).map(option => option.label)}
        />
        <div className="task-filter-grid">
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
              clients={store.clients}
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
              {store.projects.map(project => (
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
          </div>
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
        {taskLayout === 'board' ? (
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
