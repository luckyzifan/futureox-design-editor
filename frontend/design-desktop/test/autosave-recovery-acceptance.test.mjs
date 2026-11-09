import test from 'node:test'
import assert from 'node:assert/strict'
import { EXPECTED_RECOVERY_TESTS, RELEASE_FLOW, buildReport } from '../scripts/accept-autosave-recovery.mjs'

const completed = names => names.map(name => `test ${name} ... ok`).join('\n')

test('simulated autosave recovery passes do not close the release-package flow', () => {
  const report = buildReport({ cargo: { status: 0, stdout: completed(EXPECTED_RECOVERY_TESTS) }, releasePackagePresent: false, platform: 'linux', arch: 'x64' })
  assert.equal(report.confirmedRuntimeFault, false)
  assert.equal(report.releaseAcceptance, 'not_closed')
  assert.equal(report.issue, 86)
  for (const id of ['exit_during_save', 'storage_full_or_write_failure', 'reopen_last_consistent_version', 'upgrade_migration', 'original_import_unchanged']) {
    assert.equal(report.faults.find(item => item.id === id).status, 'passed')
  }
  for (const id of RELEASE_FLOW) {
    const step = report.faults.find(item => item.id === id)
    assert.equal(step.status, 'not_run')
    assert.equal(step.scope, 'release_package')
  }
  assert.equal(JSON.stringify(report).includes('File saved'), false)
})

test('a cargo failure keeps every simulated fault failed and still does not invent a release pass', () => {
  const report = buildReport({ cargo: { status: 1 }, releasePackagePresent: true })
  assert.equal(report.faults.filter(item => item.scope === 'simulated_backend').every(item => item.status === 'failed'), true)
  assert.equal(report.faults.filter(item => item.scope === 'release_package').every(item => item.status === 'not_run'), true)
})

test('a successful cargo process with zero selected tests cannot pass simulated recovery', () => {
  const report = buildReport({ cargo: { status: 0, stdout: 'running 0 tests\ntest result: ok. 0 passed; 0 failed; 0 ignored\n' } })
  assert.equal(report.faults.some(item => item.scope === 'simulated_backend' && item.status === 'passed'), false)
})

test('a missing required recovery case remains not run even when the cargo process succeeds', () => {
  const [missing, ...rest] = EXPECTED_RECOVERY_TESTS
  const report = buildReport({ cargo: { status: 0, stdout: completed(rest) } })
  assert.deepEqual(report.cargo.missingTests, [missing])
  assert.equal(report.faults.filter(item => item.scope === 'simulated_backend').every(item => item.status === 'not_run'), true)
})

test('an ignored recovery case does not certify a pass', () => {
  const [ignored, ...rest] = EXPECTED_RECOVERY_TESTS
  const report = buildReport({ cargo: { status: 0, stdout: completed(rest) + `\ntest ${ignored} ... ignored\n` } })
  assert.deepEqual(report.cargo.missingTests, [ignored])
  assert.equal(report.faults.some(item => item.scope === 'simulated_backend' && item.status === 'passed'), false)
})
