export type DocumentKind = 'DRF' | 'FSD' | 'BRD' | 'SO' | 'UAT' | 'UAD' | 'TRN'

export function safeDocumentStem(value: string): string {
  return String(value || '')
    .trim()
    .replace(/\.(?:docx|xlsx|pdf|zip)$/i, '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 150)
}

export function suggestedDocumentStem(kind: DocumentKind, client = '', projectOrSite = ''): string {
  const part = (value: string, fallback: string) => (safeDocumentStem(value) || fallback).slice(0, 65)
  if (kind === 'BRD') return `BRD-${part(projectOrSite, 'Project')}`
  if (kind === 'FSD') return `FSD-${part(client, 'Client')}-${part(projectOrSite, 'Project')}`
  if (kind === 'SO') return `SO-${part(client, 'Client')}-${part(projectOrSite, 'Branch-Site')}`
  // UAT Sign Off, UAT Deployment Approval and Training Sign Off.
  if (kind === 'UAT' || kind === 'UAD' || kind === 'TRN') return `${kind}-${part(client, 'Client')}-${part(projectOrSite, 'Project')}`
  return `DRF-${part(client, 'Client')}-${part(projectOrSite, 'Branch-Site')}`
}

export function documentOutputName(value: string, extension: string, fallback: string): string {
  const stem = safeDocumentStem(value) || safeDocumentStem(fallback) || 'Document'
  return `${stem}.${extension}`
}
