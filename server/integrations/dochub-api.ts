import { createHmac, timingSafeEqual } from 'node:crypto'

export class DocHubError extends Error {
  constructor(message: string, public status = 400, public providerStatus?: number) { super(message) }
}
const API = 'https://dochub.com/api/v2'
export const docHubId = (id: string) => encodeURIComponent(id)
export function docHubUrl(value: unknown): string {
  try { const u = new URL(String(value)); return u.protocol === 'https:' && !u.username && !u.password && (u.hostname === 'dochub.com' || u.hostname.endsWith('.dochub.com')) ? u.href : '' } catch { return '' }
}
export function storageUrl(value: unknown): string {
  const safe = docHubUrl(value)
  if (safe) return safe
  try { const u = new URL(String(value)); if (u.protocol === 'https:' && !u.username && !u.password && !u.port && /(^|\.)s3([.-][a-z0-9-]+)?\.amazonaws\.com$/.test(u.hostname)) return u.href } catch { /* invalid */ }
  throw new DocHubError('DocHub returned an unsupported storage address.', 502)
}
export function apiClient(secret: string, request: typeof fetch = fetch) {
  return {
    async call(route: string, method = 'GET', body?: unknown): Promise<any> {
      if (!route.startsWith('/') || route.includes('://')) throw new DocHubError('Invalid API route.')
      let response: Response
      try { response = await request(API + route, { method, headers: { 'X-API-Token': secret, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(30_000) }) }
      catch { throw new DocHubError('DocHub did not respond. Use Refresh to reconcile the existing document before trying again.', 502) }
      const result = await response.json().catch(() => ({}))
      if (!response.ok) {
        // Do not expose provider response bodies: they may contain credential or document data.
        const hint = response.status === 401 ? 'The account API key was rejected.' : response.status === 403 ? 'The API key lacks permission for this operation.' : response.status === 402 ? 'The DocHub account has reached its plan limit.' : response.status === 429 ? 'DocHub rate limit reached; wait before refreshing.' : response.status === 422 ? 'DocHub rejected this operation. Open the document to review its recipients and signature fields.' : `DocHub returned HTTP ${response.status}.`
        throw new DocHubError(hint, 502, response.status)
      }
      return result?.data && !Array.isArray(result.data) && result.data.attributes ? { id: result.data.id, ...result.data.attributes } : result
    },
    async upload(file: Buffer, filename: string, contentType: string) {
      const upload = await this.call('/s3-direct', 'POST', { filename, contentType })
      if (!upload.fields?.key) throw new DocHubError('DocHub did not return an upload key.', 502)
      const data = new FormData()
      for (const [key, value] of Object.entries(upload.fields)) data.append(key, String(value))
      if (!upload.fields['Content-Type']) data.append('Content-Type', contentType)
      data.append('file', new Blob([new Uint8Array(file)], { type: contentType }), filename)
      let response: Response
      try { response = await request(storageUrl(upload.url), { method: 'POST', body: data, redirect: 'error', signal: AbortSignal.timeout(60_000) }) }
      catch { throw new DocHubError('The document upload did not finish. Retry this saved preparation.', 502) }
      if (!response.ok) throw new DocHubError('DocHub storage rejected the upload.', 502)
      return String(upload.fields.key)
    },
  }
}
export function verifyDocHubWebhook(raw: Buffer, timestamp: unknown, signature: unknown, secret: string, now = Date.now()) {
  if (typeof timestamp !== 'string' || !/^\d{10}$/.test(timestamp) || typeof signature !== 'string' || !/^dochub_v1=[a-f0-9]{64}$/.test(signature)) return false
  if (Math.abs(now / 1000 - Number(timestamp)) > 300) return false
  const expected = Buffer.from('dochub_v1=' + createHmac('sha256', secret).update(timestamp + '.').update(raw).digest('hex'))
  const actual = Buffer.from(signature)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
export function draftPacket(documentId: string, signers: any[], sequential: boolean, title: string) {
  return { documentId, preparingEnabled: true, hasQueue: sequential, remindersEnabled: false, emailContent: { subject: `Please sign: ${title}`.slice(0, 200), body: 'Please review and sign this document.' }, documentRoles: signers.map((s, i) => ({ id: s.roleId, email: s.email, canFreeEdit: false, receivesFinalCopy: true, ...(sequential ? { queuePosition: i + 1 } : {}) })) }
}
export function signingStatus(remote: any) {
  const status = String(remote.status || '')
  if (status === 'FINALIZED') return 'COMPLETED'
  if (status === 'PREPARING') return 'PREPARING'
  if (['REJECTED','VOIDED','EXPIRED','ERROR','BOUNCE'].includes(status)) return status
  const signers = (remote.signersData || []).filter((s: any) => !s.removed)
  if (status === 'IN_PROGRESS') return signers.some((s: any) => s.signedAt || s.status === 'FINALIZED') ? 'PARTIALLY_SIGNED' : signers.some((s: any) => s.viewedAt) ? 'VIEWED' : 'SENT'
  return 'UNKNOWN'
}
