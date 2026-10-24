import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { Sidecar } from '../src/sidecar.mjs'
import { DOCUMENT_TRANSFER_BYTES } from '../src/document-capacity.mjs'

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
  let input = ''
  process.stdin.on('data', (chunk) => {
    if (!respond) return
    input += chunk.toString()
    let end
    while ((end = input.indexOf('\n')) >= 0) {
      const request = JSON.parse(input.slice(0, end))
      input = input.slice(end + 1)
      queueMicrotask(() =>
        process.stdout.write(
          malformed
            ? '{invalid}\n'
            : `${JSON.stringify({ id: request.id, result: { protocolVersion: 1 } })}\n`,
        ),
      )
    }
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
  assert.equal(client.writeQueue.length, 2) // First payload still owes its newline.
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

test('ordinary payload and delimiter keep one reservation until both writes finish, even with an early reply', async () => {
  const fixture = fake({ respond: false }), writes = []
  fixture.process.stdin.write = (bytes, callback) => { writes.push({ bytes, callback }); return false }
  const client = new Sidecar('/trusted/backend', '/trusted/recovery', fixture)
  const saving = client.request('save', { document: { name: 'Owned snapshot' } })
  const id = [...client.pending.keys()][0]
  assert.equal(writes.length, 1)
  assert.equal(JSON.parse(writes[0].bytes).id, id)
  assert.notEqual(writes[0].bytes.at(-1), 10)
  assert.equal(client.admittedCount, 1)
  writes[0].callback()
  fixture.process.stdin.emit('drain')
  assert.equal(writes.length, 2)
  assert.deepEqual(writes[1].bytes, Buffer.from('\n'))
  fixture.process.stdout.write(JSON.stringify({ id, result: { committed: true } }) + '\n')
  assert.deepEqual(await saving, { committed: true })
  assert.equal(client.admittedCount, 1)
  assert.ok(client.pendingBytes > 0)
  writes[1].callback()
  assert.equal(client.admittedCount, 0)
  assert.equal(client.pendingBytes, 0)
  fixture.process.stdin.emit('drain')
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
  assert.equal(client.pendingBytes, DOCUMENT_TRANSFER_BYTES)
  await assert.rejects(client.request('open', { path: '/trusted/other.fd' }), { code: 'BUSY' })
  const health = client.request('health').catch((error) => error)
  assert.equal(client.pending.size, 2)
  client.fail(Object.assign(new Error('test end'), { code: 'BACKEND_UNAVAILABLE' }))
  await Promise.all([pending, health])
  await client.stop()
})
test('large JSON responses reserve the escaped RPC envelope before accepting work',async()=>{
  const fixture=fake()
  const client=new Sidecar('/trusted/backend','/trusted/recovery',{...fixture,maxPendingBytes:3*1024*1024})
  await assert.rejects(client.request('large.read',{key:'0:1'}),{code:'BUSY'})
  await assert.rejects(client.request('large.project',{key:'0:1'}),{code:'BUSY'})
  assert.equal(client.admittedCount,0)
  await client.stop()
})
test('acknowledged queue wait has its own deadline and execution starts a fresh short timer',async()=>{
  const fixture=fake({respond:false}),client=new Sidecar('/trusted/backend','/trusted/recovery',{...fixture,timeoutMs:40,queueTimeoutMs:500})
  const result=client.request('save').catch(error=>error)
  const id=[...client.pending.keys()][0]
  fixture.process.stdout.write(JSON.stringify({desktopScheduling:{id,phase:'queued'}})+'\n')
  await new Promise(resolve=>setTimeout(resolve,90))
  assert.equal(client.stopped,false,'queued work must not kill the backend at its execution timeout')
  fixture.process.stdout.write(JSON.stringify({desktopScheduling:{id,phase:'running'}})+'\n')
  fixture.process.stdout.write(JSON.stringify({id,result:{saved:true}})+'\n')
  assert.equal((await result).saved,true)
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

test('large desktop requests and replies cross fixed frames through bounded chunks, retaining one reservation', async()=>{
  const { DocumentFrameAssembler, documentFrames } = await import('../src/document-transport.mjs')
  const { MAX_FRAME_BYTES } = await import('../src/security.mjs')
  const fixture=fake({respond:false})
  const client=new Sidecar('/trusted/backend','/trusted/recovery',fixture)
  const assembler=new DocumentFrameAssembler(DOCUMENT_TRANSFER_BYTES)
  let largest=0, requests=0
  fixture.process.stdin.on('data',chunk=>{
    largest=Math.max(largest,chunk.length)
    const received=assembler.accept(chunk)
    if(!received)return
    const request=JSON.parse(received.toString('utf8'));requests++
    const bytes=Buffer.from(JSON.stringify({id:request.id,result:{payload:request.params.payload}}))
    setImmediate(async()=>{
      for(const frame of documentFrames(bytes,'reply-large',MAX_FRAME_BYTES)){
        fixture.process.stdout.write(frame)
        await new Promise(resolve=>setImmediate(resolve))
      }
    })
  })
  const size=MAX_FRAME_BYTES+17
  assert.ok(DOCUMENT_TRANSFER_BYTES>size,'test requires >64MiB admitted transfer allowance')
  try {
    const response=await client.request('save',{payload:'x'.repeat(size)})
    assert.equal(response.payload.length,size);assert.equal(requests,1)
    assert.ok(largest<2*1024*1024);assert.equal(client.pendingBytes,0)
    assert.equal(client.admittedCount,0)
  } finally {await client.stop()}
})

test('aggregate resource rejection occurs before JSON serialization allocation',async()=>{
 const fixture=fake({respond:false})
 const client=new Sidecar('/trusted/backend','/trusted/recovery',{...fixture,maxPendingBytes:1})
 const stringify=JSON.stringify;let serialized=false,rejected
 try{
  JSON.stringify=()=>{serialized=true;throw Error('unexpected serialized allocation')}
  rejected=client.request('save',{document:{name:'not admitted'}})
 }finally{JSON.stringify=stringify}
 try{
  await assert.rejects(rejected,{code:'BUSY'})
  assert.equal(serialized,false);assert.equal(client.pendingBytes,0);assert.equal(client.pending.size,0)
 }finally{await client.stop()}
})

test('scene preparation and commit share long-job deadlines before and after scheduling receipts', async () => {
  for (const method of ['large.scene', 'large.sceneCommit']) {
    const fixture = fake({ respond: false })
    const client = new Sidecar('/trusted/backend', '/trusted/recovery', { ...fixture, timeoutMs: 20 })
    const pending = client.request(method).catch(error => error)
    const id = [...client.pending.keys()][0]
    try {
      assert.equal(client.executionTimeout(method), 600_000)
      assert.equal(client.executionTimeout('large.sceneRead'), 20)
      await new Promise(resolve => setTimeout(resolve, 50))
      assert.equal(client.stopped, false, `${method}: submission must not use the ordinary timeout`)
      fixture.process.stdout.write(JSON.stringify({ desktopScheduling: { id, phase: 'queued' } }) + '\n')
      fixture.process.stdout.write(JSON.stringify({ desktopScheduling: { id, phase: 'running' } }) + '\n')
      await new Promise(resolve => setTimeout(resolve, 50))
      assert.equal(client.stopped, false, `${method}: running must retain the long-job timeout`)
      fixture.process.stdout.write(JSON.stringify({ id, result: { completed: true } }) + '\n')
      assert.equal((await pending).completed, true)
      assert.deepEqual(fixture.process.signals, [])
    } finally {
      client.fail(Object.assign(new Error('Test end'), { code: 'BACKEND_UNAVAILABLE' }))
      await pending
      await client.stop()
    }
  }
})

test('scene cancellation uses the reserved control slot without admitting a ninth data job or replaying writes', async () => {
  const fixture = fake({ respond: false })
  const sent = []
  let input = '', requestWrites = []
  // Control the write-completion boundary explicitly. A backend response ACK
  // may precede stdin callbacks, so it does not itself release a reservation.
  fixture.process.stdin.write = (frame, callback) => {
    requestWrites.push({ callback, completed: false })
    input += frame.toString()
    let end
    while ((end = input.indexOf('\n')) >= 0) {
      const request = JSON.parse(input.slice(0, end)); input = input.slice(end + 1)
      sent.push({ ...request, writes: requestWrites, pending: client.pending.get(request.id) })
      requestWrites = []
      if (request.method === 'cancel') queueMicrotask(() => fixture.process.stdout.write(JSON.stringify({ id: request.id, result: { running: true, cancelled: false } }) + '\n'))
    }
    return true
  }
  const completeWrite = write => {
    assert.equal(write.completed, false, 'each stdin completion is delivered exactly once')
    const callback = write.callback
    write.callback = undefined
    write.completed = true
    callback()
  }
  const client = new Sidecar('/trusted/backend', '/trusted/recovery', fixture)
  const scene = client.request('large.scene').catch(error => error)
  const commit = client.request('large.sceneCommit').catch(error => error)
  const ordinary = Array.from({ length: 6 }, () => client.request('health').catch(error => error))
  let testFailure
  try {
    assert.equal(client.admittedCount, 8)
    assert.equal(sent.length, 8)
    for (const request of sent) for (const write of request.writes) completeWrite(write)
    const dataBytes = client.pendingBytes
    assert.equal(client.admittedCount, 8, 'completed data writes still await their responses')
    const jobs = [...client.pending].filter(([, value]) => ['large.scene', 'large.sceneCommit'].includes(value.method)).map(([id]) => id)
    await assert.rejects(client.request('health'), { code: 'BUSY' })
    assert.deepEqual(await client.cancelLargeDocument(), { requested: 2, running: true, cancelled: false })
    const controls = sent.filter(request => request.method === 'cancel')
    assert.deepEqual(controls.map(request => request.params.requestId), jobs)
    assert.equal(client.pending.size, 8, 'both cancellation responses have been consumed')
    for (const control of controls) {
      assert.equal(control.pending.completed, true)
      assert.equal(control.pending.allQueued, true)
      assert.equal(control.pending.written, false)
      assert.equal(control.pending.outstandingWrites, control.writes.length)
      assert.ok(control.writes.length > 0)
    }
    assert.equal(client.admittedCount, 8 + controls.length, 'ACKed controls remain reserved until all writes complete')
    assert.equal(client.pendingBytes, dataBytes + controls.reduce((bytes, control) => bytes + control.pending.bytes, 0))
    await assert.rejects(client.request('health'), { code: 'BUSY' })
    for (const control of controls) {
      const countBefore = client.admittedCount, bytesBefore = client.pendingBytes
      for (let i = 0; i < control.writes.length; i++) {
        completeWrite(control.writes[i])
        const finalWrite = i === control.writes.length - 1
        assert.equal(client.admittedCount, countBefore - (finalWrite ? 1 : 0))
        assert.equal(client.pendingBytes, bytesBefore - (finalWrite ? control.pending.bytes : 0))
      }
      assert.equal(control.pending.written, true)
      assert.equal(control.pending.released, true)
      assert.equal(control.pending.outstandingWrites, 0)
    }
    assert.equal(client.admittedCount, 8)
    assert.equal(client.pendingBytes, dataBytes)
    await assert.rejects(client.request('health'), { code: 'BUSY' })
    client.fail(Object.assign(new Error('Reply lost'), { code: 'BACKEND_UNAVAILABLE' }))
    assert.equal((await scene).outcomeUnknown, false)
    assert.equal((await commit).outcomeUnknown, true)
    assert.equal(sent.filter(request => request.method === 'large.sceneCommit').length, 1)
    assert.equal(client.pendingBytes, 0)
  } catch (error) {
    testFailure = error
  } finally {
    let cleanupFailure
    const retainCleanupFailure = error => { cleanupFailure ??= error }
    try { client.fail(Object.assign(new Error('Test end'), { code: 'BACKEND_UNAVAILABLE' })) }
    catch (error) { retainCleanupFailure(error) }
    const heldWrites = [...new Set([...sent.flatMap(request => request.writes), ...requestWrites])]
    for (const write of heldWrites) {
      if (!write.completed) {
        try { completeWrite(write) } catch (error) { retainCleanupFailure(error) }
      }
    }
    try {
      assert.equal(client.stopped, true)
      assert.equal(client.pendingBytes, 0, 'late completions cannot underflow the cleared byte ledger')
      assert.equal(client.admittedCount, 0, 'late completions cannot underflow the cleared count ledger')
      assert.ok(heldWrites.every(write => write.completed && write.callback === undefined))
    } catch (error) { retainCleanupFailure(error) }
    finally {
      sent.length = 0
      requestWrites = []
      input = ''
      heldWrites.length = 0
    }
    try { await Promise.all([scene, commit, ...ordinary]) }
    catch (error) { retainCleanupFailure(error) }
    finally {
      try { await client.stop() } catch (error) { retainCleanupFailure(error) }
    }
    // Preserve the original assertion if cleanup also found a problem.
    if (cleanupFailure) console.error('SIDECAR_TEST_CLEANUP_FAILED', cleanupFailure)
    if (testFailure) {
      if (cleanupFailure && testFailure instanceof Error && !testFailure.cause) testFailure.cause = cleanupFailure
      throw testFailure
    }
    if (cleanupFailure) throw cleanupFailure
  }
})
