// Cloud acceptance for autosave crash / storage-failure recovery.
// A passing report is unit and simulated-fault evidence. It is not a signed
// release-installer result and does not mark issue 86 as a confirmed runtime fault.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describePackage, hashReadonlyFile, verifyPublishedInstallerFile } from './release-package-resources.mjs'

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repo = path.resolve(desktop, '../..')
const studio = path.join(repo, 'design-studio')
const packagedCrashTest = 'autosave_recovery_killed_process_reopens_last_commit'
const sidecarOverride = 'FUTUREOX_TEST_PACKAGED_AUTOSAVE_SIDECAR'

export const EXPECTED_RECOVERY_TESTS = [
  'autosave_recovery_storage_full_preserves_original_and_is_not_saved',
  'autosave_recovery_interrupted_journal_next_is_not_saved',
  'autosave_recovery_uncommitted_exit_reopens_last_commit',
  'autosave_recovery_conflict_is_not_reported_saved',
  'autosave_recovery_failed_upgrade_keeps_prior_schema_then_retries',
  'autosave_recovery_readonly_and_leftover_temp_keep_import_and_recovery',
  'autosave_recovery_reopen_skips_second_copy_when_allocation_is_blocked',
  'autosave_recovery_checkpoint_refresh_failure_reopens_last_journal',
  'autosave_recovery_unpublished_crash_copy_is_discarded',
  'autosave_recovery_sqlite_storage_full_keeps_last_commit',
  'autosave_recovery_synced_journal_next_reopens_edit',
  'autosave_recovery_source_write_denied_keeps_original',
  'autosave_recovery_sqlite_readonly_is_not_saved',
  'autosave_recovery_readonly_directory_is_not_corrupt',
  'autosave_recovery_synced_temp_reopens_without_touching_import',
  'autosave_recovery_same_millisecond_synced_temp_reopens_last_edit',
  'autosave_recovery_stale_temp_with_newer_clock_does_not_roll_back_published',
  'autosave_recovery_legacy_record_without_sequence_upgrades_and_recovers',
  'autosave_recovery_legacy_synced_temp_still_adopts_by_timestamp',
  packagedCrashTest,
]

export const RELEASE_FLOW = [
  'install_release_package',
  'open_document',
  'navigate',
  'edit',
  'undo',
  'autosave',
  'close_reopen',
  'native_export',
  'original_sha_unchanged',
]

function passedCargoTests(cargo) {
  return new Set(String(cargo?.stdout || '').split('\n').flatMap(line => {
    const parts = line.trim().split(' ').filter(Boolean)
    return parts[0] === 'test' && parts[2] === '...' && parts[3] === 'ok'
      ? [parts[1].split('::').at(-1)] : []
  }))
}

