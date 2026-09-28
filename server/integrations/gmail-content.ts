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
export type GmailSyncState = { labels: string[]; cursors: Record<string,string|null> }
export async function syncGmailPages(labels: string[], previous: GmailSyncState | undefined, callbacks: {
  list: (label: string, pageToken?: string) => Promise<{ messages?: {id:string}[]; nextPageToken?: string }>
  message: (id: string, label: string) => Promise<void>
  checkpoint: (state: GmailSyncState) => Promise<void>
}, maxPages = 5) {
  const selected = [...new Set(labels)].sort()
  const state: GmailSyncState = { labels: selected, cursors: previous && JSON.stringify(previous.labels)===JSON.stringify(selected) ? {...previous.cursors} : {} }
  const seen = new Set<string>()
  let pages = 0
  for (const label of selected) {
    if (state.cursors[label] === null) continue
    do {
      const page = await callbacks.list(label, state.cursors[label] || undefined)
      for (const message of page.messages || []) {
        if (seen.has(message.id)) continue
        await callbacks.message(message.id,label); seen.add(message.id)
      }
      const token = page.nextPageToken || null
      if (token && token === state.cursors[label]) throw new Error('Gmail repeated a page token; retry sync.')
      state.cursors[label] = token
      await callbacks.checkpoint(state)
      pages++
    } while (state.cursors[label] !== null && pages < maxPages)
    if (pages >= maxPages) break
  }
  return { pages, processed:seen.size, hasMore:selected.some(label=>state.cursors[label]!==null), state }
}
