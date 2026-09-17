import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const lastPath = join(root, '.patch-backups', 'last-applied.json')
console.log(`BA Client Ops Tracker version: ${packageJson.version}`)
if (!existsSync(lastPath)) {
  console.log('No patch has been applied with the patch updater yet.')
  process.exit(0)
}
const last = JSON.parse(readFileSync(lastPath, 'utf8'))
console.log(`Last patch: ${last.patch}`)
console.log(`Applied: ${new Date(last.appliedAt).toLocaleString()}`)
console.log(`Previous version: ${last.fromVersion}`)
console.log(`Current patch version: ${last.toVersion}`)
console.log(`Rollback backup: ${last.backup}`)