export function buildReport({ cargo, releasePackagePresent = false, packagedCrash, candidateCrash, platform = process.platform, arch = process.arch }) {
  const passedTests = passedCargoTests(cargo)
  const missingTests = EXPECTED_RECOVERY_TESTS.filter(name => !passedTests.has(name))
  const unitPassed = cargo?.status === 0 && missingTests.length === 0
  const unitStatus = unitPassed ? 'passed' : cargo?.status === 0 ? 'not_run' : 'failed'
  const faults = [
    {
      id: 'exit_during_save',
      evidence: 'autosave_recovery_uncommitted_exit_reopens_last_commit, autosave_recovery_interrupted_journal_next_is_not_saved, autosave_recovery_synced_journal_next_reopens_edit, autosave_recovery_killed_process_reopens_last_commit, autosave_recovery_same_millisecond_synced_temp_reopens_last_edit, and autosave_recovery_unpublished_crash_copy_is_discarded',
      status: unitStatus,
      scope: 'simulated_backend',
    },
    {
      id: 'storage_full_or_write_failure',
      evidence: 'autosave_recovery_storage_full_preserves_original_and_is_not_saved, autosave_recovery_sqlite_storage_full_keeps_last_commit, autosave_recovery_sqlite_readonly_is_not_saved, autosave_recovery_readonly_directory_is_not_corrupt, autosave_recovery_source_write_denied_keeps_original, autosave_recovery_checkpoint_refresh_failure_reopens_last_journal, and autosave_recovery_readonly_and_leftover_temp_keep_import_and_recovery',
      status: unitStatus,
      scope: 'simulated_backend',
    },
    {
      id: 'reopen_last_consistent_version',
      evidence: 'recovery_read after a rejected save; workspace reopen after a dropped transaction and after SIGKILL; autosave_recovery_synced_temp_reopens_without_touching_import; autosave_recovery_same_millisecond_synced_temp_reopens_last_edit; autosave_recovery_stale_temp_with_newer_clock_does_not_roll_back_published; autosave_recovery_reopen_skips_second_copy_when_allocation_is_blocked',
      status: unitStatus,
      scope: 'simulated_backend',
    },
    {
      id: 'upgrade_migration',
      evidence: 'autosave_recovery_failed_upgrade_keeps_prior_schema_then_retries and autosave_recovery_legacy_record_without_sequence_upgrades_and_recovers',
      status: unitStatus,
      scope: 'simulated_backend',
    },
    {
      id: 'original_import_unchanged',
      evidence: 'readonly save, synced recovery temp, and recovery_write leave the import bytes unchanged',
      status: unitStatus,
      scope: 'simulated_backend',
    },
    ...RELEASE_FLOW.map(id => ({
      id,
      evidence: releasePackagePresent
        ? 'package path was supplied; this script does not launch the installer GUI'
        : 'no release bundle on this machine',
      status: 'not_run',
      scope: 'release_package',
      gap: 'human_desktop',
    })),
  ]
  const packagedStatus = packagedCrash && (packagedCrash.cargo?.status === 0
    ? passedCargoTests(packagedCrash.cargo).has(packagedCrashTest) ? 'passed' : 'not_run'
    : 'failed')
  if (packagedCrash) {
    faults.push({
      id: 'packaged_exit_during_save',
      evidence: 'The published sidecar reopens the last commit after SIGKILL with a SQLite writer holding the next save.',
      status: packagedStatus,
      scope: 'packaged_sidecar',
    })
  }
  const candidateStatus = candidateCrash && (candidateCrash.cargo?.status === 0
    ? passedCargoTests(candidateCrash.cargo).has(packagedCrashTest) ? 'passed' : 'not_run'
    : 'failed')
  if (candidateCrash) {
    faults.push({
      id: 'candidate_exit_during_save',
      evidence: 'The sidecar from the current unsigned release-profile package reopens the last commit after SIGKILL with a SQLite writer holding the next save.',
      status: candidateStatus,
      scope: 'candidate_sidecar',
    })
  }
  return {
    schema: 1,
    issue: 86,
    classification: 'acceptance_gap',
    confirmedRuntimeFault: false,
    platform,
    arch,
    cargo: {
      status: cargo?.status ?? null,
      filter: 'autosave_recovery',
      executedExpectedTests: EXPECTED_RECOVERY_TESTS.filter(name => passedTests.has(name)),
      missingTests,
    },
    faults,
    ...(packagedCrash ? { packagedCrash: { identity: packagedCrash.identity, status: packagedStatus } } : {}),
    ...(candidateCrash ? { candidateCrash: { identity: candidateCrash.identity, status: candidateStatus } } : {}),
    releaseAcceptance: 'not_closed',
  }
}

function runCargo(packagedSidecar = null) {
  const env = { ...process.env }
  delete env[sidecarOverride]
  if (packagedSidecar) env[sidecarOverride] = packagedSidecar
  const scope = packagedSidecar ? ['--test', 'autosave_failure_recovery', packagedCrashTest] : ['autosave_recovery']
  return spawnSync(
    'cargo',
    ['test', '--locked', '--color', 'never', '-p', 'futureox-design-desktop-backend', ...scope, '--', '--test-threads=2', '--color', 'never'],
    { cwd: studio, encoding: 'utf8', timeout: 600_000, maxBuffer: 16 * 1024 * 1024, env },
  )
}

const usage = 'Usage: accept-autosave-recovery.mjs [--packaged-sidecar=/abs/bin --installer=/abs/package --verification=/abs/release-verification.json | --candidate-package=/abs/release-package]'

