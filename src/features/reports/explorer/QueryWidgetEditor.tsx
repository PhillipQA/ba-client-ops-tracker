// The settings of a SQL query widget, on a report or the Action Center. People with Data explorer can change the SQL
// (typed, built without SQL, or asked of Jarvis); everyone who can edit the widget can change its title, its parameters
// and how the result is shown.
import { Wand2 } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Dialog } from '../../../shared/ui'
import type { Client, Project, UserAccount } from '../../../shared/types'
import { QUERY_VIEWS, type QueryView, type Widget } from '../custom/reportModel'
import { ParamInput, VIEW_LABELS } from './DataExplorer'
import type { TableInfo } from './explorerTables'
import { JarvisBar } from './Jarvis'
import { QueryBuilderFields } from './QueryBuilderFields'
import { type Builder, builderSql, emptyBuilder } from './queryBuilder'
import { REPORT_PARAMS } from './reportParams'
import { queryParams, SqlError, type SqlResult, tableIdentifierParams } from './sqlEngine'

/** The Data explorer's tables and runner, for the builder and Jarvis. */
type Explorer = {
  catalog: TableInfo[]
  run: (sql: string, params: Record<string, string>) => Promise<SqlResult>
  loadTrackers: () => Promise<unknown>
}

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
  explorer,
  canAskJarvis = false,
  eyebrow = 'Widget settings',
  about = 'The query runs in your browser each time the report opens, on fresh data.',
  saveLabel = 'Apply',
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
  /** With the Data explorer's tables, people who can write SQL also get the builder (a query without SQL). */
  explorer?: Explorer
  /** Jarvis writes, changes, fixes and explains the query (needs `explorer`). */
  canAskJarvis?: boolean
  eyebrow?: string
  /** Under the preview: when the query runs. */
  about?: string
  saveLabel?: string
}) {
  const [widget, setWidget] = useState<Widget>(initial)
  const [builder, setBuilder] = useState<Builder | null>(null)
  const [runError, setRunError] = useState('')
  const query = widget.query || { sql: '', view: 'table' as QueryView, params: {} }
  const setQuery = (patch: Partial<typeof query>) =>
    setWidget(current => ({ ...current, query: { ...query, ...patch } }))
  const names = queryParams(query.sql)
  const hasTableIdentifier = tableIdentifierParams(query.sql).length > 0
  const setSql = (sql: string) => {
    setQuery({ sql })
    setBuilder(null)
  }
  const applyBuilder = (next: Builder) => {
    if (!explorer) return
    setBuilder(next)
    setQuery({ sql: builderSql(next, explorer.catalog) })
  }
  /** Runs a query for Jarvis: resolves with its error message, or '' when it ran. The preview shows the result. */
  const tryRun = async (sql: string) => {
    if (!explorer) return ''
    try {
      await explorer.run(sql, Object.fromEntries(queryParams(sql).map(name => [name, query.params[name] ?? ''])))
      setRunError('')
      return ''
    } catch (problem) {
      const message = problem instanceof SqlError ? problem.message : 'The query could not run.'
      setRunError(message)
      return message
    }
  }
  useEffect(() => {
    if (hasTableIdentifier) void loadTrackers()
  }, [hasTableIdentifier, loadTrackers])
  return (
    <Dialog title={widget.title || 'SQL query'} eyebrow={eyebrow} onClose={onClose} size="wide">
      <div className="crp-editor">
        <div className="crp-editor-preview">
          <div className={`crp-cell crp-kind-query crp-preview-cell dx-view-${query.view}`}>{preview(widget)}</div>
          <p className="crp-muted">{about}</p>
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
          {canWriteSql && explorer && (
            <div className="dx-panel">
              <div className="dx-panel-head">
                <span>
                  <Wand2 size={14} /> Builder
                </span>
                {builder ? (
                  <button type="button" className="crp-link" onClick={() => setBuilder(null)}>
                    Close the builder
                  </button>
                ) : (
                  <button type="button" className="crp-link" onClick={() => applyBuilder(emptyBuilder())}>
                    Build a query without SQL
                  </button>
                )}
              </div>
              {builder && <QueryBuilderFields builder={builder} catalog={explorer.catalog} onChange={applyBuilder} />}
            </div>
          )}
          {canWriteSql && explorer && canAskJarvis && (
            <JarvisBar explorer={explorer} sql={query.sql} setSql={setSql} run={tryRun} error={runError} />
          )}
          <label className="crp-form-row">
            <span>SQL</span>
            <textarea
              className="dx-sql"
              rows={Math.min(14, Math.max(5, query.sql.split('\n').length + 1))}
              spellCheck={false}
              value={query.sql}
              readOnly={!canWriteSql}
              maxLength={20000}
              onChange={event => setSql(event.target.value)}
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
                Left empty, {REPORT_PARAMS} take the report’s own filters. To filter rows, use these parameters in a
                WHERE condition, for example: {'({{client}} IS NULL OR client = {{client}})'}. Other empty parameters
                mean NULL.
              </p>
            </fieldset>
          )}
          <div className="k-dialog-actions crp-editor-actions">
            <span className="crp-spacer" />
            <button type="button" className="crp-btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="crp-btn primary" disabled={!query.sql.trim()}>
              {saveLabel}
            </button>
          </div>
        </form>
      </div>
    </Dialog>
  )
}
