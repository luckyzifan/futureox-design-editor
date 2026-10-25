import { prepareAuthoredPatchTransition } from './authored-patch-transition'
import { afterEach, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { blank, node, paint } from '../model'
import { createRenderPolicy } from './render-policy'
const resources = vi.hoisted(() => ({ font: undefined as Uint8Array | undefined }))
vi.mock('./kernel-resources', () => ({ loadKernelResources: async () => resources.font }))
vi.mock('./gpu/factory', () => ({
  straightAlpha: (bytes: Uint8Array) => bytes,
  createGpu: async (backend: string) => ({
    driver: { name: backend, managed: false, displayMath: false, lost: false, description: 'test transport' },
    dispose() {}, abortFrameAndReleaseFilterScratch: async () => {},
    async render(scene: any) { return { rgba: new Uint8Array(scene.width * scene.height * 4), drawCalls: 0, triangles: 0 } },
  }),
}))
const wasm = new Uint8Array(readFileSync(new URL('../../public/kernel/design_kernel_bg.wasm', import.meta.url)))
resources.font = new Uint8Array(readFileSync(new URL('../../public/fonts/NotoSansSC.ttf', import.meta.url)))
const channels: MessageChannel[] = [], NativeMessageChannel = MessageChannel
const cleanup: (() => void)[] = []
afterEach(() => { cleanup.splice(0).forEach(f => f()); channels.splice(0).forEach(pair => { pair.port1.close(); pair.port2.close() }); vi.unstubAllGlobals() })
async function fixture(guarded = true) {
  vi.resetModules()
  const kernel = await import('../generated/design-kernel/design_kernel')
  const {initializeKernelModule}=await import('./module');await initializeKernelModule(wasm)
  const prepScope: any = {}; vi.stubGlobal('self', prepScope)
  await import('./preparation-worker')
  const pair = new NativeMessageChannel(); channels.push(pair)
  prepScope.onmessage({ data: { port: pair.port2 } })
  const requests: any[] = [], original = pair.port2.onmessage!
  let rejectDerive = false
  pair.port2.onmessage = function (event) {
    requests.push(event.data)
    if (!guarded && event.data.method === 'preparation_capabilities_v1') {
      pair.port2.postMessage({ id: event.data.id, value: { protocol: 1, emptyDeltaDerivation: true } }); return
    }
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
  let directSequence = 1_000_000
  const directPreparation = (lane: string, method: string, args: unknown[]) => new Promise<any>((resolve, reject) => {
    const id = ++directSequence
    const listener = (event: MessageEvent) => {
      if (event.data.id !== id) return
      pair.port1.removeEventListener('message', listener)
      if (event.data.error) reject(Error(event.data.error)); else resolve(event.data)
    }
    pair.port1.addEventListener('message', listener)
    pair.port1.postMessage({ id, lane, method, args })
  })
  return { kernel, doc, options, requests, messages, send, finish, initial, directPreparation, rejectDerive: () => { rejectDerive = true } }
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
test('first pose derives and applies native transforms without a full document load and preserves the canvas lane',async()=>{
  const f=await fixture(),{result,receipt}=await f.initial(),id=f.doc.pages[0].children[0]
  const transform=[1,0,0,1,3.125,5.25],loads=f.requests.filter(r=>r.method==='load_document').length
  f.send({id:2,channel:'interaction',deriveFrom:receipt,derivedTransforms:{[id]:transform},documentRevision:1})
  const pose=await f.finish(2);expect(pose.error).toBeUndefined()
  expect(f.messages.some(m=>m.id===2&&m.documentFallback)).toBe(false)
  expect(f.requests.filter(r=>r.method==='load_document')).toHaveLength(loads)
  expect(f.requests.filter(r=>r.method==='apply_interaction_transforms')).toHaveLength(1)
  const reference=new f.kernel.VectorEngine();cleanup.push(()=>reference.free())
  reference.load_font(resources.font!);reference.load_document(JSON.stringify({...f.doc,nodes:{...f.doc.nodes,[id]:{...f.doc.nodes[id],transform}}}))
  f.send({id:3,channel:'interaction',documentRevision:1,png:true,readback:true})
  const png=await f.finish(3);expect(png.error).toBeUndefined()
  const request=[...f.requests].reverse().find(r=>r.method==='render_png'||r.method==='render_color_png')
  expect(new Uint8Array(png.buffer)).toEqual(reference.render_png(request.args[0]))
  f.send({id:4,channel:'canvas',documentRevision:1})
  const unchanged=await f.finish(4);expect(unchanged.error).toBeUndefined()
  expect(new Uint8Array(unchanged.buffer)).toEqual(new Uint8Array(result.buffer))
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
test('real acknowledged edit→derive→undo→redo avoids full payload and matches independent packet/pixel oracles', async () => {
  const f = await fixture(), { receipt: initialReceipt } = await f.initial()
  const shape = Object.values(f.doc.nodes)[0]
  const moved = { ...f.doc, nodes: { ...f.doc.nodes, [shape.id]: { ...shape, transform: [1, 0, 0, 1, 4, 5] as typeof shape.transform, opacity: .65 } } }
  let before = f.doc, receipt = initialReceipt, revision = 1, id = 1, interactionRevision = 0
  for (const after of [moved, f.doc, moved]) {
    const transition = prepareAuthoredPatchTransition(before, after); expect(transition.canAcknowledge).toBe(true)
    const patchId = ++id
    f.send({ id: patchId, documentPatch: JSON.stringify(transition.patch), patchBaseReceipt: receipt,
      baseDocumentRevision: revision, documentRevision: ++revision })
    expect((await f.finish(patchId)).error).toBeUndefined()
    const fresh = f.messages.find(m => m.id === patchId && m.documentSynchronized)?.stateReceipt
    expect(fresh?.nonce).not.toBe(receipt.nonce); expect(fresh?.lane).toBe('canvas'); receipt = fresh
    const deriveId = ++id
    f.send({ id: deriveId, channel: 'interaction', deriveFrom: receipt, documentRevision: ++interactionRevision })
    const result = await f.finish(deriveId); expect(result.error).toBeUndefined()
    expect(f.requests.filter(r => r.method === 'load_document')).toHaveLength(1)
    expect(f.messages.some(m => m.id === deriveId && m.documentFallback)).toBe(false)
    const reference = new f.kernel.VectorEngine()
    try {
      reference.load_font(resources.font!); reference.set_image_mips(false); reference.load_document(JSON.stringify(after))
      const renderOptions = [...f.requests].reverse().find(r => r.method === 'render_cpu_frame').args[0]
      expect(new Uint8Array(result.buffer)).toEqual(reference.render_rgba(renderOptions))
      const packet = await f.directPreparation('interaction', 'compile_gpu_packet', [renderOptions])
      // FGSC carries producer-specific resource IDs/receipts. Compare every
      // material/geometry value after binding; wire scope is intentionally distinct.
      const {decodeScenePacket}=await import('./gpu/scene-packet')
      expect(decodeScenePacket(packet.value)).toEqual(decodeScenePacket(reference.compile_gpu_packet(renderOptions)))
      const png = await f.directPreparation('interaction', 'render_png', [renderOptions])
      expect(png.value).toEqual(reference.render_png(renderOptions))
    } finally { reference.free() }
    before = after
  }
  expect((f.doc as any).extension).toEqual({ nullValue: null, arbitrary: ['unchanged', { hidden: true }] })
})
test('actual patch ACK requires matching prepatch proof; local rejection cannot execute the native mutation', async () => {
  const f = await fixture(), { receipt } = await f.initial(), shape = Object.values(f.doc.nodes)[0]
  const moved = { ...f.doc, nodes: { ...f.doc.nodes, [shape.id]: { ...shape, opacity: .5 } } }
  const patch = prepareAuthoredPatchTransition(f.doc, moved).patch
  f.send({ id: 2, documentPatch: JSON.stringify(patch), patchBaseReceipt: { ...receipt, nonce: 'lost-or-stale' }, baseDocumentRevision: 1, documentRevision: 2 })
  expect((await f.finish(2)).error).toContain('STALE_AUTHORED_PATCH_BASE')
  expect(f.messages.some(m => m.id === 2 && m.documentSynchronized)).toBe(false)
  expect(f.requests.some(r => r.method === 'apply_document_patch_with_damage')).toBe(false)
  f.send({ id: 3, document: JSON.stringify(moved), documentRevision: 3 })
  expect((await f.finish(3)).error).toBeUndefined()
  expect(f.messages.find(m => m.id === 3 && m.documentSynchronized)?.stateReceipt?.lane).toBe('canvas')
})
test('font/root changes and failed patches revoke postpatch source authority without altering exported authored data', async () => {
  const f = await fixture(), { receipt } = await f.initial()
  f.send({ id: 2, documentPatch: JSON.stringify({ nodes: {}, fields: { fonts: {} } }), baseDocumentRevision: 1, documentRevision: 2 })
  expect((await f.finish(2)).error).toBeUndefined()
  expect(f.messages.find(m => m.id === 2 && m.documentSynchronized)?.stateReceipt).toBeNull()
  f.send({ id: 3, documentPatch: JSON.stringify({ nodes: {}, fields: { extension: null } }), baseDocumentRevision: 2, documentRevision: 3 })
  expect((await f.finish(3)).error).toContain('Unsupported document field')
  expect(f.messages.some(m => m.id === 3 && m.documentSynchronized)).toBe(false)
  expect((f.doc as any).extension.nullValue).toBeNull()
})
test('backend-authoritative CAS catches out-of-band source change and preserves live actual state', async () => {
  const f = await fixture(), { receipt } = await f.initial(), shape = Object.values(f.doc.nodes)[0]
  const actual = { ...f.doc, name: 'actual newer native source', nodes: { ...f.doc.nodes, [shape.id]: { ...shape, opacity: .15 } } }
  const changed = await f.directPreparation('canvas', 'load_document', [JSON.stringify(actual)])
  const intended = { ...f.doc, nodes: { ...f.doc.nodes, [shape.id]: { ...shape, width: 9 } } }
  const patch = prepareAuthoredPatchTransition(f.doc, intended).patch
  f.send({ id: 2, documentPatch: JSON.stringify(patch), patchBaseReceipt: receipt, baseDocumentRevision: 1, documentRevision: 2 })
  expect((await f.finish(2)).error).toBe('STALE_BASE')
  expect(f.messages.some(m => m.id === 2 && m.documentSynchronized)).toBe(false)
  const sent = f.requests.find(r => r.method === 'apply_document_patch_with_damage')
  expect(sent.args[1]).toEqual({ expectedBaseReceipt: receipt })
  // Definitive CAS rejection did not retire actual native/WASM state or receipt.
  const retained = await f.directPreparation('canvas', 'apply_document_patch_with_damage', [JSON.stringify({ nodes: {}, fields: {} }), { expectedBaseReceipt: changed.stateReceipt }])
  expect(retained.stateReceipt?.lane).toBe('canvas')
  f.send({ id: 3, document: JSON.stringify(intended), documentRevision: 3 })
  const recovered = await f.finish(3); expect(recovered.error).toBeUndefined()
  const reference = new f.kernel.VectorEngine(); cleanup.push(() => reference.free())
  reference.load_font(resources.font!); reference.load_document(JSON.stringify(intended))
  const options = [...f.requests].reverse().find(r => r.method === 'render_cpu_frame').args[0]
  expect(new Uint8Array(recovered.buffer)).toEqual(reference.render_rgba(options))
})
test('old derivation-capable backend lacking explicit patch-CAS capability never renews postpatch binding', async () => {
  const f = await fixture(false), { receipt } = await f.initial(), shape = Object.values(f.doc.nodes)[0]
  const intended = { ...f.doc, nodes: { ...f.doc.nodes, [shape.id]: { ...shape, opacity: .5 } } }
  f.send({ id: 2, documentPatch: JSON.stringify(prepareAuthoredPatchTransition(f.doc, intended).patch), patchBaseReceipt: receipt, baseDocumentRevision: 1, documentRevision: 2 })
  expect((await f.finish(2)).error).toBeUndefined()
  expect(f.requests.find(r => r.method === 'apply_document_patch_with_damage').args).toHaveLength(1)
  expect(f.messages.find(m => m.id === 2 && m.documentSynchronized)?.stateReceipt).toBeNull()
})
test('authored optional-null projection mismatch preserves normal editing but withholds renewed binding', async () => {
  const f = await fixture(), shape = Object.values(f.doc.nodes)[0]
  Object.assign(shape, { layout: null })
  const { receipt } = await f.initial()
  const target = { ...f.doc, nodes: { ...f.doc.nodes, [shape.id]: { ...shape, opacity: .4 } } }
  const transition = prepareAuthoredPatchTransition(f.doc, target)
  expect(transition.canAcknowledge).toBe(true)
  f.send({ id: 2, documentPatch: JSON.stringify(transition.patch), patchBaseReceipt: receipt, baseDocumentRevision: 1, documentRevision: 2 })
  const result = await f.finish(2); expect(result.error).toBeUndefined()
  expect(f.requests.find(r => r.method === 'apply_document_patch_with_damage').args[1]).toEqual({ expectedBaseReceipt: receipt })
  expect(f.messages.find(m => m.id === 2 && m.documentSynchronized)?.stateReceipt).toBeNull()
  expect((target.nodes[shape.id] as any).layout).toBeNull()
  const reference = new f.kernel.VectorEngine()
  try {
    reference.load_font(resources.font!); reference.load_document(JSON.stringify(target))
    const options = [...f.requests].reverse().find(r => r.method === 'render_cpu_frame').args[0]
    expect(new Uint8Array(result.buffer)).toEqual(reference.render_rgba(options))
  } finally { reference.free() }
})

test.each([false, true])('guard capability %s preserves deferred translation and later synchronization without renewal', async guarded => {
  const f = await fixture(guarded)
  Object.values(f.doc.nodes)[0].transform[4] = 20
  Object.values(f.doc.nodes)[0].transform[5] = 20
  const options = { ...f.options, width: 100, height: 100, rasterProfile: 'analytic', renderIntent: 'preview', livePreview: true, retainInteractionGraph: true }
  f.send({ id: 1, backend: 'auto', document: JSON.stringify(f.doc), documentRevision: 1, options })
  expect((await f.finish(1)).backend).toBe('webgpu')
  const receipt = f.messages.find(m => m.id === 1 && m.documentSynchronized).stateReceipt
  expect(receipt).toBeTruthy()
  const id = f.doc.pages[0].children[0], before = f.doc.nodes[id]
  const edited = { ...f.doc, nodes: { ...f.doc.nodes, [id]: { ...before, transform: [...before.transform.slice(0, 4), before.transform[4] + 2, before.transform[5]] } } }
  const transition = prepareAuthoredPatchTransition(f.doc, edited as any)
  expect(transition.canAcknowledge).toBe(true)
  const patchesBefore = f.requests.filter(r => r.method === 'apply_document_patch_with_damage').length
  f.send({ id: 2, backend: 'auto', documentPatch: JSON.stringify(transition.patch), patchBaseReceipt: receipt,
    baseDocumentRevision: 1, documentRevision: 2, options })
  expect((await f.finish(2)).error).toBeUndefined()
  expect(f.messages.find(m => m.id === 2 && m.damage)?.damage.reason).toBe('transient-translation')
  expect(f.messages.find(m => m.id === 2 && m.documentSynchronized).stateReceipt).toBeNull()
  expect(f.requests.filter(r => r.method === 'apply_document_patch_with_damage')).toHaveLength(patchesBefore)
  // A later nontranslation edit first drains the deferred document, then uses
  // the ordinary patch route, without pretending the original receipt is current.
  const after = { ...edited, nodes: { ...edited.nodes, [id]: { ...edited.nodes[id], opacity: .5 } } }
  const next = prepareAuthoredPatchTransition(edited as any, after as any)
  f.send({ id: 3, backend: 'auto', documentPatch: JSON.stringify(next.patch), patchBaseReceipt: receipt,
    baseDocumentRevision: 2, documentRevision: 3, options })
  expect((await f.finish(3)).error).toBeUndefined()
  expect(f.messages.find(m => m.id === 3 && m.documentSynchronized).stateReceipt).toBeNull()
  const applied = f.requests.filter(r => r.method === 'apply_document_patch_with_damage')
  expect(applied.at(-1).args).toHaveLength(1)
  f.send({ id: 4, documentRevision: 3, png: true, readback: true })
  const result = await f.finish(4); expect(result.error).toBeUndefined()
  const reference = new f.kernel.VectorEngine(); cleanup.push(() => reference.free())
  reference.load_font(resources.font!); reference.load_document(JSON.stringify(after))
  const request = [...f.requests].reverse().find(r => r.method === 'render_png' || r.method === 'render_color_png')
  expect(new Uint8Array(result.buffer)).toEqual(reference.render_png(request.args[0]))
})
