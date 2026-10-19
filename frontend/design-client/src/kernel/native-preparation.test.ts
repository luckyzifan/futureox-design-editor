import { afterEach, expect, test, vi } from 'vitest'
import { blank } from '../model'
import { connectNativePreparation } from './native-preparation'
import { PreparationChannel } from './preparation-channel'
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })
test('a failed native transport is retired and an explicit render retry reloads the full document', async () => {
  let sequence = 0
  const native = { open: vi.fn(async () => String(++sequence)), close: vi.fn(async () => {}),
    request: vi.fn(async (id: string, request: any) => {
      if (id === '1') throw Error('Native preparation worker exited')
      return { id: 1, value: JSON.stringify(request.args[0]) }
    }) }
  class WorkerStub {
    static instances: WorkerStub[] = []
    messages: any[] = []; onmessage?: (event: any) => void
    terminated = false
    constructor() { WorkerStub.instances.push(this) }
    postMessage(value: any) { this.messages.push(value) }
    terminate() { this.terminated = true }
  }
  vi.stubGlobal('window', { coreDesktop: { version: 1, renderPolicy: { cpuOnly: true }, preparation: native } })
  vi.stubGlobal('Worker', WorkerStub)
  const { KernelClient } = await import('./client')
  const client = new KernelClient(), doc = blank()
  const options = { pageId: doc.pages[0].id, width: 20, height: 20, view: { x: 0, y: 0, zoom: 1 }, grid: false, transparent: false }
  try {
    await expect(client.render(doc, options, false, 'cpu')).rejects.toThrow('worker exited')
    expect(WorkerStub.instances[0].terminated).toBe(true)
    expect(native.open).toHaveBeenCalledTimes(1)
    expect(native.request).toHaveBeenCalledTimes(1)
    const retry = client.render(doc, options, false, 'cpu')
    await vi.waitFor(() => expect(WorkerStub.instances[1].messages.filter(m => m.id)).toHaveLength(1))
    const message = WorkerStub.instances[1].messages.find(m => m.id)
    expect(message.document).toBe(JSON.stringify(doc))
    expect(message.documentPatch).toBeUndefined()
    WorkerStub.instances[1].onmessage?.({ data: { id: message.id, backend: 'cpu', milliseconds: 0, stats: { nodes: 0 } } })
    await retry
    expect(native.close).toHaveBeenCalledWith('1')
  } finally { client.dispose() }
})
test('native transport preserves request IDs and binary replies and closes an opening session', async () => {
  const pair = new MessageChannel(), channel = new PreparationChannel(pair.port2)
  const close = vi.fn(async () => {})
  const bridge = { open: async () => 'owned', close, request: vi.fn(async (_session, request) => ({ id: 99,
    value: request.method === 'serialize' ? JSON.stringify(request.args[0]) : new Uint8Array([70,71,80,75]) })) }
  const connection = connectNativePreparation(bridge, pair.port1)
  try {
    expect((await channel.request('canvas','compile_gpu_packet',['{}'])).value).toEqual(new Uint8Array([70,71,80,75]))
    const input = { name: '中文', nodes: {} }
    expect(await connection.serialize(input)).toBe(JSON.stringify(input))
    expect(bridge.request.mock.calls.at(-1)![1].args[0]).toBe(input)
  } finally { connection.close(); channel.close() }
  await vi.waitFor(() => expect(close).toHaveBeenCalledWith('owned'))
})
test('desktop serialization cannot reorder document revisions or wait for rendering to complete', async () => {
  let firstResolve!: (value: string) => void
  let first = true
  const native = { open: async () => 'owned', close: vi.fn(async () => {}), request: vi.fn(async (_id, request) => {
    if (request.method !== 'serialize') return { id: 1 }
    const value = first ? await new Promise<string>(resolve => { firstResolve=resolve }) : JSON.stringify(request.args[0])
    first=false;return { id:1,value }
  }) }
  class WorkerStub {
    static instance: WorkerStub
    messages: any[]=[]; onmessage?: (event:any)=>void
    constructor(){WorkerStub.instance=this}
    postMessage(value:any){this.messages.push(value)}
    terminate(){}
  }
  vi.stubGlobal('window',{coreDesktop:{version:1,renderPolicy:{cpuOnly:true},preparation:native}})
  vi.stubGlobal('Worker',WorkerStub)
  const {KernelClient}=await import('./client')
  const client=new KernelClient(), doc=blank(), next={...doc,name:'Next'}
  const options={pageId:doc.pages[0].id,width:20,height:20,view:{x:0,y:0,zoom:1},grid:false,transparent:false}
  try {
    const a=client.render(doc,options,false,'cpu'), b=client.render(next,options,false,'cpu')
    await vi.waitFor(()=>expect(firstResolve).toBeTypeOf('function'))
    expect(WorkerStub.instance.messages.filter(m=>m.id)).toHaveLength(0)
    firstResolve(JSON.stringify(doc))
    await vi.waitFor(()=>expect(WorkerStub.instance.messages.filter(m=>m.id)).toHaveLength(2))
    const [one,two]=WorkerStub.instance.messages.filter(m=>m.id)
    expect(one.document).toBe(JSON.stringify(doc));expect(two.documentPatch).toBeTruthy()
    expect(two.baseDocumentRevision).toBe(one.documentRevision)
    for(const message of [one,two])WorkerStub.instance.onmessage?.({data:{id:message.id,backend:'cpu',milliseconds:0,stats:{nodes:0}}})
    await Promise.all([a,b])
    let finishEncoding!: (value:any)=>void
    native.request.mockImplementationOnce(async()=>await new Promise(resolve=>{finishEncoding=resolve}))
    const stale={...next,name:'Cancelled before dispatch'}
    const cancelled=client.render(stale,{...options,livePreview:true},false,'cpu')
    const rejection=expect(cancelled).rejects.toThrow('PREVIEW_CANCELLED')
    await vi.waitFor(()=>expect(finishEncoding).toBeTypeOf('function'))
    client.cancelPreview()
    finishEncoding({id:3,value:JSON.stringify(stale)})
    await rejection
    expect(WorkerStub.instance.messages.filter(m=>m.id)).toHaveLength(2)
    const current=client.render(next,options,false,'cpu')
    await vi.waitFor(()=>expect(WorkerStub.instance.messages.filter(m=>m.id)).toHaveLength(3))
    const last=WorkerStub.instance.messages.filter(m=>m.id).at(-1)
    expect(last.documentRevision).toBe(two.documentRevision)
    WorkerStub.instance.onmessage?.({data:{id:last.id,backend:'cpu',milliseconds:0,stats:{nodes:0}}})
    await current
  }finally{client.dispose()}
})
