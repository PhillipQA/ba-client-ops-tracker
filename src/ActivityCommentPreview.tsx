import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

export default function ActivityCommentPreview({ text, title }: { text: string; title: string }) {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [open, setOpen] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [position, setPosition] = useState({ top: 0, left: 0, width: 340, maxHeight: 300 })
  const content = text?.trim()
  const cancelClose = () => { clearTimeout(timer.current) }
  const close = () => { cancelClose(); setOpen(false); setPinned(false) }
  const show = () => {
    cancelClose()
    const rect = trigger.current?.getBoundingClientRect()
    if (!rect) return
    const width = Math.min(380, window.innerWidth - 24)
    const below = window.innerHeight - rect.bottom - 20
    const above = rect.top - 20
    const placeBelow = below >= 240 || below >= above
    const maxHeight = Math.min(340, Math.max(80, placeBelow ? below : above))
    setPosition({ width, maxHeight, left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), top: placeBelow ? rect.bottom + 8 : Math.max(12, rect.top - maxHeight - 8) })
    setOpen(true)
  }
  const scheduleClose = () => {
    cancelClose()
    if (!pinned) timer.current = setTimeout(() => setOpen(false), 180)
  }
  useEffect(() => () => clearTimeout(timer.current), [])
  useEffect(() => {
    if (open && pinned) panel.current?.querySelector<HTMLElement>('.activity-comment-full')?.focus({ preventScroll: true })
  }, [open, pinned])
  useEffect(() => {
    if (!open) return
    const dismiss = (event: PointerEvent) => {
      if (!trigger.current?.contains(event.target as Node) && !panel.current?.contains(event.target as Node)) close()
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close(); trigger.current?.focus() }
    }
    const dismissOnMove = (event: Event) => {
      if (!panel.current?.contains(event.target as Node)) close()
    }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', escape)
    window.addEventListener('resize', dismissOnMove)
    window.addEventListener('scroll', dismissOnMove, true)
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('keydown', escape)
      window.removeEventListener('resize', dismissOnMove)
      window.removeEventListener('scroll', dismissOnMove, true)
    }
  }, [open])
  if (!content) return <p className="activity-tile-no-comment">No comments yet</p>
  return <>
    <button ref={trigger} type="button" className="activity-comment-preview" aria-expanded={open} aria-controls={open ? id : undefined} aria-label={`Read comments for ${title}`}
      onMouseEnter={show} onMouseLeave={scheduleClose}
      onClick={() => { if (pinned) close(); else { show(); setPinned(true) } }}>
      <span className="activity-comment-label">Comments / notes</span>
      <span className="activity-comment-excerpt">{content}</span>
      <span className="activity-comment-hint">Read full comment</span>
    </button>
    {open && createPortal(<div ref={panel} id={id} role="region" aria-label={`Comments for ${title}`} className="activity-comment-popover" style={position}
      onMouseEnter={cancelClose} onMouseLeave={scheduleClose}>
      <div className="activity-comment-popover-head"><strong>Comments / notes</strong><button type="button" aria-label="Close comments" onClick={() => { close(); trigger.current?.focus() }}><X size={17} /></button></div>
      <div className="activity-comment-full" tabIndex={0}>{content}</div>
    </div>, document.body)}
  </>
}
