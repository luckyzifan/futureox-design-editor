import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { Sidecar } from '../src/sidecar.mjs'

function fake({ ignoreTerm = false, respond = true, malformed = false, failSpawn = false } = {}) {
  const process = new EventEmitter()
  process.stdin = new PassThrough()
  process.stdout = new PassThrough()
  process.stderr = new PassThrough()
  process.signals = []
  process.kill = (signal) => {
    process.signals.push(signal)
    if (ignoreTerm && signal === 'SIGTERM') return true
    queueMicrotask(() => { process.emit('exit', null, signal); process.emit('close', null, signal) })
    return true
  }
  process.stdin.on('data', (chunk) => {
    if (!respond) return
    const request = JSON.parse(chunk.toString())
    queueMicrotask(() =>
      process.stdout.write(
        malformed
          ? '{invalid}\n'
          : `${JSON.stringify({ id: request.id, result: { protocolVersion: 1 } })}\n`,
      ),
    )
  })
  const spawnProcess = (...args) => {
    process.spawnArgs = args
    if (failSpawn) queueMicrotask(() => process.emit('error', new Error('ENOENT')))
    return process
  }
  return { process, spawnProcess }
}

test('stdio RPC is bounded, shell-free and roundtrips a correlated response', async () => {
  const fixture = fake()
  const client = new Sidecar('/trusted/backend', '/trusted/recovery', fixture)
  assert.deepEqual(await client.request('health'), { protocolVersion: 1 })
  assert.equal(fixture.process.spawnArgs[2].shell, false)
  assert.deepEqual(fixture.process.spawnArgs[1], ['--recovery-dir', '/trusted/recovery'])
  assert.equal(await client.stop(), true)
  await assert.rejects(client.request('health'), { code: 'BACKEND_UNAVAILABLE' })
})
test('malformed backend output fails closed and reaps child', async () => {
  const fixture = fake({ malformed: true })
  const client = new Sidecar('/trusted/backend', '/trusted/recovery', fixture)
  await assert.rejects(client.request('health'), { code: 'BACKEND_UNAVAILABLE' })
  assert.equal(await client.stop(), true)
})
test('failed spawn rejects outstanding work without unhandled error', async () => {
  const fixture = fake({ failSpawn: true, respond: false })
  const client = new Sidecar('/missing/backend', '/trusted/recovery', fixture)
  await assert.rejects(client.request('health'), { code: 'BACKEND_UNAVAILABLE' })
  assert.equal(await client.stop(), true)
})
test('request timeout never retries and escalates unresponsive child termination', async () => {
  const fixture = fake({ ignoreTerm: true, respond: false })
  const client = new Sidecar('/trusted/backend', '/trusted/recovery', { ...fixture, timeoutMs: 10 })
  await assert.rejects(client.request('save', {}), { code: 'BACKEND_TIMEOUT' })
  assert.equal(await client.stop(), true)
  assert.deepEqual(fixture.process.signals, ['SIGTERM', 'SIGKILL'])
})
test('pending queue is bounded and all requests fail after backend loss', async () => {
  const fixture = fake({ respond: false })
  const client = new Sidecar('/trusted/backend', '/trusted/recovery', { ...fixture, timeoutMs: 50 })
  const pending = Array.from({ length: 8 }, () =>
    client.request('health').catch((error) => error.code),
  )
  await assert.rejects(client.request('health'), { code: 'BUSY' })
  await client.stop()
  assert.deepEqual(await Promise.all(pending), Array(8).fill('BACKEND_TIMEOUT'))
})
test('split frames are assembled and unknown IDs fail closed', async () => {
  const fixture = fake({ respond: false })
  const client = new Sidecar('/trusted/backend', '/trusted/recovery', fixture)
  const promise = client.request('health')
  const id = [...client.pending.keys()][0]
  const response = `${JSON.stringify({ id, result: { yes: true } })}\n`
  fixture.process.stdout.write(response.slice(0, 8))
  fixture.process.stdout.write(response.slice(8))
  assert.deepEqual(await promise, { yes: true })
  fixture.process.stdout.write('{"id":"unknown","result":{}}\n')
  assert.equal(client.stopped, true)
  await client.stop()
})

test('aggregate bytes reject before transport and drain gates queued frames', async () => {
  const fixture = fake({ respond: false })
  const writes = []
  fixture.process.stdin.write = (frame, callback) => { writes.push({ frame, callback }); return false }
  const client = new Sidecar('/trusted/backend', '/trusted/recovery', { ...fixture, maxPendingBytes: 9000 })
  const first = client.request('save', { document: 'x'.repeat(180) }).catch((error) => error)
  const second = client.request('health', { padding: 'x'.repeat(180) }).catch((error) => error)
  assert.equal(writes.length, 1)
  assert.equal(client.writeQueue.length, 1)
  await assert.rejects(client.request('save', { document: 'x'.repeat(180) }), { code: 'BUSY' })
  writes[0].callback()
  fixture.process.stdin.emit('drain')
  assert.equal(writes.length, 2)
  client.fail(Object.assign(new Error('lost'), { code: 'BACKEND_UNAVAILABLE' }))
  assert.equal((await first).outcomeUnknown, true)
  assert.equal((await second).outcomeUnknown, false)
  writes[1].callback()
  assert.equal(client.pendingBytes, 0)
  assert.equal(client.writeQueue.length, 0)
  await client.stop()
})

test('graceful stop drains EOF and accepts committed response before close', async () => {
  const fixture = fake({ respond: false })
  const client = new Sidecar('/trusted/backend', '/trusted/recovery', fixture)
  const saved = client.request('save', {})
  const id = [...client.pending.keys()][0]
  fixture.process.stdin.on('finish', () => {
    fixture.process.emit('exit', 0, null)
    fixture.process.stdout.write(JSON.stringify({ id, result: { hash: 'committed', warning: 'durability warning' } }) + '\n')
    fixture.process.emit('close', 0, null)
  })
  const stopped = client.stop()
  await assert.rejects(client.request('health'), { code: 'BACKEND_UNAVAILABLE' })
  assert.equal((await saved).hash, 'committed')
  assert.equal(await stopped, true)
  assert.deepEqual(fixture.process.signals, [])
  assert.equal(client.pendingBytes, 0)
})

test('large-result reservations prevent small open requests multiplying response memory', async () => {
  const fixture = fake({ respond: false })
  const client = new Sidecar('/trusted/backend', '/trusted/recovery', fixture)
  const pending = client.request('open', { path: '/trusted/document.fd' }).catch((error) => error)
  assert.equal(client.pendingBytes, 64 * 1024 * 1024)
  await assert.rejects(client.request('open', { path: '/trusted/other.fd' }), { code: 'BUSY' })
  const health = client.request('health').catch((error) => error)
  assert.equal(client.pending.size, 2)
  client.fail(Object.assign(new Error('test end'), { code: 'BACKEND_UNAVAILABLE' }))
  await Promise.all([pending, health])
  await client.stop()
})

test('lost replies classify every native Sketch mutation as an uncertain outcome', async () => {
  const methods = ['open', 'rename', 'resizeLegacyContainer', 'setTextOverride', 'setLeafFrame', 'undo', 'redo', 'saveAs', 'close']
  for (const name of methods) {
    const fixture = fake({ respond: false })
    const client = new Sidecar('/trusted/backend', '/trusted/recovery', fixture)
    const pending = client.request(`sketch.session.${name}`).catch(error => error)
    client.fail(Object.assign(new Error('Response lost'), { code: 'BACKEND_UNAVAILABLE' }))
    assert.equal((await pending).outcomeUnknown, true, name)
    await client.stop()
  }
})
