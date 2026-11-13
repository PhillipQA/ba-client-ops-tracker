// Formatted email signatures (bold, colours, fonts, links, a logo), like Gmail's. Shared by the browser and the server,
// so this module stays free of React, the DOM and Node APIs.
//
// A signature is stored as text. A formatted one starts with RICH_MARK and holds HTML that has been through
// sanitizeSignature: only the formatting tags and style properties listed here survive, everything else is dropped or
// written as text, so a stored signature can be shown in the composer and sent in an email as it is.

export const RICH_MARK = '<!--sig:html-->'
export const SIGNATURE_LIMITS = {
  /** The whole stored signature, images included. */
  chars: 400_000,
  images: 3,
  /** One image, as a file. */
  imageBytes: 200_000,
} as const

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
const decode = (text: string) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code =
        name[1].toLowerCase() === 'x' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ''
    }
    return ENTITIES[name.toLowerCase()] ?? whole
  })

const KEEP = new Set(['b', 'strong', 'i', 'em', 'u', 's', 'span', 'div', 'p', 'br', 'a', 'img', 'ul', 'ol', 'li', 'hr'])
const VOID = new Set(['br', 'img', 'hr'])
/** Their content is dropped with them. */
const DROP_WITH_CONTENT = new Set(['script', 'style', 'head', 'title', 'iframe', 'object', 'embed', 'svg', 'math'])
const STYLE = new Set([
  'color',
  'background-color',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'text-decoration',
  'text-decoration-line',
  'text-align',
])
const STYLE_VALUE = /^[#\w ,.%()'-]{1,120}$/
const FONT_SIZES = ['10px', '10px', '13px', '16px', '18px', '24px', '32px', '48px']
const IMAGE = /^data:image\/(png|jpeg|gif);base64,[A-Za-z0-9+/]+=*$/

function cleanStyle(value: string) {
  const kept: string[] = []
  for (const part of decode(value).split(';')) {
    const at = part.indexOf(':')
    if (at < 0) continue
    const name = part.slice(0, at).trim().toLowerCase()
    const text = part
      .slice(at + 1)
      .trim()
      .replace(/"/g, "'")
    if (!STYLE.has(name) || !STYLE_VALUE.test(text) || /url|expression|javascript/i.test(text)) continue
    kept.push(`${name}:${text}`)
  }
  return kept.join(';')
}

function attributes(source: string) {
  const found: Record<string, string> = {}
  for (const match of source.matchAll(/([a-zA-Z][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g))
    found[match[1].toLowerCase()] ??= match[2] ?? match[3] ?? match[4] ?? ''
  return found
}

/** The opening tag as it may be kept, or '' when the tag is dropped (its text stays). */
function openTag(tag: string, given: Record<string, string>, images: { count: number }) {
  const out: string[] = []
  let name = tag
  let style = cleanStyle(given.style || '')
  if (tag === 'font') {
    // Older editors write <font color face size>: kept as a span with the same look.
    name = 'span'
    const size = FONT_SIZES[Number(given.size)] || ''
    style = cleanStyle(
      [
        given.color ? `color:${given.color}` : '',
        given.face ? `font-family:${given.face}` : '',
        size ? `font-size:${size}` : '',
        style,
      ]
        .filter(Boolean)
        .join(';'),
    )
  }
  if (!KEEP.has(name)) return { name: '', html: '' }
  if (name === 'a') {
    const href = decode(given.href || '').trim()
    if (!/^(https?:\/\/|mailto:)[^\s<>"']+$/i.test(href)) return { name: '', html: '' }
    out.push(`href="${escapeHtml(href)}"`, 'target="_blank"', 'rel="noopener noreferrer"')
  }
  if (name === 'img') {
    const src = (given.src || '').trim()
    if (!IMAGE.test(src) || images.count >= SIGNATURE_LIMITS.images) return { name: '', html: '' }
    if (Math.floor((src.length - src.indexOf(',') - 1) * 0.75) > SIGNATURE_LIMITS.imageBytes)
      return { name: '', html: '' }
    images.count++
    out.push(`src="${src}"`, `alt="${escapeHtml(decode(given.alt || '').slice(0, 120))}"`)
    for (const side of ['width', 'height'] as const)
      if (/^\d{1,4}$/.test(given[side] || '')) out.push(`${side}="${given[side]}"`)
  }
  if (style) out.push(`style="${escapeHtml(style)}"`)
  return { name, html: `<${name}${out.length ? ` ${out.join(' ')}` : ''}>` }
}

/**
 * The HTML of a signature with only safe formatting left: the tags in KEEP, the style properties in STYLE, links to
 * http(s) and mailto, and images embedded as PNG, JPEG or GIF data. Scripts, event handlers, remote images, classes
 * and everything else are removed. The result is rebuilt from what was understood, never copied through.
 */
export function sanitizeSignature(html: string): string {
  const source = String(html ?? '').slice(0, SIGNATURE_LIMITS.chars * 2)
  const out: string[] = []
  const open: string[] = []
  const images = { count: 0 }
  let dropping = ''
  const token = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|[^<]+|</g
  for (const match of source.matchAll(token)) {
    const [whole, closing, rawTag, rest] = match
    const tag = rawTag?.toLowerCase()
    if (dropping) {
      if (tag === dropping && closing) dropping = ''
      continue
    }
    if (!tag) {
      if (!whole.startsWith('<!--')) out.push(escapeHtml(decode(whole)))
      continue
    }
    if (DROP_WITH_CONTENT.has(tag)) {
      if (!closing && !/\/\s*$/.test(rest)) dropping = tag
      continue
    }
    if (closing) {
      const name = tag === 'font' ? 'span' : tag
      const at = open.lastIndexOf(name)
      if (at < 0) continue
      while (open.length > at) out.push(`</${open.pop()}>`)
      continue
    }
    const made = openTag(tag, attributes(rest), images)
    if (!made.name) continue
    out.push(made.html)
    if (!VOID.has(made.name)) open.push(made.name)
  }
  while (open.length) out.push(`</${open.pop()}>`)
  return out.join('').slice(0, SIGNATURE_LIMITS.chars)
}

export const isRichSignature = (stored: string) => String(stored || '').startsWith(RICH_MARK)

/** A plain-text signature (as kept before formatting existed) as HTML. */
export const plainToHtml = (text: string) => escapeHtml(String(text || '').trim()).replace(/\r\n|\r|\n/g, '<br>')

/** The signature's HTML, cleaned, from what is stored (formatted or plain). */
export function signatureHtml(stored: string) {
  const value = String(stored || '')
  return isRichSignature(value) ? sanitizeSignature(value.slice(RICH_MARK.length)) : plainToHtml(value)
}

/** What to store for an edited signature: cleaned HTML behind the mark, or '' when it holds nothing. */
export function storeSignature(html: string) {
  const clean = sanitizeSignature(html)
  return signatureText(clean) || /<img /.test(clean) ? `${RICH_MARK}${clean}` : ''
}

/** The signature as plain text, for the text version of an email. */
export function signatureText(html: string) {
  return decode(
    String(html || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(div|p|li)>/gi, '\n')
      .replace(/<hr[^>]*>/gi, '\n----------\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/ /g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export type InlineImage = { cid: string; mimeType: string; data: string }

/**
 * For sending: embedded images become attachments shown in place (cid:), because mail apps such as Gmail do not show
 * images embedded as data. Answers the HTML pointing at them, and the images.
 */
export function inlineImages(html: string, idFor: (index: number) => string) {
  const images: InlineImage[] = []
  const pointed = html.replace(/src="data:(image\/(?:png|jpeg|gif));base64,([A-Za-z0-9+/]+=*)"/g, (_, type, data) => {
    const cid = idFor(images.length)
    images.push({ cid, mimeType: type, data })
    return `src="cid:${cid}"`
  })
  return { html: pointed, images }
}
