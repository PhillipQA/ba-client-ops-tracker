/** Convert HTML-only email to readable text without executing or rendering HTML. */
export function htmlEmailText(html: string) {
  const entities: Record<string,string> = { amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' ',ndash:'–',mdash:'—',hellip:'…',bull:'•',copy:'©',reg:'®',rsquo:'’',lsquo:'‘',rdquo:'”',ldquo:'“',euro:'€',pound:'£' }
  return html.replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,'')
    .replace(/<\s*br\s*\/?\s*>/gi,'\n').replace(/<\/?(?:p|div|tr|h[1-6]|ul|ol|table|blockquote)\b[^>]*>/gi,'\n')
    .replace(/<li\b[^>]*>/gi,'\n• ').replace(/<\/(?:td|th)>/gi,'\t').replace(/<[^>]*>/g,'')
    .replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi,(match,entity:string)=>{
      if (entity.startsWith('#')) { const n = entity[1].toLowerCase()==='x'?parseInt(entity.slice(2),16):parseInt(entity.slice(1),10); return n>0 && n<=0x10ffff ? String.fromCodePoint(n) : match }
      return entities[entity.toLowerCase()] ?? match
    }).replace(/[ \t]+\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim()
}
export async function gmailBodyText(payload: any, attachment: (id: string) => Promise<string>): Promise<string> {
  if (!payload || payload.filename) return ''
  if (['text/plain','text/html'].includes(payload.mimeType)) {
    const encoded = payload.body?.data || (payload.body?.attachmentId ? await attachment(payload.body.attachmentId) : '')
    const body = encoded ? Buffer.from(encoded,'base64url').toString('utf8') : ''
    return payload.mimeType === 'text/html' ? htmlEmailText(body) : body.trim()
  }
  const parts: any[] = payload.parts || []
  if (payload.mimeType === 'multipart/alternative') {
    for (const part of [...parts].sort((a,b)=>Number(b.mimeType==='text/plain')-Number(a.mimeType==='text/plain'))) {
      const text = await gmailBodyText(part,attachment)
      if (text) return text
    }
    return ''
  }
  const texts: string[]=[]
  for (const part of parts) { const text = await gmailBodyText(part,attachment); if(text) texts.push(text) }
  return texts.join('\n\n')
}
/** Metadata kept for each Gmail attachment. File contents are never stored; they are fetched from Gmail on download. */
export type GmailAttachmentSummary = { name: string; partId: string; mimeType: string; size: number }
export type GmailAttachmentPart = GmailAttachmentSummary & { attachmentId: string; data: string }
export const GMAIL_MAX_ATTACHMENTS = 50
/** Every named part, depth first, in the same order the earlier name-only list used, so stored indexes stay valid. */
export function gmailAttachmentParts(payload: any): GmailAttachmentPart[] {
  const found: GmailAttachmentPart[] = []
  const visit = (part: any) => {
    if (!part) return
    if (part.filename) found.push({
      name: String(part.filename).slice(0,255),
      partId: String(part.partId ?? ''),
      mimeType: String(part.mimeType || 'application/octet-stream').slice(0,255),
      size: Number.isSafeInteger(part.body?.size) && part.body.size > 0 ? part.body.size : 0,
      attachmentId: String(part.body?.attachmentId || ''),
      data: String(part.body?.data || ''),
    })
    for (const child of part.parts || []) visit(child)
  }
  visit(payload)
  return found.slice(0,GMAIL_MAX_ATTACHMENTS)
}
export function gmailAttachmentSummaries(payload: any): GmailAttachmentSummary[] {
  return gmailAttachmentParts(payload).map(({name,partId,mimeType,size}) => ({name,partId,mimeType,size}))
}
/** Rows synced before attachment metadata existed hold plain file names. */
export function storedAttachment(entry: unknown): { name: string; partId?: string } | null {
  if (typeof entry === 'string') return entry ? { name: entry } : null
  if (entry && typeof entry === 'object' && typeof (entry as any).name === 'string' && (entry as any).name) {
    const partId = (entry as any).partId
    return { name: (entry as any).name, ...(typeof partId === 'string' && partId ? { partId } : {}) }
  }
  return null
}
/** Find the Gmail part for a stored attachment. Part ids are stable for a message; attachment ids are not. */
export function matchAttachmentPart(parts: GmailAttachmentPart[], wanted: { name: string; partId?: string }, index: number) {
  if (wanted.partId) return parts.find(part => part.partId === wanted.partId && part.name === wanted.name) || null
  if (parts[index]?.name === wanted.name) return parts[index]
  const sameName = parts.filter(part => part.name === wanted.name)
  return sameName.length === 1 ? sameName[0] : null
}
/** Content-Disposition that always downloads and cannot be used to inject headers or paths. */
export function attachmentDisposition(name: string) {
  const clean = name.replace(/[\u0000-\u001f\u007f"\\/]/g,'_').replace(/^\.+/,'').trim().slice(0,200) || 'attachment'
  const ascii = clean.replace(/[^\x20-\x7e]/g,'_')
  const encoded = encodeURIComponent(clean).replace(/['()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase())
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`
}
/** Only pass through a well-formed MIME type; anything else downloads as generic binary. */
export function attachmentContentType(mimeType: string) {
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/i.test(mimeType) ? mimeType.toLowerCase() : 'application/octet-stream'
}
export type GmailSyncState ={ labels: string[]; cursors: Record<string,string|null>; windowStart?: number; nextLabelIndex?: number; nextHeadIndex?: number }
export const GMAIL_SYNC_WINDOW_DAYS = 10
export function gmailWindowStart(previous: GmailSyncState | undefined, now = Date.now()) {
  const current = Math.floor(now / 1000)
  const cutoff = current - GMAIL_SYNC_WINDOW_DAYS * 86400
  const saved = previous?.windowStart
  // Keep a stable search query while continuing a bounded scan. A stale
  // cursor starts over with a fresh ten-day window.
  return Number.isSafeInteger(saved) && saved! >= cutoff - 6 * 3600 && saved! <= current ? saved! : cutoff
}
export async function syncGmailPages(labels: string[], previous: GmailSyncState | undefined, callbacks: {
  list: (label: string, pageToken?: string) => Promise<{ messages?: {id:string}[]; nextPageToken?: string }>
  message: (id: string, label: string) => Promise<void>
  checkpoint: (state: GmailSyncState) => Promise<void>
}, maxPages = 5, windowStart?: number) {
  const selected = [...new Set(labels)].sort()
  const continuing = previous && JSON.stringify(previous.labels)===JSON.stringify(selected) && previous.windowStart===windowStart
  const state: GmailSyncState = { labels: selected, cursors: continuing ? {...previous.cursors} : {}, ...(windowStart===undefined?{}:{windowStart}), nextLabelIndex:continuing ? previous.nextLabelIndex || 0 : 0, nextHeadIndex:continuing ? previous.nextHeadIndex || 0 : 0 }
  const seen = new Set<string>()
  let pages = 0, completedLabels = 0
  const process = async (label: string, pageToken?: string) => {
    const page = await callbacks.list(label,pageToken)
    for (const message of page.messages || []) {
      if (seen.has(message.id)) continue
      await callbacks.message(message.id,label); seen.add(message.id)
    }
    pages++
    return page.nextPageToken || null
  }
  // Even during a longer backfill, check the newest page so a fresh message
  // does not wait behind the continuation cursor. Rotate labels under budget.
  if (continuing && selected.some(label=>state.cursors[label]!==null)) {
    const headPages=Math.min(selected.length,Math.max(0,maxPages-1))
    for (let i=0;i<headPages;i++) {
      const index=state.nextHeadIndex! % selected.length,label=selected[index]
      state.nextHeadIndex=(index+1)%selected.length
      const token=await process(label)
      if (state.cursors[label]===undefined) state.cursors[label]=token
      await callbacks.checkpoint(state)
    }
  }
  while (pages < maxPages && selected.length && completedLabels < selected.length) {
    const index = state.nextLabelIndex! % selected.length
    const label = selected[index]
    state.nextLabelIndex = (index + 1) % selected.length
    if (state.cursors[label] === null) { completedLabels++; continue }
    completedLabels = 0
    const token = await process(label, state.cursors[label] || undefined)
    if (token && token === state.cursors[label]) throw new Error('Gmail repeated a page token; retry sync.')
    state.cursors[label] = token
    await callbacks.checkpoint(state)
  }
  return { pages, processed:seen.size, hasMore:selected.some(label=>state.cursors[label]!==null), state }
}
