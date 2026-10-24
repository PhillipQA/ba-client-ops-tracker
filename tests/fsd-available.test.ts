import assert from 'node:assert/strict'
import test from 'node:test'
import express from 'express'
import PizZip from 'pizzip'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import FsdReadinessChecklist from '../src/features/documents/FsdReadinessChecklist'
import { fsdReadiness } from '../src/features/documents/fsd-readiness'
import { emptyFsdDraft, fsdSectionsForModules, type FsdSource, type FsdSourceAnalysis } from '../src/features/documents/fsd-model'
import { groundingFromSourceAnalyses, sourceAnalysisFingerprint, validateSourceAnalysis } from '../server/documents/fsd-source-analysis'
import { completeAvailableSections, unavailableFsdInputs, fsdInputCoverage } from '../server/documents/fsd-available'
import { registerFsdRoutes } from '../server/documents/fsd-documents'

const modules = ['MMS Report'] as const
const source: FsdSource = { id: 'SRC-001', name: 'Short notes.txt', kind: 'Chat', target: '', text: 'The stock report shows item codes.' }
function reviewed(s = source, options: Partial<FsdSourceAnalysis> = {}): FsdSource {
  const value = validateSourceAnalysis({ readability: 'readable', summary: 'The stock report displays item codes.', complete: true, requirements: [{ id: 'R1', requirement: s.text, module: 'MMS Report', evidence: [{ sourceId: s.id, quote: s.text }] }], gaps: [], ...options }, s, [...modules])
  return { ...s, analysis: { ...value, fingerprint: sourceAnalysisFingerprint(s, modules), provider: 'Fixture', model: 'Fixture', analyzedAt: '2026-10-07T00:00:00Z' } }
}
const draft = (sources: FsdSource[]) => {
  const d = emptyFsdDraft()
  Object.assign(d.details, { client: 'Acme', feature: 'Stock report', author: 'QA' })
  return { ...d, modules: [...modules], sources, sourceReviewVersion: 1, allowIncomplete: true }
}

test('readiness lists actionable missing inputs in Preview & Generate without demanding a BRD', () => {
  const withGap = reviewed(source, { gaps: ['The calculation formula is missing.', 'Report filter rules are not provided.'] })
  const issues = fsdReadiness([withGap], modules)
  assert.match(issues.find(i => /formula/.test(i.missing))!.add, /worked example/)
  assert.match(issues.find(i => /filter/.test(i.missing))!.add, /column definitions, filter rules/)
  assert.ok(!issues.some(i => i.title === 'POS Feature'))
  const markup = renderToStaticMarkup(createElement(FsdReadinessChecklist, { issues, preview: null }))
  assert.match(markup, /What to add:/)
  assert.match(markup, /formal BRD.*not required/)
  assert.match(markup, /Generate anyway/)
  assert.match(fsdReadiness([], modules)[0].add, /paste a few notes/)
  assert.match(fsdReadiness([{ ...source, target: 'pos' }], modules)[0].missing, /unchecked modules/)
})

test('available generation uses verified partial facts and records unreadable and failed sources as skipped', () => {
  const partial = reviewed(source, { complete: false, readability: 'partial', gaps: ['The report filter is unclear.'] })
  const unreadable = reviewed({ ...source, id: 'SRC-002', name: 'Blurred image.png', text: '[Extraction warning: no readable text found in this image; inspect the original for visual requirements.]' }, { readability: 'unreadable', requirements: [] })
  const failed = { ...source, id: 'SRC-003', name: 'Failed review.txt', analysisError: 'Temporary provider failure' }
  const all = [partial, unreadable, failed]
  assert.throws(() => groundingFromSourceAnalyses(all, all, [...modules]), /review is incomplete/)
  const result = groundingFromSourceAnalyses(all, all, [...modules], true)
  assert.equal(result.requirements.length, 1)
  assert.equal(result.requirements[0].evidence[0].quote, source.text)
  assert.deepEqual(result.sourceCoverage.usedSourceIds, ['SRC-001'])
  assert.deepEqual(result.sourceCoverage.partialSourceIds, ['SRC-001'])
  assert.equal(result.sourceCoverage.skippedSources.length, 2)
  assert.ok(result.gaps.some(g => /Blurred image.*skipped/.test(g)))
})

test('Generate anyway still rejects stale source reviews and unsupported excerpts', () => {
  const partial = reviewed(source, { complete: false })
  assert.throws(() => groundingFromSourceAnalyses([{ ...source, text: 'Edited notes' }], [partial], [...modules], true), /source or scope changed/)
  const forged = structuredClone(partial)
  forged.analysis!.requirements[0].evidence[0].quote = 'Invented maximum quantity'
  assert.throws(() => groundingFromSourceAnalyses([source], [forged], [...modules], true), /excerpt not found/)
})

