import { useState, type MouseEvent } from 'react'
import { Folder, FolderOpen, LayoutGrid, List, Lock, Table2, Users } from 'lucide-react'
import { columnTypeLabel, trackerProjectIds, type Tracker } from './trackerModel'
import { usersOf, type TrackerFolder } from './trackerFolders'
import { niceTime, plural } from './trackerUi'
import { opensElsewhere, pathForTracker } from '../../app/routes'

export type TrackerLayout = 'tile' | 'list' | 'table'
export type FolderLayout = 'tile' | 'row'

/**
 * A choice kept in this browser (which view and layout the Trackers page opens with). Browser storage can be missing
 * or full, so a failed read or write just keeps the default.
 */
export function useStoredChoice<T extends string>(key: string, allowed: readonly T[], fallback: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const saved = localStorage.getItem(key) as T | null
      return saved && allowed.includes(saved) ? saved : fallback
    } catch {
      return fallback
    }
  })
  const choose = (next: T) => {
    setValue(next)
    try {
      localStorage.setItem(key, next)
    } catch {
      /* Only this visit remembers it. */
    }
  }
  return [value, choose] as const
}

/** A small set of buttons, one on. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: { value: T; label: string; icon?: typeof List }[]
  onChange: (value: T) => void
}) {
  return (
    <div className="trk-segmented" role="group" aria-label={label}>
      {options.map(option => {
        const Icon = option.icon
        return (
          <button
            key={option.value}
            type="button"
            className={value === option.value ? 'on' : ''}
            aria-pressed={value === option.value}
            onClick={() => onChange(option.value)}
          >
            {Icon && <Icon size={13} aria-hidden="true" />} {option.label}
          </button>
        )
      })}
    </div>
  )
}

export const TRACKER_LAYOUTS: { value: TrackerLayout; label: string; icon: typeof List }[] = [
  { value: 'tile', label: 'Tile', icon: LayoutGrid },
  { value: 'list', label: 'List', icon: List },
  { value: 'table', label: 'Table', icon: Table2 },
]
export const FOLDER_LAYOUTS: { value: FolderLayout; label: string; icon: typeof List }[] = [
  { value: 'tile', label: 'Tile', icon: LayoutGrid },
  { value: 'row', label: 'Row', icon: List },
]

/** Everyone's folders: one per active person, the viewer's first. */
export function FolderGrid({
  folders,
  layout,
  onOpen,
}: {
  folders: TrackerFolder[]
  layout: FolderLayout
  onOpen: (userId: string) => void
}) {
  return (
    <section className={layout === 'tile' ? 'trk-folder-grid' : 'trk-folder-rows'} aria-label="Folders">
      {folders.map(folder => {
        const Icon = folder.count ? FolderOpen : Folder
        return (
          <button
            type="button"
            key={folder.userId}
            className={`trk-folder${folder.mine ? ' mine' : ''}`}
            onClick={() => onOpen(folder.userId)}
          >
            <Icon size={layout === 'tile' ? 26 : 18} aria-hidden="true" />
            <strong>{folder.mine ? `${folder.name} (you)` : folder.name}</strong>
            <span>{folder.count ? plural(folder.count, 'tracker') : 'Empty'}</span>
          </button>
        )
      })}
    </section>
  )
}

type CollectionProps = {
  trackers: Tracker[]
  layout: TrackerLayout
  clientName: (id: string) => string
  projectName: (id: string) => string
  personName: (id: string) => string
  clientsOf: (tracker: Tracker) => string[]
  onOpen: (id: string) => void
}

/** Trackers as tiles, a compact list, or the full table. */
export function TrackerCollection(props: CollectionProps) {
  const { trackers, layout } = props
  const where = (tracker: Tracker) =>
    [
      props.clientsOf(tracker).map(props.clientName).join(', '),
      trackerProjectIds(tracker).map(props.projectName).filter(Boolean).join(', '),
    ]
      .filter(Boolean)
      .join(' · ')
  const usersTitle = (tracker: Tracker) => usersOf(tracker).map(props.personName).join(', ')
  const nameLink = (tracker: Tracker) => (
    <a
      className="trk-link-button"
      href={pathForTracker(tracker.id)}
      onClick={(event: MouseEvent) => {
        if (opensElsewhere(event)) return
        event.preventDefault()
        props.onOpen(tracker.id)
      }}
    >
      {tracker.name}
    </a>
  )
  const chips = (tracker: Tracker) => (
    <>
      {tracker.private && (
        <span className="trk-chip">
          <Lock size={11} aria-hidden="true" /> Only you
        </span>
      )}
      {tracker.archived && <span className="trk-chip warn">Archived</span>}
    </>
  )

  if (layout === 'tile')
    return (
      <section className="trk-tracker-grid" aria-label="Trackers">
        {trackers.map(tracker => (
          <article className="trk-tracker-tile" key={tracker.id}>
            <div className="trk-list-name">
              {nameLink(tracker)}
              {chips(tracker)}
            </div>
            <span className="trk-tile-where">{where(tracker) || 'No client or project'}</span>
            <div className="trk-tile-facts">
              <span>{plural(tracker.rowCount, 'row')}</span>
              <span>{plural(tracker.columns.length, 'column')}</span>
              <span title={usersTitle(tracker)}>
                <Users size={12} aria-hidden="true" /> {usersOf(tracker).length}
              </span>
            </div>
            <small className="trk-muted">
              Updated {niceTime(tracker.updatedAt)} · {tracker.createdByName || 'Unknown'}
            </small>
          </article>
        ))}
      </section>
    )

  if (layout === 'list')
    return (
      <section className="trk-list trk-list-compact" aria-label="Trackers">
        {trackers.map(tracker => (
          <div className="trk-compact-row" key={tracker.id}>
            <span className="trk-list-name">
              {nameLink(tracker)}
              {chips(tracker)}
            </span>
            <span className="trk-muted">{where(tracker)}</span>
            <span className="trk-muted" title={usersTitle(tracker)}>
              <Users size={12} aria-hidden="true" /> {usersOf(tracker).length}
            </span>
            <span className="trk-muted">{niceTime(tracker.updatedAt)}</span>
          </div>
        ))}
      </section>
    )

  return (
    <section className="trk-list" aria-label="Trackers">
      <div className="trk-list-row head" role="row">
        <span role="columnheader">Name</span>
        <span role="columnheader">Client and project</span>
        <span role="columnheader">Rows</span>
        <span role="columnheader">Columns</span>
        <span role="columnheader">Updated</span>
        <span role="columnheader">Created by</span>
      </div>
      {trackers.map(tracker => (
        <div className="trk-list-row" role="row" key={tracker.id}>
          <span role="cell" className="trk-list-name">
            {nameLink(tracker)}
            {chips(tracker)}
          </span>
          <span role="cell">{where(tracker) || <span className="trk-muted">—</span>}</span>
          <span role="cell">{tracker.rowCount.toLocaleString('en')}</span>
          <span
            role="cell"
            title={tracker.columns.map(column => `${column.name} (${columnTypeLabel(column.type)})`).join(', ')}
          >
            {tracker.columns.length}
          </span>
          <span role="cell">{niceTime(tracker.updatedAt)}</span>
          <span role="cell">{tracker.createdByName || <span className="trk-muted">—</span>}</span>
        </div>
      ))}
    </section>
  )
}
