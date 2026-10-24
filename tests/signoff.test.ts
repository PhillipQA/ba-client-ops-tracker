import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import express from 'express'
import PizZip from 'pizzip'
import { renderSignoff, registerSignoffRoutes, validateSignoff } from '../server/documents/signoff-documents'
import {
  DEPLOYMENT_TYPES,
  DEPLOYED_PRODUCTS,
  SIGNOFF_FORM_LABELS,
  SIGNOFF_FORM_TYPES,
  SIGNOFF_PURPOSE,
  SIGNOFF_MAX_FILE_BYTES,
  SIGNOFF_MAX_SIGNATORIES,
  SIGNOFF_TABLE_MAX_ROWS,
  SIGNOFF_TEMPLATE_KIND,
  GO_LIVE_SECTION_FIELDS,
  GO_LIVE_TYPES,
  EXTRA_SIGNOFF_FORMS,
  formatDeploymentDate,
  requiredSignoffTags,
  signoffFieldDefaults,
  signoffReference,
  signoffSectionDefaults,
  signoffSectionFields,
  signoffTableDefaults,
  signoffTitle,
  type SignoffFormType,
  type SignoffInput,
} from '../src/features/documents/signoff'

const templatePath = new URL('../templates/signoff-template.docx', import.meta.url).pathname
const template = await readFile(templatePath)
const goLiveTemplatePath = new URL('../templates/golive-template.docx', import.meta.url).pathname
const goLiveTemplate = await readFile(goLiveTemplatePath)
const uatTemplate = await readFile(new URL('../templates/uat-template.docx', import.meta.url).pathname)
const uatDeployTemplate = await readFile(new URL('../templates/uatdeploy-template.docx', import.meta.url).pathname)
const trainingTemplate = await readFile(new URL('../templates/training-template.docx', import.meta.url).pathname)
const png = await readFile(new URL('./fixtures/signoff-evidence.png', import.meta.url))
const jpg = await readFile(new URL('./fixtures/signoff-evidence.jpg', import.meta.url))
const input = () => ({
  clientName: 'Example & Partners <Retail>',
  deploymentDate: '2026-09-25',
  deploymentType: 'Production - Branch',
  product: 'Barter CX v1.0',
  site: 'BR-001 & Main',
  documentYear: '2026',
  documentNumber: '7',
  irippleSignatories: [1, 2, 3].map(i => ({ name: `iRipple Person ${i}`, title: `iRipple Role ${i}` })),
  clientSignatories: [1, 2, 3].map(i => ({ name: `Client Person ${i}`, title: `Client Role ${i}` })),
})
const goLiveInput = (): SignoffInput => ({
  ...input(),
  formType: 'golive',
  projectName: 'Retail rollout & pilot',
  preparedBy: 'Approved Author',
  documentDate: '2026-09-28',
  goLiveType: 'Pilot Branch',
  site: '',
  irippleSignatories: input().irippleSignatories.slice(0, 2),
  clientSignatories: input().clientSignatories.slice(0, 2),
  sections: Object.fromEntries(
    GO_LIVE_SECTION_FIELDS.map(([key, label]) => [key, `${label}: edited & verified\nSecond line <details>`]),
  ),
})
const twoEach = () => ({
  irippleSignatories: input().irippleSignatories.slice(0, 2),
  clientSignatories: input().clientSignatories.slice(0, 2),
})
const uatInput = (): SignoffInput => ({
  ...input(),
  ...twoEach(),
  formType: 'uat',
  site: '',
  projectName: 'POS upgrade & rollout',
  preparedBy: 'Approved Author',
  documentDate: '2026-10-20',
  fields: {
    ...signoffFieldDefaults('uat', '2026-10-12'),
    uat_date_end: '2026-10-16',
    version: '5.1.2 & patch',
    testing_environment: 'Staging',
    overall_result: 'Accepted with Known Issues',
  },
  sections: { ...signoffSectionDefaults('uat'), scope_of_uat: 'Loyalty module\nVoid <transactions>' },
  tables: {
    tested_modules: [
      { module_name: 'Loyalty & Rewards', pct_passed: '95%', pct_failed: '5%', uat_cycles: '2', status: 'Accepted' },
      { module_name: 'Voids', pct_passed: '80%', pct_failed: '20%', uat_cycles: '3', status: 'Not Accepted' },
    ],
    high_priority_issues: [
      {
        issue_name: 'Receipt cut-off',
        description: 'Long names <truncated>',
        environment: 'POS',
        status: 'For Re-testing',
        classification: 'Critical',
      },
    ],
    remaining_issues: [
      {
        issue_name: 'Label typo',
        description: 'Report heading',
        environment: 'MMS',
        status: 'Ongoing QA Testing',
        classification: 'Low',
      },
      {
        issue_name: 'Sync lag',
        description: 'Interface delay',
        environment: 'Integration',
        status: 'Ongoing Development',
        classification: 'Medium',
      },
      { issue_name: 'Rounding', description: 'Totals', environment: 'POS', status: 'Passed', classification: 'Low' },
    ],
  },
})
const trainingInput = (): SignoffInput => ({
  ...input(),
  ...twoEach(),
  formType: 'training',
  site: '',
  projectName: 'POS upgrade & rollout',
  preparedBy: 'Approved Author',
  documentDate: '2026-10-20',
  fields: {
    ...signoffFieldDefaults('training', '2026-10-05'),
    training_date_end: '2026-10-07',
    version: '5.1',
    training_mode: 'Hybrid',
    training_facilitator: 'Juan Dela Cruz & Maria',
  },
  sections: {
    ...signoffSectionDefaults('training'),
    training_participants: 'Store managers\nCashiers',
    training_scope: 'POS operations',
    training_materials: 'User guide',
    training_modules: 'POS, MMS',
  },
  tables: {
    training_activities: [
      {
        module_name: 'POS',
        attendees: '8',
        venue: 'Head Office',
        start_date: '2026-10-05',
        end_date: '2026-10-06',
        instructor: 'Juan',
      },
      {
        module_name: 'MMS',
        attendees: '6',
        venue: 'Online',
        start_date: '2026-10-07',
        end_date: '',
        instructor: 'Maria',
      },
    ],
  },
})
const uatDeployInput = (): SignoffInput => ({
  ...input(),
  ...twoEach(),
  formType: 'uatdeploy',
  site: '',
  deploymentDate: '2026-10-25',
  fields: {
    ...signoffFieldDefaults('uatdeploy'),
    enhancement_name: 'Loyalty <Redemption>',
    deployment_type: 'Staging - Hotfix',
    version: '5.1.3-b210',
  },
  sections: { ...signoffSectionDefaults('uatdeploy'), scope: 'New redemption screen\nVoid fixes' },
})
const tablesOf = (xml: string) => [...xml.matchAll(/<w:tbl[ >][\s\S]*?<\/w:tbl>/g)].map(m => m[0])
const rowsOf = (table: string) => [...table.matchAll(/<w:tr[ >][\s\S]*?<\/w:tr>/g)].map(m => m[0])
const textOf = (xml: string) => Array.from(xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g), m => m[1]).join('')
const image = (name = 'evidence.png') => ({ name, data: png.toString('base64'), caption: 'Sample & verified' })

