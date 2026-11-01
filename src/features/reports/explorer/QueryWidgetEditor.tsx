// Custom reports: the settings of a SQL query widget. People with Data explorer can change the SQL; everyone who can
// edit the report can change its title, its parameters and how the result is shown.
import { useEffect, useState, type ReactNode } from 'react'
import { Dialog } from '../../../shared/ui'
import type { Client, Project, UserAccount } from '../../../shared/types'
import { QUERY_VIEWS, type QueryView, type Widget } from '../custom/reportModel'
import { ParamInput, VIEW_LABELS } from './DataExplorer'
import { REPORT_PARAMS } from './reportParams'
import { queryParams, tableIdentifierParams } from './sqlEngine'

export function QueryWidgetEditor({
  widget: initial,
  canWriteSql,
  clients,
  projects,
  accounts,
  tableNames,
  loadTrackers,
  preview,
  onSave,
  onClose,
}: {
  widget: Widget
  canWriteSql: boolean
  clients: Client[]
  projects: Project[]
  accounts: UserAccount[]
  tableNames: string[]
  loadTrackers: () => Promise<unknown>
  preview: (widget: Widget) => ReactNode
  onSave: (widget: Widget) => void
  onClose: () => void
}) {
  const [widget, setWidget] = useState<Widget>(initial)
  const query = widget.query || { sql: '', view: 'table' as QueryView, params: {} }
  const setQuery = (patch: Partial<typeof query>) =>
    setWidget(current => ({ ...current, query: { ...query, ...patch } }))
  const names = queryParams(query.sql)
  const hasTableIdentifier = tableIdentifierParams(query.sql).length > 0
  useEffect(() => {
    if (hasTableIdentifier) void loadTrackers()
  }, [hasTableIdentifier, loadTrackers])
  return (
    <Dialog title={widget.title || 'SQL query'} eyebrow="Widget settings" onClose={onClose} size="wide">
      <div className="crp-editor">
        <div className="crp-editor-preview">
          <div className={`crp-cell crp-kind-query crp-preview-cell dx-view-${query.view}`}>{preview(widget)}</div>
          <p className="crp-muted">The query runs in your browser each time the report opens, on fresh data.</p>
        </div>
        <form
          className="crp-editor-form"
          onSubmit={event => {
            event.preventDefault()
            onSave({
              ...widget,
              query: { ...query, params: Object.fromEntries(names.map(name => [name, query.params[name] ?? ''])) },
            })
          }}
        >
          <div className="crp-kinds" role="group" aria-label="Show the result as">
            {QUERY_VIEWS.map(view => (
              <button
                type="button"
                key={view}
                className={query.view === view ? 'on' : ''}
                aria-pressed={query.view === view}
                onClick={() => setQuery({ view })}
              >
                {VIEW_LABELS[view]}
              </button>
            ))}
          </div>
          <label className="crp-form-row">
            <span>Title</span>
            <input
              value={widget.title}
              maxLength={120}
              onChange={event => setWidget(current => ({ ...current, title: event.target.value }))}
            />
          </label>
          <label className="crp-form-row">
            <span>SQL</span>
            <textarea
              className="dx-sql"
              rows={Math.min(14, Math.max(5, query.sql.split('\n').length + 1))}
              spellCheck={false}
              value={query.sql}
              readOnly={!canWriteSql}
              maxLength={20000}
              onChange={event => setQuery({ sql: event.target.value })}
            />
            {!canWriteSql && <small>Only Administrators and people given Data explorer can change the SQL.</small>}
          </label>
          {names.length > 0 && (
            <fieldset>
              <legend>Parameters</legend>
              <div className="dx-run">
                {names.map(name => (
                  <ParamInput
                    key={name}
                    name={name}
                    value={query.params[name] ?? ''}
                    clients={clients}
                    projects={projects}
                    accounts={accounts}
                    tableNames={tableNames}
                    isTableIdentifier={tableIdentifierParams(query.sql).includes(name)}
                    onChange={value => setQuery({ params: { ...query.params, [name]: value } })}
                  />
                ))}
              </div>
              <p className="crp-muted">
                Left empty, {REPORT_PARAMS} take the report’s own filters, so people viewing the report can change them.
                Other empty parameters mean NULL.
              </p>
            </fieldset>
          )}
          <div className="k-dialog-actions crp-editor-actions">
            <span className="crp-spacer" />
            <button type="button" className="crp-btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="crp-btn primary">
              Apply
            </button>
          </div>
        </form>
      </div>
    </Dialog>
  )
}
