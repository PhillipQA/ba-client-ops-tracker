import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'

/**
 * A floating panel next to an element. It is placed with fixed coordinates, so a scrolling grid cannot clip it, and it
 * closes on outside click, Escape, or when anything behind it scrolls.
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
  }, [anchor, minWidth])
  useEffect(() => {
    const down = (event: MouseEvent) => {
      const target = event.target as Node
      if (box.current?.contains(target) || anchor.current?.contains(target)) return
      close.current()
    }
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        close.current()
      }
    }
    const scroll = (event: Event) => {
      if (!box.current?.contains(event.target as Node)) close.current()
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
  return (
    <div ref={box} className={`k-popover ${className}`} style={style} role="dialog" aria-label={label}>
      {children}
    </div>
  )
}
