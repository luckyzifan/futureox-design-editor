import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { NativeRenderProcess, NATIVE_RENDER_MAX_PENDING } from '../src/native-render.mjs'
import { MAX_FRAME_BYTES } from '../src/security.mjs'

function fixture(t, options = {}) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null, signalCode: null,
  })
  const writes = [], signals = []
  child.stdin.on('data', bytes => writes.push(JSON.parse(bytes.toString())))
  child.kill = signal => {
    signals.push(signal)
    queueMicrotask(() => { child.signalCode = signal; child.emit('exit', null, signal); child.emit('close') })
    return true
  }
  const bridge = new NativeRenderProcess('/owned/design-render', undefined, 'cpu', { spawnProcess: () => child, ...options })
  bridge.spawnProcess()
  t.after(() => bridge.stop())
  const reply = value => child.stdout.write(JSON.stringify(value) + '\n')
  return { bridge, child, writes, signals, reply }
}

test('overlapping frame, stats and load requests retain FIFO ownership', async t => {
  const f = fixture(t)
  const frame = f.bridge.frame({ width: 1, height: 1 })
  const stats = f.bridge.stats()
  const load = f.bridge.load('{"id":"next"}')
  assert.deepEqual(f.writes.map(v => v.cmd), ['frame'])
  f.reply({ type: 'frame', width: 1, height: 1, rgba: 'AQIDBA==', stats: { frames: 1 } })
  assert.equal((await frame).rgba, 'AQIDBA==')
  assert.deepEqual(f.writes.map(v => v.cmd), ['frame', 'stats'])
  f.reply({ type: 'stats', stats: { marker: 'owned' } })
  assert.deepEqual(await stats, { marker: 'owned' })
  f.reply({ type: 'loaded' }); await load
  assert.equal(f.bridge.pendingBytes, 0)
  assert.equal(f.bridge.queue.length, 0)
})

test('application error rejects only its request and advances the queue', async t => {
  const f = fixture(t)
  const bad = assert.rejects(f.bridge.frame({}), /invalid options/)
  const next = f.bridge.stats()
  f.reply({ type: 'error', message: 'invalid options' }); await bad
  f.reply({ type: 'stats', stats: { alive: true } })
  assert.deepEqual(await next, { alive: true })
  assert.equal(f.bridge.closed, false)
})

test('queue count is bounded and stop cancels active and queued requests', async t => {
  const f = fixture(t)
  const pending = Array.from({ length: NATIVE_RENDER_MAX_PENDING }, () => assert.rejects(f.bridge.stats(), /Bridge stopped/))
  await assert.rejects(f.bridge.stats(), /queue full/)
  assert.equal(f.writes.length, 1)
  await f.bridge.stop(); await Promise.all(pending)
  assert.equal(f.bridge.pendingBytes, 0)
  assert.equal(f.bridge.queue.length, 0)
  assert.deepEqual(f.signals, ['SIGTERM'])
})

test('timeout settles every request and retires the stalled child', async t => {
  const f = fixture(t, { timeoutMs: 20 })
  await Promise.all([assert.rejects(f.bridge.stats(), /timed out/), assert.rejects(f.bridge.frame({}), /timed out/)])
  await f.bridge.stop()
  assert.equal(f.bridge.pendingBytes, 0)
  assert.equal(f.bridge.closed, true)
  assert.deepEqual(f.signals, ['SIGTERM'])
})

test('malformed and unexpected completed replies fail closed', async t => {
  for (const response of ['{broken}\n', '{"type":"frame"}\n']) {
    const f = fixture(t)
    const rejected = assert.rejects(f.bridge.stats(), /Malformed native render response/)
    f.child.stdout.write(response); await rejected
    assert.equal(f.bridge.closed, true)
  }
})

test('split UTF-8 replies are decoded only after the full line arrives', async t => {
  const f = fixture(t), pending = f.bridge.stats()
  const bytes = Buffer.from(JSON.stringify({ type: 'stats', stats: { label: '中文' } }) + '\n')
  const split = bytes.indexOf(Buffer.from('中')) + 1
  f.child.stdout.write(bytes.subarray(0, split)); f.child.stdout.write(bytes.subarray(split))
  assert.deepEqual(await pending, { label: '中文' })
  assert.ok(f.child.stderr.listenerCount('data'), 'stderr must be continuously consumed')
})

test('oversized output is rejected before concatenation or JSON parsing', async t => {
  const f = fixture(t), rejected = assert.rejects(f.bridge.stats(), /response exceeded limit/)
  const part = Buffer.alloc(1024 * 1024, 32)
  for (let bytes = 0; bytes <= MAX_FRAME_BYTES; bytes += part.length) f.child.stdout.write(part)
  await rejected
  assert.equal(f.bridge.bufferBytes, 0)
})

test('stdin failure rejects all outstanding work', async t => {
  const f = fixture(t)
  const pending = [assert.rejects(f.bridge.stats(), /pipe failed/), assert.rejects(f.bridge.frame({}), /pipe failed/)]
  f.child.stdin.emit('error', new Error('pipe failed'))
  await Promise.all(pending)
  assert.equal(f.bridge.pendingBytes, 0)
})

test('backpressure delays the next request even after its predecessor replies', async t => {
  const f = fixture(t)
  const write = f.child.stdin.write.bind(f.child.stdin)
  f.child.stdin.write = (...args) => { write(...args); return false }
  const first = f.bridge.stats(), second = f.bridge.stats()
  f.reply({ type: 'stats', stats: { sequence: 1 } }); await first
  assert.equal(f.writes.length, 1)
  f.child.stdin.emit('drain')
  assert.equal(f.writes.length, 2)
  f.reply({ type: 'stats', stats: { sequence: 2 } })
  assert.deepEqual(await second, { sequence: 2 })
})

test('exit waits for buffered stdout before settling the final response', async t => {
  const f = fixture(t), pending = f.bridge.stats()
  f.child.exitCode = 0; f.child.emit('exit', 0, null)
  await assert.rejects(f.bridge.load('{"id":"replacement"}'), /process is exiting/)
  f.reply({ type: 'stats', stats: { final: true } }); f.child.emit('close')
  assert.deepEqual(await pending, { final: true })
  assert.equal(f.bridge.closed, true)
})
