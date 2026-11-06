// Turns `node --test` output into GitHub annotations, so the full suite's result shows on the run page.
// Each failing test also gets its own annotation with the error, so a failure can be fixed without rerunning locally.
// Usage: node scripts/test-summary.mjs test-output.txt
import { readFileSync } from 'node:fs'

const text = readFileSync(process.argv[2], 'utf8')
const total = name => Number(new RegExp(`^# ${name} (\\d+)`, 'm').exec(text)?.[1] ?? 0)
const annotation = value => value.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
console.log(`::notice title=Full test suite::${total('pass')} passed, ${total('fail')} failed`)

// A failure is a `not ok` line followed by its YAML block (error, expected, actual, location, stack).
const lines = text.split('\n')
const failures = []
for (let i = 0; i < lines.length; i++) {
  const match = /^(\s*)not ok \d+ - (.+)$/.exec(lines[i])
  if (!match) continue
  const detail = []
  for (let j = i + 1; j < lines.length && detail.length < 25; j++) {
    if (/^\s*(ok|not ok) \d+ - /.test(lines[j]) || /^\s*\.\.\.\s*$/.test(lines[j])) break
    const line = lines[j].trim()
    if (line && line !== '---' && !/^(duration_ms|type):/.test(line)) detail.push(line)
  }
  failures.push({ name: match[2].trim(), detail: detail.join('\n') })
}
const seen = new Set()
for (const failure of failures) {
  if (seen.has(failure.name)) continue
  seen.add(failure.name)
  console.log(
    `::warning title=Failing test: ${annotation(failure.name).slice(0, 200)}::${annotation(failure.detail || '(no detail)')}`,
  )
}
