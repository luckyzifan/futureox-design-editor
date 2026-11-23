import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { closeTestElectron, createTestScratch, detachedTestProcess } from '../../../scripts/lib/test-scratch.mjs'

const runner = fileURLToPath(new URL('../../../scripts/run-test.mjs', import.meta.url))
const exec = promisify(execFile)
const node = process.execPath

async function fixture(t) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'fx-test-runner-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const temp = join(root, 'temporary')
  const evidence = join(root, 'evidence')
  await Promise.all([mkdir(temp), mkdir(evidence)])
  const env = { ...process.env, TMPDIR: temp, TMP: temp, TEMP: temp, TEST_EVIDENCE: evidence }
  return { root, temp, evidence, env }
}

async function repo(t) {
  const f = await fixture(t)
  const source = join(f.root, 'source')
  await mkdir(source)
  const git = (...args) => exec('git', ['-C', source, ...args])
  await git('init', '--quiet')
  await writeFile(join(source, 'fixture'), 'current')
  await git('add', 'fixture')
  await git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgSign=false',
    'commit', '--quiet', '-m', 'Fixture')
  return { ...f, source, git }
}

test('repeated runs dispose sandbox data, copies and exact Git worktree registrations', async t => {
  const f = await repo(t)
  const other = join(f.root, 'other-worktree')
  await f.git('worktree', 'add', '--detach', other, 'HEAD')
  await writeFile(join(other, 'keep'), 'another checkout')
  const initial = (await f.git('worktree', 'list', '--porcelain')).stdout
  const callerTmp = join(f.temp, 'srcab-caller-owned')
  await mkdir(callerTmp)
  const exercise = `
    const fs = require('node:fs')
    const {join} = require('node:path')
    const root = process.env.FUTUREOX_TEST_RUN_DIR
    const temp = require('node:os').tmpdir()
    const profile = fs.mkdtempSync(join(temp, 'srcab-'))
    const release = join(root, 'copied-release-build')
    fs.mkdirSync(release)
    const data = Buffer.alloc(8 * 1024 * 1024, 37)
    const sandboxFile = join(profile, 'workspace.sqlite3')
    const releaseFile = join(release, 'sidecar')
    fs.writeFileSync(sandboxFile, data)
    fs.writeFileSync(releaseFile, data)
    fs.writeFileSync(join(process.cwd(), 'modified-by-test'), 'discarded build data')
    fs.writeFileSync(join(process.env.TEST_EVIDENCE, 'run-' + process.argv[1] + '.json'), JSON.stringify({
      root, temp, profile, release, cwd: process.cwd(),
      baseline: fs.readFileSync(join(root, 'baseline-release', 'fixture'), 'utf8'),
      allocatedBytes: (fs.statSync(sandboxFile).blocks + fs.statSync(releaseFile).blocks) * 512
    }))
  `
  let allocated = 0
  for (let i = 0; i < 5; i++) {
    await exec(node, [runner, '--worktree=worktree=HEAD', '--worktree=baseline-release=HEAD',
      '--', node, '-e', exercise, String(i)], { cwd: f.source, env: f.env })
    const result = JSON.parse(await readFile(join(f.evidence, `run-${i}.json`), 'utf8'))
    assert.equal(result.cwd, join(result.root, 'worktree'))
    assert.equal(result.temp, join(result.root, 'tmp'))
    assert.equal(result.baseline, 'current')
    assert.ok(result.allocatedBytes >= 16 * 1024 * 1024)
    allocated += result.allocatedBytes
    for (const path of [result.root, result.profile, result.release, result.cwd]) {
      await assert.rejects(lstat(path), { code: 'ENOENT' })
    }
    assert.deepEqual(await readdir(f.temp), ['srcab-caller-owned'])
    assert.equal((await f.git('worktree', 'list', '--porcelain')).stdout, initial)
  }
  assert.equal(await readFile(join(other, 'keep'), 'utf8'), 'another checkout')
  assert.equal((await readdir(f.evidence)).length, 5)
  t.diagnostic(`Allocated ${allocated / (1024 * 1024)} MiB over 5 runs, 0 bytes of run scratch retained`)
})

