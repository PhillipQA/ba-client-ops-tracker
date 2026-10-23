import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import {
  AlignLeft, CalendarDays, CheckCircle2, CircleDot, Clock3, FileSignature, FolderOpen, Hash, Link2, ListTodo, LockKeyhole, Type, UserRound, Users, X,
} from 'lucide-react'
import type { ColumnType, OptionColor } from './trackerModel'
import type { Tone } from './trackerQuery'

export const TYPE_ICONS: Record<ColumnType, typeof Type> = {
  text: Type, longtext: AlignLeft, number: Hash, date: CalendarDays, checkbox: CheckCircle2, select: CircleDot, multiselect: ListTodo,
  person: UserRound, link: Link2, task_status: CircleDot, task_due: Clock3, task_owner: Users, signoff: FileSignature, drive_files: FolderOpen, secret: LockKeyhole,
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

/**
 * A floating panel next to an element. It is placed with fixed coordinates, so a scrolling grid cannot clip it, and it
 * closes on outside click, Escape, or when anything behind it scrolls.
 */
export function Popover({ anchor, onClose, children, className = '', minWidth, label }: { anchor: RefObject<HTMLElement | null>; onClose: () => void; children: ReactNode; className?: string; minWidth?: number; label?: string }) {
  const box = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  const [style, setStyle] = useState<CSSProperties>({ position: 'fixed', top: 0, left: 0, visibility: 'hidden' })
  useLayoutEffect(() => {
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect(), element = box.current
      if (!rect || !element) return
      const height = element.offsetHeight, width = element.offsetWidth
      const room = window.innerHeight - rect.bottom
      const top = room < height + 8 && rect.top > room ? Math.max(8, rect.top - height - 4) : rect.bottom + 4
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))
      setStyle({ position: 'fixed', top, left, minWidth: minWidth ?? Math.max(rect.width, 200), maxHeight: Math.max(160, window.innerHeight - top - 12), visibility: 'visible' })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [anchor, minWidth])
  useEffect(() => {
    const down = (event: MouseEvent) => {
      const target = event.target as Node
      if (box.current?.contains(target) || anchor.current?.contains(target)) return
      close.current()
    }
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); close.current() } }
    const scroll = (event: Event) => { if (!box.current?.contains(event.target as Node)) close.current() }
    document.addEventListener('mousedown', down, true)
    document.addEventListener('keydown', key, true)
    window.addEventListener('scroll', scroll, true)
    return () => { document.removeEventListener('mousedown', down, true); document.removeEventListener('keydown', key, true); window.removeEventListener('scroll', scroll, true) }
  }, [anchor])
  return <div ref={box} className={`trk-popover ${className}`} style={style} role="dialog" aria-label={label}>{children}</div>
}

/** A modal on the browser's top layer, so themed panels and clipping never hide it. */
export function Dialog({ title, eyebrow, onClose, children, wide, busy }: { title: string; eyebrow?: string; onClose: () => void; children: ReactNode; wide?: boolean; busy?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useEffect(() => {
    const element = ref.current!
    const previousOverflow = document.body.style.overflow
    const previousFocus = document.activeElement as HTMLElement | null
    if (!element.open) element.showModal()
    document.body.style.overflow = 'hidden'
    return () => { element.close(); document.body.style.overflow = previousOverflow; if (previousFocus?.isConnected) previousFocus.focus() }
  }, [])
  return <dialog ref={ref} className={`trk-dialog${wide ? ' wide' : ''}`} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); if (!busy) onClose() }}>
    <header className="trk-dialog-head">
      <div>{eyebrow && <p>{eyebrow}</p>}<h2 id={titleId}>{title}</h2></div>
      <button type="button" className="trk-icon-button" aria-label="Close" disabled={busy} onClick={onClose}><X size={18} /></button>
    </header>
    {children}
  </dialog>
}

export function Notice({ kind, children, onClose }: { kind: 'error' | 'info'; children: ReactNode; onClose?: () => void }) {
  return <div className={`trk-notice trk-notice-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
    <span>{children}</span>
    {onClose && <button type="button" className="trk-icon-button small" aria-label="Dismiss" onClick={onClose}><X size={14} /></button>}
  </div>
}
