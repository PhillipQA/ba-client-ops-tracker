/**
 * Report widgets on the Action Center: ones a person builds here with the Reports builder, and ones pinned from a saved
 * report (which follow the report). Both are worked out in the browser from the same data Reports reads.
 */
import { ExternalLink, X } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { businessDateKey } from '../../shared/businessDate'
import type { AppState, SignedInUser } from '../../app/useAppState'
import type { UserAccount } from '../../shared/types'
import { reportApi } from '../reports/custom/reportApi'
import { computeWidget, type ReportData } from '../reports/custom/reportData'
import {
  newWidget,
  type ReportFilters,
  type ReportItem,
  WIDGET_LABELS,
  type Widget,
} from '../reports/custom/reportModel'
import { WidgetBody } from '../reports/custom/ReportWidgets'
import { WidgetEditor } from '../reports/custom/WidgetEditor'
import { trackerProblemOf, useReportSources, useTrackerData } from '../reports/custom/useReportSources'
import '../reports/custom/customReports.css'

const NO_FILTERS: ReportFilters = { range: 'all' }

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

/** The numbers, chart or table of one widget. */
function WidgetView({ widget, filters, engine }: { widget: Widget; filters: ReportFilters; engine: ReportEngine }) {
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
  return (
    <div className={`crp-cell crp-kind-${widget.kind} ac-report-body`}>
      <WidgetBody widget={widget} computed={computed} fields={fields} today={today} problem={problem} />
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

export function CustomWidget({ widget, engine }: { widget: Widget; engine: ReportEngine }) {
  return (
    <ReportPanel title={widget.title || WIDGET_LABELS[widget.kind]} sub="Your own widget">
      <WidgetView widget={widget} filters={NO_FILTERS} engine={engine} />
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
  onOpenReport,
  onRemove,
}: {
  reportId: string
  widgetId: string
  reports: ReturnType<typeof useSavedReports>
  engine: ReportEngine
  onOpenReport: () => void
  onRemove?: () => void
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
        <p className="ac-widget-note">Query widgets show on their report. Open the report to see it.</p>
      ) : (
        <WidgetView widget={widget} filters={report.definition.filters || NO_FILTERS} engine={engine} />
      )}
    </ReportPanel>
  )
}

/** The Reports builder, for a widget of the person's own on the Action Center. */
export function BuildWidgetDialog({
  initial,
  engine,
  onSave,
  onClose,
}: {
  initial?: Widget
  engine: ReportEngine
  onSave: (widget: Widget) => void
  onClose: () => void
}) {
  const [start] = useState<Widget>(() => initial || newWidget('bar', { x: 0, y: 0 }))
  const { trackers } = engine
  useEffect(() => {
    if (engine.canUseTrackers) trackers.loadList()
  }, [engine.canUseTrackers, trackers.loadList])
  return (
    <div className="crp-page ac-crp">
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
    </div>
  )
}
