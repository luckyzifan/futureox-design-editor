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
