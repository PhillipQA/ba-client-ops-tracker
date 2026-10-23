/**
 * Rules for composing an email, shared by the browser form and the server so both agree.
 * Nothing here touches the network or the DOM.
 */
export const EMAIL_LIMITS = {
  recipients: 25,
  subject: 200,
  body: 30000,
  attachments: 10,
  /** Total attachment size. Gmail refuses messages over 25 MB once encoded, so this keeps a safe margin. */
  attachmentBytes: 12 * 1024 * 1024,
  taskLinks: 10,
} as const

/** File types Gmail refuses to send. Checking first gives a clear message instead of a Gmail error. */
export const BLOCKED_ATTACHMENT_EXTENSIONS = new Set([
  'ade', 'adp', 'apk', 'appx', 'appxbundle', 'bat', 'cab', 'chm', 'cmd', 'com', 'cpl', 'dll', 'dmg', 'ex', 'ex_', 'exe', 'hta', 'ins', 'isp', 'iso', 'jar', 'js', 'jse', 'lib', 'lnk', 'mde', 'msc', 'msi', 'msix', 'msixbundle', 'msp', 'mst', 'nsh', 'pif', 'ps1', 'scr', 'sct', 'shb', 'sys', 'vb', 'vbe', 'vbs', 'vxd', 'wsc', 'wsf', 'wsh',
])

export function blockedAttachmentReason(name: string): string {
  const extension = String(name || '').split('.').pop()?.toLowerCase() || ''
  return String(name || '').includes('.') && BLOCKED_ATTACHMENT_EXTENSIONS.has(extension)
    ? `Gmail does not allow “.${extension}” files, so “${name}” cannot be attached.` : ''
}

const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/
export function isValidEmail(value: string): boolean {
  return value.length <= 254 && EMAIL.test(value) && !value.includes('..') && !value.startsWith('.') && !value.includes('.@')
}

/** "Ana Cruz <ana@acme.com>" or "ana@acme.com" gives "ana@acme.com". Returns the text unchanged when it has no angle brackets. */
export function extractAddress(value: unknown): string {
  const text = String(value ?? '').trim()
  const angle = text.match(/<([^<>]+)>\s*$/)
  return (angle ? angle[1] : text).trim().replace(/^mailto:/i, '')
}

/** Split a pasted list at commas, semicolons or new lines. Commas inside quotes belong to a display name. */
export function splitAddresses(input: unknown): string[] {
  const parts = Array.isArray(input) ? input.map(String) : String(input ?? '').split(/[;\n]|,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
  return parts.map(extractAddress).filter(Boolean)
}

export type ParsedRecipients = { addresses: string[]; invalid: string[] }
/** Valid addresses with duplicates removed (case-insensitive), plus the entries that are not addresses. */
export function parseRecipients(input: unknown): ParsedRecipients {
  const seen = new Set<string>(), addresses: string[] = [], invalid: string[] = []
  for (const candidate of splitAddresses(input)) {
    if (!isValidEmail(candidate)) { invalid.push(candidate.slice(0, 80)); continue }
    const key = candidate.toLowerCase()
    if (!seen.has(key)) { seen.add(key); addresses.push(candidate) }
  }
  return { addresses, invalid }
}

export function replySubject(subject: string): string {
  const clean = String(subject || '').trim()
  return /^re\s*:/i.test(clean) ? clean : `Re: ${clean || '(no subject)'}`.slice(0, EMAIL_LIMITS.subject)
}

/** The quoted original under a reply, kept short so the reply stays readable. */
export function quoteReply(sender: string, receivedAt: string, body: string, max = 3000): string {
  const when = new Date(receivedAt)
  const stamp = Number.isNaN(when.getTime()) ? '' : `On ${when.toLocaleString()}, `
  const text = String(body || '').trim()
  const clipped = text.length > max ? `${text.slice(0, max).trimEnd()}\n[…]` : text
  return `\n\n${stamp}${String(sender || 'the sender').trim()} wrote:\n${clipped.split(/\r?\n/).map(line => `> ${line}`).join('\n')}`
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  return bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1048576).toFixed(1)} MB`
}

/** Short description of the recipients for activity entries: the first address and a count of the rest. */
export function recipientSummary(addresses: string[]): string {
  if (!addresses.length) return 'no one'
  return addresses.length === 1 ? addresses[0] : `${addresses[0]} and ${addresses.length - 1} other${addresses.length === 2 ? '' : 's'}`
}
