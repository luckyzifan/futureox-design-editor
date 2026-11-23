import { lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

export async function createTestScratch(prefix = 'futureox-test-run-') {
  if (!/^[a-z0-9-]+-$/.test(prefix)) throw new Error('Invalid test scratch prefix')
  const root = await mkdtemp(join(await realpath(tmpdir()), prefix))
  const identity = await lstat(root)
  const tmp = join(root, 'tmp')
  const assertOwned = async () => {
    const current = await lstat(root).catch(error => {
      if (error.code !== 'ENOENT') throw error
    })
    if (!current) return false
    if (!current.isDirectory() || current.dev !== identity.dev || current.ino !== identity.ino)
      throw new Error(`Test scratch directory was replaced: ${root}`)
    return true
  }
  const remove = async () => {
    if (await assertOwned()) await rm(root, { recursive: true, force: true, maxRetries: 3 })
  }
  try {
    await mkdir(tmp, { mode: 0o700 })
  } catch (error) {
    await remove()
    throw error
  }
  return {
    root, tmp, assertOwned, remove,
    environment: (env = process.env) => ({
      ...env, TMPDIR: tmp, TMP: tmp, TEMP: tmp, FUTUREOX_TEST_RUN_DIR: root,
    }),
  }
}

export const detachedTestProcess = process.platform !== 'win32'

function signalTestTree(child, signal) {
  if (!child?.pid) return false
  if (!detachedTestProcess) {
    if (child.exitCode !== null || child.signalCode !== null) return false
    return signal === 0 || child.kill(signal)
  }
  try {
    process.kill(-child.pid, signal)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    // Darwin can report EPERM between termination and reaping the last member.
    // Treat it as still present until the kernel confirms the group is gone.
    if (error.code === 'EPERM' && (signal === 0 || child.exitCode !== null || child.signalCode !== null)) return true
    throw error
  }
}

async function waitForTestTree(child, milliseconds) {
  const until = performance.now() + milliseconds
  while (signalTestTree(child, 0)) {
    if (performance.now() >= until) return false
    await delay(25)
  }
  return true
}

// The CLI and Playwright each launch a private process group on POSIX.
export async function stopTestTree(child, signal = 'SIGTERM', graceMs = 2000) {
  if (!signalTestTree(child, signal) || await waitForTestTree(child, graceMs)) return
  signalTestTree(child, 'SIGKILL')
  if (!(await waitForTestTree(child, 2000))) throw new Error(`Test process tree ${child.pid} did not stop`)
}

export async function closeTestElectron(scratch, app, child = app?.process()) {
  // Playwright drops its dispatcher during close(). Keep the ChildProcess
  // handle while the application is still connected.
  let timer
  try {
    if (app) await Promise.race([
      app.close(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Owned Electron close timed out')), 30_000)
      }),
    ])
  } finally {
    clearTimeout(timer)
    await stopTestTree(child)
    await scratch.remove()
  }
  return child
}
