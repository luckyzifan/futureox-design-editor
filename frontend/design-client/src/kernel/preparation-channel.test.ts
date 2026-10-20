import { afterEach, expect, test } from 'vitest'
import { PreparationChannel } from './preparation-channel'

const close: (() => void)[] = []
afterEach(() => close.splice(0).forEach(fn => fn()))
function fixture() {
  const pair = new MessageChannel(), client = new PreparationChannel(pair.port1)
  close.push(() => { client.close(); pair.port2.close() })
  return { client, server: pair.port2 }
}
test('preparation routes lane and payload without sharing GPU handles', async () => {
  const { client, server } = fixture()
  server.onmessage = event => {
    expect(event.data.lane).toBe('interaction'); expect(event.data.method).toBe('compile_gpu_packet')
    expect(event.data.args).toEqual(['options'])
    const bytes = new Uint8Array([70, 71, 80, 75])
    server.postMessage({ id: event.data.id, value: bytes }, [bytes.buffer])
    expect(bytes.byteLength).toBe(0)
  }
  const reply = await client.request('interaction', 'compile_gpu_packet', ['options'])
  expect(reply.value).toEqual(new Uint8Array([70, 71, 80, 75]))
})
test('a failed preparation does not resolve or poison a later request', async () => {
  const { client, server } = fixture()
  server.onmessage = event => server.postMessage(event.data.id === 1
    ? { id: 1, error: 'Invalid document' } : { id: event.data.id, value: 'valid' })
  await expect(client.request('canvas', 'load_document', ['invalid'])).rejects.toThrow('Invalid document')
  expect((await client.request('canvas', 'stats')).value).toBe('valid')
})
test('closing preparation rejects outstanding work and future work', async () => {
  const { client } = fixture(), request = client.request('canvas', 'compile_gpu_packet', ['options'])
  const rejected = expect(request).rejects.toThrow('CPU preparation closed')
  client.close(); await rejected
  await expect(client.request('canvas', 'stats')).rejects.toThrow('CPU preparation closed')
})

test('cancelled in-flight packet releases its consumer but fences physical preparation; only latest queued packet is sent', async () => {
  const { client, server } = fixture(), received: any[] = []
  server.onmessage = event => { received.push(event.data) }
  const first = new AbortController(), second = new AbortController()
  const old = client.request('canvas', 'compile_gpu_packet', ['old'], first.signal)
  const rejectedOld = expect(old).rejects.toThrow('PREVIEW_CANCELLED')
  await new Promise(resolve => setTimeout(resolve, 10))
  expect(received.map(x => x.args[0])).toEqual(['old'])
  first.abort(); await rejectedOld
  const obsolete = client.request('canvas', 'compile_gpu_packet', ['obsolete'], second.signal)
  const rejectedObsolete = expect(obsolete).rejects.toThrow('PREVIEW_CANCELLED')
  second.abort(); await rejectedObsolete
  const latest = client.request('interaction', 'compile_gpu_packet', ['latest'])
  await new Promise(resolve => setTimeout(resolve, 10))
  expect(received.map(x => x.args[0])).toEqual(['old'])
  server.postMessage({ id: received[0].id, value: new Uint8Array([1]) })
  await new Promise(resolve => setTimeout(resolve, 10))
  expect(received.map(x => x.args[0])).toEqual(['old', 'latest'])
  server.postMessage({ id: received[1].id, value: new Uint8Array([2]) })
  expect((await latest).value).toEqual(new Uint8Array([2]))
})

test('cancelled preview preserves adjacent ordered mutation, export and readback preparation', async () => {
  const { client, server } = fixture(), events: string[] = []
  let release!: () => void
  server.onmessage = event => {
    const { id, method } = event.data; events.push(method)
    if (events.length === 1) release = () => server.postMessage({ id, value: new Uint8Array([1]) })
    else server.postMessage({ id, value: method })
  }
  const controller = new AbortController()
  const preview = client.request('canvas', 'compile_gpu_packet', ['old'], controller.signal)
  const rejected = expect(preview).rejects.toThrow('PREVIEW_CANCELLED')
  const patch = client.request('canvas', 'apply_document_patch_with_damage', ['patch'])
  const exported = client.request('canvas', 'render_png', ['export'])
  const readback = client.request('canvas', 'render_linear', ['readback'])
  await new Promise(resolve => setTimeout(resolve, 10))
  controller.abort(); await rejected; release()
  await Promise.all([patch, exported, readback])
  expect(events).toEqual(['compile_gpu_packet', 'apply_document_patch_with_damage', 'render_png', 'render_linear'])
  await expect(client.request('canvas', 'load_document', [], new AbortController().signal)).rejects.toThrow('Only stateless')
})

test('latest packet burst dispatches at most the executing obsolete compile and the final packet', async () => {
  const { client, server } = fixture(), received: string[] = []
  let chain = Promise.resolve(), release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  server.onmessage = event => {
    const request = event.data
    received.push(request.args[0])
    chain = chain.then(async () => {
      await gate
      // Synthetic serial compiler, not a claim about real document CPU cost.
      await new Promise(resolve => setTimeout(resolve, 20))
      server.postMessage({ id: request.id, value: new Uint8Array([1]) })
    })
  }
  const obsolete: Promise<unknown>[] = []
  for (let i = 0; i < 16; i++) {
    const controller = new AbortController()
    obsolete.push(client.request('canvas', 'compile_gpu_packet', [`obsolete-${i}`], controller.signal).catch(() => undefined))
    controller.abort()
  }
  const latest = client.request('canvas', 'compile_gpu_packet', ['latest'])
  const at = performance.now(); release(); await latest
  console.info('PREPARATION_BURST_RESULT', JSON.stringify({ latestMs: performance.now() - at, dispatched: received.length, syntheticCompileMs: 20, obsoleteRequests: 16 }))
  await Promise.all(obsolete)
  expect(received).toEqual(['obsolete-0', 'latest'])
})

