// Summarises Biome's JSON report as GitHub annotations: counts per rule, then where each rule fires.
// Usage: node scripts/lint-summary.mjs lint.json
import { readFileSync } from 'node:fs'

let report = {}
try {
  report = JSON.parse(readFileSync(process.argv[2], 'utf8'))
} catch (error) {
  console.log(`::warning title=Lint summary::Could not read the report: ${error.message}`)
}
const diagnostics = Array.isArray(report.diagnostics) ? report.diagnostics : []
const sources = new Map()
// file:line for a byte offset, so a finding can be found without running Biome
function lineOf(file, offset) {
  if (typeof offset !== 'number') return file
  if (!sources.has(file)) {
    try {
      sources.set(file, readFileSync(file))
    } catch {
      sources.set(file, null)
    }
  }
  const bytes = sources.get(file)
  if (!bytes) return file
  let line = 1
  for (let i = 0; i < offset && i < bytes.length; i++) if (bytes[i] === 10) line++
  return `${file}:${line}`
}
const escape = value => value.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
const byRule = new Map()
for (const d of diagnostics) {
  const rule = d.category || 'unknown'
  const file = d.location?.path?.file || d.location?.path || '?'
  const where = lineOf(file, d.location?.span?.[0] ?? d.location?.span?.start)
  if (!byRule.has(rule)) byRule.set(rule, new Map())
  const files = byRule.get(rule)
  files.set(where, (files.get(where) || 0) + 1)
}
const count = files => [...files.values()].reduce((a, b) => a + b, 0)
const rules = [...byRule].sort((a, b) => count(b[1]) - count(a[1]))
console.log(
  `::notice title=Lint (${diagnostics.length} findings, ${diagnostics.filter(d => d.severity === 'error').length} errors)::${escape(rules.map(([rule, files]) => `${count(files)}  ${rule}`).join('\n') || 'none')}`,
)
const detail = rules.map(
  ([rule, files]) => `${rule}: ${[...files].map(([f, n]) => `${f}${n > 1 ? ` x${n}` : ''}`).join(', ')}`,
)
for (let i = 0; i < Math.min(8, Math.ceil(detail.join('\n').length / 3500)); i++) {
  const chunk = []
  let size = 0
  while (detail.length && size + detail[0].length < 3500) size += chunk.push(detail.shift()) && chunk.at(-1).length
  if (!chunk.length) chunk.push(detail.shift().slice(0, 3500))
  console.log(`::notice title=Lint details ${i + 1}::${escape(chunk.join('\n'))}`)
}
