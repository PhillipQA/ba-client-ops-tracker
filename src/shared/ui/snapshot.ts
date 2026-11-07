/**
 * A picture of part of the page, drawn straight onto a canvas: boxes (backgrounds, borders, rounded corners), text
 * where the browser laid it out, and SVG charts as images. No HTML-in-SVG, so it works in Safari too, and nothing
 * leaves the browser. Enough for reports (cards, tables, numbers and SVG charts), not a general HTML renderer.
 */

type Options = {
  /** Elements matching this selector (and their children) are left out, like the report's buttons. */
  skip?: string
  /** Pixels per CSS pixel. Defaults to 2 for a sharp picture. */
  scale?: number
  /** Behind everything, when the element itself is see-through. */
  background?: string
  /** Widest picture, in CSS pixels; wider elements are scaled down to fit. */
  maxWidth?: number
}

const transparent = (color: string) => !color || color === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(color)
const px = (value: string) => Number.parseFloat(value) || 0

function backgroundOf(element: HTMLElement | null): string | null {
  for (let node = element; node; node = node.parentElement) {
    const color = getComputedStyle(node).backgroundColor
    if (!transparent(color)) return color
  }
  return null
}

const SVG_STYLE = [
  'fill',
  'fill-opacity',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-dasharray',
  'stroke-linecap',
  'opacity',
  'font-family',
  'font-size',
  'font-weight',
  'text-anchor',
  'dominant-baseline',
  'visibility',
]

