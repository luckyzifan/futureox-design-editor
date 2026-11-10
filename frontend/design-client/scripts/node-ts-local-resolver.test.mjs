// Node strip-only cannot resolve extensionless relative TypeScript imports.
// These checks keep the render-contract entry on that loader: the same files
// fail closed before assertions without the preload, and pass with it.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const clientRoot = fileURLToPath(new URL('..', import.meta.url))
const repro = [
  'src/image-import.test.mjs',
  'src/kernel/canvas-effect-sampling.test.mjs',
  'src/kernel/render-diagnostics.test.mjs',
  'src/kernel/cpu-frame-contract.test.mjs',
  'src/retained-board-capture.test.mjs',
]
const env = { ...process.env }
delete env.NODE_OPTIONS
// node --test sets this in its own process. Leaving it makes a nested
// `node --test` skip the files as a recursive run.
delete env.NODE_TEST_CONTEXT

function runNode(args, extra = {}) {
  return spawnSync(process.execPath, args, { cwd: clientRoot, encoding: 'utf8', env, ...extra })
}

function outputOf(result) {
  return `${result.stdout}\n${result.stderr}`
}

function tapCounts(output) {
  const read = name => {
    const match = output.match(new RegExp(`^# ${name} (\\d+)$`, 'm'))
    return match ? Number(match[1]) : Number.NaN
  }
  return { tests: read('tests'), pass: read('pass'), fail: read('fail') }
}

test('render contract scripts preload the extensionless TypeScript resolver', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const prefix = 'node --import ./scripts/node-ts-local-resolver.mjs --test '
  for (const name of ['test:render-diagnostics', 'test:render-contracts'])
    assert.equal(pkg.scripts[name].startsWith(prefix), true, name)
  assert.match(pkg.scripts['test:render-diagnostics'], /src\/kernel\/render-diagnostics\.test\.mjs/)
  assert.match(pkg.scripts['test:render-diagnostics'], /scripts\/node-ts-local-resolver\.test\.mjs/)
  for (const file of [...repro, 'src/kernel/use-zoom-activity.test.mjs', 'scripts/node-ts-local-resolver.test.mjs'])
    assert.equal(pkg.scripts['test:render-contracts'].includes(file), true, file)
})

test('node --test fails before assertions without the resolver', () => {
  const result = runNode(['--test-reporter=tap', '--test', ...repro])
  const output = outputOf(result)
  assert.notEqual(result.status, 0, output)
  assert.match(output, /ERR_MODULE_NOT_FOUND/)
  assert.match(output, /render-failure-telemetry/)
  assert.match(output, /imported from .*render-diagnostics\.ts/)
})

test('preloaded resolver runs the render contract files under node --test', () => {
  const result = runNode(['--import', './scripts/node-ts-local-resolver.mjs', '--test-reporter=tap', '--test', ...repro])
  const output = outputOf(result)
  const counts = tapCounts(output)
  assert.equal(result.status, 0, output)
  assert.equal(counts.fail, 0, output)
  assert.equal(counts.pass, counts.tests, output)
  assert.ok(counts.pass >= 14, output)
  for (const name of [
    'preserves exact original bytes and intrinsic dimensions without a canvas',
    'other-page effects do not disable the current page reusable zoom density',
    'actual recorder is disabled by default and pause prevents new samples',
    'integer analytic: routes original options to exact CPU renderer',
    'retained drag capture preserves one axis-independent density at DPR 1',
  ]) assert.ok(output.includes(name), name)
  assert.doesNotMatch(output, /ERR_MODULE_NOT_FOUND/)
})

test('resolver does not invent a missing relative module', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'node-ts-resolver-'))
  try {
    const probe = path.join(dir, 'probe.mjs')
    writeFileSync(probe, "await import('./missing-module')\n")
    const result = runNode(['--import', './scripts/node-ts-local-resolver.mjs', probe])
    const output = outputOf(result)
    assert.notEqual(result.status, 0, output)
    assert.match(output, /ERR_MODULE_NOT_FOUND/)
    assert.match(output, /missing-module/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