test('failure preserves the command exit code and removes its isolated output', async t => {
  const f = await fixture(t)
  const script = `const fs = require('node:fs')
    fs.writeFileSync(process.env.FUTUREOX_TEST_RUN_DIR + '/temporary-build', 'owned')
    fs.writeFileSync(process.env.TEST_EVIDENCE + '/failure.json', 'evidence')
    process.exitCode = 17`
  await assert.rejects(exec(node, [runner, '--', node, '-e', script], { cwd: f.root, env: f.env }), { code: 17 })
  assert.deepEqual(await readdir(f.temp), [])
  assert.equal(await readFile(join(f.evidence, 'failure.json'), 'utf8'), 'evidence')
})

test('cleanup handles a failed executable and partially prepared worktrees', async t => {
  const f = await repo(t)
  await assert.rejects(exec(node, [runner, '--', join(f.root, 'missing-executable')], { cwd: f.source, env: f.env }),
    error => error.code === 1 && error.stderr.includes('ENOENT'))
  const before = (await f.git('worktree', 'list', '--porcelain')).stdout
  await assert.rejects(exec(node, [runner, '--worktree=worktree=HEAD', '--worktree=missing=invalid-ref',
    '--', node, '-e', 'process.exit(99)'], { cwd: f.source, env: f.env }), { code: 1 })
  assert.equal((await f.git('worktree', 'list', '--porcelain')).stdout, before)
  assert.deepEqual(await readdir(f.temp), [])
})

test('a finished run does not remove the scratch or checkout of a concurrent run', { timeout: 10_000 }, async t => {
  const f = await repo(t)
  const ready = join(f.evidence, 'ready')
  const release = join(f.evidence, 'release')
  const command = `
    const fs = require('node:fs')
    fs.writeFileSync(process.env.TEST_EVIDENCE + '/ready', process.cwd())
    const timer = setInterval(() => {
      if (fs.existsSync(process.env.TEST_EVIDENCE + '/release')) clearInterval(timer)
    }, 25)
  `
  const active = spawn(node, [runner, '--worktree=worktree=HEAD', '--', node, '-e', command],
    { cwd: f.source, env: f.env, stdio: 'ignore' })
  const exited = once(active, 'exit')
  t.after(async () => {
    if (active.exitCode === null && active.signalCode === null) {
      active.kill('SIGTERM')
      await exited
    }
  })
  for (let attempt = 0; attempt < 120 && !(await lstat(ready).catch(() => null)); attempt++) await delay(25)
  const checkout = await readFile(ready, 'utf8')
  await exec(node, [runner, '--worktree=worktree=HEAD', '--', node, '-e', ''], { cwd: f.source, env: f.env })
  assert.equal(await readFile(join(checkout, 'fixture'), 'utf8'), 'current')
  assert.equal((await readdir(f.temp)).length, 1)
  await writeFile(release, '')
  assert.deepEqual(await exited, [0, null])
  assert.deepEqual(await readdir(f.temp), [])
  assert.equal((await f.git('worktree', 'list', '--porcelain')).stdout.match(/^worktree /gm).length, 1)
})

test('normal command completion joins a background process in the run group', { skip: !detachedTestProcess, timeout: 10_000 }, async t => {
  const f = await fixture(t)
  const sidecar = `
    const fs = require('node:fs')
    const root = process.env.FUTUREOX_TEST_RUN_DIR
    process.on('SIGTERM', () => {
      fs.writeFileSync(root + '/flushed', 'final write')
      fs.writeFileSync(process.env.TEST_EVIDENCE + '/stopped', 'sidecar stopped')
      process.exit(0)
    })
    process.send('ready')
    setInterval(() => {}, 500)
  `
  const command = `
    const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(sidecar)}],
      {stdio: ['ignore', 'ignore', 'ignore', 'ipc']})
    child.once('message', () => process.exit(0))
  `
  await exec(node, [runner, '--', node, '-e', command], { cwd: f.root, env: f.env, timeout: 8000 })
  assert.equal(await readFile(join(f.evidence, 'stopped'), 'utf8'), 'sidecar stopped')
  assert.deepEqual(await readdir(f.temp), [])
})

