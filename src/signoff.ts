export const DEPLOYMENT_TYPES = ['Production - New Site', 'Production - Head Office', 'Production - Branch'] as const
export const DEPLOYED_PRODUCTS = ['Barter RPOS 5.1', 'Barter FPOS 5.1', 'Barter CX v1.1', 'Barter CX v1.0'] as const
export const SIGNOFF_MAX_FILE_BYTES = 5 * 1024 * 1024
export const SIGNOFF_MAX_TOTAL_BYTES = 12 * 1024 * 1024
export const SIGNOFF_MAX_ATTACHMENTS = 20
export const SIGNOFF_TITLE = 'PRODUCTION DEPLOYMENT APPROVAL FORM'
export const SIGNOFF_PURPOSE = 'This document serves as formal authorization to proceed with the deployment and activation of a new site in the Production environment for client operational use. It confirms that all required readiness activities have been completed and reviewed.'
export const SIGNOFF_SCOPE = 'The deployment approval covers the following scope:\nIn-Scope:\n• New Site configuration\n• POS Terminal Setup\n\nAny functionality, enhancement, or modification not explicitly stated above is excluded from this deployment and will require a separate change request and approval.'
export const SIGNOFF_AUTHORIZATION = 'Based on the completion of the required readiness checks and validations, approval is hereby granted to deploy and activate the new site in the Production environment.\n\nThe new site is authorized for live operational use effective on the approved deployment date.\n\nFollowing deployment, the team will continue to provide full support and promptly address any issues that may arise to ensure system stability and performance.'
export type ApprovalPerson = { name: string; title: string }
export type SignoffInput = {
  clientName: string
  deploymentDate: string
  deploymentType: string
  product: string
  site: string
  documentYear: string
  documentNumber: string
  irippleSignatories: ApprovalPerson[]
  clientSignatories: ApprovalPerson[]
}
export type SignoffAttachment = { name: string; data: string; caption: string }
export function signoffReference(clientName: string, year: string, number: string) {
  const client = clientName.trim().toUpperCase().replace(/[^\p{L}\p{N}]/gu, '') || 'CLIENT'
  return `PAF-${client}-${year}-${number.padStart(2, '0')}`
}
export function formatDeploymentDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) throw new Error('Select a valid deployment date.')
  const [, year, month, day] = match
  const date = new Date(`${value}T12:00:00Z`)
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value || Number(year) < 1900 || Number(year) > 9999) throw new Error('Select a valid deployment date.')
  return `${month}/${day}/${year}`
}
