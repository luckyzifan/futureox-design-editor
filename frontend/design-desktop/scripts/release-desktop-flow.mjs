// Checklist for a frozen release package. Without that package every GUI step
// stays not_run. This is release preparation, not a confirmed runtime fault.
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const DESKTOP_FLOW = [
  'freeze_release_package',
  'record_package_hash_and_platform',
  'install',
  'open',
  'navigate',
  'edit',
  'undo',
  'autosave',
  'close_reopen',
  'native_export',
  'original_design_sha_unchanged',
  'distinguish_dev_package_from_release',
]

function directoryFiles(directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...directoryFiles(full))
    else if (entry.isFile()) files.push(full)
  }
  return files
}

export function inspectReleasePackage(packagePath) {
  if (!packagePath || !existsSync(packagePath)) return { present: false, sha256: null, files: 0 }
  const info = statSync(packagePath)
  if (info.isFile()) {
    return { present: true, sha256: createHash('sha256').update(readFileSync(packagePath)).digest('hex'), files: 1 }
  }
  const files = directoryFiles(packagePath).sort()
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(path.relative(packagePath, file))
    hash.update(readFileSync(file))
  }
  return { present: true, sha256: hash.digest('hex'), files: files.length }
}

export function buildDesktopFlowReport({
  packagePath = process.env.FUTUREOX_RELEASE_PACKAGE,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const inspected = inspectReleasePackage(packagePath)
  return {
    schema: 1,
    issue: 85,
    classification: 'release_prep',
    confirmedRuntimeFault: false,
    platform,
    arch,
    packagePath: packagePath || null,
    package: inspected.present
      ? { status: 'hashed_not_installed', sha256: inspected.sha256, files: inspected.files }
      : { status: 'missing_environment', sha256: null, files: 0 },
    devPackageEvidence: 'not a substitute for this checklist',
    steps: DESKTOP_FLOW.map(id => ({
      id,
      status: 'not_run',
      reason: inspected.present
        ? 'package bytes were hashed; installer GUI was not launched'
        : 'no frozen release package was supplied',
    })),
    releaseAcceptance: 'not_closed',
  }
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invoked) {
  const report = buildDesktopFlowReport()
  console.log(JSON.stringify(report, null, 2))
  process.exit(report.steps.every(step => step.status === 'not_run') ? 0 : 1)
}
