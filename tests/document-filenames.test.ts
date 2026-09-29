import test from 'node:test'
import assert from 'node:assert/strict'
import { documentOutputName, suggestedDocumentStem } from '../src/documentFilename'

test('document filenames follow the requested client, project and site patterns', () => {
  assert.equal(suggestedDocumentStem('DRF', 'Acme Retail', 'Main / North'), 'DRF-Acme-Retail-Main-North')
  assert.equal(suggestedDocumentStem('FSD', 'Acme Retail', 'POS Rollout'), 'FSD-Acme-Retail-POS-Rollout')
  assert.equal(suggestedDocumentStem('BRD', '', 'POS Rollout'), 'BRD-POS-Rollout')
  assert.equal(suggestedDocumentStem('SO', 'Acme Retail', 'Main / North'), 'SO-Acme-Retail-Main-North')
})

test('custom name is safe and keeps the actual generated document extension', () => {
  assert.equal(documentOutputName('SO-Acme-Main.docx', 'zip', 'SO-Client-Site'), 'SO-Acme-Main.zip')
  assert.equal(documentOutputName('../DRF-Client/Branch', 'xlsx', 'DRF-Client-Site'), 'DRF-Client-Branch.xlsx')
  assert.equal(documentOutputName('', 'docx', 'BRD-Project'), 'BRD-Project.docx')
})