test('Word output retains header/logo and fixed sections, populates every client reference and all six signatories', async () => {
  const rendered = await renderSignoff(template, input())
  assert.equal(rendered.fileName, 'PAF-EXAMPLEPARTNERSRETAIL-2026-07.docx')
  const zip = new PizZip(rendered.output),
    original = new PizZip(template)
  assert.deepEqual(
    zip.file('word/media/image3.jpg')!.asNodeBuffer(),
    original.file('word/media/image3.jpg')!.asNodeBuffer(),
  )
  const body = textOf(zip.file('word/document.xml')!.asText()),
    header = textOf(zip.file('word/header1.xml')!.asText())
  assert(header.includes('PRODUCTION DEPLOYMENT APPROVAL FORM'))
  assert(header.includes('PAF-EXAMPLEPARTNERSRETAIL-2026-07'))
  assert.equal((body.match(/Example &amp; Partners &lt;Retail&gt;/g) || []).length, 3)
  assert(body.includes('09/25/2026'))
  assert(body.includes('Barter CX v1.0'))
  assert(body.includes('BR-001 &amp; Main'))
  for (let i = 1; i <= 3; i++)
    for (const side of ['iRipple', 'Client']) {
      assert(body.includes(`${side} Person ${i}`))
      assert(body.includes(`${side} Role ${i}`))
    }
  assert(body.includes(SIGNOFF_PURPOSE))
  assert(body.includes('New Site configuration'))
  assert(body.includes('POS Terminal Setup'))
  assert(body.includes('Deployment Authorization'))
  assert(!body.includes('Deployment History'))
  assert(!body.includes('CARD INDOGROSIR'))
  assert(!body.includes('{@attachments}'))
  assert.equal(Object.keys(zip.files).filter(n => n.startsWith('word/media/')).length, 1)
})

