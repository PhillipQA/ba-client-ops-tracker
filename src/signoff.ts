export const DEPLOYMENT_TYPES = ['Production - New Site', 'Production - Head Office', 'Production - Branch'] as const
export const DEPLOYED_PRODUCTS = ['Barter RPOS 5.1', 'Barter FPOS 5.1', 'Barter CX v1.1', 'Barter CX v1.0'] as const
export const SIGNOFF_MAX_FILE_BYTES = 5 * 1024 * 1024
export const SIGNOFF_MAX_TOTAL_BYTES = 12 * 1024 * 1024
export const SIGNOFF_MAX_ATTACHMENTS = 20
export const SIGNOFF_MAX_SIGNATORIES = 20
export type SignoffFormType = 'production' | 'golive'
export const GO_LIVE_TYPES = ['Pilot Branch', 'Store Roll Out'] as const
export const GO_LIVE_TITLE = 'GO LIVE SIGN OFF'
export const PRODUCTION_SECTION_FIELDS = [['purpose', 'Purpose'], ['scope', 'Scope'], ['deployment_authorization', 'Deployment Authorization']] as const
export const GO_LIVE_SECTION_FIELDS = [['introduction', 'Introduction'], ['activities_completed', 'Activities Completed'], ['receipt_validation', 'Receipt Printout Validation'], ['mall_integration', 'Mall Integration Requirements (if applicable)'], ['branches_live', 'Branch/es that Went Live'], ['known_issues', 'Known Issues'], ['acknowledgement', 'Acknowledgement']] as const
export const SIGNOFF_TITLE = 'PRODUCTION DEPLOYMENT APPROVAL FORM'
export const SIGNOFF_PURPOSE = 'This document serves as formal authorization to proceed with the deployment and activation of a new site in the Production environment for client operational use. It confirms that all required readiness activities have been completed and reviewed.'
export const SIGNOFF_SCOPE = 'The deployment approval covers the following scope:\nIn-Scope:\n• New Site configuration\n• POS Terminal Setup\n\nAny functionality, enhancement, or modification not explicitly stated above is excluded from this deployment and will require a separate change request and approval.'
export const SIGNOFF_AUTHORIZATION = 'Based on the completion of the required readiness checks and validations, approval is hereby granted to deploy and activate the new site in the Production environment.\n\nThe new site is authorized for live operational use effective on the approved deployment date.\n\nFollowing deployment, the team will continue to provide full support and promptly address any issues that may arise to ensure system stability and performance.'
export type ApprovalPerson = { name: string; title: string }
export type SignoffInput = {
  formType?: SignoffFormType
  projectName?: string
  preparedBy?: string
  documentDate?: string
  goLiveType?: string
  sections?: Record<string, string>
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
export function signoffReference(clientName: string, year: string, number: string, formType: SignoffFormType = 'production') {
  const client = clientName.trim().toUpperCase().replace(/[^\p{L}\p{N}]/gu, '') || 'CLIENT'
  return `${formType === 'golive' ? 'SOF' : 'PAF'}-${client}-${year}-${number.padStart(2, '0')}`
}
export function signoffSectionDefaults(formType: SignoffFormType): Record<string, string> {
  return formType === 'production' ? { purpose: SIGNOFF_PURPOSE, scope: SIGNOFF_SCOPE, deployment_authorization: SIGNOFF_AUTHORIZATION } : {
    introduction: 'This document confirms that the product has been deployed, activated, and is operational in the production environment.',
    activities_completed: '', receipt_validation: '', mall_integration: '', branches_live: '', known_issues: '',
    acknowledgement: 'The signatories confirm their understanding that the stores listed in this document successfully went live in the production environment.',
  }
}
export function formatDeploymentDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) throw new Error('Select a valid deployment date.')
  const [, year, month, day] = match
  const date = new Date(`${value}T12:00:00Z`)
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value || Number(year) < 1900 || Number(year) > 9999) throw new Error('Select a valid deployment date.')
  return `${month}/${day}/${year}`
}
