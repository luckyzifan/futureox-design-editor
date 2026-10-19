import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const repository = dirname(dirname(fileURLToPath(import.meta.url)))
const scripts = ['test-high-zoom.sh', 'test-new-features.sh']
// Each test uses an isolated copied runner with a fake local Vitest. These test
// the shell contract only; they do not claim to execute the selected unit suites.
async function fixture(t, script, { ready = true, exit = 0 } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'futureox-runner-contract-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const root = join(directory, 'project with spaces')
  const client = join(root, 'frontend/design-client')
  const logParent = join(directory, 'logs with spaces')
  await mkdir(client, { recursive: true })
  await copyFile(join(repository, script), join(root, script))
  const listed = spawnSync('bash', [join(root, script), '--list'], { cwd: tmpdir(), encoding: 'utf8' })
  assert.equal(listed.status, 0, listed.stderr)
  const targets = listed.stdout.trim().split('\n').slice(1)
  assert.ok(targets.length > 0)
  if (ready) {
    const paths = [...targets, 'public/kernel/design_kernel_bg.wasm', 'src/generated/design-kernel/design_kernel.js', 'public/fonts/NotoSansSC.ttf']
    for (const path of paths) {
      const file = join(client, path)
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, '')
    }
    const runner = join(client, 'node_modules/vitest/vitest.mjs')
    await mkdir(dirname(runner), { recursive: true })
    await writeFile(runner, `import assert from 'node:assert/strict';\nassert.equal(process.cwd(), ${JSON.stringify(client)});\nassert.deepEqual(process.argv.slice(2), ${JSON.stringify(['run', ...targets])});\nconsole.log('fake runner stdout; 999 passed is not an exit status');\nconsole.error('fake runner stderr');\nprocess.exit(${exit});\n`)
  }
  function run(...args) {
    return spawnSync('bash', [join(root, script), '--log-dir', logParent, ...args], { cwd: tmpdir(), encoding: 'utf8', timeout: 10000 })
  }
  async function log() {
    const dirs = await readdir(logParent)
    assert.equal(dirs.length, 1)
    return readFile(join(logParent, dirs[0], 'result.log'), 'utf8')
  }
  return { root, client, run, log, targets }
}

for (const script of scripts) {
  test(`${script}: works from another cwd and preserves both output streams`, async t => {
    const f = await fixture(t, script)
    const result = f.run()
    assert.equal(result.status, 0, result.stdout + result.stderr)
    const log = await f.log()
    assert.match(log, /fake runner stdout/)
    assert.match(log, /fake runner stderr/)
    assert.match(log, /PASSED: selected .* unit suite only/)
    assert.doesNotMatch(log, /All checks passed|43个测试通过|1433 passed/)
  })
  test(`${script}: preserves runner failure despite misleading success text`, async t => {
    const f = await fixture(t, script, { exit: 37 })
    const result = f.run()
    assert.equal(result.status, 37, result.stdout + result.stderr)
    const log = await f.log()
    assert.match(log, /999 passed/)
    assert.match(log, /FAILED:.*runner exit 37/)
    assert.doesNotMatch(log, /PASSED: selected/)
  })
  test(`${script}: missing prerequisites are not a passing test run`, async t => {
    const f = await fixture(t, script, { ready: false })
    const result = f.run()
    assert.equal(result.status, 2)
    const log = await f.log()
    assert.match(log, /ERROR: missing prerequisite/)
    assert.match(log, /NOT RUN:/)
    assert.doesNotMatch(log, /PASSED: selected|fake runner/)
  })
  test(`${script}: checks generated bindings even when WASM exists`, async t => {
    const f = await fixture(t, script)
    await rm(join(f.client, 'src/generated/design-kernel/design_kernel.js'))
    const result = f.run()
    assert.equal(result.status, 2)
    assert.match(await f.log(), /missing prerequisite: .*design_kernel\.js/)
  })
  test(`${script}: rejects unknown options without running tests`, async t => {
    const f = await fixture(t, script)
    const result = f.run('--run-gpu')
    assert.equal(result.status, 2)
    assert.match(result.stderr, /unknown argument/)
    assert.doesNotMatch(result.stdout, /fake runner/)
  })
  test(`${script}: help and list require no installed dependencies`, async t => {
    const f = await fixture(t, script, { ready: false })
    const result = f.run('--help')
    assert.equal(result.status, 0)
    assert.match(result.stdout, /Does not install/)
    assert.ok(f.targets.every(path => path.endsWith('.test.ts')))
  })
}