for (const [signal, status] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  test(`${signal} joins the test process before removing its scratch`, { skip: !detachedTestProcess, timeout: 10_000 }, async t => {
    const f = await fixture(t)
    const ready = join(f.evidence, 'ready')
    const command = `
      const fs = require('node:fs')
      const root = process.env.FUTUREOX_TEST_RUN_DIR
      process.on('${signal}', () => {
        fs.writeFileSync(root + '/shutdown', 'sidecar closed')
        fs.writeFileSync(process.env.TEST_EVIDENCE + '/shutdown', 'closed before cleanup')
        process.exit(0)
      })
      fs.writeFileSync(process.env.TEST_EVIDENCE + '/ready', root)
      setInterval(() => {}, 500)
    `
    const child = spawn(node, [runner, '--', node, '-e', command], { cwd: f.root, env: f.env, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk })
    const exited = once(child, 'exit')
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM') })
    for (let attempt = 0; attempt < 120 && !(await lstat(ready).catch(() => null)); attempt++) await delay(25)
    const scratch = await readFile(ready, 'utf8')
    assert.ok((await lstat(scratch)).isDirectory())
    assert.equal(child.kill(signal), true)
    assert.deepEqual(await exited, [status, null])
    assert.equal(await readFile(join(f.evidence, 'shutdown'), 'utf8'), 'closed before cleanup')
    assert.deepEqual(await readdir(f.temp), [], stderr)
  })
}

test('a scratch run rejects replacement of its root and preserves symlink targets', { skip: !detachedTestProcess }, async t => {
  const f = await fixture(t)
  const scratch = await createTestScratch()
  const moved = scratch.root + '-moved'
  t.after(async () => {
    await rm(scratch.root, { recursive: true, force: true })
    await rm(moved, { recursive: true, force: true })
  })
  await writeFile(join(f.evidence, 'keep'), 'caller owned')
  await symlink(f.evidence, join(scratch.tmp, 'outside'))
  await rename(scratch.root, moved)
  await symlink(f.evidence, scratch.root)
  await assert.rejects(scratch.remove(), /Test scratch directory was replaced/)
  assert.equal(await readFile(join(f.evidence, 'keep'), 'utf8'), 'caller owned')
  await rm(scratch.root)
  await rename(moved, scratch.root)
  await scratch.remove()
  assert.equal(await readFile(join(f.evidence, 'keep'), 'utf8'), 'caller owned')
})

test('an Electron close error stops the owned process and still removes its profile', { skip: !detachedTestProcess }, async t => {
  const scratch = await createTestScratch('srcab-')
  const child = spawn(node, ['-e', 'setInterval(() => {}, 1000)'], {
    env: scratch.environment(), detached: detachedTestProcess, stdio: 'ignore',
  })
  await once(child, 'spawn')
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, 'exit')
      child.kill('SIGKILL')
      await exit
    }
    await scratch.remove()
  })
  await writeFile(join(scratch.tmp, 'profile'), 'owned')
  await assert.rejects(closeTestElectron(scratch, {
    process: () => child,
    async close() { throw Error('simulated IPC close failure') },
  }), /simulated IPC close failure/)
  assert.ok(child.exitCode !== null || child.signalCode !== null)
  await assert.rejects(lstat(scratch.root), { code: 'ENOENT' })
})

test('Electron shutdown uses the child handle captured before Playwright disposes it', { skip: !detachedTestProcess }, async t => {
  const scratch = await createTestScratch('srcab-')
  const child = spawn(node, ['-e', 'setInterval(() => {}, 1000)'], {
    env: scratch.environment(), detached: detachedTestProcess, stdio: 'ignore',
  })
  await once(child, 'spawn')
  const exit = once(child, 'exit')
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await exit
    await scratch.remove()
  })
  let disposed = false
  const handle = await closeTestElectron(scratch, {
    process() {
      assert.equal(disposed, false, 'The Playwright process handle is unavailable after close')
      return child
    },
    async close() {
      disposed = true
      child.kill('SIGTERM')
      await exit
    },
  })
  assert.equal(handle, child)
  await assert.rejects(lstat(scratch.root), { code: 'ENOENT' })
})
