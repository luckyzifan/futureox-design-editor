// Checklist for a frozen release package. This report leaves every GUI step
// not_run. Hashing and resource listing are preparation evidence, not formal
// acceptance. release-desktop-session.mjs is the launcher that can record an
// installed release-profile bundle; a desktop-dev tree still cannot close it.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describePackage, recordReadonlyOriginals, releaseEvidenceFailed } from './release-package-resources.mjs'

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

function splitOriginals(value) {
  if (!value) return []
  return value.split(path.delimiter).filter(Boolean)
}

function stepReason(described) {
  if (!described.identity.present) return 'no frozen release package was supplied'
  if (described.evidence.kind === 'unopened_installer' || described.evidence.kind === 'opaque_file') {
    return 'package bytes were hashed; installer was not opened and GUI was not launched'
  }
  if (described.resources.status === 'listed') return 'bundle resources were recorded; installer GUI was not launched'
  return 'package was not installed and GUI was not launched'
}

export function inspectReleasePackage(packagePath) {
  const described = describePackage(packagePath)
  return { present: described.identity.present, sha256: described.identity.sha256, files: described.identity.files }
}

export function buildDesktopFlowReport({
  packagePath = process.env.FUTUREOX_RELEASE_PACKAGE,
  platform = process.platform,
  arch = process.arch,
  runtimeRoot = process.env.FUTUREOX_RELEASE_RUNTIME,
  originalPaths = splitOriginals(process.env.FUTUREOX_RELEASE_ORIGINALS),
} = {}) {
  const described = describePackage(packagePath, { runtimeRoot, platform, arch })
  const originals = recordReadonlyOriginals(originalPaths)
  const reason = stepReason(described)
  const report = {
    schema: 2,
    issue: 85,
    classification: 'release_prep',
    confirmedRuntimeFault: false,
    platform,
    arch,
    packagePath: packagePath || null,
    package: !described.identity.present
      ? { status: 'missing_environment', sha256: null, files: 0 }
      : described.identity.sha256
        ? { status: 'hashed_not_installed', sha256: described.identity.sha256, files: described.identity.files }
        : { status: 'unhashed', sha256: null, files: described.identity.files },
    evidence: described.evidence,
    resources: described.resources,
    originals,
    devPackageEvidence: described.evidence.note,
    steps: DESKTOP_FLOW.map(id => ({
      id,
      status: 'not_run',
      reason,
      packageSha256: described.identity.sha256,
      platform,
      arch,
      packagePlatform: described.evidence.packagePlatform,
      packageArch: described.evidence.packageArch,
      evidenceKind: described.evidence.kind,
    })),
    releaseAcceptance: 'not_closed',
  }
  report.failed = releaseEvidenceFailed(described, originals)
  return report
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invoked) {
  const report = buildDesktopFlowReport()
  console.log(JSON.stringify(report, null, 2))
  const stepsOpen = report.steps.every(step => step.status === 'not_run')
  process.exit(!stepsOpen || report.failed ? 1 : 0)
}
