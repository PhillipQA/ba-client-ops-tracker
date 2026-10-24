/** Email signatures (one per person) and email templates, stored on the server. */
export type EmailTemplate = {
  id: string; name: string; subject: string; body: string; shared: boolean
  createdBy: string; createdByName: string; updatedByName: string; createdAt: string; updatedAt: string; canEdit: boolean
}
export type TemplateDraft = { name: string; subject: string; body: string; shared: boolean }
export const TEMPLATE_LIMITS = { name: 120, subject: 200, body: 30000, signature: 2000 } as const

export class EmailStoreError extends Error { constructor(message: string, public status: number) { super(message) } }

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response
  try {
    response = await fetch(`/api/email${path}`, { method, credentials: 'same-origin', cache: 'no-store', headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  } catch { throw new EmailStoreError('The connection was interrupted. Check your connection and try again.', 0) }
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new EmailStoreError(typeof data?.error === 'string' ? data.error : 'Email templates are unavailable right now.', response.status)
  return data as T
}

export const emailStore = {
  signature: () => call<{ signature: string; saved: boolean }>('GET', '/signature'),
  saveSignature: (signature: string) => call<{ signature: string }>('PUT', '/signature', { signature }),
  templates: () => call<{ templates: EmailTemplate[] }>('GET', '/templates'),
  create: (draft: TemplateDraft) => call<{ template: EmailTemplate }>('POST', '/templates', draft),
  update: (id: string, draft: Partial<TemplateDraft>) => call<{ template: EmailTemplate }>('PATCH', `/templates/${id}`, draft),
  remove: (id: string) => call<{ deleted: true }>('DELETE', `/templates/${id}`),
}

/** The signature block added under a new email's message. */
export const signatureBlock = (signature: string) => signature.trim() ? `\n\n-- \n${signature.trim()}` : ''

/** Puts a template's message above the signature, keeping the signature once. */
export function applyTemplateBody(body: string, signature: string) {
  return `${body.replace(/\s+$/, '')}${signatureBlock(signature)}`
}
