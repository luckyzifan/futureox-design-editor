// Cloud acceptance for autosave crash / storage-failure recovery.
// A passing report is unit and simulated-fault evidence. It is not a signed
// release-installer result and does not mark issue 86 as a confirmed runtime fault.
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repo = path.resolve(desktop, '../..')
const studio = path.join(repo, 'design-studio')

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

export function buildReport({ cargo, releasePackagePresent = false, platform = process.platform, arch = process.arch }) {
  const passedTests = new Set(String(cargo?.stdout || '').split('\n').flatMap(line => {
    const parts = line.trim().split(' ').filter(Boolean)
    return parts[0] === 'test' && parts[2] === '...' && parts[3] === 'ok'
      ? [parts[1].split('::').at(-1)] : []
  }))
  const missingTests = EXPECTED_RECOVERY_TESTS.filter(name => !passedTests.has(name))
  const unitPassed = cargo?.status === 0 && missingTests.length === 0
  const unitStatus = unitPassed ? 'passed' : cargo?.status === 0 ? 'not_run' : 'failed'
  const faults = [
    {
      id: 'exit_during_save',
      evidence: 'autosave_recovery_uncommitted_exit_reopens_last_commit, autosave_recovery_interrupted_journal_next_is_not_saved, and autosave_recovery_unpublished_crash_copy_is_discarded',
      status: unitStatus,
      scope: 'simulated_backend',
    },
    {
      id: 'storage_full_or_write_failure',
      evidence: 'autosave_recovery_storage_full_preserves_original_and_is_not_saved, autosave_recovery_sqlite_storage_full_keeps_last_commit, autosave_recovery_checkpoint_refresh_failure_reopens_last_journal, and autosave_recovery_readonly_and_leftover_temp_keep_import_and_recovery',
      status: unitStatus,
      scope: 'simulated_backend',
    },
    {
      id: 'reopen_last_consistent_version',
      evidence: 'recovery_read after a rejected save; workspace reopen after a dropped transaction; autosave_recovery_reopen_skips_second_copy_when_allocation_is_blocked',
      status: unitStatus,
      scope: 'simulated_backend',
    },
    {
      id: 'upgrade_migration',
      evidence: 'autosave_recovery_failed_upgrade_keeps_prior_schema_then_retries',
      status: unitStatus,
      scope: 'simulated_backend',
    },
    {
      id: 'original_import_unchanged',
      evidence: 'readonly save and recovery_write leave the import bytes unchanged',
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
    releaseAcceptance: 'not_closed',
  }
}

function runCargo() {
  return spawnSync(
    'cargo',
    ['test', '--locked', '--color', 'never', '-p', 'futureox-design-desktop-backend', 'autosave_recovery', '--', '--test-threads=2', '--color', 'never'],
    { cwd: studio, encoding: 'utf8', timeout: 600_000, maxBuffer: 16 * 1024 * 1024 },
  )
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invoked) {
  const cargo = runCargo()
  const report = buildReport({
    cargo,
    releasePackagePresent: Boolean(process.env.FUTUREOX_RELEASE_PACKAGE),
  })
  if (cargo.stdout) process.stderr.write(cargo.stdout)
  if (cargo.stderr) process.stderr.write(cargo.stderr)
  console.log(JSON.stringify(report, null, 2))
  if (cargo.error) {
    console.error(cargo.error.message)
    process.exit(2)
  }
  const unitFailed = report.faults.some(item => item.scope === 'simulated_backend' && item.status !== 'passed')
  process.exit(unitFailed ? 1 : 0)
}