test('physical preparation telemetry keeps original owner after cancellation and separates local queue wait', async () => {
  const pair = new MessageChannel(), rows: any[] = [], received: any[] = []
  let owner = 10
  const client = new PreparationChannel(pair.port1, { enabled: () => true, owner: () => owner, record: (event, fields) => rows.push({ event, ...fields }) })
  close.push(() => { client.close(); pair.port2.close() })
  pair.port2.onmessage = event => received.push(event.data)
  const controller = new AbortController()
  const packet = client.request('canvas', 'compile_gpu_packet', [], controller.signal).catch(() => undefined)
  owner = 11
  const load = client.request('interaction', 'load_document', ['doc'])
  await new Promise(resolve => setTimeout(resolve, 10)); controller.abort(); await packet
  expect(rows.find(r => r.phase === 3)).toMatchObject({ requestId: 10, methodCode: 8, superseded: true })
  pair.port2.postMessage({ id: received[0].id, value: new Uint8Array() })
  await new Promise(resolve => setTimeout(resolve, 10))
  expect(rows.find(r => r.phase === 4)).toMatchObject({ requestId: 10, methodCode: 8, superseded: true })
  const dispatch = rows.find(r => r.phase === 2 && r.requestId === 11)
  expect(dispatch.waitMs).toBeGreaterThanOrEqual(0); expect(dispatch.methodCode).toBe(3)
  pair.port2.postMessage({ id: received[1].id, documentFork: true }); await load
  expect(rows.at(-1)).toMatchObject({ phase: 4, requestId: 11, documentFork: true })
})

test('receipts certify only acknowledged lane state and pending edits suppress old proofs', async () => {
  const { client, server } = fixture(), received: any[] = []
  const receipt = (lane: 'canvas' | 'interaction', nonce: string) => ({ protocol: 1 as const, sessionGeneration: 's', canvasOwner: 'o', documentIncarnation: 'd', lane, synchronizedRevision: nonce, resourceEpoch: nonce, nonce })
  server.onmessage = event => { received.push(event.data) }
  const one = client.request('canvas', 'load_document', ['doc'])
  expect(client.currentReceipt('canvas')).toBeUndefined()
  await new Promise(resolve => setTimeout(resolve, 10))
  server.postMessage({ id: received[0].id, stateReceipt: receipt('canvas', '1') }); await one
  expect(client.currentReceipt('canvas')).toEqual(receipt('canvas', '1'))
  const warm = client.request('interaction', 'warm_resources')
  expect(client.currentReceipt('canvas')).toEqual(receipt('canvas', '1'))
  await new Promise(resolve => setTimeout(resolve, 10)); server.postMessage({ id: received[1].id }); await warm
  const init = client.request('interaction', 'initialize', [false])
  expect(client.currentReceipt('canvas')).toEqual(receipt('canvas', '1'))
  await new Promise(resolve => setTimeout(resolve, 10)); server.postMessage({ id: received[2].id, stateReceipt: null }); await init
  const patch = client.request('canvas', 'apply_document_patch_with_damage', ['patch'])
  const second = client.request('canvas', 'load_document', ['next'])
  expect(client.currentReceipt('canvas')).toBeUndefined()
  await new Promise(resolve => setTimeout(resolve, 10)); server.postMessage({ id: received[3].id, stateReceipt: receipt('canvas', '2') }); await patch
  expect(client.currentReceipt('canvas')).toBeUndefined()
  await new Promise(resolve => setTimeout(resolve, 10)); server.postMessage({ id: received[4].id, stateReceipt: receipt('canvas', '3') }); await second
  expect(client.currentReceipt('canvas')).toEqual(receipt('canvas', '3'))
  client.close(); expect(client.currentReceipt('canvas')).toBeUndefined()
})
test('failed atomic derive preserves target receipt but failed mutation revokes it', async () => {
  const { client, server } = fixture()
  const receipt = { protocol: 1 as const, sessionGeneration: 's', canvasOwner: 'o', documentIncarnation: 'd', lane: 'interaction' as const, synchronizedRevision: '1', resourceEpoch: '1', nonce: '1' }
  server.onmessage = event => server.postMessage(event.data.method === 'load_document'
    ? { id: event.data.id, stateReceipt: receipt } : { id: event.data.id, error: 'STALE_TARGET' })
  await client.request('interaction', 'load_document', ['doc'])
  await expect(client.request('interaction', 'derive_document_v1', [{}])).rejects.toThrow('STALE_TARGET')
  expect(client.currentReceipt('interaction')).toEqual(receipt)
  await expect(client.request('interaction', 'apply_document_patch_with_damage', ['bad'])).rejects.toThrow()
  expect(client.currentReceipt('interaction')).toBeUndefined()
})
