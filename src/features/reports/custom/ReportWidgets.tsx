// Custom reports: how each widget draws itself. Charts are plain SVG and HTML, drawn at the widget's real size.
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { dayNumber, isoOf } from '../../trackers/timelineModel'
import {
  displayValue,
  formatNumber,
  measureName,
  niceDate,
  type ChartData,
  type Computed,
  type Field,
  type GanttBar,
} from './reportData'
import type { Widget } from './reportModel'

/** The size of an element, kept up to date. */
function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  useLayoutEffect(() => {
    const element = ref.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      setSize(current =>
        Math.abs(current.width - width) < 1 && Math.abs(current.height - height) < 1 ? current : { width, height },
      )
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return [ref, size] as const
}

// --- Colours: identity follows the value, never its rank ---

const SEMANTIC: Record<string, string> = {
  Done: 'var(--crp-good)',
  Overdue: 'var(--crp-critical)',
  Open: 'var(--crp-s1)',
}
/** Colours for a set of values: in name order, so a value keeps its colour whatever its size. Other is grey. */
function palette(keys: { key: string; label: string }[], field?: string) {
  const named = keys
    .filter(item => item.key !== '__other')
    .map(item => item.label)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  const index = new Map(named.map((label, at) => [label, at]))
  return (item: { key: string; label: string }) => {
    if (item.key === '__other') return 'var(--crp-other)'
    if (field === 'state' && SEMANTIC[item.label]) return SEMANTIC[item.label]
    return `var(--crp-s${((index.get(item.label) ?? 0) % 8) + 1})`
  }
}

// --- Tooltip ---

type TipLine = { label: string; value: string; color?: string }
type TipState = { x: number; y: number; title: string; lines: TipLine[] } | null

function useTip() {
  const [tip, setTip] = useState<TipState>(null)
  const host = useRef<HTMLDivElement>(null)
  const show = (event: { clientX: number; clientY: number }, title: string, lines: TipLine[]) => {
    const box = host.current?.getBoundingClientRect()
    if (!box) return
    setTip({ x: event.clientX - box.left, y: event.clientY - box.top, title, lines })
  }
  const hide = () => setTip(null)
  const view = tip && (
    <div
      className="crp-tip"
      role="status"
      style={{
        left: Math.min(tip.x + 12, Math.max(0, (host.current?.clientWidth || 0) - 190)),
        top: Math.max(0, tip.y - 12),
      }}
    >
      <strong>{tip.title}</strong>
      {tip.lines.map(line => (
        <span key={line.label}>
          {line.color && <i style={{ background: line.color }} />}
          {line.label}
          <b>{line.value}</b>
        </span>
      ))}
    </div>
  )
  return { host, show, hide, view }
}

// --- Axis helpers ---

/** A round step for an axis: 1, 2, 2.5 or 5 times a power of ten. */
function niceStep(value: number) {
  if (value <= 0) return 1
  const power = 10 ** Math.floor(Math.log10(value))
  const scaled = value / power
  return (scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 2.5 ? 2.5 : scaled <= 5 ? 5 : 10) * power
}
/** Four even ticks from zero that reach past the largest value. */
function axisTicks(max: number) {
  const step = niceStep(max / 4)
  const count = Math.max(1, Math.ceil(max / step))
  return Array.from({ length: count + 1 }, (_, index) => step * index)
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const short = (text: string, max: number) => (text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text)
/** A path for a bar with its data end rounded and its base square. */
function roundedTop(x: number, y: number, width: number, height: number, radius: number) {
  if (height <= 0 || width <= 0) return ''
  const r = Math.min(radius, width / 2, height)
  return `M${x},${y + height}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height}Z`
}

function Legend({ items, color }: { items: { key: string; label: string }[]; color: (item: any) => string }) {
  return (
    <div className="crp-legend">
      {items.map(item => (
        <span key={item.key}>
          <i style={{ background: color(item) }} />
          {item.label}
        </span>
      ))}
    </div>
  )
}

/** Clicking a group (a bar, slice, point or summary row) shows the records behind it: its key, as chartData drew it. */
type PickGroup = ((key: string, label: string) => void) | undefined

/** What a widget's numbers are: its own label, or what its measure says. */
const valueName = (widget: Widget, fields: Field[]) => widget.valueLabel || measureName(widget.measure, fields)

const Empty = ({ children = 'Nothing to show for these filters.' }: { children?: ReactNode }) => (
  <div className="crp-empty">{children}</div>
)

// --- Charts ---

function BarChart({
  widget,
  chart,
  fields,
  onPick,
}: {
  widget: Widget
  chart: ChartData
  fields: Field[]
  onPick?: PickGroup
}) {
  const tip = useTip()
  const series = chart.series[0]
  const max = Math.max(0, ...series.values.map(value => value ?? 0))
  const color = palette(chart.categories, widget.groupBy)
  const single = widget.groupBy !== 'state'
  return (
    <div className="crp-bars" ref={tip.host} onMouseLeave={tip.hide}>
      {chart.categories.map((category, index) => {
        const value = series.values[index]
        const width = max > 0 && value ? Math.max(1, (value / max) * 100) : 0
        return (
          <div
            className="crp-bar-row"
            key={category.key}
            onClick={onPick ? () => onPick(category.key, category.label) : undefined}
            onMouseMove={event =>
              tip.show(event, category.label, [
                { label: valueName(widget, fields), value: formatNumber(value, widget.measure) },
                { label: 'Rows', value: String(chart.counts[index]) },
              ])
            }
          >
            <span className="crp-bar-label" title={category.label}>
              {category.label}
            </span>
            <span className="crp-bar-track">
              <span
                className="crp-bar-fill"
                style={{ width: `${width}%`, background: single ? 'var(--crp-s1)' : color(category) }}
              />
            </span>
            <b>{formatNumber(value, widget.measure)}</b>
          </div>
        )
      })}
      {tip.view}
    </div>
  )
}

function ColumnOrLine({
  widget,
  chart,
  fields,
  onPick,
}: {
  widget: Widget
  chart: ChartData
  fields: Field[]
  onPick?: PickGroup
}) {
  const [ref, size] = useSize<HTMLDivElement>()
  const tip = useTip()
  const [hover, setHover] = useState<number | null>(null)
  const line = widget.kind === 'line'
  const stacked = !line && (widget.measure.op === 'count' || widget.measure.op === 'sum') && chart.series.length > 1
  const color = palette(chart.series, widget.splitBy)
  const n = chart.categories.length
  const totals = chart.categories.map((_, index) =>
    stacked
      ? chart.series.reduce((sum, series) => sum + (series.values[index] ?? 0), 0)
      : Math.max(0, ...chart.series.map(series => series.values[index] ?? 0)),
  )
  const ticks = axisTicks(Math.max(0, ...totals))
  const max = ticks[ticks.length - 1]
  const left = Math.max(28, ...ticks.map(tick => formatNumber(tick).length * 7 + 10))
  const top = 8,
    bottom = 22,
    right = 8
  const width = Math.max(0, size.width),
    height = Math.max(0, size.height)
  const plotW = Math.max(1, width - left - right),
    plotH = Math.max(1, height - top - bottom)
  const band = plotW / Math.max(1, n)
  const y = (value: number) => top + plotH - (value / max) * plotH
  const every = Math.max(1, Math.ceil(n / Math.max(1, plotW / 64)))
  const multi = chart.series.length > 1
  const label = (index: number) => (event: { clientX: number; clientY: number }) => {
    setHover(index)
    tip.show(
      event,
      chart.categories[index].label,
      [
        ...chart.series.map(series => ({
          label: multi ? series.label : valueName(widget, fields),
          value: formatNumber(series.values[index], widget.measure),
          color: multi ? color(series) : undefined,
        })),
        ...(stacked ? [{ label: 'Total', value: formatNumber(totals[index], widget.measure) }] : []),
      ].filter(line => !multi || line.value !== '—' || line.label === 'Total'),
    )
  }
  return (
    <div className="crp-chart">
      <div
        className="crp-plot"
        ref={node => {
          ;(ref as { current: HTMLDivElement | null }).current = node
          ;(tip.host as { current: HTMLDivElement | null }).current = node
        }}
        onMouseLeave={() => {
          setHover(null)
          tip.hide()
        }}
      >
        {width > 0 && (
          <svg width={width} height={height} role="img" aria-label={widget.title || 'Chart'}>
            {ticks.map(tick => (
              <g key={tick}>
                <line className="crp-grid" x1={left} x2={width - right} y1={y(tick)} y2={y(tick)} />
                <text className="crp-axis" x={left - 6} y={y(tick) + 4} textAnchor="end">
                  {formatNumber(tick)}
                </text>
              </g>
            ))}
            <line className="crp-baseline" x1={left} x2={width - right} y1={y(0)} y2={y(0)} />
            {chart.categories.map((category, index) =>
              index % every === 0 ? (
                <text
                  key={category.key}
                  className="crp-axis"
                  x={left + band * index + band / 2}
                  y={height - 6}
                  textAnchor="middle"
                >
                  {short(category.label, Math.max(3, Math.floor((band * every) / 7)))}
                </text>
              ) : null,
            )}
            {!line &&
              chart.categories.map((category, index) => {
                const barW = Math.max(2, Math.min(48, band * 0.72))
                const x0 = left + band * index + (band - barW) / 2
                if (stacked) {
                  let base = 0
                  const parts = chart.series.map(series => {
                    const value = series.values[index] ?? 0
                    const part = { series, from: base, to: base + value }
                    base += value
                    return part
                  })
                  const lastWithValue = [...parts].reverse().find(part => part.to > part.from)
                  return (
                    <g key={category.key} opacity={hover === null || hover === index ? 1 : 0.55}>
                      {parts.map(part => {
                        if (part.to <= part.from) return null
                        const yTop = y(part.to),
                          h = y(part.from) - yTop
                        const gap = part === parts.find(p => p.to > p.from) ? 0 : 1
                        return part === lastWithValue ? (
                          <path
                            key={part.series.key}
                            d={roundedTop(x0, yTop, barW, Math.max(0, h - gap), 4)}
                            fill={color(part.series)}
                          />
                        ) : (
                          <rect
                            key={part.series.key}
                            x={x0}
                            y={yTop}
                            width={barW}
                            height={Math.max(0, h - gap)}
                            fill={color(part.series)}
                          />
                        )
                      })}
                    </g>
                  )
                }
                const each = chart.series.length
                const slot = barW / each
                return (
                  <g key={category.key} opacity={hover === null || hover === index ? 1 : 0.55}>
                    {chart.series.map((series, at) => {
                      const value = series.values[index] ?? 0
                      if (value <= 0) return null
                      return (
                        <path
                          key={series.key}
                          d={roundedTop(
                            x0 + slot * at + (each > 1 ? 1 : 0),
                            y(value),
                            slot - (each > 1 ? 2 : 0),
                            y(0) - y(value),
                            4,
                          )}
                          fill={multi ? color(series) : 'var(--crp-s1)'}
                        />
                      )
                    })}
                  </g>
                )
              })}
            {line &&
              chart.series.map(series => {
                const segments: string[][] = [[]]
                series.values.forEach((value, index) => {
                  if (value === null) {
                    if (segments[segments.length - 1].length) segments.push([])
                    return
                  }
                  segments[segments.length - 1].push(`${left + band * index + band / 2},${y(value)}`)
                })
                const stroke = multi ? color(series) : 'var(--crp-s1)'
                return (
                  <g key={series.key}>
                    {segments
                      .filter(points => points.length)
                      .map(points =>
                        points.length === 1 ? (
                          <circle
                            key={points[0]}
                            cx={Number(points[0].split(',')[0])}
                            cy={Number(points[0].split(',')[1])}
                            r={3}
                            fill={stroke}
                          />
                        ) : (
                          <polyline
                            key={points[0]}
                            points={points.join(' ')}
                            fill="none"
                            stroke={stroke}
                            strokeWidth={2}
                          />
                        ),
                      )}
                  </g>
                )
              })}
            {line && hover !== null && (
              <g>
                <line
                  className="crp-crosshair"
                  x1={left + band * hover + band / 2}
                  x2={left + band * hover + band / 2}
                  y1={top}
                  y2={top + plotH}
                />
                {chart.series.map(series => {
                  const value = series.values[hover]
                  if (value === null) return null
                  return (
                    <circle
                      key={series.key}
                      className="crp-dot"
                      cx={left + band * hover + band / 2}
                      cy={y(value)}
                      r={4}
                      fill={multi ? color(series) : 'var(--crp-s1)'}
                    />
                  )
                })}
              </g>
            )}
            {chart.categories.map((category, index) => (
              <rect
                key={category.key}
                className="crp-hit"
                x={left + band * index}
                y={top}
                width={band}
                height={plotH}
                onMouseMove={label(index)}
                onClick={onPick ? () => onPick(category.key, category.label) : undefined}
              />
            ))}
          </svg>
        )}
        {tip.view}
      </div>
      {multi && <Legend items={chart.series} color={color} />}
    </div>
  )
}

function PieChart({
  widget,
  chart,
  fields,
  onPick,
}: {
  widget: Widget
  chart: ChartData
  fields: Field[]
  onPick?: PickGroup
}) {
  const [ref, size] = useSize<HTMLDivElement>()
  const tip = useTip()
  const [hover, setHover] = useState<string | null>(null)
  const values = chart.series[0].values.map(value => Math.max(0, value ?? 0))
  const total = values.reduce((sum, value) => sum + value, 0)
  const color = palette(chart.categories, widget.groupBy)
  const diameter = Math.max(0, Math.min(size.width, size.height) - 8)
  const radius = diameter / 2,
    inner = radius * 0.58
  let angle = -Math.PI / 2
  const arcs = chart.categories.map((category, index) => {
    const share = total ? values[index] / total : 0
    const start = angle,
      end = angle + share * Math.PI * 2
    angle = end
    return { category, index, start, end, share }
  })
  const point = (r: number, a: number) => `${radius + 4 + r * Math.cos(a)},${radius + 4 + r * Math.sin(a)}`
  const arcPath = (start: number, end: number) => {
    if (end - start >= Math.PI * 2 - 1e-6) end = start + Math.PI * 2 - 1e-4
    const large = end - start > Math.PI ? 1 : 0
    return `M${point(radius, start)}A${radius},${radius} 0 ${large} 1 ${point(radius, end)}L${point(inner, end)}A${inner},${inner} 0 ${large} 0 ${point(inner, start)}Z`
  }
  const lines = (index: number) => [
    { label: valueName(widget, fields), value: formatNumber(chart.series[0].values[index], widget.measure) },
    { label: 'Share', value: `${total ? Math.round((values[index] / total) * 100) : 0}%` },
  ]
  if (!total) return <Empty />
  return (
    <div className="crp-pie">
      <div className="crp-pie-plot" ref={ref}>
        <div
          ref={tip.host}
          className="crp-pie-host"
          onMouseLeave={() => {
            setHover(null)
            tip.hide()
          }}
        >
          {diameter > 20 && (
            <svg width={diameter + 8} height={diameter + 8} role="img" aria-label={widget.title || 'Pie chart'}>
              {arcs.map(arc =>
                arc.share > 0 ? (
                  <path
                    key={arc.category.key}
                    d={arcPath(arc.start, arc.end)}
                    fill={color(arc.category)}
                    className="crp-slice"
                    opacity={hover === null || hover === arc.category.key ? 1 : 0.45}
                    onClick={onPick ? () => onPick(arc.category.key, arc.category.label) : undefined}
                    onMouseMove={event => {
                      setHover(arc.category.key)
                      tip.show(event, arc.category.label, lines(arc.index))
                    }}
                  />
                ) : null,
              )}
              <text
                className="crp-pie-total"
                x={radius + 4}
                y={radius + 4}
                textAnchor="middle"
                dominantBaseline="middle"
              >
                {formatNumber(total, widget.measure.op === 'percent' ? undefined : widget.measure)}
              </text>
            </svg>
          )}
          {tip.view}
        </div>
      </div>
      <ul className="crp-pie-legend">
        {arcs.map(arc => (
          <li
            key={arc.category.key}
            onMouseEnter={() => setHover(arc.category.key)}
            onMouseLeave={() => setHover(null)}
            onClick={onPick ? () => onPick(arc.category.key, arc.category.label) : undefined}
            className={hover === arc.category.key ? 'on' : ''}
          >
            <i style={{ background: color(arc.category) }} />
            <span title={arc.category.label}>{arc.category.label}</span>
            <b>{formatNumber(chart.series[0].values[arc.index], widget.measure)}</b>
            <em>{Math.round(arc.share * 100)}%</em>
          </li>
        ))}
      </ul>
    </div>
  )
}

function SummaryTable({
  widget,
  chart,
  fields,
  onPick,
}: {
  widget: Widget
  chart: ChartData
  fields: Field[]
  onPick?: PickGroup
}) {
  const group = fields.find(field => field.key === widget.groupBy)?.label || 'Group'
  return (
    <div className="crp-table-wrap">
      <table className="crp-table">
        <thead>
          <tr>
            <th>{group}</th>
            {chart.series.map(series => (
              <th key={series.key} className="num">
                {chart.series.length > 1 ? series.label : valueName(widget, fields)}
              </th>
            ))}
            <th className="num">Rows</th>
          </tr>
        </thead>
        <tbody>
          {chart.categories.map((category, index) => (
            <tr key={category.key} onClick={onPick ? () => onPick(category.key, category.label) : undefined}>
              <td>{category.label}</td>
              {chart.series.map(series => (
                <td key={series.key} className="num">
                  {formatNumber(series.values[index], widget.measure)}
                </td>
              ))}
              <td className="num">{chart.counts[index]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function RowsTable({ computed }: { computed: Extract<Computed, { kind: 'rows' }> }) {
  if (!computed.rows.length) return <Empty />
  return (
    <div className="crp-table-wrap">
      <table className="crp-table">
        <thead>
          <tr>
            {computed.columns.map(column => (
              <th key={column.key} className={column.type === 'number' ? 'num' : ''}>
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {computed.rows.map((row, index) => (
            <tr key={String(row.$id ?? index)}>
              {computed.columns.map(column => (
                <td
                  key={column.key}
                  className={column.type === 'number' ? 'num' : column.type === 'date' ? 'date' : ''}
                >
                  {displayValue(row[column.key], column.type)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {computed.total > computed.rows.length && (
        <p className="crp-more">
          Showing {computed.rows.length} of {computed.total}.
        </p>
      )}
    </div>
  )
}

function Gantt({ widget, bars, today }: { widget: Widget; bars: GanttBar[]; today: string }) {
  const tip = useTip()
  const groups = useMemo(() => {
    const seen = new Map<string, { key: string; label: string }>()
    for (const bar of bars)
      if (bar.group && !seen.has(bar.group)) seen.set(bar.group, { key: bar.group, label: bar.group })
    return [...seen.values()]
  }, [bars])
  if (!bars.length) return <Empty>No rows with dates to show.</Empty>
  const color = palette(groups, widget.splitBy)
  const first = Math.min(...bars.map(bar => dayNumber(bar.start) as number))
  const last = Math.max(...bars.map(bar => dayNumber(bar.end) as number))
  const from = first - 1,
    to = last + 2
  const span = Math.max(1, to - from)
  const pct = (day: number) => ((day - from) / span) * 100
  const ticks: { day: number; label: string }[] = []
  const unit = span > 120 ? 'month' : span > 14 ? 'week' : 'day'
  for (let day = from; day <= to; day++) {
    const [year, month, date] = isoOf(day).split('-').map(Number)
    const monday = new Date(day * 86400000).getUTCDay() === 1
    if (unit === 'month' && date === 1)
      ticks.push({ day, label: month === 1 || !ticks.length ? `${MONTHS[month - 1]} ${year}` : MONTHS[month - 1] })
    else if ((unit === 'week' && monday) || unit === 'day') ticks.push({ day, label: `${MONTHS[month - 1]} ${date}` })
  }
  const todayDay = dayNumber(today)
  return (
    <div className="crp-gantt" ref={tip.host} onMouseLeave={tip.hide}>
      <div className="crp-gantt-head">
        <span />
        <div className="crp-gantt-scale">
          {ticks.map(tick => (
            <span key={tick.day} style={{ left: `${pct(tick.day)}%` }}>
              {tick.label}
            </span>
          ))}
        </div>
      </div>
      <div className="crp-gantt-body">
        {bars.map(bar => {
          const start = dayNumber(bar.start) as number,
            end = dayNumber(bar.end) as number
          return (
            <div className="crp-gantt-row" key={bar.id}>
              <span className="crp-gantt-label" title={bar.label}>
                {bar.label}
              </span>
              <div className="crp-gantt-track">
                {todayDay !== null && todayDay >= from && todayDay <= to && (
                  <i className="crp-today" style={{ left: `${pct(todayDay + 0.5)}%` }} />
                )}
                <span
                  className="crp-gantt-bar"
                  style={{
                    left: `${pct(start)}%`,
                    width: `${Math.max(0.6, pct(end + 1) - pct(start))}%`,
                    background: bar.group ? color({ key: bar.group, label: bar.group }) : 'var(--crp-s1)',
                  }}
                  onMouseMove={event =>
                    tip.show(event, bar.label, [
                      { label: 'Start', value: niceDate(bar.start) },
                      { label: 'End', value: niceDate(bar.end) },
                      ...(bar.group ? [{ label: 'Group', value: bar.group }] : []),
                    ])
                  }
                />
              </div>
            </div>
          )
        })}
      </div>
      {groups.length > 1 && <Legend items={groups} color={color} />}
      {tip.view}
    </div>
  )
}

/** The inside of a widget: what it shows, given what was worked out for it. */
export function WidgetBody({
  widget,
  computed,
  fields,
  today,
  problem,
  onPick,
}: {
  widget: Widget
  computed: Computed | null
  fields: Field[]
  today: string
  /** Shown instead of the data, e.g. while a tracker loads. */
  problem?: string
  /**
   * Drill-down (the Action Center): a group's key and label, or null for the whole widget (a metric). Without it the
   * widget is not clickable.
   */
  onPick?: (key: string | null, label: string) => void
}) {
  if (widget.kind === 'heading') return <h3 className="crp-heading">{widget.text || 'Section'}</h3>
  if (widget.kind === 'note') return <p className="crp-note">{widget.text}</p>
  if (problem || !computed) return <Empty>{problem || 'Loading…'}</Empty>
  switch (computed.kind) {
    case 'metric':
      return (
        <div
          className="crp-metric"
          {...(onPick
            ? {
                role: 'button',
                tabIndex: 0,
                title: 'See these rows',
                onClick: () => onPick(null, valueName(widget, fields)),
                onKeyDown: (event: { key: string }) => {
                  if (event.key === 'Enter') onPick(null, valueName(widget, fields))
                },
              }
            : {})}
        >
          <strong>{formatNumber(computed.value, widget.measure)}</strong>
          <span>
            {valueName(widget, fields)}
            {widget.measure.op !== 'count' && ` · ${computed.rows} rows`}
          </span>
        </div>
      )
    case 'chart':
      if (!computed.chart.categories.length) return <Empty />
      if (widget.kind === 'table')
        return <SummaryTable widget={widget} chart={computed.chart} fields={fields} onPick={onPick} />
      if (widget.kind === 'pie')
        return <PieChart widget={widget} chart={computed.chart} fields={fields} onPick={onPick} />
      if (widget.kind === 'bar')
        return <BarChart widget={widget} chart={computed.chart} fields={fields} onPick={onPick} />
      return <ColumnOrLine widget={widget} chart={computed.chart} fields={fields} onPick={onPick} />
    case 'rows':
      return <RowsTable computed={computed} />
    case 'gantt':
      return <Gantt widget={widget} bars={computed.bars} today={today} />
    case 'text':
      return null
  }
}