test('all dropdown choices are accepted; invalid values, impossible dates, and missing fields are rejected', () => {
  for (const deploymentType of DEPLOYMENT_TYPES)
    for (const product of DEPLOYED_PRODUCTS)
      assert.equal(validateSignoff({ ...input(), deploymentType, product }).product, product)
  assert.equal(formatDeploymentDate('2028-02-29'), '02/29/2028')
  for (const date of ['2026-02-29', '2026-04-31', '09/25/2026', '', '2026-00-01'])
    assert.throws(() => formatDeploymentDate(date))
  for (const patch of [
    { clientName: '' },
    { site: '' },
    { deploymentType: 'Sandbox' },
    { product: 'Other' },
    { documentNumber: '0' },
    { documentYear: '26' },
    { clientSignatories: [] },
    { clientName: 'bad\u0000name' },
  ])
    assert.throws(() => validateSignoff({ ...input(), ...patch }))
})

test('edited production sections replace the original wording and preserve multiline text safely', async () => {
  const sections = {
    purpose: 'Branch activation & approval\nReviewed <scope>',
    scope: 'Branch devices only\nPOS 01\nPOS 02',
    deployment_authorization: '',
  }
  const result = await renderSignoff(template, { ...input(), sections })
  const body = new PizZip(result.output).file('word/document.xml')!.asText()
  assert(body.includes('Branch activation &amp; approval'))
  assert(body.includes('Reviewed &lt;scope&gt;'))
  assert(body.includes('<w:br/>'))
  assert(!textOf(body).includes(SIGNOFF_PURPOSE))
  assert(!textOf(body).includes('New Site configuration'))
  assert(!textOf(body).includes('approval is hereby granted'))
  assert(textOf(body).includes('POS 02'))
})

test('Go Live output maps all required fields and editable sections without sample people or dates', async () => {
  const result = await renderSignoff(goLiveTemplate, goLiveInput(), [image()])
  assert.equal(result.fileName, 'SOF-EXAMPLEPARTNERSRETAIL-2026-07.docx')
  assert.equal(result.imageCount, 1)
  const zip = new PizZip(result.output),
    original = new PizZip(goLiveTemplate)
  const body = textOf(zip.file('word/document.xml')!.asText()),
    header = textOf(zip.file('word/header1.xml')!.asText())
  assert(header.includes('GO LIVE SIGN OFF'))
  assert(header.includes('SOF-EXAMPLEPARTNERSRETAIL-2026-07'))
  assert(header.includes('Approved Author'))
  assert(header.includes('09/28/2026'))
  assert(body.includes('09/25/2026'))
  assert(body.includes('Pilot Branch'))
  assert(body.includes('Retail rollout &amp; pilot'))
  assert(body.includes('Example &amp; Partners &lt;Retail&gt;'))
  assert(body.includes('Barter CX v1.0'))
  for (const [, label] of GO_LIVE_SECTION_FIELDS) assert(body.includes(`${label}: edited &amp; verified`))
  assert(body.includes('Second line &lt;details&gt;'))
  assert(!body.includes('iripple_name_3'))
  assert(!body.includes('undefined'))
  assert(!header.includes('Jiane'))
  assert(!header.includes('January 15, 2026'))
  assert(!body.includes('Branch 1 - mm/dd/yyyy'))
  assert.deepEqual(
    zip.file('word/media/image1.jpg')!.asNodeBuffer(),
    original.file('word/media/image1.jpg')!.asNodeBuffer(),
  )
})

test('both layouts support two initial signatories and additional approvers on either side', async () => {
  for (const [bytes, details] of [
    [template, input()],
    [goLiveTemplate, goLiveInput()],
  ] as const) {
    for (const [left, right] of [
      [2, 2],
      [5, 2],
      [2, 5],
      [4, 4],
    ]) {
      const people = (side: string, count: number) =>
        Array.from({ length: count }, (_, i) => ({ name: `${side} approver ${i + 1}`, title: `Role ${i + 1}` }))
      const result = await renderSignoff(bytes, {
        ...details,
        irippleSignatories: people('iRipple', left),
        clientSignatories: people('Client', right),
      })
      const body = new PizZip(result.output).file('word/document.xml')!.asText(),
        approval = body.match(/<w:tbl[ >][\s\S]*?<\/w:tbl>/)![0]
      assert.equal((approval.match(/<w:tr[ >]/g) || []).length, Math.max(left, right) + 1)
      for (let i = 1; i <= left; i++) assert(textOf(approval).includes(`iRipple approver ${i}`))
      for (let i = 1; i <= right; i++) assert(textOf(approval).includes(`Client approver ${i}`))
      assert(!textOf(approval).includes('undefined'))
      assert(!textOf(approval).includes('{client_'))
      if (left !== right) {
        const finalRow = [...approval.matchAll(/<w:tr[ >][\s\S]*?<\/w:tr>/g)].at(-1)![0]
        const cells = [...finalRow.matchAll(/<w:tc[ >][\s\S]*?<\/w:tc>/g)].map(m => m[0])
        const unused = left < right ? cells[0] : cells.at(-1)!
        assert.equal(textOf(unused), '')
      }
    }
  }
})

