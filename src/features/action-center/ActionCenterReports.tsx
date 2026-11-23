/**
 * Report widgets on the Action Center: ones a person builds here (with the Reports builder, or as a SQL query on the
 * Data explorer's tables, written, built without SQL or by Jarvis), and ones pinned from a saved report (which follow
 * the report). All are worked out in the browser from the same data Reports and the Data explorer read.
 */
import { ExternalLink, X } from 'lucide-react'
import { lazy, type ReactNode, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { businessDateKey } from '../../shared/businessDate'
import type { AppState, SignedInUser } from '../../app/useAppState'
import type { UserAccount } from '../../shared/types'
import { reportApi } from '../reports/custom/reportApi'
import { computeWidget, rangeDates, type ReportData } from '../reports/custom/reportData'
import {
  newWidget,
  type ReportFilters,
  type ReportItem,
  WIDGET_LABELS,
  type Widget,
} from '../reports/custom/reportModel'
import { WidgetBody } from '../reports/custom/ReportWidgets'
import { trackerProblemOf, useReportSources, useTrackerData } from '../reports/custom/useReportSources'
import { QueryResultView, useQueryRun } from '../reports/explorer/QueryResult'
import { reportQueryParams, type ReportFilterValues } from '../reports/explorer/reportParams'
import { useExplorerData } from '../reports/explorer/useExplorerData'
import { type Drill, recordRows, widgetDrillRecords } from './drillDown'
import '../reports/custom/customReports.css'
import '../reports/explorer/dataExplorer.css'

const NO_FILTERS: ReportFilters = { range: 'all' }
// The widget editors download when a widget is built or changed, not with the Action Center.
const WidgetEditor = lazy(() =>
  import('../reports/custom/WidgetEditor').then(module => ({ default: module.WidgetEditor })),
)
const QueryWidgetEditor = lazy(() =>
  import('../reports/explorer/QueryWidgetEditor').then(module => ({ default: module.QueryWidgetEditor })),
)

/** The data report widgets read, for the signed-in person. */
export function useReportEngine(app: AppState, currentUser: SignedInUser, canUseTrackers: boolean) {
  const { store } = app
  const today = businessDateKey()
  const me: UserAccount = useMemo(
    () =>
      store.accounts.find(account => account.id === currentUser.id) ||
      ({ id: currentUser.id, name: currentUser.name || '', role: currentUser.role } as unknown as UserAccount),
    [store.accounts, currentUser.id, currentUser.name, currentUser.role],
  )
  const trackers = useTrackerData(canUseTrackers)
  const data: ReportData = useMemo(
    () => ({
      clients: store.clients,
      projects: store.projects,
      items: store.items,
      planner: store.planner,
      workEvents: store.workEvents || [],
      accounts: store.accounts,
      taskSettings: store.taskSettings,
      today,
      currentUser: me,
      trackers: trackers.loaded,
      dateOf: iso => businessDateKey(iso),
    }),
    [
      store.clients,
      store.projects,
      store.items,
      store.planner,
      store.workEvents,
      store.accounts,
      store.taskSettings,
      today,
      me,
      trackers.loaded,
    ],
  )
  const { recordsFor, fieldsFor } = useReportSources(data, trackers)
  return { data, today, me, trackers, recordsFor, fieldsFor, canUseTrackers }
}
export type ReportEngine = ReturnType<typeof useReportEngine>

/**
 * The Data explorer's tables, for SQL widgets. As in Reports: Administrators and people given Data explorer query the
 * whole account, everyone else their own work. Trackers and Work Hub messages load only when a query reads them.
 */
export function useActionCenterExplorer(
  app: AppState,
  engine: ReportEngine,
  access: { canUseInbox: boolean; wholeAccount: boolean },
) {
  const { store } = app
  return useExplorerData({
    clients: store.clients,
    projects: store.projects,
    items: store.items,
    planner: store.planner,
    workEvents: store.workEvents || [],
    accounts: store.accounts,
    taskSettings: store.taskSettings,
    currentUser: engine.me,
    canUseTrackers: engine.canUseTrackers,
    canUseInbox: access.canUseInbox,
    wholeAccount: access.wholeAccount,
  })
}
export type ActionCenterExplorer = ReturnType<typeof useExplorerData>

const NO_FILTER_VALUES: ReportFilterValues = { range: null, client: '', project: '', person: '' }

/** A report's filters as the values its SQL widgets' parameters take. */
function filterValuesOf(filters: ReportFilters, data: ReportData): ReportFilterValues {
  return {
    range: rangeDates(filters, data.today),
    client: data.clients.find(client => client.id === filters.clientId)?.name || '',
    project: data.projects.find(project => project.id === filters.projectId)?.name || '',
    person: (filters.userId && data.accounts.find(account => account.id === filters.userId)?.name) || '',
    clientId: filters.clientId || '',
    projectId: filters.projectId || '',
    personId: filters.userId || '',
  }
}

/** A SQL widget's result: run in the browser, again whenever the data changes. */
function QueryView({
  widget,
  values,
  explorer,
  refresh,
}: {
  widget: Widget
  values: ReportFilterValues
  explorer: ActionCenterExplorer
  refresh: unknown
}) {
  const query = widget.query ? { ...widget.query, params: reportQueryParams(widget.query, values) } : undefined
  const { result, error, running } = useQueryRun(explorer.run, query, refresh)
  const view = widget.query?.view || 'table'
  return (
    <div className={`crp-cell crp-kind-query ac-report-body dx-view-${view}`}>
      {error ? (
        <div className="crp-empty dx-error">{error}</div>
      ) : result ? (
        <QueryResultView result={result} view={view} today={explorer.today} />
      ) : (
        <div className="crp-empty">{running ? 'Running the query…' : ''}</div>
      )}
    </div>
  )
}

/** The numbers, chart or table of one widget. With onDrill, a bar, slice, point or metric opens its records. */
function WidgetView({
  widget,
  filters,
  engine,
  onDrill,
}: {
  widget: Widget
  filters: ReportFilters
  engine: ReportEngine
  onDrill?: (drill: Drill) => void
}) {
  const { trackers, recordsFor, fieldsFor, today } = engine
  useEffect(() => {
    if (widget.source === 'tracker') trackers.ensure(widget.trackerId)
  }, [widget.source, widget.trackerId, trackers.ensure])
  const problem = trackerProblemOf(widget, trackers, true)
  const fields = fieldsFor(widget.source, widget.trackerId)
  const records = recordsFor(widget.source, widget.trackerId)
  const computed = useMemo(
    () => (problem ? null : computeWidget(widget, records, fields, filters, today)),
    [widget, records, fields, filters, today, problem],
  )
  const pick = (key: string | null, label: string) => {
    if (!onDrill) return
    const found = widgetDrillRecords(widget, records, fields, filters, today, key)
    const name = widget.title || WIDGET_LABELS[widget.kind]
    onDrill({
      title: key === null ? name : `${name}: ${label}`,
      subtitle: key === null ? label : undefined,
      ...recordRows(found, fields, widget, widget.source === 'tasks'),
    })
  }
  const drillable = Boolean(onDrill) && ['metric', 'bar', 'column', 'line', 'pie', 'table'].includes(widget.kind)
  return (
    <div className={`crp-cell crp-kind-${widget.kind} ac-report-body${drillable ? ' ac-report-drillable' : ''}`}>
      <WidgetBody
        widget={widget}
        computed={computed}
        fields={fields}
        today={today}
        problem={problem}
        onPick={drillable ? pick : undefined}
      />
    </div>
  )
}

function ReportPanel({
  title,
  sub,
  actions,
  children,
}: {
  title: string
  sub: string
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="panel dashboard-panel ac-report crp-page">
      <div className="panel-heading dashboard-panel-heading">
        <div>
          <h2>{title}</h2>
          <p>{sub}</p>
        </div>
        {actions && <div className="dashboard-panel-actions">{actions}</div>}
      </div>
      {children}
    </div>
  )
}

export function CustomWidget({
  widget,
  engine,
  explorer,
  onDrill,
}: {
  widget: Widget
  engine: ReportEngine
  explorer: ActionCenterExplorer
  onDrill?: (drill: Drill) => void
}) {
  return (
    <ReportPanel
      title={widget.title || WIDGET_LABELS[widget.kind]}
      sub={widget.kind === 'query' ? 'Your own widget · Data explorer' : 'Your own widget'}
    >
      {widget.kind === 'query' ? (
        <QueryView widget={widget} values={NO_FILTER_VALUES} explorer={explorer} refresh={engine.data} />
      ) : widget.kind === 'note' ? (
        <div className="crp-cell crp-kind-note ac-report-body">
          <p className="crp-note">{widget.text}</p>
        </div>
      ) : (
        <WidgetView widget={widget} filters={NO_FILTERS} engine={engine} onDrill={onDrill} />
      )}
    </ReportPanel>
  )
}

/** Saved reports, loaded once when a pinned widget needs them. */
export function useSavedReports(enabled: boolean) {
  const [items, setItems] = useState<ReportItem[] | null>(null)
  const [error, setError] = useState('')
  const load = useCallback(() => {
    reportApi
      .list()
      .then(result => {
        setItems(result.items || [])
        setError('')
      })
      .catch(failure => setError(failure instanceof Error ? failure.message : 'Reports could not be loaded.'))
  }, [])
  useEffect(() => {
    if (enabled && !items) load()
  }, [enabled, items, load])
  return { items, error, reload: load }
}

export function PinnedWidget({
  reportId,
  widgetId,
  reports,
  engine,
  explorer,
  onOpenReport,
  onRemove,
  onDrill,
}: {
  reportId: string
  widgetId: string
  reports: ReturnType<typeof useSavedReports>
  engine: ReportEngine
  explorer: ActionCenterExplorer
  onOpenReport: () => void
  onRemove?: () => void
  onDrill?: (drill: Drill) => void
}) {
  const report = reports.items?.find(item => item.id === reportId && item.kind === 'report')
  const widget = report?.definition?.widgets.find(item => item.id === widgetId)
  if (reports.error)
    return (
      <ReportPanel title="Pinned widget" sub="From Reports">
        <p className="ac-widget-note">{reports.error}</p>
      </ReportPanel>
    )
  if (!reports.items)
    return (
      <ReportPanel title="Pinned widget" sub="From Reports">
        <p className="ac-widget-note">Loading…</p>
      </ReportPanel>
    )
  if (!report || !widget)
    return (
      <ReportPanel
        title="Pinned widget"
        sub="From Reports"
        actions={
          onRemove && (
            <button type="button" className="secondary" onClick={onRemove}>
              <X size={14} /> Remove
            </button>
          )
        }
      >
        <p className="ac-widget-note">
          {report ? 'This widget was taken off its report.' : 'Its report was deleted or is no longer shared with you.'}{' '}
          You can remove it from your Action Center.
        </p>
      </ReportPanel>
    )
  const title = widget.title || WIDGET_LABELS[widget.kind]
  return (
    <ReportPanel
      title={title}
      sub={`From report: ${report.name}`}
      actions={
        <button type="button" className="secondary" onClick={onOpenReport}>
          <ExternalLink size={14} /> Open report
        </button>
      }
    >
      {widget.kind === 'query' ? (
        <QueryView
          widget={widget}
          values={filterValuesOf(report.definition.filters || NO_FILTERS, engine.data)}
          explorer={explorer}
          refresh={engine.data}
        />
      ) : (
        <WidgetView
          widget={widget}
          filters={report.definition.filters || NO_FILTERS}
          engine={engine}
          onDrill={onDrill}
        />
      )}
    </ReportPanel>
  )
}

/** A new SQL widget: a starting query the person changes, builds without SQL or asks Jarvis for. */
export const newSqlWidget = (): Widget => ({
  ...newWidget('query', { x: 0, y: 0 }),
  title: 'Open work by client',
  query: {
    sql: 'SELECT client, count(*) AS open\nFROM tasks\nWHERE done = false\nGROUP BY client\nORDER BY open DESC',
    view: 'bar',
    params: {},
  },
})

/**
 * A widget of the person's own on the Action Center: the Reports builder for numbers, charts and tables, or the SQL
 * widget settings (with the builder and Jarvis) for a query on the Data explorer's tables.
 */
export function BuildWidgetDialog({
  initial,
  adding = false,
  engine,
  sql,
  onSave,
  onClose,
}: {
  initial?: Widget
  /** A new widget (Add), not one being changed (Apply). */
  adding?: boolean
  engine: ReportEngine
  /** For SQL widgets: the tables, and what this person may do with them. */
  sql?: { explorer: ActionCenterExplorer; canWriteSql: boolean; canAskJarvis: boolean }
  onSave: (widget: Widget) => void
  onClose: () => void
}) {
  const [start] = useState<Widget>(() => initial || newWidget('bar', { x: 0, y: 0 }))
  const { trackers } = engine
  useEffect(() => {
    if (engine.canUseTrackers) trackers.loadList()
  }, [engine.canUseTrackers, trackers.loadList])
  if (start.kind === 'query' && sql)
    return (
      <Suspense fallback={null}>
        <QueryWidgetEditor
          widget={start}
          canWriteSql={sql.canWriteSql}
          clients={engine.data.clients}
          projects={engine.data.projects}
          accounts={engine.data.accounts}
          tableNames={sql.explorer.catalog.map(table => table.name)}
          loadTrackers={sql.explorer.loadTrackers}
          explorer={sql.explorer}
          canAskJarvis={sql.canAskJarvis}
          eyebrow="Your own widget · Data explorer"
          about="The query runs in your browser each time your Action Center opens, on fresh data."
          saveLabel={adding ? 'Add widget' : 'Apply'}
          preview={widget => (
            <>
              <div className="crp-card-head">
                <h3>{widget.title || WIDGET_LABELS.query}</h3>
              </div>
              <QueryView widget={widget} values={NO_FILTER_VALUES} explorer={sql.explorer} refresh={engine.data} />
            </>
          )}
          onSave={onSave}
          onClose={onClose}
        />
      </Suspense>
    )
  return (
    <div className="crp-page ac-crp">
      <Suspense fallback={null}>
        <WidgetEditor
          widget={start}
          trackers={trackers.list}
          canUseTrackers={engine.canUseTrackers}
          fieldsFor={(source, trackerId) => {
            if (source === 'tracker') trackers.ensure(trackerId)
            return engine.fieldsFor(source, trackerId)
          }}
          recordsFor={engine.recordsFor}
          preview={widget => (
            <>
              <div className="crp-card-head">
                <h3>{widget.title || WIDGET_LABELS[widget.kind]}</h3>
              </div>
              <WidgetView widget={widget} filters={NO_FILTERS} engine={engine} />
            </>
          )}
          onClose={onClose}
          onSave={onSave}
        />
      </Suspense>
    </div>
  )
}
