export const DEPLOYMENT_TYPES = ['Production - New Site', 'Production - Head Office', 'Production - Branch'] as const
export const DEPLOYED_PRODUCTS = ['Barter RPOS 5.1', 'Barter FPOS 5.1', 'Barter CX v1.1', 'Barter CX v1.0'] as const
export const SIGNOFF_MAX_FILE_BYTES = 5 * 1024 * 1024
export const SIGNOFF_MAX_TOTAL_BYTES = 12 * 1024 * 1024
export const SIGNOFF_MAX_ATTACHMENTS = 20
export const SIGNOFF_MAX_SIGNATORIES = 20
export type SignoffFormType = 'production' | 'golive' | 'uat' | 'uatdeploy' | 'training'
export const SIGNOFF_FORM_TYPES: readonly SignoffFormType[] = ['production', 'golive', 'uat', 'uatdeploy', 'training']
/** Key under which each form's Word template is stored in Settings → Templates. */
export type SignoffTemplateKind = 'signoff' | 'golive' | 'uat' | 'uatdeploy' | 'training'
export const SIGNOFF_TEMPLATE_KIND: Record<SignoffFormType, SignoffTemplateKind> = { production: 'signoff', golive: 'golive', uat: 'uat', uatdeploy: 'uatdeploy', training: 'training' }
export const SIGNOFF_FORM_LABELS: Record<SignoffFormType, string> = { production: 'Production Deployment Form', golive: 'Go Live Sign Off', uat: 'UAT Sign Off', uatdeploy: 'UAT Deployment Approval', training: 'Training Sign Off' }
export const GO_LIVE_TYPES = ['Pilot Branch', 'Store Roll Out'] as const
export const GO_LIVE_TITLE = 'GO LIVE SIGN OFF'
export const PRODUCTION_SECTION_FIELDS = [['purpose', 'Purpose'], ['scope', 'Scope'], ['deployment_authorization', 'Deployment Authorization']] as const
export const GO_LIVE_SECTION_FIELDS = [['introduction', 'Introduction'], ['activities_completed', 'Activities Completed'], ['receipt_validation', 'Receipt Printout Validation'], ['mall_integration', 'Mall Integration Requirements (if applicable)'], ['branches_live', 'Branch/es that Went Live'], ['known_issues', 'Known Issues'], ['acknowledgement', 'Acknowledgement']] as const
export const SIGNOFF_TITLE = 'PRODUCTION DEPLOYMENT APPROVAL FORM'
export const SIGNOFF_PURPOSE = 'This document serves as formal authorization to proceed with the deployment and activation of a new site in the Production environment for client operational use. It confirms that all required readiness activities have been completed and reviewed.'
export const SIGNOFF_SCOPE = 'The deployment approval covers the following scope:\nIn-Scope:\n• New Site configuration\n• POS Terminal Setup\n\nAny functionality, enhancement, or modification not explicitly stated above is excluded from this deployment and will require a separate change request and approval.'
export const SIGNOFF_AUTHORIZATION = 'Based on the completion of the required readiness checks and validations, approval is hereby granted to deploy and activate the new site in the Production environment.\n\nThe new site is authorized for live operational use effective on the approved deployment date.\n\nFollowing deployment, the team will continue to provide full support and promptly address any issues that may arise to ensure system stability and performance.'
export type SignoffControl = 'text' | 'select' | 'suggest' | 'date' | 'daterange'
export type SignoffFieldDef = { key: string; label: string; control: SignoffControl; options?: readonly string[]; required?: boolean; max?: number; placeholder?: string; help?: string; initial?: string }
export type SignoffColumnDef = { key: string; label: string; control: 'text' | 'select' | 'date'; options?: readonly string[]; placeholder?: string }
export type SignoffTableDef = { key: string; label: string; help?: string; columns: readonly SignoffColumnDef[] }
export type SignoffFormDef = {
  type: 'uat' | 'uatdeploy' | 'training'
  title: string
  /** `prepared` = Prepared By + Date header (Go Live layout); `page` = page-number header (Production layout). */
  header: 'prepared' | 'page'
  /** Heading above the approval table: the typed client/project name, or the fixed "Client Enhancement" heading. */
  heading: 'project' | 'enhancement'
  dateLabel?: string
  fields: readonly SignoffFieldDef[]
  sections: readonly (readonly [string, string])[]
  tables: readonly SignoffTableDef[]
}
export const SIGNOFF_TABLE_MAX_ROWS = 40
export const UAT_ENVIRONMENTS = ['Staging', 'Production'] as const
export const UAT_RESULTS = ['Accepted', 'Accepted with Known Issues', 'Not Accepted'] as const
export const TRAINING_MODES = ['Onsite', 'Online', 'Hybrid'] as const
export const UAT_DEPLOYMENT_TYPES = ['UAT - Enhancement', 'UAT - Major Release', 'UAT - Hotfix', 'Staging - Enhancement', 'Staging - Major Release', 'Staging - Hotfix'] as const
const ISSUE_COLUMNS: readonly SignoffColumnDef[] = [
  { key: 'issue_name', label: 'Issue name', control: 'text', placeholder: 'Short name or title for the issue' },
  { key: 'description', label: 'Description', control: 'text', placeholder: 'Brief description of the issue' },
  { key: 'environment', label: 'Environment', control: 'select', options: ['POS', 'MMS', 'Integration'] },
  { key: 'status', label: 'Status', control: 'select', options: ['Passed', 'For Re-testing', 'Ongoing Development', 'Ongoing QA Testing'] },
  { key: 'classification', label: 'Classification', control: 'select', options: ['Critical', 'Medium', 'Low'] },
]
export const EXTRA_SIGNOFF_FORMS: Record<'uat' | 'uatdeploy' | 'training', SignoffFormDef> = {
  uat: {
    type: 'uat', title: 'USER ACCEPTANCE TESTING SIGN OFF', header: 'prepared', heading: 'project',
    fields: [
      { key: 'uat_date', label: 'UAT date', control: 'daterange', required: true, help: 'Start and end date of the UAT. Leave the end date blank for a single day.' },
      { key: 'version', label: 'Version', control: 'text', required: true, max: 80, placeholder: 'Version used during UAT' },
      { key: 'testing_environment', label: 'Testing environment', control: 'select', options: UAT_ENVIRONMENTS, required: true },
      { key: 'overall_result', label: 'Overall UAT result', control: 'select', options: UAT_RESULTS, required: true, initial: '' },
    ],
    sections: [['introduction', 'Introduction'], ['scope_of_uat', 'Scope of UAT'], ['defects_classification', 'Defects Classification'], ['acceptance_criteria', 'Acceptance Criteria']],
    tables: [
      { key: 'tested_modules', label: 'Summary of tested modules', columns: [
        { key: 'module_name', label: 'Module name', control: 'text', placeholder: 'Module tested' },
        { key: 'pct_passed', label: 'Percentage passed', control: 'text', placeholder: 'e.g. 95%' },
        { key: 'pct_failed', label: 'Percentage failed', control: 'text', placeholder: 'e.g. 5%' },
        { key: 'uat_cycles', label: 'No. of UAT cycles', control: 'text', placeholder: 'e.g. 2' },
        { key: 'status', label: 'Status', control: 'select', options: ['Accepted', 'Not Accepted'] },
      ] },
      { key: 'high_priority_issues', label: 'High priority issues identified', columns: ISSUE_COLUMNS },
      { key: 'remaining_issues', label: 'Remaining issues identified', columns: ISSUE_COLUMNS },
    ],
  },
  uatdeploy: {
    type: 'uatdeploy', title: 'UAT DEPLOYMENT APPROVAL FORM', header: 'page', heading: 'enhancement', dateLabel: 'Target Deployment Date',
    fields: [
      { key: 'enhancement_name', label: 'Enhancement name', control: 'text', required: true, max: 180, placeholder: 'Shown under "Client Enhancement" in the heading' },
      { key: 'deployment_type', label: 'Deployment type', control: 'suggest', options: UAT_DEPLOYMENT_TYPES, required: true, max: 120, initial: UAT_DEPLOYMENT_TYPES[0], help: 'Type of deployment and target environment. Pick a suggestion or type your own.' },
      { key: 'version', label: 'Release / Version No.', control: 'text', required: true, max: 80, placeholder: 'Version or build number being deployed' },
    ],
    sections: [['purpose', 'Purpose'], ['scope', 'Scope of Deployment'], ['deployment_authorization', 'Deployment Authorization']],
    tables: [],
  },
  training: {
    type: 'training', title: 'TRAINING SIGN OFF', header: 'prepared', heading: 'project',
    fields: [
      { key: 'training_date', label: 'Training date', control: 'daterange', required: true, help: 'Start and end date of the training. Leave the end date blank for a single day.' },
      { key: 'version', label: 'Version', control: 'text', required: true, max: 80, placeholder: 'Version of the system during training' },
      { key: 'training_mode', label: 'Training mode', control: 'select', options: TRAINING_MODES, required: true },
      { key: 'training_facilitator', label: 'Training facilitator', control: 'text', max: 300, placeholder: 'Name of the person/s who conducted the training' },
    ],
    sections: [['training_participants', 'Training Participants'], ['training_scope', 'Training Scope'], ['training_objectives', 'Training Objectives'], ['training_materials', 'Training Materials Provided'], ['training_modules', 'Modules']],
    tables: [
      { key: 'training_activities', label: 'Training activities completed', columns: [
        { key: 'module_name', label: 'Module name', control: 'text', placeholder: 'Module discussed' },
        { key: 'attendees', label: 'No. of attendees', control: 'text', placeholder: 'e.g. 8' },
        { key: 'venue', label: 'Venue', control: 'text', placeholder: 'Location of training' },
        { key: 'start_date', label: 'Start date', control: 'date' },
        { key: 'end_date', label: 'End date', control: 'date' },
        { key: 'instructor', label: 'Instructor', control: 'text', placeholder: 'Who facilitated' },
      ] },
    ],
  },
}
export function extraSignoffForm(formType: SignoffFormType | undefined): SignoffFormDef | undefined {
  return formType === 'uat' || formType === 'uatdeploy' || formType === 'training' ? EXTRA_SIGNOFF_FORMS[formType] : undefined
}
export const UAT_DEFECTS_CLASSIFICATION = '• "Critical" Class – Features or defects are critical in nature, do not allow the system to operate if the feature does not exist or if the defect is present, do not have workaround and demand immediate action\n• "Medium" Class – Same as "Critical" Class except for the existence of a workaround, do not demand immediate action because of the workaround.\n• "Low" Class – do not stop system operation if the feature does not exist or if the defect is present, has a workaround, is cosmetic in nature, has minimal effect on the system, does not prohibit the users from performing their tasks and have the least priority'
export const UAT_ACCEPTANCE_CRITERIA = 'For the Client to accept the modules with enhancement/changes, the below criteria should apply:\n• 100% of all scenarios went through testing.\n• 100% of all critical POS issues resolved\n• 100% of all critical interface issues are resolved.\n• 90% of all critical MMS issues are resolved. With known workarounds\n• 80% of all non-critical issues are resolved.'
export const TRAINING_OBJECTIVES = '1. Identify the many uses of Barter™ software and how these can be used to develop business and store operations efficiency.\n2. Understand and use the software accurately based on the function of each module, to further improve task implementation.\n3. Apply the technical and logical learning on the actual working environment.\n4. Impart the learning to future end-users of the software.'
export const UAT_DEPLOYMENT_PURPOSE = 'The purpose of this document is to formally confirm that all required reviews, validations, and approvals have been completed, and that authorization is granted to proceed with the deployment of the specified system release to the target environment.'
export const UAT_DEPLOYMENT_AUTHORIZATION = 'Based on the completion of the required activities and validations, approval is hereby granted to proceed with the deployment of the above-mentioned release to the designated environment, in accordance with the approved deployment plan and schedule.\n\nFollowing deployment, the team will continue to provide full support and promptly address any issues that may arise to ensure system stability and performance.'
export type ApprovalPerson = { name: string; title: string }
export type SignoffInput = {
  formType?: SignoffFormType
  projectName?: string
  preparedBy?: string
  documentDate?: string
  goLiveType?: string
  sections?: Record<string, string>
  /** Form-specific values for UAT, UAT Deployment and Training forms. Date ranges use `<key>_start` and `<key>_end`. */
  fields?: Record<string, string>
  /** Repeating table rows for UAT and Training forms, keyed by table. */
  tables?: Record<string, Record<string, string>[]>
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
  return `${formType === 'production' || formType === 'uatdeploy' ? 'PAF' : 'SOF'}-${client}-${year}-${number.padStart(2, '0')}`
}
export function signoffTitle(formType: SignoffFormType) {
  return extraSignoffForm(formType)?.title ?? (formType === 'golive' ? GO_LIVE_TITLE : SIGNOFF_TITLE)
}
export function signoffSectionFields(formType: SignoffFormType): readonly (readonly [string, string])[] {
  return extraSignoffForm(formType)?.sections ?? (formType === 'golive' ? GO_LIVE_SECTION_FIELDS : PRODUCTION_SECTION_FIELDS)
}
/** Initial values for a form's own fields (selects start on their first option unless `initial` says otherwise). */
export function signoffFieldDefaults(formType: SignoffFormType, today = ''): Record<string, string> {
  const result: Record<string, string> = {}
  for (const field of extraSignoffForm(formType)?.fields ?? []) {
    if (field.control === 'daterange') { result[`${field.key}_start`] = today; result[`${field.key}_end`] = '' }
    else result[field.key] = field.initial ?? (field.control === 'select' ? field.options?.[0] ?? '' : '')
  }
  return result
}
export function signoffTableDefaults(formType: SignoffFormType): Record<string, Record<string, string>[]> {
  return Object.fromEntries((extraSignoffForm(formType)?.tables ?? []).map(table => [table.key, [Object.fromEntries(table.columns.map(column => [column.key, '']))]]))
}
/** Mapping tags a custom template for this form must keep, checked when a template is uploaded. */
export function requiredSignoffTags(formType: SignoffFormType): string[] {
  const form = extraSignoffForm(formType)
  if (!form) return []
  const tags = ['{client_name}', '{document_reference}', '{product}', '{iripple_name_1}', '{iripple_title_1}', '{client_name_1}', '{client_title_1}', '{@attachments}']
  if (form.header === 'prepared') tags.push('{project_name}', '{prepared_by}', '{document_date}')
  if (form.dateLabel) tags.push('{deployment_date}')
  if (form.heading === 'enhancement') tags.push('{enhancement_name}')
  for (const field of form.fields) if (!tags.includes(`{${field.key}}`)) tags.push(`{${field.key}}`)
  for (const [key] of form.sections) tags.push(`{${key}}`)
  for (const table of form.tables) tags.push(`{#${table.key}}`, `{/${table.key}}`)
  return tags
}
export function signoffSectionDefaults(formType: SignoffFormType): Record<string, string> {
  if (formType === 'uat') return { introduction: 'This document confirms that User Acceptance Testing (UAT) was conducted by the client\'s designated personnel based on the UAT scenarios, including both negative and positive scenarios.', scope_of_uat: '', defects_classification: UAT_DEFECTS_CLASSIFICATION, acceptance_criteria: UAT_ACCEPTANCE_CRITERIA }
  if (formType === 'uatdeploy') return { purpose: UAT_DEPLOYMENT_PURPOSE, scope: '', deployment_authorization: UAT_DEPLOYMENT_AUTHORIZATION }
  if (formType === 'training') return { training_participants: '', training_scope: '', training_objectives: TRAINING_OBJECTIVES, training_materials: '', training_modules: '' }
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
