// Turns `node --test` output into GitHub annotations, so the full suite's result shows on the run page.
// Usage: node scripts/test-summary.mjs test-output.txt
import { readFileSync } from 'node:fs'

const text = readFileSync(process.argv[2], 'utf8')
const total = name => Number(new RegExp(`^# ${name} (\\d+)`, 'm').exec(text)?.[1] ?? 0)
const failing = [...new Set([...text.matchAll(/^\s*not ok \d+ - (.+)$/gm)].map(m => m[1].trim()))]
const annotation = value => value.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
console.log(`::notice title=Full test suite::${total('pass')} passed, ${total('fail')} failed`)
if (failing.length) console.log(`::warning title=Failing tests (${failing.length})::${annotation(failing.join('\n'))}`)
