import type { ReactNode } from 'react'
import {
  AlignLeft,
  CalendarDays,
  CheckCircle2,
  CircleDot,
  Clock3,
  FileSignature,
  FolderOpen,
  Hash,
  Link2,
  ListTodo,
  LoaderCircle,
  Sigma,
  LockKeyhole,
  Type,
  UserRound,
  Users,
} from 'lucide-react'
import type { ColumnType, OptionColor } from './trackerModel'
import type { Tone } from './trackerQuery'

export const TYPE_ICONS: Record<ColumnType, typeof Type> = {
  text: Type,
  longtext: AlignLeft,
  number: Hash,
  date: CalendarDays,
  checkbox: CheckCircle2,
  select: CircleDot,
  multiselect: ListTodo,
  person: UserRound,
  link: Link2,
  task_status: CircleDot,
  task_due: Clock3,
  task_owner: Users,
  signoff: FileSignature,
  drive_files: FolderOpen,
  secret: LockKeyhole,
  formula: Sigma,
}

export function ColumnIcon({ type, size = 14 }: { type: ColumnType; size?: number }) {
  const Icon = TYPE_ICONS[type] || Type
  return <Icon size={size} aria-hidden="true" />
}

/** Status is always written out; colour only backs it up. */
export function Pill({
  tone = 'gray',
  children,
  title,
}: {
  tone?: Tone | OptionColor
  children: ReactNode
  title?: string
}) {
  return (
    <span className={`trk-pill trk-tone-${tone}`} title={title}>
      {children}
    </span>
  )
}

export const initials = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map(part => part[0]?.toUpperCase() || '')
    .join('') || '?'

export function Avatar({ name }: { name: string }) {
  return (
    <span className="trk-avatar" aria-hidden="true">
      {initials(name)}
    </span>
  )
}

export function niceDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return value
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).toLocaleDateString('en', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

export function niceTime(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleString('en', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function plural(count: number, one: string, many = `${one}s`) {
  return `${count.toLocaleString('en')} ${count === 1 ? one : many}`
}

// The dialog, popover and notice now live in the shared UI kit; trackers keep importing them from here.
export { Dialog, Notice, Popover } from '../../shared/ui'

/**
 * Shown while trackers or a tracker load: a spinner and the message, then a few grey placeholder rows, so the page
 * is never just empty. Screen readers hear the message once.
 */
export function TrackerLoading({ label, rows = 4 }: { label: string; rows?: number }) {
  return (
    <div className="trk-loading" role="status" aria-live="polite">
      <p className="trk-loading-label">
        <LoaderCircle size={16} className="trk-spin" aria-hidden="true" /> {label}
      </p>
      <div className="trk-skeleton" aria-hidden="true">
        {Array.from({ length: rows }, (_, at) => (
          <span key={at} style={{ width: `${92 - ((at * 17) % 30)}%` }} />
        ))}
      </div>
    </div>
  )
}

/** Row highlight colours, in the order they are offered. */
export const HIGHLIGHTS: { color: OptionColor; label: string }[] = [
  { color: 'amber', label: 'Yellow' },
  { color: 'green', label: 'Green' },
  { color: 'blue', label: 'Blue' },
  { color: 'red', label: 'Red' },
  { color: 'purple', label: 'Purple' },
  { color: 'pink', label: 'Pink' },
  { color: 'teal', label: 'Teal' },
  { color: 'gray', label: 'Grey' },
]

/** Colour swatches for highlighting rows; the first clears the highlight. */
export function HighlightSwatches({
  value,
  onPick,
  label = 'Highlight',
}: {
  value?: string
  onPick: (color: string) => void
  label?: string
}) {
  return (
    <div className="trk-swatches" role="group" aria-label={label}>
      <button
        type="button"
        className={`trk-swatch none${value ? '' : ' on'}`}
        title="No highlight"
        aria-label="No highlight"
        aria-pressed={!value}
        onClick={() => onPick('')}
      />
      {HIGHLIGHTS.map(item => (
        <button
          key={item.color}
          type="button"
          className={`trk-swatch trk-tone-${item.color}${value === item.color ? ' on' : ''}`}
          title={item.label}
          aria-label={item.label}
          aria-pressed={value === item.color}
          onClick={() => onPick(item.color)}
        />
      ))}
    </div>
  )
}
