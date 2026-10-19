import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import test from 'node:test'
const { Sidecar } = await import(
  process.env.CORE_DESKTOP_TEST_SOURCE
    ? new URL('sidecar.mjs', process.env.CORE_DESKTOP_TEST_SOURCE).href
    : new URL('../src/sidecar.mjs', import.meta.url).href
)
const fixture = fileURLToPath(new URL('./fixtures/sidecar-lifecycle-child.mjs', import.meta.url))
function launch(timeoutMs) {
  const backend = new Sidecar(process.execPath, '/unused-test-path', {
    timeoutMs,
    spawnProcess: (_executable, _args, options) => spawn(process.execPath, [fixture], options),
  })
  backend.on('unavailable', () => {})
  return backend
}

await test('real owned child ignoring SIGTERM is terminated by bounded SIGKILL and reaped', async () => {
  const backend = launch(5000)
  try {
    const ready = await backend.request('health')
    assert.equal(ready.ready, true)
    assert.equal(ready.pid, backend.child.pid)
    const started = performance.now()
    assert.equal(await backend.stop(), true)
    const elapsed = performance.now() - started
    assert.ok(elapsed >= 900 && elapsed < 4500, `SIGKILL/reap elapsed ${elapsed} ms`)
    assert.equal(backend.child.signalCode, 'SIGKILL')
    assert.throws(
      () => process.kill(ready.pid, 0),
      (error) => error.code === 'ESRCH',
    )
    assert.equal(backend.pending.size, 0)
  } finally {
    await backend.stop()
  }
})

await test('real stalled child times out, rejects pending work, refuses later work, and is reaped', async () => {
  // Process creation is not the stalled-request behavior under test. Establish
  // readiness first, then keep the original 250 ms request timeout unchanged.
  const backend = launch(5000)
  try {
    const ready = await backend.request('health')
    backend.timeoutMs = 250
    const started = performance.now()
    const first = backend.request('hang')
    const second = backend.request('hang-again')
    await Promise.all([
      assert.rejects(first, (error) => error.code === 'BACKEND_TIMEOUT'),
      assert.rejects(second, (error) => error.code === 'BACKEND_TIMEOUT'),
    ])
    const elapsed = performance.now() - started
    assert.ok(elapsed >= 200 && elapsed < 2000, `Stalled request timeout ${elapsed} ms`)
    assert.equal(backend.pending.size, 0)
    await assert.rejects(backend.request('health'), (error) => error.code === 'BACKEND_UNAVAILABLE')
    assert.equal(await backend.stop(), true)
    assert.equal(backend.child.signalCode, 'SIGKILL')
    assert.throws(
      () => process.kill(ready.pid, 0),
      (error) => error.code === 'ESRCH',
    )
  } finally {
    await backend.stop()
  }
})
