import { afterEach, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { blank, node, paint } from '../model'
import { createRenderPolicy } from './render-policy'
const resources = vi.hoisted(() => ({ font: undefined as Uint8Array | undefined }))
vi.mock('./kernel-resources', () => ({ loadKernelResources: async () => resources.font }))
const wasm = new Uint8Array(readFileSync(new URL('../../public/kernel/design_kernel_bg.wasm', import.meta.url)))
resources.font = new Uint8Array(readFileSync(new URL('../../public/fonts/NotoSansSC.ttf', import.meta.url)))
const channels: MessageChannel[] = [], NativeMessageChannel = MessageChannel
const cleanup: (() => void)[] = []
afterEach(() => { cleanup.splice(0).forEach(f => f()); channels.splice(0).forEach(pair => { pair.port1.close(); pair.port2.close() }); vi.unstubAllGlobals() })
async function fixture() {
  vi.resetModules()
  const kernel = await import('../generated/design-kernel/design_kernel'); await kernel.default({ module_or_path: wasm })
  const prepScope: any = {}; vi.stubGlobal('self', prepScope)
  await import('./preparation-worker')
  const pair = new NativeMessageChannel(); channels.push(pair)
  prepScope.onmessage({ data: { port: pair.port2 } })
  const requests: any[] = [], original = pair.port2.onmessage!
  let rejectDerive = false
  pair.port2.onmessage = function (event) {
    requests.push(event.data)
    if (rejectDerive && event.data.method === 'derive_document_v1') {
      pair.port2.postMessage({ id: event.data.id, error: 'STALE_TARGET' }); return
    }
    original.call(this, event)
  }
  const messages: any[] = [], scope: any = { postMessage(value: any) { messages.push(value) } }
  vi.stubGlobal('self', scope)
  vi.stubGlobal('MessageChannel', class { constructor() { const pair = new NativeMessageChannel(); channels.push(pair); return pair } })
  await import('./render-worker')
  scope.onmessage({ data: { command: 'prepare-port', port: pair.port1 } })
  const executionPolicy = createRenderPolicy(false, false, false, false, false)
  const doc = blank('Exact authored source'), rectangle = node('rectangle', 1, 1, 12, 12)
  rectangle.fills = [paint('#aa3355')]; doc.nodes[rectangle.id] = rectangle; doc.pages[0].children = [rectangle.id]
  Object.assign(doc, { extension: { nullValue: null, arbitrary: ['unchanged', { hidden: true }] } })
  const options = { pageId: doc.pages[0].id, width: 20, height: 20, view: { x: 0, y: 0, zoom: 1 }, grid: false, transparent: false }
  const send = (request: any) => scope.onmessage({ data: { executionPolicy, backend: 'cpu', options, ...request } })
  const finish = async (id: number) => {
    await vi.waitFor(() => expect(messages.some(m => m.id === id && (m.backend || m.error))).toBe(true))
    return messages.find(m => m.id === id && (m.backend || m.error))
  }
  const initial = async () => {
    send({ id: 1, document: JSON.stringify(doc), documentRevision: 1 })
    const result = await finish(1); expect(result.error).toBeUndefined()
    const receipt = messages.find(m => m.id === 1 && m.documentSynchronized)?.stateReceipt
    expect(receipt?.lane).toBe('canvas')
    return { result, receipt }
  }
  return { kernel, doc, options, requests, messages, send, finish, initial, rejectDerive: () => { rejectDerive = true } }
}
test('real WASM derive crosses both preparation boundaries without a full payload and matches fresh exact pixels/PNG', async () => {
  const f = await fixture(), { result, receipt } = await f.initial()
  const initialLoads = f.requests.filter(r => r.method === 'load_document').length
  f.send({ id: 2, channel: 'interaction', deriveFrom: receipt, documentRevision: 1 })
  const derived = await f.finish(2); expect(derived.error).toBeUndefined()
  expect(new Uint8Array(derived.buffer)).toEqual(new Uint8Array(result.buffer))
  expect(f.requests.filter(r => r.method === 'load_document')).toHaveLength(initialLoads)
  const requests = f.requests.filter(r => r.method === 'derive_document_v1')
  expect(requests).toHaveLength(1); expect(requests[0].args[0].delta).toEqual([])
  expect(JSON.stringify(requests[0])).not.toContain('Exact authored source')
  expect(Object.hasOwn(requests[0].args[0], 'document')).toBe(false)
  const reference = new f.kernel.VectorEngine(); cleanup.push(() => reference.free())
  reference.load_font(resources.font!); reference.load_document(JSON.stringify(f.doc))
  f.send({ id: 3, channel: 'interaction', documentRevision: 1, png: true, readback: true })
  const png = await f.finish(3); expect(png.error).toBeUndefined()
  const request = [...f.requests].reverse().find(r => r.method === 'render_png' || r.method === 'render_color_png')
  expect(new Uint8Array(png.buffer)).toEqual(reference.render_png(request.args[0]))
})
test('rejected target CAS requests exact captured fallback and leaves the ordered lane usable', async () => {
  const f = await fixture(), { receipt } = await f.initial(); f.rejectDerive()
  f.send({ id: 2, channel: 'interaction', deriveFrom: receipt, documentRevision: 1 })
  await vi.waitFor(() => expect(f.messages.some(m => m.id === 2 && m.documentFallback)).toBe(true))
  expect(f.messages.some(m => m.id === 2 && m.documentSynchronized)).toBe(false)
  f.send({ command: 'document-fallback', id: 2, document: JSON.stringify(f.doc) })
  const result = await f.finish(2); expect(result.error).toBeUndefined()
  expect(f.requests.filter(r => r.method === 'load_document')).toHaveLength(2)
  f.send({ id: 3, channel: 'interaction', documentRevision: 1, png: true })
  expect((await f.finish(3)).error).toBeUndefined()
})
test('stale source/resource receipt never derives; cancellation still completes captured fallback before exact output', async () => {
  const f = await fixture(), { receipt } = await f.initial()
  const preview = { ...f.options, renderIntent: 'preview', livePreview: true }
  f.send({ id: 2, channel: 'interaction', deriveFrom: { ...receipt, resourceEpoch: 'stale' }, documentRevision: 1, options: preview })
  await vi.waitFor(() => expect(f.messages.some(m => m.id === 2 && m.documentFallback)).toBe(true))
  f.send({ command: 'cancel-preview', channel: 'interaction' })
  f.send({ id: 3, channel: 'interaction', documentRevision: 1, png: true })
  f.send({ command: 'document-fallback', id: 2, document: JSON.stringify(f.doc) })
  expect((await f.finish(2)).error).toContain('PREVIEW_CANCELLED')
  expect((await f.finish(3)).error).toBeUndefined()
  expect(f.requests.some(r => r.method === 'derive_document_v1')).toBe(false)
  expect(f.messages.some(m => m.id === 2 && m.documentSynchronized)).toBe(true)
})
test('fallback rejection releases its fence and does not acknowledge unsynchronized target', async () => {
  const f = await fixture(), { receipt } = await f.initial()
  f.send({ id: 2, channel: 'interaction', deriveFrom: { ...receipt, nonce: 'stale' }, documentRevision: 1 })
  await vi.waitFor(() => expect(f.messages.some(m => m.id === 2 && m.documentFallback)).toBe(true))
  f.send({ command: 'document-fallback', id: 2, error: 'captured serialization failed' })
  expect((await f.finish(2)).error).toContain('captured serialization failed')
  expect(f.messages.some(m => m.id === 2 && m.documentSynchronized)).toBe(false)
  f.send({ id: 3, channel: 'interaction', document: JSON.stringify(f.doc), documentRevision: 2 })
  expect((await f.finish(3)).error).toBeUndefined()
})
test('derived resources and authored pixels survive source replacement/disposal', async () => {
  const f = await fixture()
  const image = node('rectangle', 0, 0, 8, 8), text = node('text', 0, 8, 20, 12)
  const bytes = f.kernel.encode_png_rgba(1, 1, new Uint8Array([30, 140, 80, 255]))
  image.fills = [{ ...paint('#ffffff'), kind: 'image', image: `data:image/png;base64,${Buffer.from(bytes).toString('base64')}` }]
  text.text = 'A'; text.fontSize = 10
  f.doc.nodes[image.id] = image; f.doc.nodes[text.id] = text; f.doc.pages[0].children.push(image.id, text.id)
  const { receipt, result } = await f.initial()
  f.send({ id: 2, channel: 'interaction', deriveFrom: receipt, documentRevision: 1 }); expect((await f.finish(2)).error).toBeUndefined()
  const next = blank('Replacement with same authored ID'); next.id = f.doc.id; next.pages[0].id = f.doc.pages[0].id
  f.send({ id: 3, document: JSON.stringify(next), documentRevision: 2 }); expect((await f.finish(3)).error).toBeUndefined()
  f.send({ id: 4, channel: 'interaction', documentRevision: 1, readback: true })
  const readback = await f.finish(4); expect(readback.error).toBeUndefined()
  expect(new Uint8Array(readback.buffer)).toEqual(new Uint8Array(result.buffer))
})
test('fallback timeout is bounded and a late response cannot overwrite a later synchronized target', async () => {
  const f = await fixture(), { receipt } = await f.initial()
  try {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    f.send({ id: 2, channel: 'interaction', deriveFrom: { ...receipt, nonce: 'stale' }, documentRevision: 1 })
    await vi.waitFor(() => expect(f.messages.some(m => m.id === 2 && m.documentFallback)).toBe(true))
    await vi.advanceTimersByTimeAsync(15001)
    await vi.waitFor(() => expect(f.messages.some(m => m.id === 2 && String(m.error).includes('DERIVATION_FALLBACK_TIMEOUT'))).toBe(true))
  } finally { vi.useRealTimers() }
  const changed = { ...f.doc, name: 'Recovered exact target' }
  f.send({ id: 3, channel: 'interaction', document: JSON.stringify(changed), documentRevision: 2 })
  expect((await f.finish(3)).error).toBeUndefined()
  const loads = f.requests.filter(r => r.method === 'load_document').length
  f.send({ command: 'document-fallback', id: 2, document: JSON.stringify(f.doc) })
  f.send({ id: 4, channel: 'interaction', documentRevision: 2, png: true })
  expect((await f.finish(4)).error).toBeUndefined()
  expect(f.requests.filter(r => r.method === 'load_document')).toHaveLength(loads)
})
