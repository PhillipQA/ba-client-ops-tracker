import { randomBytes } from 'node:crypto'
import { attachmentContentType, attachmentDisposition } from './gmail-content'

/** Sending is a separate Google permission, requested only when a person chooses to send from the tracker. */
export const SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send'
export const READ_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'
export const hasScope = (granted: unknown, scope: string) => String(granted || '').split(/\s+/).includes(scope)

const oneLine = (value: string) => String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
const isAscii = (value: string) => /^[\x20-\x7e]*$/.test(value)

/** Header text that is safe on one line. Non-ASCII text becomes RFC 2047 encoded words of at most 75 characters. */
export function mimeWords(text: string): string {
  const clean = oneLine(text)
  if (isAscii(clean)) return clean
  const words: string[] = []
  let chunk = '', size = 0
  for (const character of Array.from(clean)) {
    const bytes = Buffer.byteLength(character)
    if (size + bytes > 45) { words.push(chunk); chunk = ''; size = 0 }
    chunk += character; size += bytes
  }
  if (chunk) words.push(chunk)
  return words.map(word => `=?UTF-8?B?${Buffer.from(word, 'utf8').toString('base64')}?=`).join('\r\n ')
}

export function mailbox(email: string, name?: string): string {
  const display = oneLine(name || '')
  if (!display) return email
  return isAscii(display) ? `"${display.replace(/["\\]/g, '\\$&')}" <${email}>` : `${mimeWords(display)} <${email}>`
}

/** Base64 in 76-character lines, as MIME requires. */
export function base64Lines(data: Buffer | string): string {
  return (Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8')).toString('base64').replace(/.{76}/g, '$&\r\n').replace(/\r\n$/, '')
}

/** Message ids such as <abc@mail.gmail.com>, from a Message-ID or References header. */
export function messageIds(value: unknown, keep = 20): string[] {
  return (String(value || '').match(/<[^<>\s]{1,300}>/g) || []).slice(-keep)
}

export type OutgoingAttachment = { name: string; mimeType: string; bytes: Buffer }
export type OutgoingMessage = {
  from: { email: string; name?: string }
  to: string[]; cc?: string[]; bcc?: string[]
  subject: string; text: string
  attachments?: OutgoingAttachment[]
  /** Headers that keep a reply in the same conversation. */
  inReplyTo?: string; references?: string[]
  date?: Date
}

/** Build the raw RFC 822 message Gmail expects. Everything written is plain ASCII; text and files are base64. */
export function buildMessage(message: OutgoingMessage): Buffer {
  const headers = [
    'MIME-Version: 1.0',
    `Date: ${(message.date || new Date()).toUTCString()}`,
    `From: ${mailbox(message.from.email, message.from.name)}`,
    `To: ${message.to.join(', ')}`,
    ...(message.cc?.length ? [`Cc: ${message.cc.join(', ')}`] : []),
    ...(message.bcc?.length ? [`Bcc: ${message.bcc.join(', ')}`] : []),
    `Subject: ${mimeWords(message.subject)}`,
    ...(message.inReplyTo ? [`In-Reply-To: ${message.inReplyTo}`] : []),
    ...(message.references?.length ? [`References: ${message.references.join(' ')}`] : []),
  ]
  const text = String(message.text ?? '').replace(/\r\n|\r|\n/g, '\r\n')
  const textPart = ['Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', base64Lines(text)]
  const files = message.attachments || []
  if (!files.length) return Buffer.from([...headers, ...textPart].join('\r\n'), 'utf8')
  const boundary = `=_ba_${randomBytes(18).toString('hex')}`
  const lines = [...headers, `Content-Type: multipart/mixed; boundary="${boundary}"`, '', `--${boundary}`, ...textPart]
  for (const file of files) {
    const name = oneLine(file.name).replace(/[\\/]/g, '_').slice(0, 200) || 'attachment'
    const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
    lines.push(`--${boundary}`, `Content-Type: ${attachmentContentType(file.mimeType)}; name="${ascii}"`, `Content-Disposition: ${attachmentDisposition(name)}`, 'Content-Transfer-Encoding: base64', '', base64Lines(file.bytes))
  }
  lines.push(`--${boundary}--`, '')
  return Buffer.from(lines.join('\r\n'), 'utf8')
}
