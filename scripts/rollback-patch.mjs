import { existsSync, mkdirSync, readFileSync, rmSync, cpSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = process.cwd()
const statePath = join(root, '.patch-backups', 'last-applied.json')

function fail(message) {
  console.error(`\nRollback stopped: ${message}\n`)
  process.exit(1)
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' })
  if (result.error || result.status !== 0) fail(`${command} failed during rollback.`)
}

const requestedBackup = process.argv[2]
let backupRoot
if (requestedBackup) {
  backupRoot = resolve(root, requestedBackup)
} else {
  if (!existsSync(statePath)) fail('No previously applied patch was found.')
  backupRoot = readJson(statePath).backup
}

const manifestPath = join(backupRoot, 'backup-manifest.json')
if (!existsSync(manifestPath)) fail(`Backup manifest not found: ${manifestPath}`)
const manifest = readJson(manifestPath)

for (const entry of manifest.entries || []) {
  const target = join(root, entry.path)
  const backup = join(backupRoot, 'files', entry.path)
  if (entry.existed) {
    if (!existsSync(backup)) fail(`Backup file missing: ${entry.path}`)
    if (existsSync(target)) rmSync(target, { recursive: true, force: true })
    mkdirSync(dirname(target), { recursive: true })
    cpSync(backup, target, { recursive: true, force: true })
  } else if (existsSync(target)) {
    rmSync(target, { recursive: true, force: true })
  }
}

if (manifest.requiresNpmInstall) {
  console.log('\nRestored package files. Running npm install...')
  if (process.platform === 'win32') {
    run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm install'])
  } else {
    run('npm', ['install'])
  }
}

console.log('\nRollback completed.')
console.log(`Restored version ${manifest.fromVersion}.`)
console.log('Restart the app with: npm run dev')
