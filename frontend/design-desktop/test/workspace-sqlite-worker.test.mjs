import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { performance } from 'node:perf_hooks'
import { Sidecar } from '../src/sidecar.mjs'
import { assertDocumentSerialization } from '../src/document-capacity.mjs'
import { createWorkspaceSqliteCodec, SQLITE_OFFTHREAD_BYTES } from '../src/workspace-sqlite-worker-host.mjs'

function document(extra = 8000) {
  const nodes = {}
  for (let i = 0; i < extra; i++) nodes[`n${i}`] = { id: `n${i}`, name: `layer ${i}`, x: i, y: 2, width: 100, height: 80 }
  return { schemaVersion: 6, id: '10000000-0000-0000-0000-000000000001', name: '本地设计', nodes }
}

async function eventLoopLag(work) {
  let max = 0
  let stop = false
  const pulse = () => {
    const start = performance.now()
    setImmediate(() => {
      max = Math.max(max, performance.now() - start)
      if (!stop) pulse()
    })
  }
  pulse()
  const started = performance.now()
  await work()
  const elapsed = performance.now() - started
  stop = true
  await new Promise((resolve) => setImmediate(resolve))
  return { max, elapsed }
}

test('large workspace commit frames are built off the caller and reject invalid documents', async () => {
  const codec = createWorkspaceSqliteCodec()
  try {
    const source = document()
    const documentJson = JSON.stringify(source)
    assert.ok(Buffer.byteLength(documentJson) >= SQLITE_OFFTHREAD_BYTES)
    const encoded = await codec.encodeRequest('req-1', 'workspace.commit', {
      documentJson, expectedRevision: null, mutationId: 'save_1',
    })
    const frame = JSON.parse(Buffer.from(encoded.frame).toString('utf8'))
    assert.equal(frame.id, 'req-1')
    assert.equal(frame.method, 'workspace.commit')
    assert.equal(frame.scheduling, true)
    assert.equal(frame.params.documentJson, undefined)
    assert.deepEqual(frame.params.document, source)
    assert.equal(frame.params.expectedRevision, null)
    assert.equal(frame.params.mutationId, 'save_1')
    assert.equal(encoded.wireBytes, Buffer.byteLength(JSON.stringify(frame)))
    await assert.rejects(codec.encodeRequest('req-2', 'workspace.commit', { documentJson: '[]', expectedRevision: 1, mutationId: 'm' }), /Invalid document/)
    await assert.rejects(codec.encodeRequest('req-3', 'workspace.commit', { documentJson: 'null', expectedRevision: 1, mutationId: 'm' }), /Invalid document/)
  } finally {
    await codec.close()
  }
})

test('large SQLite responses expose documentJson without a caller-side parse', async () => {
  const codec = createWorkspaceSqliteCodec()
  const source = document(2000)
  const payload = JSON.stringify({
    id: 'open-1',
    result: { id: source.id, name: source.name, revision: 2, deleted: false, document: source },
  })
  assert.ok(Buffer.byteLength(payload) >= SQLITE_OFFTHREAD_BYTES)
  const process = new EventEmitter()
  process.stdin = new PassThrough()
  process.stdout = new PassThrough()
  process.stderr = new PassThrough()
  process.kill = () => {
    queueMicrotask(() => { process.emit('exit', 0, null); process.emit('close', 0, null) })
    return true
  }
  process.stdin.on('data', () => queueMicrotask(() => process.stdout.write(payload + '\n')))
  const sidecar = new Sidecar('/trusted/backend', '/trusted/recovery', {
    spawnProcess: () => process,
    sqliteCodec: codec,
    timeoutMs: 5000,
  })
  try {
    const opened = await sidecar.requestFrame('workspace.open', 'open-1', Buffer.from('{"id":"open-1","method":"workspace.open","params":{},"scheduling":true}'), 80)
    assert.equal(opened.document, undefined)
    assert.deepEqual(JSON.parse(opened.documentJson), source)
    assert.equal(opened.revision, 2)
  } finally {
    await sidecar.stop()
    await codec.close()
  }
})

test('workspace document framing reduces caller event-loop lag', async () => {
  const codec = createWorkspaceSqliteCodec()
  const documentJson = JSON.stringify(document(12000))
  const iterations = 3
  try {
    const inline = await eventLoopLag(async () => {
      for (let i = 0; i < iterations; i++) {
        const document = JSON.parse(documentJson)
        const envelope = { id: 'x', method: 'workspace.commit', params: { document, expectedRevision: 1, mutationId: 'm' }, scheduling: true }
        assertDocumentSerialization(envelope)
        JSON.stringify(envelope)
      }
    })
    await codec.encodeRequest('warm', 'workspace.commit', { documentJson, expectedRevision: 1, mutationId: 'm' })
    const worker = await eventLoopLag(async () => {
      for (let i = 0; i < iterations; i++) {
        await codec.encodeRequest(`req-${i}`, 'workspace.commit', { documentJson, expectedRevision: 1, mutationId: 'm' })
      }
    })
    console.log(JSON.stringify({
      bytes: Buffer.byteLength(documentJson),
      iterations,
      inlineMaxMs: Number(inline.max.toFixed(3)),
      inlineElapsedMs: Number(inline.elapsed.toFixed(3)),
      workerMaxMs: Number(worker.max.toFixed(3)),
      workerElapsedMs: Number(worker.elapsed.toFixed(3)),
    }))
    assert.ok(worker.max * 2 < inline.max, `main-thread lag ${worker.max.toFixed(1)}ms was not under half of inline ${inline.max.toFixed(1)}ms`)
  } finally {
    await codec.close()
  }
})
