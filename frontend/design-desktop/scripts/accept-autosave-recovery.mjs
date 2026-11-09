// Cloud acceptance for autosave crash / storage-failure recovery.
// A passing report is unit and simulated-fault evidence. It is not a signed
// release-installer result and does not mark issue 86 as a confirmed runtime fault.
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repo = path.resolve(desktop, '../..')
const studio = path.join(repo, 'design-studio')

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
  const unitPassed = cargo?.status === 0
  const faults = [
    {
      id: 'exit_during_save',
      evidence: 'autosave_recovery_uncommitted_exit_reopens_last_commit and autosave_recovery_interrupted_journal_next_is_not_saved',
      status: unitPassed ? 'passed' : 'failed',
      scope: 'simulated_backend',
    },
    {
      id: 'storage_full_or_write_failure',
      evidence: 'autosave_recovery_storage_full_preserves_original_and_is_not_saved and autosave_recovery_readonly_and_leftover_temp_keep_import_and_recovery',
      status: unitPassed ? 'passed' : 'failed',
      scope: 'simulated_backend',
    },
    {
      id: 'reopen_last_consistent_version',
      evidence: 'recovery_read after a rejected save; workspace reopen after a dropped transaction',
      status: unitPassed ? 'passed' : 'failed',
      scope: 'simulated_backend',
    },
    {
      id: 'upgrade_migration',
      evidence: 'autosave_recovery_failed_upgrade_keeps_prior_schema_then_retries',
      status: unitPassed ? 'passed' : 'failed',
      scope: 'simulated_backend',
    },
    {
      id: 'original_import_unchanged',
      evidence: 'readonly save and recovery_write leave the import bytes unchanged',
      status: unitPassed ? 'passed' : 'failed',
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
    },
    faults,
    releaseAcceptance: 'not_closed',
  }
}

function runCargo() {
  return spawnSync(
    'cargo',
    ['test', '-p', 'futureox-design-desktop-backend', 'autosave_recovery', '--', '--test-threads=8'],
    { cwd: studio, encoding: 'utf8' },
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
