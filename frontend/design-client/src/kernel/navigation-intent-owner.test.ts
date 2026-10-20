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

import { NavigationIntentOwner, optionalNavigation } from './navigation-intent-owner'
const scope = { livePreview: true, renderIntent: 'preview' }
test('ownership composes caller cancellation and rejects non-navigation/session paths', () => {
  const session={}, owner=new NavigationIntentOwner(session), caller=new AbortController()
  const a=owner.begin(session,{},scope,caller.signal)!, b=owner.begin(session,{},scope)!
  expect(a.signal.aborted).toBe(true);a.settle();caller.abort();expect(b.current()).toBe(true)
  for(const extra of [{livePreview:false},{renderIntent:'canvas'},{tileViewport:{}},{interactionChannel:'interaction'},{retainInteractionGraph:true},{captureViewport:{}},{exportFormat:'png'},{exportRegion:{}},{pixelPreview:true},{png:true},{readback:true}])expect(owner.begin(session,{}, {...scope,...extra})).toBeUndefined()
  expect(owner.begin({}, {}, scope)).toBeUndefined();expect(b.current()).toBe(true)
  owner.reset({});expect(b.signal.aborted).toBe(true);expect(owner.begin(session,{},scope)).toBeUndefined()
  const nextSession={}, composed=new NavigationIntentOwner(nextSession), external=new AbortController()
  const c=composed.begin(nextSession,{},scope,external.signal)!;external.abort();expect(c.signal.aborted).toBe(true)
})
test('request-only supersession preserves accepted mutation ACK and receipt chain',async()=>{
  const f=await fixture(),session={},owner=new NavigationIntentOwner(session)
  try{
    const shape=node('rectangle',0,0,10,10);f.document.nodes[shape.id]=shape;f.document.pages[0].children=[shape.id]
    const a=owner.begin(session,{},scope)!,first=f.render(f.document,scope,a.signal).catch(String),accepted=await f.next(1)
    const b=owner.begin(session,{},scope)!,changed={...f.document,nodes:{...f.document.nodes,[shape.id]:{...shape,opacity:.5}}},last=f.render(changed,scope,b.signal)
    expect(await first).toContain('PREVIEW_CANCELLED')
    await new Promise(resolve=>setTimeout(resolve,10));expect(f.worker.requests()).toHaveLength(1)
    expect(f.worker.messages.filter(x=>x.command?.startsWith('cancel')).map(x=>[x.command,x.requestId])).toEqual([['cancel-request',accepted.id]])
    f.ack(accepted,receipt('1'));const next=await f.next(2)
    expect(next.baseDocumentRevision).toBe(accepted.documentRevision);expect(next.patchBaseReceipt).toEqual(receipt('1'))
    expect(next.documentPatch).toContain('0.5')
    a.settle();expect(b.current()).toBe(true);f.ack(next,receipt('2'));f.finish(next);await last;b.settle();expect(b.current()).toBe(false)
  }finally{f.client.dispose()}
})