test('a readable source with no mapped facts can produce a TBD draft; entirely unreadable input cannot', () => {
  const empty = reviewed(source, { requirements: [] })
  assert.equal(groundingFromSourceAnalyses([empty], [empty], [...modules], true).requirements.length, 0)
  assert.throws(() => groundingFromSourceAnalyses([empty], [empty], [...modules]), /usable requirement map/)
  const unreadable = reviewed({ ...source, text: '[Extraction warning: no readable text found in this image; inspect the original for visual requirements.]' }, { readability: 'unreadable', requirements: [] })
  assert.throws(() => groundingFromSourceAnalyses([unreadable], [unreadable], [...modules], true), /at least one readable source/)
})

test('sparse previews retain selected template sections and never reintroduce unchecked sections', () => {
  const expected = fsdSectionsForModules([...modules])
  const result = completeAvailableSections({ sections: [], gaps: [], conflicts: [] }, expected)
  assert.deepEqual(result.sections.map((s: any) => s.id), expected.map(([id]) => id))
  assert.ok(result.sections.every((s: any) => /^TBD/.test(s.blocks[0].text)))
  assert.throws(() => completeAvailableSections({ sections: [{ id: 'pos' }] }, expected), /unchecked section/)
  assert.throws(() => completeAvailableSections({ sections: [{ id: 'summary' }, { id: 'summary' }] }, expected), /duplicate/)
})

test('partly specified module and acceptance notes gain template tables with only TBD values', () => {
  const expected = fsdSectionsForModules([...modules])
  const section = (id: string) => ({ id, sourceIds: [], blocks: [{ type: 'paragraph', text: source.text, requirementIds: ['REQ-001'] }] })
  const result = completeAvailableSections({ sections: [section('report'), section('acceptance')], gaps: [], conflicts: [] }, expected)
  const report = result.sections.find((s: any) => s.id === 'report')!
  assert.equal(report.blocks[0].text, source.text)
  assert.equal(report.blocks.find((b: any) => b.type === 'table' && b.headers.length === 2).rows.length, 8)
  assert.ok(report.blocks.find((b: any) => b.type === 'table' && b.headers.length === 5).rows[0].every((cell: string) => /^TBD/.test(cell)))
  assert.ok(result.sections.find((s: any) => s.id === 'acceptance').blocks.some((b: any) => b.type === 'table' && b.headers.length === 3))
})

async function harness(run: (post: (path: string, body: any) => Promise<{ status: number; body: any }>, wire: any[]) => Promise<void>, reply: any) {
  const originalFetch = globalThis.fetch, wire: any[] = []
  globalThis.fetch = (async (url: any, options: any) => {
    if (!String(url).startsWith('https://api.anthropic.com/')) return originalFetch(url, options)
    wire.push(JSON.parse(options.body))
    return new Response(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(reply) }] }), { headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  const app = express(); app.use(express.json())
  app.use((req: any, _res, next) => { req.authUser = { organizationId: 'fixture', role: 'Administrator', modules: ['documents'] }; next() })
  const pass = (_req: any, _res: any, next: any) => next()
  const db: any = { from: () => ({ select() { return this }, eq() { return this }, async maybeSingle() { return { data: null, error: null } } }) }
  const aiAgents: any = { active: async () => ({ secret: 'synthetic-fixture-only', config: { provider: 'anthropic', model: 'fixture' } }) }
  registerFsdRoutes(app, { db, requireAuth: pass, requireTenant: pass, aiAgents, logoPath: new URL('../templates/fsd-logo.png', import.meta.url).pathname })
  const server = app.listen(0), base = `http://127.0.0.1:${(server.address() as any).port}/api/documents/fsd/`
  const post = async (path: string, body: any) => { const r = await originalFetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() } }
  try { await run(post, wire) } finally { globalThis.fetch = originalFetch; await new Promise<void>(resolve => server.close(() => resolve())) }
}

