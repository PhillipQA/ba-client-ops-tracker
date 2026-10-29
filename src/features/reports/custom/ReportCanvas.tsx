// Custom reports: the page widgets sit on. A 12-column grid; while editing, widgets are dragged to move, resized from
// their corner, and new ones dropped in from the palette. Others make room as a widget moves.
import {
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react'
import { GripVertical } from 'lucide-react'
import {
  GRID_COLUMNS,
  placeWidget,
  WIDGET_KINDS,
  WIDGET_SIZES,
  type Box,
  type Widget,
  type WidgetKind,
} from './reportModel'

export const ROW = 30
export const GAP = 12
const NARROW = 640
/** The drag data a palette item carries. */
export const WIDGET_TYPE = 'text/x-report-widget'

type Drag = {
  id: string
  mode: 'move' | 'resize'
  origin: Box
  startX: number
  startY: number
  started: boolean
}

export function ReportCanvas({
  widgets,
  editing,
  selectedId,
  newKind,
  renderWidget,
  onChange,
  onSelect,
  onDropNew,
}: {
  widgets: Widget[]
  editing: boolean
  selectedId?: string
  /** A widget kind being dragged in from the palette. */
  newKind: WidgetKind | null
  renderWidget: (widget: Widget) => ReactNode
  onChange: (widgets: Widget[]) => void
  onSelect: (id: string) => void
  onDropNew: (kind: WidgetKind, at: { x: number; y: number }) => void
}) {
  const grid = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [preview, setPreview] = useState<Widget[] | null>(null)
  const [ghost, setGhost] = useState<Box | null>(null)

  useLayoutEffect(() => {
    const element = grid.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const narrow = width > 0 && width < NARROW
  const shown = preview || widgets
  const colPitch = (width + GAP) / GRID_COLUMNS
  const rowPitch = ROW + GAP
  const bottom = shown.reduce((max, widget) => Math.max(max, widget.y + widget.h), 0)
  const rows = Math.max(editing ? bottom + 6 : bottom, editing ? 12 : 1)
  const canDrag = editing && !narrow

  const cellAt = (clientX: number, clientY: number, size: { w: number; h: number }) => {
    const box = grid.current?.getBoundingClientRect()
    if (!box) return { x: 0, y: 0 }
    const x = Math.floor((clientX - box.left) / colPitch - size.w / 2 + 0.5)
    const y = Math.floor((clientY - box.top) / rowPitch)
    return { x: Math.min(GRID_COLUMNS - size.w, Math.max(0, x)), y: Math.max(0, y) }
  }

  const begin = (event: PointerEvent<HTMLElement>, widget: Widget, mode: Drag['mode']) => {
    if (!canDrag || event.button !== 0) return
    const target = event.target as HTMLElement
    if (
      mode === 'move' &&
      target.closest('button:not(.crp-grip), a, input, select, textarea, .crp-resize, .crp-table-wrap')
    )
      return
    event.currentTarget.setPointerCapture(event.pointerId)
    setDrag({
      id: widget.id,
      mode,
      origin: { x: widget.x, y: widget.y, w: widget.w, h: widget.h },
      startX: event.clientX,
      startY: event.clientY,
      started: mode === 'resize',
    })
    if (mode === 'resize') event.preventDefault()
  }
  const move = (event: PointerEvent<HTMLElement>) => {
    if (!drag) return
    const dx = event.clientX - drag.startX,
      dy = event.clientY - drag.startY
    if (!drag.started) {
      if (Math.abs(dx) + Math.abs(dy) < 5) return
      setDrag({ ...drag, started: true })
    }
    const cols = Math.round(dx / colPitch),
      rowsMoved = Math.round(dy / rowPitch)
    const box =
      drag.mode === 'move'
        ? { ...drag.origin, x: drag.origin.x + cols, y: drag.origin.y + rowsMoved }
        : { ...drag.origin, w: drag.origin.w + cols, h: drag.origin.h + rowsMoved }
    setPreview(placeWidget(widgets, drag.id, box))
  }
  const end = () => {
    if (!drag) return
    if (drag.started && preview) onChange(preview)
    else if (!drag.started) onSelect(drag.id)
    setDrag(null)
    setPreview(null)
  }
  const nudge = (event: KeyboardEvent<HTMLElement>, widget: Widget) => {
    const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key]
    if (!step || !canDrag) return
    event.preventDefault()
    const box = event.shiftKey
      ? { x: widget.x, y: widget.y, w: widget.w + step[0], h: widget.h + step[1] }
      : { x: widget.x + step[0], y: widget.y + step[1], w: widget.w, h: widget.h }
    onChange(placeWidget(widgets, widget.id, box))
  }

  // The palette says which kind is coming as the drag starts; the drop itself carries it too.
  const dragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!canDrag || !event.dataTransfer.types.includes(WIDGET_TYPE)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    const size = WIDGET_SIZES[newKind || 'bar']
    const at = cellAt(event.clientX, event.clientY, size)
    setGhost(current =>
      current && current.x === at.x && current.y === at.y && current.w === size.w ? current : { ...at, ...size },
    )
  }
  const drop = (event: DragEvent<HTMLDivElement>) => {
    const carried = event.dataTransfer.getData(WIDGET_TYPE) as WidgetKind
    const kind = WIDGET_KINDS.includes(carried) ? carried : newKind
    setGhost(null)
    if (!kind || !canDrag) return
    event.preventDefault()
    onDropNew(kind, cellAt(event.clientX, event.clientY, WIDGET_SIZES[kind]))
  }

  const place = (box: Box) =>
    narrow
      ? { gridColumn: '1 / -1', gridRow: 'auto', height: box.h * ROW + (box.h - 1) * GAP }
      : { gridColumn: `${box.x + 1} / span ${box.w}`, gridRow: `${box.y + 1} / span ${box.h}` }
  const ordered = narrow ? [...shown].sort((a, b) => a.y - b.y || a.x - b.x) : shown

  return (
    <div
      ref={grid}
      className={`crp-canvas${editing ? ' editing' : ''}${narrow ? ' narrow' : ''}${drag?.started ? ' dragging' : ''}`}
      style={{
        gridAutoRows: narrow ? 'auto' : `${ROW}px`,
        gap: `${GAP}px`,
        minHeight: narrow ? undefined : rows * rowPitch - GAP,
      }}
      onDragOver={dragOver}
      onDragLeave={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) setGhost(null)
      }}
      onDrop={drop}
    >
      {ordered.map(widget => (
        <div
          key={widget.id}
          className={`crp-cell crp-kind-${widget.kind}${selectedId === widget.id ? ' selected' : ''}${drag?.id === widget.id && drag.started ? ' moving' : ''}`}
          style={place(widget)}
          onPointerDown={event => begin(event, widget, 'move')}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
        >
          {canDrag && (
            <button
              type="button"
              className="crp-grip"
              aria-label={`Move ${widget.title || 'widget'}. Arrow keys move it, Shift and arrow keys resize it.`}
              title="Drag to move. Arrow keys move, Shift + arrow keys resize."
              onKeyDown={event => nudge(event, widget)}
            >
              <GripVertical size={14} />
            </button>
          )}
          {renderWidget(widget)}
          {canDrag && (
            <span
              className="crp-resize"
              aria-hidden="true"
              title="Drag to resize"
              onPointerDown={event => {
                event.stopPropagation()
                begin(event, widget, 'resize')
              }}
              onPointerMove={move}
              onPointerUp={end}
              onPointerCancel={end}
            />
          )}
        </div>
      ))}
      {ghost && <div className="crp-ghost" style={place(ghost)} />}
      {editing && !widgets.length && !ghost && (
        <div className="crp-canvas-hint" style={{ gridColumn: '1 / -1', gridRow: '2 / span 3' }}>
          Drag a widget here from the left, or click one to add it.
        </div>
      )}
    </div>
  )
}
