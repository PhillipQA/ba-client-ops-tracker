import { type ReactNode } from 'react'
import {
  AlignLeft, CalendarDays, CheckCircle2, CircleDot, Clock3, FileSignature, FolderOpen, Hash, Link2, ListTodo, Sigma, LockKeyhole, Type, UserRound, Users,
} from 'lucide-react'
import type { ColumnType, OptionColor } from './trackerModel'
import type { Tone } from './trackerQuery'

export const TYPE_ICONS: Record<ColumnType, typeof Type> = {
  text: Type, longtext: AlignLeft, number: Hash, date: CalendarDays, checkbox: CheckCircle2, select: CircleDot, multiselect: ListTodo,
  person: UserRound, link: Link2, task_status: CircleDot, task_due: Clock3, task_owner: Users, signoff: FileSignature, drive_files: FolderOpen, secret: LockKeyhole, formula: Sigma,
}

export function ColumnIcon({ type, size = 14 }: { type: ColumnType; size?: number }) {
  const Icon = TYPE_ICONS[type] || Type
  return <Icon size={size} aria-hidden="true" />
}

/** Status is always written out; colour only backs it up. */
export function Pill({ tone = 'gray', children, title }: { tone?: Tone | OptionColor; children: ReactNode; title?: string }) {
  return <span className={`trk-pill trk-tone-${tone}`} title={title}>{children}</span>
}

export const initials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map(part => part[0]?.toUpperCase() || '').join('') || '?'

export function Avatar({ name }: { name: string }) {
  return <span className="trk-avatar" aria-hidden="true">{initials(name)}</span>
}

export function niceDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return value
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' })
}

export function niceTime(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('en', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function plural(count: number, one: string, many = `${one}s`) {
  return `${count.toLocaleString('en')} ${count === 1 ? one : many}`
}


// The dialog, popover and notice now live in the shared UI kit; trackers keep importing them from here.
export { Dialog, Notice, Popover } from '../../shared/ui'
