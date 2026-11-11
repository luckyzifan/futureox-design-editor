import test from 'node:test'
import assert from 'node:assert/strict'
import { MIN_GPU_WORKING_BUDGET_MIB, MAX_GPU_WORKING_BUDGET_MIB, parseGpuWorkingBudgetMiB, selectGpuWorkingBudgetMiB } from '../src/gpu-working-budget.mjs'

test('unconfigured and explicit auto retain the existing admission default', () => {
  assert.equal(parseGpuWorkingBudgetMiB(undefined), undefined)
  assert.equal(parseGpuWorkingBudgetMiB('auto'), undefined)
})

test('launch budget accepts inclusive bounds and intermediate whole MiB values', () => {
  assert.equal(MIN_GPU_WORKING_BUDGET_MIB, 256)
  assert.equal(MAX_GPU_WORKING_BUDGET_MIB, 4096)
  for (const value of ['256', '512', '1024', '3072', '4096'])
    assert.equal(parseGpuWorkingBudgetMiB(value), Number(value))
})

test('explicit invalid launch budgets fail without coercion or silent clamping', () => {
  for (const value of ['', ' ', ' auto', 'AUTO', '256 ', '256\n', '4096\r\n', '0256', '+256', '-256', '256.0', '256.5', '0x100', '1e3', '255', '0', '4097', '9007199254740992', 'NaN', 'Infinity', null, 4096, {}, []])
    assert.throws(() => parseGpuWorkingBudgetMiB(value), /CORE_GPU_WORKING_BUDGET_MIB.*256.*4096/)
})

test('automatic desktop budget checks Apple unified memory and startup availability', () => {
  const GiB = 1024 ** 3
  const ample = { platform: 'darwin', arch: 'arm64', total: 16 * GiB, available: 4 * GiB }
  assert.equal(selectGpuWorkingBudgetMiB(undefined, ample), 2048)
  assert.equal(selectGpuWorkingBudgetMiB('auto', ample), 2048)
  assert.equal(selectGpuWorkingBudgetMiB('1024', ample), 1024)
  for (const memory of [
    { ...ample, available: 4 * GiB - 1 },
    { ...ample, constrained: 3 * GiB },
    { ...ample, total: 8 * GiB },
    { ...ample, available: undefined },
    { ...ample, platform: 'linux' },
    { ...ample, arch: 'x64' },
  ]) assert.equal(selectGpuWorkingBudgetMiB('auto', memory), undefined)
})
