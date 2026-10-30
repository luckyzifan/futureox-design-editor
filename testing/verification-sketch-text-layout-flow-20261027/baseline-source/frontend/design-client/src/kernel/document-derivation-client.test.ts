import { afterEach, expect, test, vi } from 'vitest'
import { blank, node } from '../model'
import type { PreparationStateReceiptV1 } from './preparation-state'
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })
const receipt = (nonce = '1'): PreparationStateReceiptV1 => ({ protocol: 1, sessionGeneration: 'session', canvasOwner: 'owner', documentIncarnation: 'incarnation', lane: 'canvas', synchronizedRevision: nonce, resourceEpoch: nonce, nonce })
async function fixture() {
  const native = { open: async () => 'owned', close: vi.fn(async () => {}), request: vi.fn(async (_id: string, request: any) => ({ id: 1, value: JSON.stringify(request.args[0]) })) }
  class WorkerStub {
    static instances: WorkerStub[] = []
    messages: any[] = []; onmessage?: (event: any) => void
    constructor() { WorkerStub.instances.push(this) }
    postMessage(value: any) { this.messages.push(value) }
    terminate() {}
    reply(data: any) { this.onmessage?.({ data }) }
    requests() { return this.messages.filter(m => m.id && !m.command) }
  }
  vi.stubGlobal('window', { coreDesktop: { version: 1, renderPolicy: { cpuOnly: true }, preparation: native } })
  vi.stubGlobal('Worker', WorkerStub)
  const { KernelClient } = await import('./client')
  const client = new KernelClient(), worker = WorkerStub.instances[0], document = blank()
  const options = { pageId: document.pages[0].id, width: 20, height: 20, view: { x: 0, y: 0, zoom: 1 }, grid: false, transparent: false }
  const render = (doc = document, extra = {}, signal?: AbortSignal, png = false) => client.render(doc, { ...options, ...extra }, png, 'cpu', false, false, undefined, undefined, signal)
  const next = async (count: number) => { await vi.waitFor(() => expect(worker.requests()).toHaveLength(count)); return worker.requests()[count - 1] }
  const ack = (request: any, value: PreparationStateReceiptV1 | null = receipt()) => worker.reply({ id: request.id, documentSynchronized: true, stateReceipt: value })
  const finish = (request: any) => worker.reply({ id: request.id, backend: 'cpu', milliseconds: 0, stats: { nodes: 0 } })
  return { native, client, worker, document, render, next, ack, finish }
}
test('acknowledged exact canvas identity admits empty derivation with zero full serialization or payload', async () => {
  const f = await fixture()
  try {
    const first = f.render(), one = await f.next(1); f.ack(one); f.finish(one); await first
    const calls = f.native.request.mock.calls.length
    const second = f.render(f.document, { interactionChannel: true }), two = await f.next(2)
    expect(two.deriveFrom).toEqual(receipt()); expect(two.document).toBeUndefined(); expect(two.documentPatch).toBeUndefined()
    expect(f.native.request).toHaveBeenCalledTimes(calls)
    f.ack(two, null); f.finish(two); await second
  } finally { f.client.dispose() }
})
test('isolated render roots use the original canvas receipt without serializing another document',async()=>{
  const f=await fixture(),a=node('frame',0,0,20,20),b=node('frame',30,0,20,20)
  f.document.nodes[a.id]=a;f.document.nodes[b.id]=b;f.document.pages[0].children=[a.id,b.id]
  try{
    const first=f.render(),one=await f.next(1);f.ack(one);f.finish(one);await first
    const calls=f.native.request.mock.calls.length
    const next=f.render(f.document,{interactionChannel:true,gpuRoots:[a.id]}),two=await f.next(2)
    expect(two.deriveFrom).toEqual(receipt());expect(two.document).toBeUndefined();expect(two.documentPatch).toBeUndefined()
    expect(two.options.gpuRoots).toEqual([a.id]);expect(f.native.request).toHaveBeenCalledTimes(calls)
    expect(f.document.nodes[b.id].visible).toBe(true)
    f.ack(two,null);f.finish(two);await next
  }finally{f.client.dispose()}
})

