// Node strip-only cannot resolve extensionless relative TypeScript imports.
// These checks keep the render-contract entry on that loader: the same files
// fail closed before assertions without the preload, and pass with it.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

const nodeEntries = [
  'src/import-ownership.test.mjs',
  'src/kernel/op-sync-history.test.mjs',
  'src/shift-move-snapping.test.mjs',
  'src/kernel/render-failure-budget-fields.test.mjs',
  'src/kernel/render-failure-origin.test.mjs',
  'src/export-ownership.test.mjs',
  'src/model-feature-admission.test.mjs',
  'src/model-mask-admission.test.mjs',
  'src/sketch-text-query.test.mjs',
]

test('render contract scripts preload the extensionless TypeScript resolver', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const prefix = 'node --import ./scripts/node-ts-local-resolver.mjs --test '
  for (const name of ['test:render-diagnostics', 'test:render-contracts', 'test:node-entries'])
    assert.equal(pkg.scripts[name].startsWith(prefix), true, name)
  assert.match(pkg.scripts['test:render-diagnostics'], /src\/kernel\/render-diagnostics\.test\.mjs/)
  assert.match(pkg.scripts['test:render-diagnostics'], /scripts\/node-ts-local-resolver\.test\.mjs/)
  for (const file of [...repro, 'src/kernel/use-zoom-activity.test.mjs', 'scripts/node-ts-local-resolver.test.mjs'])
    assert.equal(pkg.scripts['test:render-contracts'].includes(file), true, file)
  for (const file of nodeEntries)
    assert.equal(pkg.scripts['test:node-entries'].includes(file), true, file)
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

test('parameter properties execute under strip-only only with the preload', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'node-ts-param-'))
  try {
    writeFileSync(path.join(dir, 'param.ts'), `
      export class Box { constructor(private n: number) {} get value() { return this.n } }
      export class Tagged extends Error {
        constructor(readonly code: string, message: string) { super(message) }
      }
      export const value = new Box(4).value
      export const tagged = new Tagged('c', 'hello')
    `)
    const probe = path.join(dir, 'probe.mjs')
    writeFileSync(probe, `
      import { value, tagged } from './param.ts'
      if (value !== 4 || tagged.code !== 'c' || tagged.message !== 'hello' || !(tagged instanceof Error)) {
        throw new Error('parameter property runtime mismatch')
      }
    `)
    const bare = runNode([probe])
    assert.notEqual(bare.status, 0, outputOf(bare))
    assert.match(outputOf(bare), /ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX/)
    assert.match(outputOf(bare), /parameter property/)
    const loaded = runNode(['--import', './scripts/node-ts-local-resolver.mjs', probe])
    assert.equal(loaded.status, 0, outputOf(loaded))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('extensionless import prefers TypeScript and resolves generated JavaScript', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'node-ts-generated-'))
  try {
    writeFileSync(path.join(dir, 'choose.ts'), 'export const which = "ts"\n')
    writeFileSync(path.join(dir, 'choose.js'), 'export const which = "js"\n')
    writeFileSync(path.join(dir, 'choose.mjs'), `
      import { which } from './choose'
      if (which !== 'ts') throw new Error(which)
    `)
    const generated = path.join(dir, 'generated')
    const snippets = path.join(generated, 'snippets')
    writeFileSync(path.join(dir, 'main.ts'), 'export { value as got } from "./generated/design_kernel"\n')
    mkdirSync(snippets, { recursive: true })
    writeFileSync(path.join(generated, 'design_kernel.js'), 'export { value } from "./snippets/helper"\n')
    writeFileSync(path.join(snippets, 'helper.js'), 'export const value = 7\n')
    writeFileSync(path.join(dir, 'generated.mjs'), `
      import { got } from './main.ts'
      if (got !== 7) throw new Error(String(got))
    `)
    const preferred = runNode(['--import', './scripts/node-ts-local-resolver.mjs', path.join(dir, 'choose.mjs')])
    assert.equal(preferred.status, 0, outputOf(preferred))
    const chain = runNode(['--import', './scripts/node-ts-local-resolver.mjs', path.join(dir, 'generated.mjs')])
    assert.equal(chain.status, 0, outputOf(chain))
    const missing = path.join(dir, 'missing.mjs')
    writeFileSync(missing, "await import('./generated/absent_kernel')\n")
    const absent = runNode(['--import', './scripts/node-ts-local-resolver.mjs', missing])
    const absentOutput = outputOf(absent)
    assert.notEqual(absent.status, 0, absentOutput)
    assert.match(absentOutput, /ERR_MODULE_NOT_FOUND/)
    assert.match(absentOutput, /absent_kernel/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
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