test('short partial notes preview and export with missing sections, source evidence and actionable pending items', async () => {
  const partial = reviewed(source, { complete: false, readability: 'partial', gaps: ['Report filter rules are missing.'] })
  const unreadable = reviewed({ ...source, id: 'SRC-002', name: 'Blurred image.png', text: '[Extraction warning: no readable text found in this image; inspect the original for visual requirements.]' }, { readability: 'unreadable', requirements: [] })
  const excluded = { ...source, id: 'SRC-003', name: 'Excluded POS notes.txt', target: 'pos' }
  const noFacts = reviewed({ ...source, id: 'SRC-004', name: 'Background.txt' }, { requirements: [] })
  const d = { ...draft([partial, unreadable, excluded, noFacts]), uploadFailures: [{ id: 'upload-1', name: 'Broken.docx', reason: 'Damaged Word document' }] }
  await harness(async (post, wire) => {
    const strict = await post('preview', { ...d, allowIncomplete: false })
    assert.equal(strict.status, 422); assert.equal(wire.length, 0)
    const preview = await post('preview', d)
    assert.equal(preview.status, 200, JSON.stringify(preview.body))
    assert.equal(preview.body.generationMode, 'available')
    assert.equal(preview.body.requirements.length, 1)
    assert.equal(preview.body.sourceCoverage.skippedSources.length, 1)
    assert.deepEqual(preview.body.sourceCoverage.contributingSourceIds, ['SRC-001'])
    assert.deepEqual(preview.body.sourceCoverage.noRelevantSourceIds, ['SRC-004'])
    assert.equal(preview.body.sourceCoverage.excludedSources[0].name, excluded.name)
    assert.equal(preview.body.uploadFailures[0].name, 'Broken.docx')
    assert.match(preview.body.sections.find((s: any) => s.id === 'acceptance').blocks[0].text, /^TBD/)
    assert.ok(preview.body.gaps.some((g: string) => /What to add:.*filter/.test(g)))
    assert.ok(!preview.body.sections.some((s: any) => s.id === 'pos'))
    assert.equal(wire.length, 1)
    const writing = JSON.parse(wire[0].messages[0].content)
    assert.equal(writing.requirements.length, 1); assert.equal(writing.sources, undefined); assert.equal(writing.uploadFailures, undefined)
    const output = await post('generate', { ...d, preview: preview.body, reviewed: true, fileName: 'FSD-Acme-Stock-report.docx' })
    assert.equal(output.status, 200, JSON.stringify(output.body)); assert.equal(output.body.fileName, 'FSD-Acme-Stock-report.docx')
    const zip = new PizZip(Buffer.from(output.body.fileData, 'base64'))
    const word = zip.file('word/document.xml')!.asText()
    assert.match(word, /Pending information/); assert.match(word, /stock report shows item codes/)
    assert.match(word, /Input Coverage/); assert.match(word, /Broken.docx/); assert.match(word, /Excluded POS notes.txt/); assert.match(word, /Background.txt/); assert.match(word, /Reviewed — no relevant requirements/)
    assert.match(word, /What to add:/); assert.match(word, /Blurred image.png: skipped/)
    assert.ok(!word.includes('5.4 POS Feature'))
    const changed = await post('generate', { ...d, sources: [{ ...partial, text: 'Edited notes' }, unreadable], preview: preview.body, reviewed: true })
    assert.equal(changed.status, 422); assert.match(changed.body.error, /excerpt not found|source or scope changed/)
    const unreviewed = await post('generate', { ...d, preview: preview.body, reviewed: false })
    assert.equal(unreviewed.status, 400)
  }, { sections: ['functional', 'report'].map(id => ({ id, title: id, sourceIds: [], blocks: [{ type: 'paragraph', text: 'The stock report shows item codes.', requirementIds: ['REQ-001'] }] })), gaps: [], conflicts: [] })
})

test('TBD-only preview from sparse readable input downloads while basic fields stay mandatory', async () => {
  const d = draft([reviewed(source, { requirements: [] })])
  await harness(async (post, wire) => {
    const missingBasics = await post('preview', { ...d, details: { ...d.details, client: '' } })
    assert.equal(missingBasics.status, 400); assert.match(missingBasics.body.error, /client is required/)
    const preview = await post('preview', d)
    assert.equal(preview.status, 200, JSON.stringify(preview.body)); assert.equal(wire.length, 0)
    assert.deepEqual(preview.body.requirements, [])
    const exported = await post('generate', { ...d, preview: preview.body, reviewed: true })
    assert.equal(exported.status, 200, JSON.stringify(exported.body))
    assert.match(new PizZip(Buffer.from(exported.body.fileData, 'base64')).file('word/document.xml')!.asText(), /Short notes.txt/)
    const forged = structuredClone(preview.body)
    forged.sections.find((s: any) => s.id === 'functional').blocks = [{ type: 'paragraph', text: 'The system automatically emails reports.', requirementIds: [] }]
    const rejected = await post('generate', { ...d, preview: forged, reviewed: true })
    assert.equal(rejected.status, 422); assert.match(rejected.body.error, /unsupported content/)
  }, {})
})



test('upload diagnostics remain actionable without becoming requirement sources', () => {
  const failures = [{ id: 'broken-1', name: 'Broken.docx', reason: 'Damaged Word document' }]
  const issues = fsdReadiness([reviewed()], modules, undefined, failures)
  const unavailable = issues.find(i => i.id === 'broken-1')!
  assert.equal(unavailable.category, 'unavailable')
  assert.match(unavailable.add, /Generate anyway skips/)
  assert.equal(unavailableFsdInputs(undefined).length, 0)
  assert.deepEqual(unavailableFsdInputs(failures), failures)
  assert.throws(() => unavailableFsdInputs([{ ...failures[0], reason: '' }]), /Invalid/)
  assert.throws(() => unavailableFsdInputs([...failures, ...failures]), /Duplicate/)
  const notes = reviewed()
  const rows = fsdInputCoverage([notes], [notes], notes.analysis!.requirements, failures)
  assert.equal(rows[0].status, 'Contributed supported requirements')
  assert.equal(rows[1].name, 'Broken.docx')
  assert.match(rows[1].status, /skipped/)
})