test('first native workset adoption synchronizes its full source once and derives later poses without serializing it again',async()=>{
  const f=await fixture(),shape=node('frame',0,0,20,20)
  try{
    const first=f.render(),one=await f.next(1);f.ack(one);f.finish(one);await first
    const populated={...f.document,nodes:{[shape.id]:shape},pages:[{...f.document.pages[0],children:[shape.id]}]}
    const adopted=f.render(populated,{renderIntent:'canvas',tileViewport:[]}),two=await f.next(2)
    expect(two.document).toBe(JSON.stringify(populated));expect(two.documentPatch).toBeUndefined()
    expect(f.native.request).toHaveBeenCalledTimes(2)
    f.ack(two,receipt('workset'));f.finish(two);await adopted
    const {interactionPatchedDocument}=await import('./interaction-document-source')
    const pose=interactionPatchedDocument(populated,{[shape.id]:{transform:[1,0,0,1,30,40]}})
    const moving=f.render(pose,{interactionChannel:true,retainInteractionGraph:true}),three=await f.next(3)
    expect(three.deriveFrom).toEqual(receipt('workset'));expect(three.derivedTransforms).toEqual({[shape.id]:[1,0,0,1,30,40]})
    expect(three.document).toBeUndefined();expect(three.documentPatch).toBeUndefined();expect(f.native.request).toHaveBeenCalledTimes(2)
    f.ack(three,null);f.finish(three);await moving
    // Populated documents keep ordinary incremental mutation, including adds.
    const added=node('rectangle'),later={...populated,nodes:{...populated.nodes,[added.id]:added}}
    const edit=f.render(later),four=await f.next(4)
    expect(four.document).toBeUndefined();expect(JSON.parse(four.documentPatch).nodes[added.id]).toEqual(added)
    f.ack(four,null);f.finish(four);await edit
  }finally{f.client.dispose()}
})