function flagValue(args, key) {
  return args.find(arg => arg.startsWith(`--${key}=`))?.slice(key.length + 3)
}

function candidateSidecar(args) {
  const packageDir = flagValue(args, 'candidate-package')
  if (!packageDir) return null
  if (!path.isAbsolute(packageDir)) throw new Error(usage)
  const described = describePackage(packageDir)
  if (described.evidence.kind !== 'unsigned_release_profile_bundle' || described.evidence.profile !== 'release') {
    throw new Error(`Candidate package is not an unsigned release-profile bundle: ${described.evidence.note}`)
  }
  if (!described.identity.present || described.resources.status !== 'listed') {
    throw new Error('Candidate package bytes could not be listed')
  }
  const name = `sidecar/futureox-design-desktop-backend${process.platform === 'win32' ? '.exe' : ''}`
  const entry = described.resources.entries.find(item => item.installPath === name)
  if (!entry?.present || !entry.sha256) throw new Error(`Candidate package does not contain ${name}`)
  const sidecar = path.join(packageDir, described.resources.installRoot, name)
  const observed = hashReadonlyFile(sidecar)
  if (observed.sha256 !== entry.sha256) throw new Error('Candidate sidecar hash does not match the package resource list')
  return {
    sidecar,
    identity: {
      kind: 'unsigned_release_candidate',
      platform: `${process.platform}-${process.arch}`,
      packageSha256: described.identity.sha256,
      packageFiles: described.identity.files,
      packageProfile: described.evidence.profile,
      packageEvidence: described.evidence.kind,
      sidecarSha256: observed.sha256,
      sidecarPath: name,
    },
  }
}

function publishedSidecar(args) {
  if (!args.length) return null
  const value = key => flagValue(args, key)
  const sidecar = value('packaged-sidecar'), installer = value('installer'), recordPath = value('verification')
  if (args.length !== 3 || [sidecar, installer, recordPath].some(file => !file || !path.isAbsolute(file))) {
    throw new Error(usage)
  }
  const record = JSON.parse(readFileSync(recordPath, 'utf8'))
  const triple = `${process.platform}-${process.arch}`
  const installerIdentity = verifyPublishedInstallerFile(installer, record, triple)
  const name = `sidecar/futureox-design-desktop-backend${process.platform === 'win32' ? '.exe' : ''}`
  const { sha256: sidecarSha256 } = hashReadonlyFile(sidecar)
  if (sidecarSha256 !== record.packages?.[triple]?.nativeSha256?.[name]) {
    throw new Error('Sidecar hash does not match the release verification')
  }
  return {
    sidecar,
    identity: { version: record.version, sourceCommit: record.sourceCommit, platform: triple,
      installerSha256: installerIdentity.sha256, sidecarSha256 },
  }
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invoked) {
  const args = process.argv.slice(2)
  const candidate = candidateSidecar(args)
  if (candidate && args.some(arg => /^--(packaged-sidecar|installer|verification)=/.test(arg))) {
    throw new Error('Select either a published sidecar or a candidate package, not both')
  }
  const packaged = candidate ? null : publishedSidecar(args)
  const cargo = runCargo()
  const packagedCrash = packaged && { identity: packaged.identity, cargo: runCargo(packaged.sidecar) }
  const candidateCrash = candidate && { identity: candidate.identity, cargo: runCargo(candidate.sidecar) }
  const report = buildReport({
    cargo,
    releasePackagePresent: Boolean(packaged || candidate || process.env.FUTUREOX_RELEASE_PACKAGE),
    packagedCrash,
    candidateCrash,
  })
  for (const result of [cargo, packagedCrash?.cargo, candidateCrash?.cargo].filter(Boolean)) {
    if (result.stdout) process.stderr.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)
  }
  console.log(JSON.stringify(report, null, 2))
  if (cargo.error) {
    console.error(cargo.error.message)
    process.exit(2)
  }
  const unitFailed = report.faults.some(item => item.scope === 'simulated_backend' && item.status !== 'passed')
  process.exit(unitFailed || (packagedCrash && report.packagedCrash.status !== 'passed')
    || (candidateCrash && report.candidateCrash.status !== 'passed') ? 1 : 0)
}
