import { existsSync, mkdirSync, readFileSync, rmSync, cpSync, writeFileSync, readdirSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, normalize, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'

const root = process.cwd()
const patchArg = process.argv[2]
const force = process.argv.includes('--force')

function fail(message) {
  console.error(`\nPatch update stopped: ${message}\n`)
  process.exit(1)
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function safeRelativePath(value) {
  if (!value || typeof value !== 'string' || isAbsolute(value)) fail(`Invalid patch path: ${String(value)}`)
  const cleaned = normalize(value).replaceAll('\\', '/')
  if (cleaned === '..' || cleaned.startsWith('../') || cleaned.includes('/../')) fail(`Unsafe patch path: ${value}`)
  const protectedRoots = ['node_modules', '.git', '.patch-backups', '.patch-tmp']
  if (cleaned.startsWith('.env') || protectedRoots.some((item) => cleaned === item || cleaned.startsWith(`${item}/`))) fail(`Patch is not allowed to modify protected path: ${value}`)
  return cleaned
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.error) fail(`${command} could not run: ${result.error.message}`)
  if (result.status !== 0) fail(`${command} exited with code ${result.status}`)
}

function extractArchive(archive, destination) {
  if (process.platform === 'win32') {
    const escapedArchive = archive.replaceAll("'", "''")
    const escapedDestination = destination.replaceAll("'", "''")
    run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `Expand-Archive -LiteralPath '${escapedArchive}' -DestinationPath '${escapedDestination}' -Force`])
    return
  }
  run('unzip', ['-q', archive, '-d', destination])
}

function findManifestBase(start) {
  const direct = join(start, 'patch-manifest.json')
  if (existsSync(direct)) return start
  const folders = readdirSync(start, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  for (const folder of folders) {
    const candidate = join(start, folder.name, 'patch-manifest.json')
    if (existsSync(candidate)) return join(start, folder.name)
  }
  fail('patch-manifest.json was not found in the patch package.')
}

if (!patchArg) {
  console.log('Usage: npm run patch -- "C:\\Downloads\\ba-client-ops-patch-vX.Y.Z.zip"')
  console.log('       npm run patch -- ./path/to/extracted-patch-folder')
  process.exit(0)
}

const packagePath = join(root, 'package.json')
if (!existsSync(packagePath)) fail('Run this command from the BA Client Ops Tracker project folder.')
const packageJson = readJson(packagePath)
const patchPath = resolve(root, patchArg)
if (!existsSync(patchPath)) fail(`Patch package not found: ${patchPath}`)

const temporaryRoot = join(tmpdir(), `ba-client-ops-patch-${Date.now()}`)
let extractedRoot = patchPath
let shouldCleanTemp = false

try {
  if (patchPath.toLowerCase().endsWith('.zip')) {
    mkdirSync(temporaryRoot, { recursive: true })
    extractArchive(patchPath, temporaryRoot)
    extractedRoot = findManifestBase(temporaryRoot)
    shouldCleanTemp = true
  } else {
    extractedRoot = findManifestBase(patchPath)
  }

  const manifest = readJson(join(extractedRoot, 'patch-manifest.json'))
  if (manifest.format !== 1) fail('Unsupported patch format.')
  if (manifest.app !== packageJson.name) fail(`This patch is for ${manifest.app}, not ${packageJson.name}.`)
  if (!force && manifest.fromVersion && manifest.fromVersion !== packageJson.version) {
    fail(`Patch expects version ${manifest.fromVersion}, but this project is version ${packageJson.version}. Use the matching patch or --force only if you understand the risk.`)
  }

  const files = Array.isArray(manifest.files) ? manifest.files.map(safeRelativePath) : []
  const deletes = Array.isArray(manifest.delete) ? manifest.delete.map(safeRelativePath) : []
  for (const relative of files) {
    const source = join(extractedRoot, 'payload', relative)
    if (!existsSync(source)) fail(`Patch payload is missing: ${relative}`)
  }

  const impacted = [...new Set([...files, ...deletes])]
  const backupStamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
  const backupRoot = join(root, '.patch-backups', `${backupStamp}_${packageJson.version}_to_${manifest.toVersion || 'unknown'}`)
  const backupFilesRoot = join(backupRoot, 'files')
  mkdirSync(backupFilesRoot, { recursive: true })

  const backupEntries = []
  for (const relative of impacted) {
    const target = join(root, relative)
    const existed = existsSync(target)
    backupEntries.push({ path: relative, existed })
    if (existed) {
      const destination = join(backupFilesRoot, relative)
      mkdirSync(dirname(destination), { recursive: true })
      cpSync(target, destination, { recursive: true })
    }
  }

  writeFileSync(join(backupRoot, 'backup-manifest.json'), JSON.stringify({
    format: 1,
    app: packageJson.name,
    fromVersion: packageJson.version,
    toVersion: manifest.toVersion,
    createdAt: new Date().toISOString(),
    entries: backupEntries,
    requiresNpmInstall: Boolean(manifest.requiresNpmInstall),
  }, null, 2))

  writeFileSync(join(root, '.patch-backups', 'last-applied.json'), JSON.stringify({
    patch: basename(patchPath),
    fromVersion: packageJson.version,
    toVersion: manifest.toVersion || packageJson.version,
    appliedAt: new Date().toISOString(),
    backup: backupRoot,
    status: 'in-progress',
  }, null, 2))

  for (const relative of files) {
    const source = join(extractedRoot, 'payload', relative)
    const target = join(root, relative)
    if (existsSync(target)) rmSync(target, { recursive: true, force: true })
    mkdirSync(dirname(target), { recursive: true })
    cpSync(source, target, { recursive: true, force: true })
  }

  for (const relative of deletes) {
    const target = join(root, relative)
    if (existsSync(target)) rmSync(target, { recursive: true, force: true })
  }

  if (manifest.requiresNpmInstall) {
    console.log('\nDependencies changed. Running npm install...')
    if (process.platform === 'win32') {
      run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm install'], { cwd: root })
    } else {
      run('npm', ['install'], { cwd: root })
    }
  }

  const updatedPackage = readJson(packagePath)
  if (manifest.toVersion && updatedPackage.version !== manifest.toVersion) {
    console.warn(`\nWarning: patch says ${manifest.toVersion}, but package.json now says ${updatedPackage.version}.`)
  }

  mkdirSync(join(root, '.patch-backups'), { recursive: true })
  writeFileSync(join(root, '.patch-backups', 'last-applied.json'), JSON.stringify({
    patch: basename(patchPath),
    fromVersion: packageJson.version,
    toVersion: manifest.toVersion || updatedPackage.version,
    appliedAt: new Date().toISOString(),
    backup: backupRoot,
    status: 'applied',
  }, null, 2))

  console.log('\nPatch applied successfully.')
  console.log(`Version: ${packageJson.version} -> ${manifest.toVersion || updatedPackage.version}`)
  console.log(`Backup: ${backupRoot}`)
  console.log('Restart the app with: npm run dev')
  console.log('Rollback if needed with: npm run patch:rollback')
} finally {
  if (shouldCleanTemp && existsSync(temporaryRoot)) rmSync(temporaryRoot, { recursive: true, force: true })
}
