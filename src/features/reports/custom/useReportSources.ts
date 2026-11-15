/**
 * What report widgets read, shared by the Reports page and the Action Center: tracker data loaded as widgets need it,
 * and each source's records and fields, worked out once per change of data.
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import { loadAllRows, trackerApi } from '../../trackers/trackerApi'
import type { Tracker, TrackerRow } from '../../trackers/trackerModel'
import type { SourceId, Widget } from './reportModel'
import { type Field, type Rec, type ReportData, sourceFields, sourceRecords } from './reportData'

/** Trackers for the "Tracker rows" source: the list, and each tracker's rows once a widget needs them. */
export function useTrackerData(enabled: boolean) {
  const [list, setList] = useState<Tracker[] | null>(null)
  const [loaded, setLoaded] = useState<Record<string, { tracker: Tracker; rows: TrackerRow[] } | undefined>>({})
  const [failed, setFailed] = useState<Record<string, string>>({})
  const asked = useRef(new Set<string>())
  const loadList = useCallback(() => {
    if (!enabled || asked.current.has('__list')) return
    asked.current.add('__list')
    trackerApi
      .list()
      .then(result => setList(result.trackers.filter(tracker => !tracker.archived)))
      .catch(() => setList([]))
  }, [enabled])
  const ensure = useCallback(
    (id: string | undefined) => {
      if (!enabled || !id || asked.current.has(id)) return
      asked.current.add(id)
      Promise.all([trackerApi.get(id), loadAllRows(id)])
        .then(([result, rows]) => setLoaded(current => ({ ...current, [id]: { tracker: result.tracker, rows } })))
        .catch(error =>
          setFailed(current => ({ ...current, [id]: error?.message || 'This tracker could not be loaded.' })),
        )
    },
    [enabled],
  )
  return { list, loaded, failed, loadList, ensure }
}

export type TrackerData = ReturnType<typeof useTrackerData>

/** Records and fields per source, cached until the data changes. */
export function useReportSources(data: ReportData, trackers: TrackerData) {
  const recordsFor = useMemo(() => {
    const cache = new Map<string, Rec[]>()
    return (source: SourceId, trackerId = '') => {
      const key = `${source}:${source === 'tracker' ? trackerId : ''}`
      let records = cache.get(key)
      if (!records) {
        records = sourceRecords(source, data, trackerId)
        cache.set(key, records)
      }
      return records
    }
  }, [data])
  const fieldsFor = useMemo(() => {
    const cache = new Map<string, Field[]>()
    return (source: SourceId, trackerId?: string) => {
      const key = `${source}:${source === 'tracker' ? trackerId || '' : ''}`
      let fields = cache.get(key)
      if (!fields) {
        const tracker = trackerId
          ? trackers.loaded[trackerId]?.tracker || trackers.list?.find(item => item.id === trackerId)
          : undefined
        fields = sourceFields(source, tracker)
        cache.set(key, fields)
      }
      return fields
    }
  }, [trackers.loaded, trackers.list])
  return { recordsFor, fieldsFor }
}

/** Why a widget shows no numbers yet: no tracker chosen, still loading, or it failed. Empty when it is ready. */
export function trackerProblemOf(widget: Widget, trackers: TrackerData, short = false) {
  if (widget.source !== 'tracker') return ''
  if (!widget.trackerId) return short ? 'Choose a tracker.' : 'Choose a tracker in this widget’s settings.'
  return trackers.failed[widget.trackerId] || (trackers.loaded[widget.trackerId] ? '' : 'Loading the tracker…')
}
