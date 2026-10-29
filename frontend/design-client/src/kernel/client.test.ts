import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { KernelClient, backendPreference } from './client'
import { blank } from '../model'
class WorkerStub {
  static instances: WorkerStub[] = []
  messages: {
    id: number
    command?: string
    document?: string
    sourceSnapshot?: {token:string;nodes:number}
    documentPatch?: string
    baseDocumentRevision?: number
    documentRevision: number
  }[] = []
  onmessage?: (event: { data: unknown }) => void
  onerror?: unknown
  constructor() {
    WorkerStub.instances.push(this)
  }
  postMessage(value: (typeof this.messages)[number]) {
    this.messages.push(value)
  }
  terminate() {}
  reply(index: number, error?: string) {
    this.onmessage?.({
      data: {
        id: this.messages[index].id,
        error,
        backend: 'cpu',
        milliseconds: 0,
        stats: { nodes: 0 },
      },
    })
  }
}

test.each(['auto', 'cpu', 'webgl2'])('legacy %s preference does not change the default WebGPU canvas', value => {
  vi.stubGlobal('localStorage', { getItem: () => value })
  expect(backendPreference()).toBe('webgpu')
})

test('GPU contention parks an idle device while preserving its worker document revision', async () => {
  const clients = [new KernelClient(), new KernelClient(), new KernelClient()]
  const doc = blank(), options = { pageId: doc.pages[0].id, width: 20, height: 20,
    view: { x: 0, y: 0, zoom: 1 }, transparent: false, grid: false }
  try {
    for (let i = 0; i < 2; i++) {
      const result = clients[i].render(doc, options, false, 'webgpu')
      WorkerStub.instances[i].reply(0); await result
    }
    const third = clients[2].render(doc, options, false, 'webgpu')
    expect(WorkerStub.instances[0].messages[1].command).toBe('park-gpu')
    expect(WorkerStub.instances[2].messages).toHaveLength(0)
    WorkerStub.instances[0].reply(1)
    await vi.waitFor(() => expect(WorkerStub.instances[2].messages).toHaveLength(1))
    WorkerStub.instances[2].reply(0); await third
    const resumed = clients[0].render(doc, { ...options, view: { ...options.view, x: 10 } }, false, 'webgpu')
    expect(WorkerStub.instances[1].messages[1].command).toBe('park-gpu')
    WorkerStub.instances[1].reply(1)
    await vi.waitFor(() => expect(WorkerStub.instances[0].messages).toHaveLength(3))
    expect(WorkerStub.instances).toHaveLength(3)
    expect(WorkerStub.instances[0].messages[2].document).toBeUndefined()
    expect(WorkerStub.instances[0].messages[2].documentRevision).toBe(WorkerStub.instances[0].messages[0].documentRevision)
    WorkerStub.instances[0].reply(2); await resumed
  } finally { clients.forEach(client => client.dispose()) }
})
beforeEach(() => {
  WorkerStub.instances = []
  vi.stubGlobal('Worker', WorkerStub)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
test('native source rendering never serializes or transfers the full source document',async()=>{
 const client=new KernelClient(),source={owner:{documentId:'source',sessionEpoch:1},revision:0,token:'source-token',nodes:124447,pageId:'page',stageId:'stage'}
 const options={pageId:'page',width:64,height:64,view:{x:0,y:0,zoom:1},transparent:false,grid:false}
 try{
  const first=client.renderSource(source,options);const worker=WorkerStub.instances[0]
  expect(worker.messages[0].document).toBeUndefined();expect(worker.messages[0].documentPatch).toBeUndefined()
  expect(worker.messages[0].sourceSnapshot).toEqual(source);const revision=worker.messages[0].documentRevision
  worker.reply(0);await first
  const pan=client.renderSource(source,{...options,view:{x:10,y:0,zoom:1}})
  expect(worker.messages[1].sourceSnapshot).toEqual(source);expect(worker.messages[1].documentRevision).toBe(revision)
  worker.reply(1);await pan
  const next=client.renderSource({...source,revision:1,token:'new-source-token'},options)
  expect(worker.messages[2].documentRevision).toBe(revision+1);worker.reply(2);await next
  await expect(client.render(blank(),options)).rejects.toThrow('native snapshot renderer')
 }finally{client.dispose()}
})
test('a timed-out worker is replaced on the next request and the whole snapshot is resent', async () => {
  vi.useFakeTimers()
  const client = new KernelClient(),
    doc = blank(),
    options = {
      pageId: doc.pages[0].id,
      width: 20,
      height: 20,
      view: { x: 0, y: 0, zoom: 1 },
      transparent: false,
      grid: false,
    }
  const first = client.render(doc, options, false, 'cpu')
  const rejection = expect(first).rejects.toThrow('导出渲染超时')
  await vi.advanceTimersByTimeAsync(30000)
  await rejection
  const next = client.render(doc, options, false, 'cpu')
  expect(WorkerStub.instances).toHaveLength(2)
  const replacement = WorkerStub.instances[1]
  expect(replacement.messages[0].document).toBe(JSON.stringify(doc))
  replacement.reply(0)
  await next
  client.dispose()
  await expect(client.render(doc, options)).rejects.toThrow('已关闭')
})

test('a full native source can outlive the preview deadline and still cancel without publishing a late tile',async()=>{
 vi.useFakeTimers()
 const client=new KernelClient(),worker=WorkerStub.instances[0],controller=new AbortController(),progress=vi.fn()
 const source={owner:{documentId:'source',sessionEpoch:1},revision:0,token:'source-token',nodes:124447,pageId:'page',stageId:'stage'}
 const options={pageId:'page',width:64,height:64,view:{x:0,y:0,zoom:1},transparent:false,grid:false,tileViewport:[],renderIntent:'preview' as const}
 try{
  const job=client.renderSource(source,options,progress,controller.signal)
  await vi.advanceTimersByTimeAsync(60000)
  worker.onmessage?.({data:{id:worker.messages[0].id,workProgress:1,workStage:1}})
  await vi.advanceTimersByTimeAsync(180000)
  expect(WorkerStub.instances).toHaveLength(1);expect(progress).not.toHaveBeenCalled()
  const rejected=expect(job).rejects.toThrow('PREVIEW_CANCELLED');controller.abort();await rejected
  worker.onmessage?.({data:{id:worker.messages[0].id,tile:{key:'late'}}});expect(progress).not.toHaveBeenCalled()
  const next=client.renderSource(source,options);worker.reply(worker.messages.length-1);await next
 }finally{client.dispose()}
})

test('completed subregions keep queued previews alive without publishing an incomplete tile', async () => {
  vi.useFakeTimers()
  const client=new KernelClient(),worker=WorkerStub.instances[0],doc=blank(),progress=vi.fn()
  const options={pageId:doc.pages[0].id,width:20,height:20,view:{x:0,y:0,zoom:1},transparent:false,grid:false,tileViewport:[]}
  const first=client.render(doc,options,false,'cpu',false,false,undefined,progress)
  const second=client.render(doc,{...options,view:{x:10,y:0,zoom:1}},false,'cpu')
  for(let sequence=1;sequence<=3;sequence++){
    await vi.advanceTimersByTimeAsync(20000)
    worker.onmessage?.({data:{id:worker.messages[0].id,rasterProgress:sequence}})
  }
  expect(progress).not.toHaveBeenCalled()
  expect(WorkerStub.instances).toHaveLength(1)
  worker.reply(0);worker.reply(1);await first;await second;client.dispose()
})

test('duplicate progress does not hide a stalled preview and late progress cannot revive it', async () => {
  vi.useFakeTimers()
  const client=new KernelClient(),worker=WorkerStub.instances[0],doc=blank()
  const pending=client.render(doc,{pageId:doc.pages[0].id,width:20,height:20,view:{x:0,y:0,zoom:1},transparent:false,grid:false,tileViewport:[]},false,'cpu')
  const rejected=expect(pending).rejects.toThrow('预览超时')
  worker.onmessage?.({data:{id:worker.messages[0].id,rasterProgress:1}})
  await vi.advanceTimersByTimeAsync(20000)
  worker.onmessage?.({data:{id:worker.messages[0].id,rasterProgress:1}})
  await vi.advanceTimersByTimeAsync(10000);await rejected
  worker.onmessage?.({data:{id:worker.messages[0].id,rasterProgress:2}})
  client.dispose()
})

test('real compiler and encoding milestones keep active previews alive without publishing pixels',async()=>{
 vi.useFakeTimers()
 const client=new KernelClient(),worker=WorkerStub.instances[0],doc=blank(),progress=vi.fn()
 const pending=client.render(doc,{pageId:doc.pages[0].id,width:20,height:20,view:{x:0,y:0,zoom:1},transparent:false,grid:false,tileViewport:[]},false,'cpu',false,false,undefined,progress)
 try{
  await vi.advanceTimersByTimeAsync(20000)
  worker.onmessage?.({data:{id:worker.messages[0].id,workProgress:1,workStage:1}})
  await vi.advanceTimersByTimeAsync(20000)
  worker.onmessage?.({data:{id:worker.messages[0].id,workProgress:2,workStage:2,drawCalls:97000}})
  await vi.advanceTimersByTimeAsync(20000)
  expect(progress).not.toHaveBeenCalled();expect(WorkerStub.instances).toHaveLength(1)
  worker.reply(0);await pending
 }finally{client.dispose()}
})

test('duplicate or invalid work milestones do not conceal a stalled graph',async()=>{
 vi.useFakeTimers()
 const client=new KernelClient(),worker=WorkerStub.instances[0],doc=blank()
 const pending=client.render(doc,{pageId:doc.pages[0].id,width:20,height:20,view:{x:0,y:0,zoom:1},transparent:false,grid:false,tileViewport:[]},false,'cpu')
 const rejected=expect(pending).rejects.toThrow('预览超时')
 worker.onmessage?.({data:{id:worker.messages[0].id,workProgress:1,workStage:1}})
 await vi.advanceTimersByTimeAsync(20000)
 for(const fields of [{workProgress:1,workStage:1},{workProgress:2,workStage:2,drawCalls:0},{workProgress:2,workStage:7},{workProgress:NaN,workStage:1}])
  worker.onmessage?.({data:{id:worker.messages[0].id,...fields}})
 await vi.advanceTimersByTimeAsync(10000);await rejected;client.dispose()
})

test('preparation failures reject work and retire both workers before resending the document', async () => {
  vi.stubGlobal('navigator', { gpu: {} })
  const client = new KernelClient(), doc = blank()
  const options = { pageId: doc.pages[0].id, width: 20, height: 20, view: { x: 0, y: 0, zoom: 1 }, transparent: false, grid: false }
  try {
    const [render, prepare] = WorkerStub.instances
    expect(render.messages[0].command).toBe('prepare-port')
    const stopRender = vi.spyOn(render, 'terminate'), stopPrepare = vi.spyOn(prepare, 'terminate')
    const pending = client.render(doc, options, false, 'cpu')
    const rejected = expect(pending).rejects.toThrow('preparation crashed')
    ;(prepare.onerror as (event: { message: string }) => void)({ message: 'preparation crashed' })
    await rejected
    expect(stopRender).toHaveBeenCalledOnce(); expect(stopPrepare).toHaveBeenCalledOnce()
    const retry = client.render(doc, options, false, 'cpu')
    expect(WorkerStub.instances).toHaveLength(4)
    const replacement = WorkerStub.instances[2]
    expect(replacement.messages[0].command).toBe('prepare-port')
    expect(replacement.messages[1].document).toBe(JSON.stringify(doc))
    replacement.reply(1); await retry
  } finally {
    client.dispose()
    // Stub workers do not transfer ownership of MessagePorts like real workers.
    for (const worker of WorkerStub.instances) for (const message of worker.messages)
      (message as unknown as {port?:MessagePort}).port?.close()
  }
})
test('camera requests reuse a revision, while edits and undo send versioned patches', async () => {
  const client = new KernelClient(),
    worker = WorkerStub.instances[0],
    doc = blank(),
    options = {
      pageId: doc.pages[0].id,
      width: 20,
      height: 20,
      view: { x: 0, y: 0, zoom: 1 },
      transparent: false,
      grid: false,
    }
  const first = client.render(doc, options, false, 'cpu')
  worker.reply(0)
  await first
  const pan = client.render(doc, { ...options, view: { x: 10, y: 0, zoom: 1 } }, false, 'cpu')
  worker.reply(1)
  await pan
  expect(worker.messages[0].document).toBe(JSON.stringify(doc))
  expect(worker.messages[1].document).toBeUndefined()
  expect(worker.messages[1].documentRevision).toBe(worker.messages[0].documentRevision)
  const changed = { ...doc, name: 'edited' },
    edit = client.render(changed, options, false, 'cpu')
  worker.reply(2)
  await edit
  const undo = client.render(doc, options, false, 'cpu')
  worker.reply(3)
  await undo
  expect(worker.messages[2].document).toBeUndefined()
  expect(JSON.parse(worker.messages[2].documentPatch!).fields).toEqual({ name: 'edited' })
  expect(JSON.parse(worker.messages[3].documentPatch!).fields).toEqual({ name: doc.name })
  expect(worker.messages[2].baseDocumentRevision).toBe(worker.messages[1].documentRevision)
  expect(worker.messages[3].documentRevision).toBeGreaterThan(worker.messages[2].documentRevision)
  client.dispose()
})

test('camera batch cancellation keeps completed tile progress and the synchronized revision', async () => {
  const client=new KernelClient(),worker=WorkerStub.instances[0],doc=blank(),progress=vi.fn()
  const options={pageId:doc.pages[0].id,width:20,height:20,view:{x:0,y:0,zoom:1},grid:false,transparent:false,tileViewport:[]}
  const first=client.render(doc,options,false,'cpu',false,false,undefined,progress)
  const rejected=expect(first).rejects.toThrow('PREVIEW_CANCELLED')
  client.cancelTileFill()
  expect(worker.messages[1].command).toBe('cancel-tile-fill')
  worker.onmessage?.({data:{id:worker.messages[0].id,tile:{key:'finished',width:1,height:1,x:0,y:0,zoom:1},buffer:new ArrayBuffer(4)}})
  expect(progress).toHaveBeenCalledTimes(1)
  worker.reply(0,'PREVIEW_CANCELLED');await rejected
  const next=client.render(doc,options,false,'cpu')
  expect(worker.messages[2].document).toBeUndefined()
  expect(worker.messages[2].documentRevision).toBe(worker.messages[0].documentRevision)
  worker.reply(2);await next
  client.dispose()
})
test('a rejected snapshot is resent rather than reusing an unsynchronized revision', async () => {
  const client = new KernelClient(),
    worker = WorkerStub.instances[0],
    doc = blank(),
    options = {
      pageId: doc.pages[0].id,
      width: 20,
      height: 20,
      view: { x: 0, y: 0, zoom: 1 },
      transparent: false,
      grid: false,
    }
  const fail = client.render(doc, options, false, 'cpu')
  worker.reply(0, 'invalid document')
  await expect(fail).rejects.toThrow('invalid document')
  const retry = client.render(doc, options, false, 'cpu')
  expect(worker.messages[1].document).toBe(JSON.stringify(doc))
  worker.reply(1)
  await retry
  client.dispose()
})


test('cancel fences in-flight preview progress and success while a non-preview request survives', async () => {
  const client=new KernelClient(),worker=WorkerStub.instances[0],doc=blank(),progress=vi.fn()
  const options={pageId:doc.pages[0].id,width:20,height:20,view:{x:0,y:0,zoom:1},transparent:false,grid:false}
  const preview=client.render(doc,{...options,tileViewport:[{key:'tile',x:0,y:0,width:20,height:20,zoom:1}]},false,'webgpu',true,false,undefined,progress)
  const rejection=expect(preview).rejects.toThrow('PREVIEW_CANCELLED')
  const ordinary=client.render(doc,options,false,'cpu')
  client.cancelPreview()
  worker.onmessage?.({data:{id:worker.messages[0].id,tile:{},buffer:new Uint8Array(4).buffer}})
  worker.reply(0)
  await rejection
  expect(progress).not.toHaveBeenCalled()
  worker.reply(1)
  await expect(ordinary).resolves.toHaveProperty('backend','cpu')
  client.dispose()
})

test('a progress callback failure retains its own error when other previews are canceled', async () => {
  const client=new KernelClient(),worker=WorkerStub.instances[0],doc=blank()
  const options={pageId:doc.pages[0].id,width:20,height:20,view:{x:0,y:0,zoom:1},transparent:false,grid:false,livePreview:true}
  const result=client.render(doc,options,false,'webgpu',true,false,undefined,()=>{throw Error('consumer failed')})
  const rejection=expect(result).rejects.toThrow('consumer failed')
  worker.onmessage?.({data:{id:worker.messages[0].id,tile:{},buffer:new Uint8Array(4).buffer}})
  await rejection
  client.dispose()
})

test('settled and interaction lanes keep independent snapshots and cancellation fences', async () => {
  const client=new KernelClient(),worker=WorkerStub.instances[0],doc=blank()
  const options={pageId:doc.pages[0].id,width:20,height:20,view:{x:0,y:0,zoom:1},transparent:false,grid:false,livePreview:true}
  try {
    const settled=client.render(doc,options,false,'cpu'),rejected=expect(settled).rejects.toThrow('PREVIEW_CANCELLED')
    const moving=client.render({...doc,name:'transient'}, {...options,interactionChannel:true},false,'cpu')
    client.cancelPreview()
    await rejected
    expect(worker.messages[1].document).toBeDefined()
    expect(worker.messages[1].documentRevision).toBe(1)
    worker.reply(1);await moving
    const resumed=client.render(doc,options,false,'cpu')
    expect(worker.messages[3].document).toBeUndefined()
    expect(worker.messages[3].documentPatch).toBeUndefined()
    expect(worker.messages[3].documentRevision).toBe(1)
    worker.reply(3);await resumed
  } finally {client.dispose()}
})

test('cancelled GPU handles are returned to their owner instead of leaking display textures', async () => {
  const client=new KernelClient(),worker=WorkerStub.instances[0],doc=blank()
  const options={pageId:doc.pages[0].id,width:20,height:20,view:{x:0,y:0,zoom:1},transparent:false,grid:false,livePreview:true}
  const pending=client.render(doc,options,false,'cpu'),rejected=expect(pending).rejects.toThrow('PREVIEW_CANCELLED')
  client.cancelPreview();await rejected
  worker.onmessage?.({data:{id:worker.messages[0].id,gpuTile:1234}})
  expect(worker.messages.at(-1)).toMatchObject({command:'display-release',ids:[1234]})
  client.dispose()
})

test('a pixel budget rejection does not reload an already synchronized document',async()=>{
  const client=new KernelClient(),worker=WorkerStub.instances[0],doc=blank()
  const options={pageId:doc.pages[0].id,width:20,height:20,view:{x:0,y:0,zoom:1},transparent:false,grid:false,livePreview:true}
  try{
    const failed=client.render(doc,options,false,'cpu')
    worker.reply(0,'PREVIEW_BUDGET: GPU 表面内存预算超限')
    await expect(failed).rejects.toThrow('PREVIEW_BUDGET')
    const next=client.render(doc,{...options,width:10,height:10},false,'cpu')
    expect(worker.messages[1].document).toBeUndefined()
    expect(worker.messages[1].documentRevision).toBe(worker.messages[0].documentRevision)
    worker.reply(1);await next
  }finally{client.dispose()}
})

test('accepted Canvas input correlates with client stage2 without changing display command payload', async () => {
  const { recordNavigationInput } = await import('./navigation-input')
  const client = new KernelClient(), owner = {}, view = { x: 13, y: -21, zoom: 2 }
  const unbind = client.bindNavigationInput(owner)
  try {
    const start = client.navigationCapture('start', { capacity: 16, durationMs: 1000 })
    WorkerStub.instances[0].reply(0); await start
    recordNavigationInput(owner, { deltaX: 0, deltaY: -69.314718, deltaMode: 0 }, { width: 100, height: 100 }, view, true)
    const frame = { view, width: 100, height: 100, dpr: 1, items: [] }
    client.present(frame)
    const sent = WorkerStub.instances[0].messages[1] as unknown as Record<string, unknown>
    expect(sent).toEqual({ command: 'display-frame', sequence: 1, frame })
    const snapshot = client.navigationCapture('snapshot')
    WorkerStub.instances[0].reply(2)
    const report = (await snapshot).main.events.filter(event => event.stage === 1 || event.stage === 2)
    expect(report.map(event => event.stage)).toEqual([1, 2])
    expect(report[1].inputSequence).toBe(report[0].inputSequence)
    expect(report[1].inputAt).toBe(report[0].inputAt)
    expect(report[1].inputAgeMs).toBeGreaterThanOrEqual(0)
  } finally { unbind(); client.dispose() }
})

test('capture cancellation targets only its request and preserves sibling owner, revision chain and export', async () => {
  const client = new KernelClient(), doc = blank(), first = new AbortController(), sibling = new AbortController()
  const options = { pageId: doc.pages[0].id, width: 20, height: 20, view: { x: 0, y: 0, zoom: 1 }, transparent: false, grid: false, livePreview: true, renderIntent: 'preview' as const, interactionChannel: true }
  try {
    const a = client.render(doc, options, false, 'cpu', false, false, undefined, undefined, first.signal)
    const rejection = expect(a).rejects.toThrow('PREVIEW_CANCELLED')
    const b = client.render(doc, options, false, 'cpu', false, false, undefined, undefined, sibling.signal)
    const w = WorkerStub.instances[0]
    first.abort(); await rejection
    expect(w.messages.filter(m => m.command === 'cancel-request')).toEqual([expect.objectContaining({ requestId: w.messages[0].id })])
    expect(w.messages.some(m => m.command === 'cancel-preview')).toBe(false)
    expect(w.messages[1].document).toBeUndefined()
    expect(w.messages[1].documentRevision).toBe(w.messages[0].documentRevision)
    w.reply(1); await b
    const exportAbort = new AbortController()
    const exact = client.render(doc, options, true, 'cpu', true, false, undefined, undefined, exportAbort.signal)
    const index = w.messages.length - 1
    exportAbort.abort()
    expect(w.messages.filter(m => m.command === 'cancel-request')).toHaveLength(1)
    w.reply(index); await exact
  } finally { client.dispose() }
})

test('completed capture removes abort listener and later abort sends no cancellation', async () => {
  const client = new KernelClient(), doc = blank(), controller = new AbortController()
  const removed = vi.spyOn(controller.signal, 'removeEventListener')
  const options = { pageId: doc.pages[0].id, width: 20, height: 20, view: { x: 0, y: 0, zoom: 1 }, transparent: false, grid: false, livePreview: true, renderIntent: 'preview' as const, interactionChannel: true }
  try {
    const result = client.render(doc, options, false, 'cpu', false, false, undefined, undefined, controller.signal)
    const w = WorkerStub.instances[0]; w.reply(0); await result
    expect(removed).toHaveBeenCalledOnce()
    controller.abort(); controller.abort()
    expect(w.messages.some(m => m.command === 'cancel-request')).toBe(false)
  } finally { client.dispose() }
})