test('Go Live validation rejects missing required fields and unsafe sections or signer counts', () => {
  for (const goLiveType of GO_LIVE_TYPES)
    assert.equal(validateSignoff({ ...goLiveInput(), goLiveType }).go_live_type, goLiveType)
  for (const patch of [
    { formType: 'unknown' },
    { projectName: '' },
    { preparedBy: '' },
    { documentDate: '2026-02-29' },
    { goLiveType: 'Other' },
    { sections: [] },
    { sections: { introduction: 'x'.repeat(12001) } },
    { sections: { introduction: '\u0000' } },
    { irippleSignatories: [{}] },
    { clientSignatories: Array(SIGNOFF_MAX_SIGNATORIES + 1).fill({ name: '', title: '' }) },
  ])
    assert.throws(() => validateSignoff({ ...goLiveInput(), ...patch }))
  assert.equal(validateSignoff({ ...goLiveInput(), sections: { known_issues: '' } }).known_issues, '')
})

test('UAT Sign Off output maps header, fields, sections and every table row', async () => {
  const result = await renderSignoff(uatTemplate, uatInput())
  assert.equal(result.fileName, 'SOF-EXAMPLEPARTNERSRETAIL-2026-07.docx')
  const zip = new PizZip(result.output),
    body = textOf(zip.file('word/document.xml')!.asText()),
    header = textOf(zip.file('word/header1.xml')!.asText())
  assert(header.includes('USER ACCEPTANCE TESTING SIGN OFF'))
  assert(header.includes('SOF-EXAMPLEPARTNERSRETAIL-2026-07'))
  assert(header.includes('Approved Author'))
  assert(header.includes('10/20/2026'))
  assert(body.includes('10/12/2026 to 10/16/2026'))
  assert(body.includes('POS upgrade &amp; rollout'))
  assert(body.includes('5.1.2 &amp; patch'))
  assert(body.includes('Staging'))
  assert(body.includes('Accepted with Known Issues'))
  assert(body.includes('Barter CX v1.0'))
  assert(body.includes('Void &lt;transactions&gt;'))
  assert(body.includes('100% of all scenarios went through testing'))
  assert(!body.includes('09/25/2026'), 'UAT has no deployment date')
  const tables = tablesOf(zip.file('word/document.xml')!.asText())
  const modules = tables.find(table => textOf(table).startsWith('Module Name'))!
  assert.equal(rowsOf(modules).length, 3)
  assert.equal(textOf(rowsOf(modules)[1]), 'Loyalty &amp; Rewards95%5%2Accepted')
  assert.equal(textOf(rowsOf(modules)[2]), 'Voids80%20%3Not Accepted')
  const [high, remaining] = tables.filter(table => textOf(table).startsWith('Issue Name'))
  assert.equal(rowsOf(high).length, 2)
  assert.equal(rowsOf(remaining).length, 4)
  assert.equal(textOf(rowsOf(high)[1]), 'Receipt cut-offLong names &lt;truncated&gt;POSFor Re-testingCritical')
  assert.equal(textOf(rowsOf(remaining)[3]), 'RoundingTotalsPOSPassedLow')
  assert(!body.includes('undefined'))
  assert(!/\{[#/]?[a-z_]+\}/.test(body))
})

test('blank table rows are dropped but a table never renders with headings only', async () => {
  const details = uatInput()
  details.tables = {
    tested_modules: [
      { module_name: 'Loyalty', pct_passed: '', pct_failed: '', uat_cycles: '', status: '' },
      {},
      { module_name: '   ' },
      { module_name: 'Voids' },
    ] as any,
    high_priority_issues: [{}] as any,
    remaining_issues: [],
  }
  const doc = new PizZip((await renderSignoff(uatTemplate, details)).output).file('word/document.xml')!.asText()
  const tables = tablesOf(doc)
  assert.equal(rowsOf(tables.find(table => textOf(table).startsWith('Module Name'))!).length, 3)
  for (const table of tables.filter(table => textOf(table).startsWith('Issue Name'))) {
    assert.equal(rowsOf(table).length, 2)
    assert.equal(textOf(rowsOf(table)[1]), '')
  }
})

test('Training Sign Off output maps dates, facilitator, objectives and activity rows', async () => {
  const result = await renderSignoff(trainingTemplate, trainingInput())
  const zip = new PizZip(result.output),
    doc = zip.file('word/document.xml')!.asText(),
    body = textOf(doc),
    header = textOf(zip.file('word/header1.xml')!.asText())
  assert(header.includes('TRAINING SIGN OFF'))
  assert(header.includes('Approved Author'))
  assert(header.includes('10/20/2026'))
  assert(body.includes('10/05/2026 to 10/07/2026'))
  assert(body.includes('Hybrid'))
  assert(body.includes('Juan Dela Cruz &amp; Maria'))
  assert(body.includes('Identify the many uses of Barter™ software'))
  assert(body.includes('Store managers'))
  assert(body.includes('Cashiers'))
  assert(doc.includes('<w:br/>'))
  assert(body.includes('User guide'))
  assert(body.includes('POS, MMS'))
  const activities = tablesOf(doc).find(table => textOf(table).startsWith('Module Name'))!
  assert.equal(rowsOf(activities).length, 3)
  assert.equal(textOf(rowsOf(activities)[1]), 'POS8Head Office10/05/202610/06/2026Juan')
  assert.equal(textOf(rowsOf(activities)[2]), 'MMS6Online10/07/2026Maria')
  assert(!body.includes('undefined'))
  assert(!/\{[#/]?[a-z_]+\}/.test(body))
})

test('UAT Deployment Approval uses the Production layout with an enhancement heading and its own fields', async () => {
  const result = await renderSignoff(uatDeployTemplate, uatDeployInput())
  assert.equal(result.fileName, 'PAF-EXAMPLEPARTNERSRETAIL-2026-07.docx')
  const zip = new PizZip(result.output),
    body = textOf(zip.file('word/document.xml')!.asText()),
    header = textOf(zip.file('word/header1.xml')!.asText())
  assert(header.includes('UAT DEPLOYMENT APPROVAL FORM'))
  assert(header.includes('PAF-EXAMPLEPARTNERSRETAIL-2026-07'))
  assert(header.includes('Page'))
  assert(body.includes('CLIENT ENHANCEMENT'))
  assert(body.indexOf('CLIENT ENHANCEMENT') < body.indexOf('Loyalty &lt;Redemption&gt;'))
  assert(body.includes('10/25/2026'))
  assert(body.includes('Staging - Hotfix'))
  assert(!body.includes('Production - Branch'), 'the form’s own deployment type wins')
  assert(body.includes('5.1.3-b210'))
  assert(body.includes('Barter CX v1.0'))
  assert(body.includes('Void fixes'))
  assert((body.match(/Example &amp; Partners &lt;Retail&gt;/g) || []).length >= 2)
  assert(body.includes('formally confirm that all required reviews'))
  assert(body.includes('approval is hereby granted'))
  assert(!body.includes('Prepared By'))
  assert(!body.includes('undefined'))
  assert(!/\{[#/]?[a-z_]+\}/.test(body))
})

test('new forms keep two initial signatories and support additional approvers on either side', async () => {
  for (const [bytes, details] of [
    [uatTemplate, uatInput()],
    [uatDeployTemplate, uatDeployInput()],
    [trainingTemplate, trainingInput()],
  ] as const) {
    for (const [left, right] of [
      [2, 2],
      [5, 2],
      [2, 5],
    ]) {
      const people = (side: string, count: number) =>
        Array.from({ length: count }, (_, i) => ({ name: `${side} approver ${i + 1}`, title: `Role ${i + 1}` }))
      const result = await renderSignoff(bytes, {
        ...details,
        irippleSignatories: people('iRipple', left),
        clientSignatories: people('Client', right),
      })
      const approval = tablesOf(new PizZip(result.output).file('word/document.xml')!.asText())[0]
      for (let i = 1; i <= left; i++) assert(textOf(approval).includes(`iRipple approver ${i}`))
      for (let i = 1; i <= right; i++) assert(textOf(approval).includes(`Client approver ${i}`))
      assert(!textOf(approval).includes('undefined'))
      assert(!textOf(approval).includes('{client_'))
    }
  }
})

test('new form validation enforces required fields, choices, date ranges and table limits', () => {
  const withFields = (details: SignoffInput, fields: Record<string, string>) => ({
    ...details,
    fields: { ...details.fields, ...fields },
  })
  const valid = validateSignoff(uatInput())
  assert.equal(valid.uat_date, '10/12/2026 to 10/16/2026')
  assert.equal(valid.deployment_date, '')
  assert.equal(valid.site, '')
  assert.equal(validateSignoff(withFields(uatInput(), { uat_date_end: '2026-10-12' })).uat_date, '10/12/2026')
  assert.equal(validateSignoff(withFields(uatInput(), { uat_date_end: '' })).uat_date, '10/12/2026')
  assert(validateSignoff({ ...uatInput(), sections: undefined }).acceptance_criteria.includes('100% of all scenarios'))
  assert.equal(validateSignoff({ ...uatInput(), sections: { scope_of_uat: '' } }).scope_of_uat, '')
  for (const bad of [
    { uat_date_start: '' },
    { uat_date_start: '2026-02-30' },
    { uat_date_end: '2026-10-01' },
    { version: '' },
    { testing_environment: 'Dev' },
    { overall_result: '' },
    { overall_result: 'Maybe' },
  ])
    assert.throws(() => validateSignoff(withFields(uatInput(), bad)), undefined, JSON.stringify(bad))
  const tooMany = Array.from({ length: SIGNOFF_TABLE_MAX_ROWS + 1 }, () => ({ module_name: 'x' }))
  for (const tables of [
    { tested_modules: tooMany },
    { tested_modules: 'nope' },
    { tested_modules: ['x'] },
    { tested_modules: [{ status: 'Pending' }] },
    { high_priority_issues: [{ environment: 'Mobile' }] },
    { remaining_issues: [{ classification: 'Severe' }] },
    { remaining_issues: [{ status: 'Done' }] },
  ])
    assert.throws(
      () => validateSignoff({ ...uatInput(), tables: { ...uatInput().tables, ...tables } as any }),
      undefined,
      JSON.stringify(tables).slice(0, 60),
    )
  assert.doesNotThrow(() =>
    validateSignoff({
      ...uatInput(),
      tables: { tested_modules: Array.from({ length: SIGNOFF_TABLE_MAX_ROWS }, () => ({ module_name: 'x' })) },
    }),
  )
  assert.throws(() => validateSignoff({ ...uatInput(), fields: [] as any }))
  assert.throws(() => validateSignoff({ ...uatInput(), tables: [] as any }))
  assert.throws(() =>
    validateSignoff({ ...trainingInput(), tables: { training_activities: [{ start_date: '2026-02-30' }] } }),
  )
  assert.throws(() => validateSignoff(withFields(trainingInput(), { training_mode: 'Telepathy' })))
  assert.throws(() => validateSignoff(withFields(trainingInput(), { version: '' })))
  assert.equal(validateSignoff(withFields(trainingInput(), { training_facilitator: '' })).training_facilitator, '')
  for (const patch of [
    { projectName: '' },
    { preparedBy: '' },
    { documentDate: '' },
    { product: 'Other' },
    { clientName: '' },
    { clientSignatories: [] },
  ])
    for (const details of [uatInput(), trainingInput()])
      assert.throws(() => validateSignoff({ ...details, ...patch }), undefined, JSON.stringify(patch))
  for (const fields of [{ enhancement_name: '' }, { deployment_type: '' }, { version: '' }])
    assert.throws(() => validateSignoff(withFields(uatDeployInput(), fields)), undefined, JSON.stringify(fields))
  for (const patch of [{ deploymentDate: '' }, { deploymentDate: '2026-02-30' }, { product: 'Other' }])
    assert.throws(() => validateSignoff({ ...uatDeployInput(), ...patch }), undefined, JSON.stringify(patch))
  // The Production-style header collects neither a project name nor an author.
  assert.equal(
    validateSignoff({ ...uatDeployInput(), projectName: '', preparedBy: '' }).enhancement_name,
    'Loyalty <Redemption>',
  )
})

test('form definitions, defaults and built-in templates stay in step', () => {
  assert.deepEqual([...SIGNOFF_FORM_TYPES], ['production', 'golive', 'uat', 'uatdeploy', 'training'])
  assert.deepEqual(
    SIGNOFF_FORM_TYPES.map(type => SIGNOFF_FORM_LABELS[type]),
    ['Production Deployment Form', 'Go Live Sign Off', 'UAT Sign Off', 'UAT Deployment Approval', 'Training Sign Off'],
  )
  assert.deepEqual(
    SIGNOFF_FORM_TYPES.map(type => SIGNOFF_TEMPLATE_KIND[type]),
    ['signoff', 'golive', 'uat', 'uatdeploy', 'training'],
  )
  assert.deepEqual(signoffFieldDefaults('production'), {})
  assert.deepEqual(signoffFieldDefaults('training', '2026-10-05'), {
    training_date_start: '2026-10-05',
    training_date_end: '',
    version: '',
    training_mode: 'Onsite',
    training_facilitator: '',
  })
  assert.equal(signoffFieldDefaults('uat').overall_result, '')
  assert.equal(signoffFieldDefaults('uatdeploy').deployment_type, 'UAT - Enhancement')
  assert.deepEqual(Object.keys(signoffTableDefaults('uat')), [
    'tested_modules',
    'high_priority_issues',
    'remaining_issues',
  ])
  assert.deepEqual(signoffTableDefaults('golive'), {})
  assert.equal(signoffReference('Acme', '2026', '3', 'uatdeploy'), 'PAF-ACME-2026-03')
  assert.equal(signoffReference('Acme', '2026', '3', 'uat'), 'SOF-ACME-2026-03')
  assert.equal(signoffReference('Acme', '2026', '3', 'training'), 'SOF-ACME-2026-03')
  const bytes = { uat: uatTemplate, uatdeploy: uatDeployTemplate, training: trainingTemplate }
  for (const type of ['uat', 'uatdeploy', 'training'] as const) {
    const zip = new PizZip(bytes[type]),
      xml = zip
        .file(/^word\/(document|header\d*)\.xml$/)
        .map(file => file.asText())
        .join('')
        .replace(/<[^>]+>/g, '')
    for (const tag of requiredSignoffTags(type)) assert(xml.includes(tag), `${type} template is missing ${tag}`)
    const defaults = signoffSectionDefaults(type)
    for (const [key] of signoffSectionFields(type)) assert(key in defaults, `${type} has no default for ${key}`)
    assert.equal(signoffTitle(type), EXTRA_SIGNOFF_FORMS[type].title)
    assert(new PizZip(bytes[type]).file('word/header1.xml')!.asText().includes(EXTRA_SIGNOFF_FORMS[type].title))
  }
})

test('four images are embedded in order with independent relationships and escaped captions', async () => {
  const attachments = [
    image(),
    { name: 'photo.jpg', data: jpg.toString('base64'), caption: 'Photo' },
    image('third.png'),
    image('fourth.png'),
  ]
  const result = await renderSignoff(template, input(), attachments)
  assert.equal(result.imageCount, 4)
  assert(result.fileName.endsWith('.docx'))
  const zip = new PizZip(result.output),
    doc = zip.file('word/document.xml')!.asText(),
    rels = zip.file('word/_rels/document.xml.rels')!.asText()
  for (let i = 1; i <= 4; i++) {
    assert(doc.includes(`rIdSignoffImage${i}`))
    assert(rels.includes(`Id="rIdSignoffImage${i}"`))
  }
  assert.deepEqual(zip.file('word/media/signoff-2.jpg')!.asNodeBuffer(), jpg)
  assert(doc.includes('Sample &amp; verified'))
  assert(doc.indexOf('Attachment 1') < doc.indexOf('Attachment 4'))
  const independent = new PizZip(
    (await renderSignoff(template, { ...input(), clientName: 'Another Account' }, [])).output,
  )
  assert(!independent.file('word/document.xml')!.asText().includes('rIdSignoffImage'))
})

test('supporting files are bundled byte-for-byte beside the Word form with safe unique paths', async () => {
  const bytes = Buffer.from('Supporting evidence — keep original bytes')
  const result = await renderSignoff(template, input(), [
    image(),
    { name: '../../report.txt', data: bytes.toString('base64'), caption: 'Reference' },
    { name: '../../report.txt', data: bytes.toString('base64'), caption: '' },
  ])
  assert.equal(result.mimeType, 'application/zip')
  const zip = new PizZip(result.output),
    paths = Object.keys(zip.files).filter(p => !zip.files[p].dir)
  assert.equal(paths.length, 4)
  assert(paths.every(p => !p.split('/').includes('..')))
  for (const path of paths.filter(p => p.endsWith('.txt'))) assert.deepEqual(zip.file(path)!.asNodeBuffer(), bytes)
  const doc = new PizZip(zip.file(paths.find(p => p.endsWith('.docx'))!)!.asNodeBuffer())
  assert(doc.file('word/document.xml')!.asText().includes('accompanying ZIP'))
})

test('custom filename follows the Word form into the downloadable ZIP and DocHub upload', async () => {
  const stem = 'SO-Example-Branch-7'
  const word = await renderSignoff(template, input(), [], `${stem}.docx`)
  assert.equal(word.fileName, `${stem}.docx`)
  const packaged = await renderSignoff(
    template,
    input(),
    [{ name: 'approval.txt', data: Buffer.from('approved').toString('base64'), caption: '' }],
    `${stem}.docx`,
  )
  assert.equal(packaged.fileName, `${stem}.zip`)
  assert.equal(packaged.signingFile?.fileName, `${stem}.docx`)
  assert(new PizZip(packaged.output).file(`${stem}.docx`))
})

test('attachment validation rejects unsupported files, malformed images, oversized uploads, and excess counts', async () => {
  for (const attachments of [
    [{ name: 'run.exe', data: 'eA==', caption: '' }],
    [{ name: 'bad.png', data: 'eA==', caption: '' }],
    [{ name: 'bad.txt', data: '====', caption: '' }],
    Array.from({ length: 21 }, () => image()),
    [{ name: 'big.txt', data: Buffer.alloc(SIGNOFF_MAX_FILE_BYTES + 1).toString('base64'), caption: '' }],
  ])
    await assert.rejects(() => renderSignoff(template, input(), attachments))
  const validLargeText = { name: 'large.txt', data: Buffer.alloc(4 * 1024 * 1024, 65).toString('base64'), caption: '' }
  await assert.rejects(
    () =>
      renderSignoff(template, input(), [
        validLargeText,
        validLargeText,
        validLargeText,
        { name: 'one.txt', data: 'eA==', caption: '' },
      ]),
    /12 MB/,
  )
})

test('HTTP generation requires a tenant with document write access and needs no AI credentials', async () => {
  const app = express()
  app.use(express.json())
  const auth: any = (req: any, res: any, next: any) => {
    const role = req.get('x-test-role')
    if (!role) return res.sendStatus(401)
    req.authUser = {
      role: role === 'Viewer' ? 'Viewer' : role === 'Contributor' ? 'Contributor' : 'Administrator',
      accountType: role === 'platform' ? 'platform' : 'tenant',
      organizationId: req.get('x-test-tenant') || 'a',
      modules: role === 'no-documents' ? [] : ['documents'],
    }
    next()
  }
  const tenant: any = (req: any, res: any, next: any) =>
    req.authUser.accountType === 'tenant' ? next() : res.sendStatus(403)
  const queried: { tenant: string; kind: string }[] = [],
    rows = new Map<string, any>()
  const db: any = {
    from: () => {
      const filters: Record<string, string> = {}
      const query: any = {
        select: () => query,
        eq: (key: string, value: string) => {
          filters[key] = value
          return query
        },
        maybeSingle: async () => {
          queried.push({ tenant: filters.tenant_id, kind: filters.template_type })
          return { data: rows.get(`${filters.tenant_id}:${filters.template_type}`) || null, error: null }
        },
      }
      return query
    },
  }
  registerSignoffRoutes(app, { db, requireAuth: auth, requireTenant: tenant, templatePath, goLiveTemplatePath })
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  try {
    const call = (role: string, tenantId = 'a', details: any = input()) =>
      fetch(`http://127.0.0.1:${(server.address() as any).port}/api/documents/signoff/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-test-role': role, 'x-test-tenant': tenantId },
        body: JSON.stringify({ details: { ...details, clientName: tenantId }, attachments: [] }),
      })
    assert.equal((await call('')).status, 401)
    for (const role of ['Viewer', 'platform', 'no-documents']) assert.equal((await call(role)).status, 403)
    for (const role of ['Administrator', 'Contributor']) {
      const response = await call(role)
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('cache-control'), 'no-store')
      const result = await response.json()
      assert(result.fileName.endsWith('.docx'))
    }
    const result = await (await call('Contributor', 'second-tenant')).json()
    assert(result.fileName.includes('SECONDTENANT'))
    const liveResponse = await call('Contributor', 'second-tenant', goLiveInput())
    assert.equal(liveResponse.status, 200)
    const liveResult = await liveResponse.json()
    assert(liveResult.fileName.startsWith('SOF-SECONDTENANT'))
    assert.deepEqual(queried.at(-1), { tenant: 'second-tenant', kind: 'golive' })
    rows.set('second-tenant:golive', { is_enabled: false })
    assert.equal((await call('Contributor', 'second-tenant', goLiveInput())).status, 503)
    assert.equal((await call('Contributor', 'second-tenant')).status, 200)
    assert.equal((await call('Contributor', 'a', goLiveInput())).status, 200)
    for (const [details, kind, prefix] of [
      [uatInput(), 'uat', 'SOF-'],
      [uatDeployInput(), 'uatdeploy', 'PAF-'],
      [trainingInput(), 'training', 'SOF-'],
    ] as const) {
      const response = await call('Contributor', 'second-tenant', details)
      assert.equal(response.status, 200)
      assert((await response.json()).fileName.startsWith(`${prefix}SECONDTENANT`))
      assert.deepEqual(queried.at(-1), { tenant: 'second-tenant', kind })
      rows.set(`second-tenant:${kind}`, { is_enabled: false })
      assert.equal((await call('Contributor', 'second-tenant', details)).status, 503)
      assert.equal((await call('Contributor', 'a', details)).status, 200)
    }
    assert.equal((await call('Contributor', 'second-tenant', uatInput())).status, 503)
    assert.equal((await call('Contributor', 'second-tenant', goLiveInput())).status, 503)
    assert.equal((await call('Contributor', 'a', { ...input(), formType: 'unsupported' })).status, 400)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
