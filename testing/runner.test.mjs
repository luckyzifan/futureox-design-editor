import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { execute, executedAssertions } from './lib/runner.mjs'

async function run(t, code, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'design unified runner '))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const log = join(directory, 'output.log')
  return { result: await execute(process.execPath, ['-e', code], { cwd: directory, log, ...options }), log }
}
test('actual child failure wins over success-looking stdout; stderr is preserved', async t => {
  const { result, log } = await run(t, "console.log('999 passed'); console.error('real failure'); process.exit(37)")
  assert.equal(result.status, 'failed'); assert.equal(result.exitCode, 37)
  assert.match(await readFile(log, 'utf8'), /999 passed[\s\S]*real failure/)
})
test('empty and all-skipped suites cannot satisfy the assertion gate', () => {
  for (const value of ['', '# tests 0\n# pass 0\n', '# tests 7\n# pass 0\n# skipped 7\n']) assert.equal(executedAssertions(value, 'tap'), false)
  assert.equal(executedAssertions('# tests 7\n# pass 5\n# skipped 2\n', 'tap'), true)
  assert.equal(executedAssertions('Ran 0 tests', 'python'), false)
  assert.equal(executedAssertions('0 pass', 'bun'), false)
  assert.equal(executedAssertions('test result: ok. 0 passed;', 'rust'), false)
  assert.equal(executedAssertions('Ran 1 test in 0.001s\r\n\r\nOK\r\n', 'python'), true)
  assert.equal(executedAssertions('Ran 2 tests in 0.001s\r\n\r\nOK (skipped=1, expected failures=1)\r\n', 'python'), false)
  assert.equal(executedAssertions('Ran 1 test in 0.001s\n\nOK (skipped=unknown)\n', 'python'), false)
  assert.equal(executedAssertions('Ran 1 test in 0.001s\n\nOK (skipped=0, skipped=0)\n', 'python'), false)
})
async function runPython(t, body) {
  const directory = await mkdtemp(join(tmpdir(), 'design-runner-python-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const command = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
  return execute(command, ['-c', body], { log: join(directory, 'python.log') })
}
test('actual all-skipped Python unittest exits zero but fails the executed-test gate', async t => {
  const result = await runPython(t, `import unittest
class MissingFixture(unittest.TestCase):
    @unittest.skip('Required fixture is unavailable')
    def test_product_behavior(self):
        self.fail('This body must not execute in the negative control')
unittest.main()
`)
  assert.equal(result.status, 'passed', result.output)
  assert.equal(result.exitCode, 0)
  assert.match(result.output, /Ran 1 test/)
  assert.match(result.output, /OK \(skipped=1\)/)
  assert.equal(executedAssertions(result.output, 'python'), false)
})
test('actual expected-failure-only Python unittest cannot count as passing evidence', async t => {
  const result = await runPython(t, `import unittest
class KnownBroken(unittest.TestCase):
    @unittest.expectedFailure
    def test_known_failure(self):
        self.assertEqual(1, 2)
unittest.main()
`)
  assert.equal(result.status, 'passed', result.output)
  assert.equal(result.exitCode, 0)
  assert.match(result.output, /OK \(expected failures=1\)/)
  assert.equal(executedAssertions(result.output, 'python'), false)
})
test('actual Python unittest with a passing case, skip and expected failure passes the gate', async t => {
  const result = await runPython(t, `import unittest
class MixedCoverage(unittest.TestCase):
    def test_real_execution(self):
        self.assertEqual(sum([1, 2, 3]), 6)
    @unittest.skip('Optional external corpus is unavailable')
    def test_optional_corpus(self):
        self.fail('The optional corpus was not exercised')
    @unittest.expectedFailure
    def test_known_failure(self):
        self.assertEqual(1, 2)
unittest.main()
`)
  assert.equal(result.status, 'passed', result.output)
  assert.equal(result.exitCode, 0)
  assert.match(result.output, /Ran 3 tests/)
  assert.match(result.output, /OK \(skipped=1, expected failures=1\)/)
  assert.equal(executedAssertions(result.output, 'python'), true)
})
test('timeout is a failure and terminates the owned child', async t => {
  const { result } = await run(t, 'setInterval(() => {}, 500)', { timeoutMs: 100 })
  assert.equal(result.status, 'failed'); assert.equal(result.timedOut, true)
})
test('a SIGTERM-ignoring owned child is forcibly terminated after the bounded grace period', {
  skip: process.platform === 'win32' ? 'Windows terminates SIGTERM targets directly; POSIX signal interception is not available' : false,
  timeout: 10000,
}, async t => {
  // Cold Node startup competes with the parallel shell-contract fixtures. Give
  // handler installation a bounded window; the force-kill grace stays 100 ms
  // and the five-second total bound below still rejects an unretired child.
  const { result } = await run(t, "process.on('SIGTERM', () => console.log('ignored SIGTERM')); console.log('ready'); setInterval(() => {}, 100)", { timeoutMs: 2000, killGraceMs: 100 })
  assert.match(result.output, /ready/)
  assert.match(result.output, /ignored SIGTERM/)
  assert.equal(result.status, 'failed')
  assert.equal(result.timedOut, true)
  assert.equal(result.forceKillAttempted, true)
  assert.equal(result.signal, 'SIGKILL')
  assert.ok(result.durationMs < 5000, `Owned child was not promptly terminated: ${result.durationMs} ms`)
})
test('spawn error and log write errors are never reported as passes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'design-runner-missing-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  assert.equal((await execute(join(directory, 'missing'), [], { log: join(directory, 'output') })).status, 'failed')
  await assert.rejects(execute(process.execPath, ['-e', ''], { log: join(directory, 'missing', 'output') }))
})

test('unified discovery separates socket opt-in and never duplicates source files within a suite', async t => {
  const root = new URL('../', import.meta.url)
  const directory = await mkdtemp(join(tmpdir(), 'design-runner-discovery-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const result = await execute(process.execPath, [fileURLToPath(new URL('./verify-local.mjs', import.meta.url)), '--profile', 'all', '--list'], { cwd: root, log: join(directory, 'discovery.log') })
  assert.equal(result.status, 'passed', result.output)
  const phases = JSON.parse(result.output)
  const sockets = phases.find(p => p.id === 'socket-integration')
  assert.equal(sockets.selected, false)
  assert.ok(sockets.discoveredFiles > 0)
  for (const phase of phases.filter(p => p.id.endsWith('contracts'))) {
    assert.ok(phase.discoveredFiles > 0, phase.id)
    assert.equal(new Set(phase.command).size, phase.command.length, phase.id)
    assert.equal(phase.command.some(arg => /(?:bridge-socket|socket-integration)\.test\.mjs$/.test(arg)), false, phase.id)
  }
})
