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