/** An SVG as a standalone image: classes and CSS variables do not apply there, so computed styles are written in. */
function svgImage(svg: SVGSVGElement, width: number, height: number): Promise<HTMLImageElement | null> {
  const copy = svg.cloneNode(true) as SVGSVGElement
  const sources = [svg, ...Array.from(svg.querySelectorAll('*'))]
  const targets = [copy, ...Array.from(copy.querySelectorAll('*'))]
  sources.forEach((source, index) => {
    const style = getComputedStyle(source)
    const target = targets[index] as SVGElement
    target.setAttribute('style', SVG_STYLE.map(name => `${name}:${style.getPropertyValue(name)}`).join(';'))
  })
  copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  copy.setAttribute('width', String(width))
  copy.setAttribute('height', String(height))
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(copy))}`
  return new Promise(resolve => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => resolve(null)
    image.src = url
  })
}

function roundedRect(context: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2))
  context.beginPath()
  context.moveTo(x + radius, y)
  context.arcTo(x + w, y, x + w, y + h, radius)
  context.arcTo(x + w, y + h, x, y + h, radius)
  context.arcTo(x, y + h, x, y, radius)
  context.arcTo(x, y, x + w, y, radius)
  context.closePath()
}

export async function snapshotElement(root: HTMLElement, options: Options = {}): Promise<HTMLCanvasElement> {
  const origin = root.getBoundingClientRect()
  const width = Math.ceil(origin.width)
  const height = Math.ceil(origin.height)
  const fit = options.maxWidth && width > options.maxWidth ? options.maxWidth / width : 1
  const scale = (options.scale ?? 2) * fit
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * scale))
  canvas.height = Math.max(1, Math.round(height * scale))
  const context = canvas.getContext('2d')
  if (!context) throw new Error('This browser cannot make pictures.')
  context.scale(scale, scale)
  context.fillStyle = backgroundOf(root) || options.background || '#ffffff'
  context.fillRect(0, 0, width, height)
  const at = (rect: DOMRect) => ({
    x: rect.left - origin.left,
    y: rect.top - origin.top,
    w: rect.width,
    h: rect.height,
  })

  const drawBox = (element: Element, style: CSSStyleDeclaration) => {
    const box = at(element.getBoundingClientRect())
    if (!box.w || !box.h) return
    const radius = px(style.borderTopLeftRadius)
    if (!transparent(style.backgroundColor)) {
      context.fillStyle = style.backgroundColor
      roundedRect(context, box.x, box.y, box.w, box.h, radius)
      context.fill()
    }
    const sides = [
      ['Top', box.x, box.y, box.x + box.w, box.y],
      ['Right', box.x + box.w, box.y, box.x + box.w, box.y + box.h],
      ['Bottom', box.x, box.y + box.h, box.x + box.w, box.y + box.h],
      ['Left', box.x, box.y, box.x, box.y + box.h],
    ] as const
    const uniform = sides.every(
      ([side]) => style.getPropertyValue(`border-${side.toLowerCase()}-width`) === style.borderTopWidth,
    )
    if (
      uniform &&
      px(style.borderTopWidth) > 0 &&
      !transparent(style.borderTopColor) &&
      style.borderTopStyle !== 'none'
    ) {
      context.strokeStyle = style.borderTopColor
      context.lineWidth = px(style.borderTopWidth)
      const inset = context.lineWidth / 2
      roundedRect(context, box.x + inset, box.y + inset, box.w - inset * 2, box.h - inset * 2, radius)
      context.stroke()
      return
    }
    for (const [side, x1, y1, x2, y2] of sides) {
      const lineWidth = px(style.getPropertyValue(`border-${side.toLowerCase()}-width`))
      const color = style.getPropertyValue(`border-${side.toLowerCase()}-color`)
      if (!lineWidth || transparent(color) || style.getPropertyValue(`border-${side.toLowerCase()}-style`) === 'none')
        continue
      context.strokeStyle = color
      context.lineWidth = lineWidth
      context.beginPath()
      context.moveTo(x1, y1)
      context.lineTo(x2, y2)
      context.stroke()
    }
  }

  const drawText = (node: Text, style: CSSStyleDeclaration) => {
    const text = node.textContent || ''
    if (!text.trim()) return
    context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
    context.fillStyle = style.color
    context.textBaseline = 'middle'
    const range = document.createRange()
    const upper = style.textTransform === 'uppercase'
    // Word by word, so wrapped lines land where the browser put them.
    for (const match of text.matchAll(/\S+/g)) {
      range.setStart(node, match.index ?? 0)
      range.setEnd(node, (match.index ?? 0) + match[0].length)
      const rect = range.getBoundingClientRect()
      if (!rect.width) continue
      const box = at(rect)
      context.fillText(upper ? match[0].toUpperCase() : match[0], box.x, box.y + box.h / 2)
    }
  }

  const walk = async (node: Node, inherited: CSSStyleDeclaration) => {
    if (node.nodeType === Node.TEXT_NODE) return drawText(node as Text, inherited)
    if (!(node instanceof Element)) return
    if (options.skip && node.matches(options.skip)) return
    const style = getComputedStyle(node)
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return
    if (node instanceof SVGSVGElement) {
      const box = at(node.getBoundingClientRect())
      const image = box.w && box.h ? await svgImage(node, box.w, box.h) : null
      if (image) context.drawImage(image, box.x, box.y, box.w, box.h)
      return
    }
    drawBox(node, style)
    if (node instanceof HTMLInputElement || node instanceof HTMLSelectElement || node instanceof HTMLTextAreaElement) {
      const value = node instanceof HTMLSelectElement ? node.selectedOptions[0]?.text || '' : node.value
      const box = at(node.getBoundingClientRect())
      context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
      context.fillStyle = style.color
      context.textBaseline = 'middle'
      context.fillText(value, box.x + px(style.paddingLeft), box.y + box.h / 2, box.w)
      return
    }
    for (const child of Array.from(node.childNodes)) await walk(child, style)
  }
  await walk(root, getComputedStyle(root))
  return canvas
}

export function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('The picture could not be made.'))), 'image/png'),
  )
}

export function blobBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result || '')
      resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.onerror = () => reject(new Error('The picture could not be read.'))
    reader.readAsDataURL(blob)
  })
}
