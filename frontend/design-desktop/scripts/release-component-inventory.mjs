// Inventory of packaging inputs. Cargo.lock names are not shipped files.
// A missing release directory is not reported as a closed bill of materials.
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repo = path.resolve(desktop, '../..')

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function walk(directory) {
  if (!existsSync(directory)) return []
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...walk(full))
    else if (entry.isFile()) files.push(full)
  }
  return files.sort()
}

export function buildComponentInventory({ releaseDir = path.join(desktop, 'release') } = {}) {
  const releaseFiles = walk(releaseDir)
  const releasePresent = existsSync(releaseDir) && statSync(releaseDir).isDirectory() && releaseFiles.length > 0
  const licenseInventory = JSON.parse(readFileSync(path.join(repo, 'frontend/design-client/public/licenses/inventory.json'), 'utf8'))
  const notices = licenseInventory.packages.map(item => {
    const file = path.join(repo, 'frontend/design-client/public/licenses', item.file)
    const present = existsSync(file)
    const sha256 = present ? sha256File(file) : null
    return {
      package: item.package,
      version: item.version,
      license: item.license,
      file: item.file,
      sha256,
      matchesInventory: present && sha256 === item.sha256,
    }
  })
  const mcpFiles = walk(path.join(repo, 'frontend/design-mcp/src'))
    .filter(file => file.endsWith('.mjs'))
    .map(file => ({ path: path.relative(repo, file), sha256: sha256File(file) }))
  const ffmpeg = path.join(desktop, 'vendor/ffmpeg/linux-x64/ffmpeg')
  const lock = readFileSync(path.join(repo, 'design-studio/Cargo.lock'), 'utf8')
  const electron = JSON.parse(readFileSync(path.join(desktop, 'package.json'), 'utf8')).devDependencies.electron
  return {
    schema: 1,
    issue: 88,
    classification: 'release_prep',
    confirmedRuntimeFault: false,
    scope: releasePresent ? 'release_directory_present_but_not_a_closed_sbom' : 'packaging_inputs_not_a_release_bundle',
    releaseDirectory: releasePresent ? path.relative(repo, releaseDir) : null,
    notDistribution: {
      cargoLockNameEntries: [...lock.matchAll(/^name = "/gm)].length,
      note: 'Cargo.lock name entries are build inputs. They are not the files inside a release package.',
    },
    electron: {
      version: electron,
      chromiumBinaryHashed: false,
      note: 'package.json names the Electron version. This checkout did not hash a packaged Chromium binary.',
    },
    notices,
    designMcpSourceCount: mcpFiles.length,
    designMcpSources: mcpFiles,
    ffmpeg: existsSync(ffmpeg)
      ? { path: 'frontend/design-desktop/vendor/ffmpeg/linux-x64/ffmpeg', sha256: sha256File(ffmpeg), license: 'GPL-3.0-or-later' }
      : { path: null, sha256: null },
    unmappedReleaseFiles: releasePresent ? 'not enumerated as a closed notice map' : 'no release bundle to map',
  }
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invoked) {
  const report = buildComponentInventory()
  const broken = report.notices.filter(item => !item.matchesInventory)
  console.log(JSON.stringify({
    ...report,
    designMcpSources: report.designMcpSourceCount,
    notices: report.notices.map(item => ({ package: item.package, version: item.version, license: item.license, matchesInventory: item.matchesInventory })),
  }, null, 2))
  process.exit(broken.length ? 1 : 0)
}
