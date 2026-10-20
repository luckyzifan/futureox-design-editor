/** Workflow source-contract checks, not evidence that GitHub/Windows/macOS ran. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const workflow = readFileSync(new URL('../.github/workflows/local-design-cpu.yml', import.meta.url), 'utf8')
function nativeCommands(text) {
  const block = text.split('- name: Build native CPU processes from this checkout\n')[1]?.split('\n      - name:')[0]
  assert.ok(block, 'native build step required')
  return block.split('\n').map(line => line.trim().replace(/^run:\s*/, '')).filter(line => line.startsWith('cargo build '))
}
function assertNativeTargets(text) {
  // Cargo --bin filters all selected packages: listing a second -p alone does
  // not build that package's differently named binary.
  assert.deepEqual(nativeCommands(text), [
    'cargo build --locked --manifest-path design-studio/Cargo.toml -p futureox-design-kernel --bin design-prepare',
    'cargo build --locked --manifest-path design-studio/Cargo.toml -p futureox-design-desktop-backend --bin futureox-design-desktop-backend',
  ])
}
function assertFontPrerequisite(text) {
  const install = text.indexOf('run: python -m pip install --requirement testing/font-fixtures-requirements.txt')
  const run = text.indexOf('run: node testing/verify-local.mjs --profile portable')
  assert.ok(install >= 0 && run > install, 'real-font generator must be installed before portable tests')
}
test('CI names each actual native CPU binary explicitly', () => assertNativeTargets(workflow))
test('old package-only backend command is rejected', () => {
  const broken = workflow.replace(/run: \|\n\s+cargo build[^\n]+\n\s+cargo build[^\n]+/, 'run: cargo build --locked --manifest-path design-studio/Cargo.toml -p futureox-design-kernel --bin design-prepare -p futureox-design-desktop-backend')
  assert.notEqual(broken, workflow)
  assert.throws(() => assertNativeTargets(broken))
})
test('missing backend build cannot be hidden by a successful prepare build', () => {
  const broken = workflow.replace(/^\s+cargo build[^\n]+--bin futureox-design-desktop-backend\n/m, '\n')
  assert.notEqual(broken, workflow)
  assert.throws(() => assertNativeTargets(broken))
})
test('CI installs the exact font fixture dependency before real-font suites', () => {
  assertFontPrerequisite(workflow)
  const requirements = readFileSync(new URL('./font-fixtures-requirements.txt', import.meta.url), 'utf8')
  assert.deepEqual(requirements.split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#')), ['fonttools==4.61.1'])
})
test('font prerequisite removal is rejected instead of allowing fixture skips', () => {
  const broken = workflow.replace('run: python -m pip install --requirement testing/font-fixtures-requirements.txt', 'run: echo font fixtures ready')
  assert.notEqual(broken, workflow)
  assert.throws(() => assertFontPrerequisite(broken))
})