test.each([true,false])('native page replacement uses a full source only when every old/new node is in the patch: %s',async complete=>{
  const f=await fixture(),a=node('frame'),b=node('frame')
  f.document.nodes={[a.id]:a,[b.id]:b};f.document.pages[0].children=[a.id,b.id]
  try{
    const first=f.render(),one=await f.next(1);f.ack(one);f.finish(one);await first
    const replacement={...f.document,pages:[{...f.document.pages[0],name:'reloaded'}],nodes:{
      [a.id]:{...a,opacity:.5},[b.id]:complete?{...b,opacity:.5}:b}}
    const loading=f.render(replacement,{renderIntent:'canvas',tileViewport:[]}),two=await f.next(2)
    if(complete){expect(two.document).toBe(JSON.stringify(replacement));expect(two.documentPatch).toBeUndefined()}
    else {expect(two.document).toBeUndefined();expect(JSON.parse(two.documentPatch).nodes[a.id]).toBeTruthy();expect(JSON.parse(two.documentPatch).nodes[b.id]).toBeUndefined()}
    f.ack(two,complete?receipt('reloaded'):null);f.finish(two);await loading
    const moving=f.render(replacement,{interactionChannel:true,gpuRoots:[a.id]}),three=await f.next(3)
    if(complete){expect(three.deriveFrom).toEqual(receipt('reloaded'));expect(three.document).toBeUndefined()}
    else expect(three.deriveFrom).toBeUndefined()
    f.ack(three,null);f.finish(three);await moving
  }finally{f.client.dispose()}
})
test('a privately constructed first pose derives the original receipt and sends only transforms',async()=>{
  const f=await fixture(),shape=node('frame',0,0,20,20)
  const {interactionPatchedDocument}=await import('./interaction-document-source')
  f.document.nodes[shape.id]=shape;f.document.pages[0].children=[shape.id]
  try{
    const first=f.render(),one=await f.next(1);f.ack(one);f.finish(one);await first
    const transform:[number,number,number,number,number,number]=[1,0,0,1,.125,3.5]
    const pose=interactionPatchedDocument(f.document,{[shape.id]:{transform}}),calls=f.native.request.mock.calls.length
    transform[4]=999 // The caller's draft cannot rewrite the certified pose.
    const next=f.render(pose,{interactionChannel:true}),two=await f.next(2)
    expect(two.deriveFrom).toEqual(receipt());expect(two.document).toBeUndefined();expect(two.documentPatch).toBeUndefined()
    expect(two.derivedTransforms).toEqual({[shape.id]:[1,0,0,1,.125,3.5]})
    expect(f.native.request).toHaveBeenCalledTimes(calls)
    f.ack(two,null);f.finish(two);await next
    const copy={...pose},third=f.render(copy,{interactionChannel:true}),three=await f.next(3)
    expect(three.deriveFrom).toBeUndefined();expect(three.derivedTransforms).toBeUndefined()
    f.finish(three);await third
  }finally{f.client.dispose()}
})
test('same ID but different authored object, missing acknowledgment, and post-patch binding all fall back', async () => {
  const f = await fixture()
  try {
    const first = f.render(), one = await f.next(1)
    const unacked = f.render(f.document, { interactionChannel: true }), two = await f.next(2)
    expect(two.deriveFrom).toBeUndefined(); expect(two.document).toBe(JSON.stringify(f.document))
    f.ack(one); f.finish(one); f.finish(two); await Promise.all([first, unacked])
    const changed = { ...f.document, name: 'new object with same ID' }
    const patch = f.render(changed), three = await f.next(3)
    expect(three.documentPatch).toBeTruthy()
    // A stale full-load ack arriving after mutation submission is unusable.
    f.ack(one); f.ack(three); f.finish(three); await patch
    const derived = f.render(changed, { interactionChannel: true }), four = await f.next(4)
    expect(four.deriveFrom).toBeUndefined(); expect(four.documentPatch).toBeTruthy()
    f.finish(four); await derived
  } finally { f.client.dispose() }
})
test('fallback serializes the captured intended object, not a newer canvas or Rust normalized value', async () => {
  const f = await fixture()
  try {
    const first = f.render(), one = await f.next(1); f.ack(one); f.finish(one); await first
    const interaction = f.render(f.document, { interactionChannel: true }), two = await f.next(2)
    const newer = { ...f.document, name: 'newer canvas' }, update = f.render(newer), three = await f.next(3)
    f.worker.reply({ id: two.id, documentFallback: true })
    await vi.waitFor(() => expect(f.worker.messages.some(m => m.command === 'document-fallback')).toBe(true))
    const fallback = f.worker.messages.find(m => m.command === 'document-fallback')
    expect(fallback.document).toBe(JSON.stringify(f.document)); expect(fallback.document).not.toBe(JSON.stringify(newer))
    f.ack(two, null); f.finish(two); f.finish(three); await Promise.all([interaction, update])
  } finally { f.client.dispose() }
})
test('cancelled preview still supplies its accepted mutation fallback, while exact output ignores preview signal', async () => {
  const f = await fixture()
  try {
    const first = f.render(), one = await f.next(1); f.ack(one); f.finish(one); await first
    const signal = new AbortController()
    const preview = f.render(f.document, { interactionChannel: true, renderIntent: 'preview', livePreview: true }, signal.signal)
    const rejected = expect(preview).rejects.toThrow('PREVIEW_CANCELLED'), two = await f.next(2)
    signal.abort(); await rejected
    f.worker.reply({ id: two.id, documentFallback: true })
    await vi.waitFor(() => expect(f.worker.messages.some(m => m.command === 'document-fallback' && m.id === two.id)).toBe(true))
    f.ack(two, null)
    const exact = f.render(f.document, { interactionChannel: true }, signal.signal, true), three = await f.next(3)
    expect(three.png).toBe(true); f.finish(three); await exact
  } finally { f.client.dispose() }
})
test('cancelled accepted synchronizations remain bounded and reset clears captures and rejects late ACKs', async () => {
  const f = await fixture()
  try {
    const initial = f.render(), one = await f.next(1); f.ack(one); f.finish(one); await initial
    const pending: Promise<unknown>[] = []
    for (let i = 0; i < 128; i++) {
      const result = (f.client as any).request({ channel: 'interaction', deriveFrom: receipt(), documentRevision: i + 1,
        options: { livePreview: true } }, undefined, [], undefined, { document: { ...f.document, name: `captured-${i}` } })
      pending.push(result.catch((error: Error) => { expect(error.message).toBe('PREVIEW_CANCELLED') }))
      f.client.cancelPreview('interaction')
    }
    await Promise.all(pending)
    expect((f.client as any).synchronizationInputs.size).toBe(128)
    const dispatched = f.worker.requests().length
    await expect((f.client as any).request({ channel: 'interaction' }, undefined, [], undefined, { document: f.document })).rejects.toThrow('input budget exceeded')
    expect(f.worker.requests()).toHaveLength(dispatched)
    await expect(f.render(f.document, { interactionChannel: true })).rejects.toThrow('input budget exceeded')
    expect((f.client as any).interactionSnapshot).toBeUndefined()
    const rejectedRevision = (f.client as any).interactionRevision
    f.ack(f.worker.requests()[1], null)
    expect((f.client as any).synchronizationInputs.size).toBe(127)
    const retry = f.render(f.document, { interactionChannel: true }), next = await f.next(dispatched + 1)
    expect(next.deriveFrom).toEqual(receipt()); expect(next.documentPatch).toBeUndefined()
    expect(next.documentRevision).toBeGreaterThan(rejectedRevision)
    f.ack(next, null); f.finish(next); await retry
    ;(f.client as any).reset(Error('test reset'))
    expect((f.client as any).synchronizationInputs.size).toBe(0)
    f.ack(one)
    expect((f.client as any).authoredPreparation.receiptFor(f.document)).toBeUndefined()
  } finally { f.client.dispose() }
})
test('acknowledged property edit, undo and redo bind exact after objects and derive without full serialization', async () => {
  const f = await fixture(), shape = node('rectangle', 1, 1, 10, 10)
  f.document.nodes[shape.id] = shape; f.document.pages[0].children = [shape.id]
  Object.assign(f.document, { extension: { field: null, keep: ['raw'] } })
  const edited = { ...f.document, nodes: { ...f.document.nodes, [shape.id]: { ...shape, opacity: .5 } } }
  try {
    const initial = f.render(), one = await f.next(1); f.ack(one); f.finish(one); await initial
    let count = 1, lastReceipt = receipt()
    for (const target of [edited, f.document, edited]) {
      const change = f.render(target), request = await f.next(++count)
      expect(request.patchBaseReceipt).toEqual(lastReceipt); expect(request.document).toBeUndefined()
      lastReceipt = receipt(String(count)); f.ack(request, lastReceipt); f.finish(request); await change
      const serializations = f.native.request.mock.calls.length
      const drag = f.render(target, { interactionChannel: true }), derived = await f.next(++count)
      expect(derived.deriveFrom).toEqual(lastReceipt); expect(derived.document).toBeUndefined(); expect(derived.documentPatch).toBeUndefined()
      expect(f.native.request).toHaveBeenCalledTimes(serializations)
      f.ack(derived, null); f.finish(derived); await drag
    }
    expect((edited as any).extension).toBe((f.document as any).extension)
  } finally { f.client.dispose() }
})
test('lost/reordered patch ACK, resource updates and rejected patch cannot publish postpatch authority', async () => {
  const f = await fixture(), shape = node('rectangle', 1, 1, 10, 10)
  f.document.nodes[shape.id] = shape; f.document.pages[0].children = [shape.id]
  const edited = { ...f.document, nodes: { ...f.document.nodes, [shape.id]: { ...shape, opacity: .5 } } }
  const again = { ...edited, nodes: { ...edited.nodes, [shape.id]: { ...edited.nodes[shape.id], opacity: .75 } } }
  try {
    const initial = f.render(), one = await f.next(1); f.ack(one); f.finish(one); await initial
    const a = f.render(edited), two = await f.next(2)
    const b = f.render(again), three = await f.next(3)
    expect(two.patchBaseReceipt).toEqual(receipt()); expect(three.patchBaseReceipt).toBeUndefined()
    f.ack(three, receipt('3')); f.ack(two, receipt('2')); f.finish(two); f.finish(three); await Promise.all([a, b])
    expect((f.client as any).authoredPreparation.receiptFor(again)).toBeUndefined()
    const resource = { ...again, fonts: {} }, c = f.render(resource), four = await f.next(4)
    expect(four.patchBaseReceipt).toBeUndefined(); f.ack(four, receipt('4')); f.finish(four); await c
    expect((f.client as any).authoredPreparation.receiptFor(resource)).toBeUndefined()
    const failure = f.render({ ...resource, name: 'will fail' }), rejected = expect(failure).rejects.toThrow('rejected patch'), five = await f.next(5)
    f.worker.reply({ id: five.id, error: 'rejected patch' }); await rejected
    expect((f.client as any).documentSnapshot).toBeUndefined()
    expect((f.client as any).authoredPreparation.receiptFor(resource)).toBeUndefined()
  } finally { f.client.dispose() }
})
test('definite guarded CAS rejection keeps intended edits available for exact full-sync recovery', async () => {
  const f = await fixture(), shape = node('rectangle', 1, 1, 10, 10)
  f.document.nodes[shape.id] = shape; f.document.pages[0].children = [shape.id]
  Object.assign(f.document, { unknownRoot: { keep: null } })
  const intended = { ...f.document, nodes: { ...f.document.nodes, [shape.id]: { ...shape, opacity: .25 } } }
  try {
    const initial = f.render(), one = await f.next(1); f.ack(one); f.finish(one); await initial
    const update = f.render(intended), rejected = expect(update).rejects.toThrow('STALE_BASE'), two = await f.next(2)
    expect(two.patchBaseReceipt).toEqual(receipt())
    f.worker.reply({ id: two.id, error: 'STALE_BASE' }); await rejected
    expect((f.client as any).documentSnapshot).toBeUndefined()
    expect((f.client as any).authoredPreparation.receiptFor(intended)).toBeUndefined()
    const recovery = f.render(intended), three = await f.next(3)
    expect(three.document).toBe(JSON.stringify(intended))
    expect(three.documentPatch).toBeUndefined(); expect(three.patchBaseReceipt).toBeUndefined()
    f.ack(three, receipt('recovered')); f.finish(three); await recovery
    const drag = f.render(intended, { interactionChannel: true }), four = await f.next(4)
    expect(four.deriveFrom).toEqual(receipt('recovered')); expect(four.document).toBeUndefined()
    f.ack(four, null); f.finish(four); await drag
    expect(intended.nodes[shape.id].opacity).toBe(.25)
    expect((intended as any).unknownRoot).toEqual({ keep: null })
  } finally { f.client.dispose() }
})
test('optional sequential display rejection keeps an acknowledged canvas but not an unacknowledged mutation', async () => {
  const f = await fixture()
  try {
    const first = f.render(), one = await f.next(1); f.ack(one); f.finish(one); await first
    const optional = f.render(f.document, { sequentialViewport: true, livePreview: true, renderIntent: 'preview' })
    const rejected = expect(optional).rejects.toThrow('SEQUENTIAL_DISPLAY_UNSUPPORTED'), two = await f.next(2)
    f.worker.reply({ id: two.id, error: 'SEQUENTIAL_DISPLAY_UNSUPPORTED' }); await rejected
    expect((f.client as any).documentSnapshot).toBe(f.document)
    const fallback = f.render(), three = await f.next(3)
    expect(three.document).toBeUndefined(); expect(three.documentPatch).toBeUndefined()
    f.finish(three); await fallback
    const changed = { ...f.document, name: 'unacknowledged change' }
    const mutation = f.render(changed, { sequentialViewport: true, livePreview: true, renderIntent: 'preview' })
    const failed = expect(mutation).rejects.toThrow('SEQUENTIAL_DISPLAY_UNSUPPORTED'), four = await f.next(4)
    f.worker.reply({ id: four.id, error: 'SEQUENTIAL_DISPLAY_UNSUPPORTED' }); await failed
    expect((f.client as any).documentSnapshot).toBeUndefined()
    const recovery = f.render(changed), five = await f.next(5)
    expect(five.document).toBe(JSON.stringify(changed)); expect(five.documentPatch).toBeUndefined()
    f.ack(five, receipt('recovered')); f.finish(five); await recovery
  } finally { f.client.dispose() }
})
