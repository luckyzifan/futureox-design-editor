// These are runner wiring tests. The child is a synthetic environment recorder,
// never a product test, native backend, WASM module, or GPU process.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, copyFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
const testing = path.dirname(fileURLToPath(import.meta.url))
const nativeFiles = ['workspace-autosave-sqlite.test.ts', 'document-history-sqlite.test.ts', 'automation/workspace-sqlite.test.ts', 'automation/workspace-import-copy.test.ts', 'automation/workspace-fig-import-copy.test.ts']
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'verify-local-routing-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const dir of ['testing/lib', 'design-studio/scripts', 'frontend/design-client/src/automation', 'frontend/design-client/scripts', 'frontend/design-client/node_modules/vitest', 'frontend/design-client/public/kernel', 'frontend/design-client/public/fonts', 'frontend/design-client/src/generated/design-kernel', 'frontend/design-desktop/test/runtime', 'frontend/design-mcp/test']) await mkdir(path.join(root, dir), { recursive: true })
  await copyFile(process.env.VERIFY_LOCAL_SOURCE || path.join(testing, 'verify-local.mjs'), path.join(root, 'testing/verify-local.mjs'))
  await copyFile(path.join(testing, 'lib/runner.mjs'), path.join(root, 'testing/lib/runner.mjs'))
  for (const file of ['frontend/design-client/src/pure.test.ts', 'frontend/design-client/public/kernel/design_kernel_bg.wasm', 'frontend/design-client/public/fonts/NotoSansSC.ttf', 'frontend/design-client/src/generated/design-kernel/design_kernel.js', 'frontend/design-desktop/test/runtime/document-capacity-runtime.test.mjs', 'frontend/design-desktop/test/runtime/native-preparation-capacity-runtime.test.mjs', ...nativeFiles.map(f => `frontend/design-client/src/${f}`)]) await writeFile(path.join(root, file), '// recorder fixture only, not a product artifact\n')
  await writeFile(path.join(root, 'frontend/design-client/node_modules/vitest/vitest.mjs'), `
import fs from 'node:fs';
const destination = process.argv.find(arg => arg.startsWith('--outputFile.json=')).slice('--outputFile.json='.length);
fs.writeFileSync(destination, JSON.stringify({ numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0 }));
fs.writeFileSync(process.env.ROUTING_CAPTURE, JSON.stringify({ backend: process.env.FUTUREOX_BACKEND_TEST_BINARY ?? null, args: process.argv.slice(2) }));
console.log('1 synthetic routing recorder case; NO product tests executed');
`)
  const env = { ...process.env, ROUTING_CAPTURE: path.join(root, 'capture.json') }
  for (const name of ['FUTUREOX_BACKEND_TEST_BINARY', 'CORE_DESKTOP_SIDECAR', 'DESIGN_PREPARE_BINARY', 'CARGO_TARGET_DIR']) delete env[name]
  const run = (args, overrides = {}) => spawnSync(process.execPath, [path.join(root, 'testing/verify-local.mjs'), ...args], { env: { ...env, ...overrides }, encoding: 'utf8', timeout: 15000 })
  return { root, run, capture: () => readFile(env.ROUTING_CAPTURE, 'utf8').then(JSON.parse) }
}
test('portable phase does not manufacture a native opt-in', async t => {
  const f = await fixture(t)
  const result = f.run(['--suites', 'frontend-vitest', '--output', path.join(f.root, 'output')])
  assert.equal(result.status, 0, result.stderr)
  assert.equal((await f.capture()).backend, null)
})
test('portable phase preserves an explicit caller native opt-in', async t => {
  const f = await fixture(t), binary = path.join(f.root, 'explicit-backend')
  const result = f.run(['--suites', 'frontend-vitest', '--output', path.join(f.root, 'output')], { FUTUREOX_BACKEND_TEST_BINARY: binary })
  assert.equal(result.status, 0, result.stderr)
  assert.equal((await f.capture()).backend, binary)
})
test('native frontend phase fails NOT RUN when its backend is absent', async t => {
  const f = await fixture(t)
  const result = f.run(['--suites', 'frontend-native', '--output', path.join(f.root, 'output')])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /NOT RUN frontend-native: Missing prerequisites:.*futureox-design-desktop-backend/)
  await assert.rejects(f.capture(), { code: 'ENOENT' })
})
test('native frontend phase selects the five actual native suite paths and supplies its checked backend', async t => {
  const f = await fixture(t), binary = path.join(f.root, 'recorded-not-executed-backend')
  await writeFile(binary, 'prerequisite marker only; must never be executed')
  const result = f.run(['--suites', 'frontend-native', '--output', path.join(f.root, 'output')], { CORE_DESKTOP_SIDECAR: binary })
  assert.equal(result.status, 0, result.stderr)
  const captured = await f.capture()
  assert.equal(captured.backend, binary)
  for (const file of nativeFiles) assert.ok(captured.args.includes(path.join(f.root, 'frontend/design-client/src', file)), `missing native suite ${file}`)
  assert.ok(!captured.args.some(arg => arg.endsWith('/pure.test.ts')))
})
test('native discovery includes document-capacity runtime and never silently selects sockets', async t => {
  const f = await fixture(t), result = f.run(['--profile', 'native', '--list'])
  assert.equal(result.status, 0, result.stderr)
  const phases = JSON.parse(result.stdout)
  assert.equal(phases.find(p => p.id === 'frontend-native')?.selected, true)
  assert.equal(phases.find(p => p.id === 'socket-integration')?.selected, false)
  assert.ok(phases.find(p => p.id === 'native-sidecar').command.some(arg => arg.endsWith('/document-capacity-runtime.test.mjs')))
  assert.ok(phases.find(p => p.id === 'native-preparation').command.some(arg => arg.endsWith('/native-preparation-capacity-runtime.test.mjs')))
})
