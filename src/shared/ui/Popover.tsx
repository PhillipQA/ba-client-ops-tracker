import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'

/**
 * A floating panel next to an element. It is placed with fixed coordinates, so a scrolling grid cannot clip it, and it
 * closes on outside click, Escape, or when anything behind it scrolls. It is drawn at the top of the app shell (or in
 * the open modal dialog, which sits in the browser's top layer), never inside the grid, so a sticky header or frozen
 * column cannot cover it, and it keeps the theme's colours.
 */
export function Popover({
  anchor,
  onClose,
  children,
  className = '',
  minWidth,
  label,
}: {
  anchor: RefObject<HTMLElement | null>
  onClose: () => void
  children: ReactNode
  className?: string
  minWidth?: number
  label?: string
}) {
  const box = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  const [style, setStyle] = useState<CSSProperties>({ position: 'fixed', top: 0, left: 0, visibility: 'hidden' })
  const [host, setHost] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => {
    // Inside the app shell, not on <body>: the theme's colours (--k-solid…) are set on the shell, so outside it the
    // panel would have no background. The shell has no transform, so the panel is still placed against the window.
    // An anchor that is gone from the page (re-rendered away) has no shell around it: then use the page's tracker or
    // shell, so the panel keeps the tracker's styles too, and <body> only as a last resort.
    const at = anchor.current?.isConnected ? anchor.current : null
    setHost(
      at?.closest<HTMLElement>('dialog[open]') ||
        at?.closest<HTMLElement>('.app-shell, .trk-page') ||
        document.querySelector<HTMLElement>('.trk-page') ||
        document.querySelector<HTMLElement>('.app-shell') ||
        document.body,
    )
  }, [anchor])
  useLayoutEffect(() => {
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect(),
        element = box.current
      if (!rect || !element) return
      const height = element.offsetHeight,
        width = element.offsetWidth
      const room = window.innerHeight - rect.bottom
      const top = room < height + 8 && rect.top > room ? Math.max(8, rect.top - height - 4) : rect.bottom + 4
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))
      setStyle({
        position: 'fixed',
        top,
        left,
        minWidth: minWidth ?? Math.max(rect.width, 200),
        maxHeight: Math.max(160, window.innerHeight - top - 12),
        visibility: 'visible',
      })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [anchor, minWidth, host])
  useEffect(() => {
    // A type-to-search field's list floats outside the panel (on the page), but it is part of the panel: picking from
    // it or scrolling it must not close the panel.
    const inList = (target: EventTarget | null) => {
      const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null
      return Boolean(element?.closest('.client-combo-list'))
    }
    const down = (event: MouseEvent) => {
      const target = event.target as Node
      if (box.current?.contains(target) || anchor.current?.contains(target) || inList(target)) return
      close.current()
    }
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        close.current()
      }
    }
    const scroll = (event: Event) => {
      if (!box.current?.contains(event.target as Node) && !inList(event.target)) close.current()
    }
    document.addEventListener('mousedown', down, true)
    document.addEventListener('keydown', key, true)
    window.addEventListener('scroll', scroll, true)
    return () => {
      document.removeEventListener('mousedown', down, true)
      document.removeEventListener('keydown', key, true)
      window.removeEventListener('scroll', scroll, true)
    }
  }, [anchor])
  if (!host) return null
  return createPortal(
    <div ref={box} className={`k-popover ${className}`} style={style} role="dialog" aria-label={label}>
      {children}
    </div>,
    host,
  )
}
