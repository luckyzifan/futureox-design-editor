import { expect, test } from 'vitest'
import { VectorEngine } from '../generated/design-kernel/design_kernel'
import { blank } from '../model'
import { PreparationChannel } from './preparation-channel'
import { RenderKernel } from './render-kernel'

// Deliberately adversarial transport for cache revision race tests. Production
// PreparationChannel now fences physical jobs, just like the serial worker;
// these tests must still cover late/out-of-order replies independently of it.
function unorderedPreparation(port: MessagePort): PreparationChannel {
  let id = 0
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()
  port.onmessage = event => {
    const reply = event.data, waiter = pending.get(reply.id)
    if (!waiter) return
    pending.delete(reply.id)
    if (reply.error) waiter.reject(new Error(reply.error)); else waiter.resolve(reply)
  }
  port.start()
  return { request(lane: string, method: string, args: unknown[]) {
    const key = ++id
    return new Promise((resolve, reject) => { pending.set(key, { resolve, reject }); port.postMessage({ id: key, lane, method, args }) })
  }, close() { port.close(); for (const p of pending.values()) p.reject(new Error('closed')); pending.clear() } } as unknown as PreparationChannel
}


test('remote managed documents synchronize a valid image-decoder color space and restore unmanaged state', async () => {
  const remote = new VectorEngine(), assets = new VectorEngine(), ports = new MessageChannel()
  const channel = new PreparationChannel(ports.port1), kernel = new RenderKernel(assets, 'canvas', channel)
  ports.port2.onmessage = event => {
    const { id, method, args } = event.data
    try {
      if (method === 'load_document') remote.load_document(args[0])
      ports.port2.postMessage({ id, settings: remote.color_settings() })
    } catch (error) { ports.port2.postMessage({ id, error: String(error) }) }
  }
  try {
    const managed = { ...blank(), schemaVersion: 3, rasterProfile: 'figma',
      colorManagement: { documentSpace: 'display-p3', referenceWhiteNits: 203, peakLuminanceNits: 1000 } }
    await kernel.load_document(JSON.stringify(managed))
    expect(JSON.parse(assets.color_settings())).toEqual(managed.colorManagement)
    expect(kernel.color_settings()).toBe(remote.color_settings())
    await kernel.load_document(JSON.stringify(blank()))
    expect(assets.color_settings()).toBe('null'); expect(kernel.color_settings()).toBe('null')
  } finally { channel.close(); ports.port2.close(); remote.free(); assets.free() }
})

test('packet reuse is byte-exact, privately owned and invalidated by document changes',async()=>{
  const remote=new VectorEngine(),assets=new VectorEngine(),ports=new MessageChannel()
  const channel=new PreparationChannel(ports.port1),kernel=new RenderKernel(assets,'canvas',channel)
  let compilations=0
  ports.port2.onmessage=event=>{
    const {id,method,args}=event.data
    try{
      let value:Uint8Array|undefined
      if(method==='load_document')remote.load_document(args[0])
      if(method==='compile_gpu_packet'){compilations++;value=remote.compile_gpu_packet(args[0])}
      ports.port2.postMessage({id,value,settings:remote.color_settings()},value?[value.buffer]:[])
    }catch(error){ports.port2.postMessage({id,error:String(error)})}
  }
  try{
    const document=blank();await kernel.load_document(JSON.stringify(document))
    const options=JSON.stringify({pageId:document.pages[0].id,width:32,height:32,view:{x:.25,y:.5,zoom:1},transparent:false,grid:false})
    const first=await kernel.compile_gpu_packet(options),reference=first.slice();first[0]=0
    expect(await kernel.compile_gpu_packet(options)).toEqual(reference);expect(compilations).toBe(1)
    document.pages[0].background='#123456';await kernel.load_document(JSON.stringify(document))
    expect(await kernel.compile_gpu_packet(options)).not.toEqual(reference);expect(compilations).toBe(2)
  }finally{channel.close();ports.port2.close();remote.free();assets.free()}
})

test('pending patches bypass old cache hits and late compiles cannot repopulate a newer revision',async()=>{
  const remote=new VectorEngine(),assets=new VectorEngine(),ports=new MessageChannel()
  const channel=unorderedPreparation(ports.port1),kernel=new RenderKernel(assets,'canvas',channel)
  let hold=false,release:(()=>void)|undefined,notice:(()=>void)|undefined,compiles=0
  ports.port2.onmessage=event=>{
    const {id,method,args}=event.data
    try{
      let value:unknown
      if(method==='load_document')remote.load_document(args[0])
      if(method==='compile_gpu_packet'){compiles++;value=remote.compile_gpu_packet(args[0])}
      if(method==='apply_document_patch_with_damage')value=remote.apply_document_patch_with_damage(args[0])
      const send=()=>ports.port2.postMessage({id,value,settings:remote.color_settings()},value instanceof Uint8Array?[value.buffer]:[])
      if(hold&&method==='compile_gpu_packet'){hold=false;release=send;notice?.()}else send()
    }catch(error){ports.port2.postMessage({id,error:String(error)})}
  }
  try{
    const doc=blank();await kernel.load_document(JSON.stringify(doc))
    const options=JSON.stringify({pageId:doc.pages[0].id,width:32,height:32,view:{x:0,y:0,zoom:1}})
    hold=true;const reached=new Promise<void>(resolve=>notice=resolve)
    const old=kernel.compile_gpu_packet(options);await reached
    const patch=kernel.apply_document_patch_with_damage(JSON.stringify({fields:{name:'renamed'},nodes:{}}))
    await patch;release!();await old
    await kernel.compile_gpu_packet(options);expect(compiles).toBe(2)
    await kernel.compile_gpu_packet(options);expect(compiles).toBe(2)
    // Failure revokes any proof too, even when the worker rejects atomically.
    await expect(kernel.apply_document_patch_with_damage('{broken')).rejects.toThrow()
    await kernel.compile_gpu_packet(options);expect(compiles).toBe(3)
  }finally{channel.close();ports.port2.close();remote.free();assets.free()}
})

test('concurrent identical compiles share work, never transferable ownership, and failures can retry', async () => {
  const assets = new VectorEngine(), ports = new MessageChannel()
  const channel = new PreparationChannel(ports.port1), kernel = new RenderKernel(assets, 'canvas', channel)
  let compilations = 0, fail = false
  ports.port2.onmessage = event => {
    const { id, method } = event.data
    if (method !== 'compile_gpu_packet') { ports.port2.postMessage({ id }); return }
    compilations++
    const value = new Uint8Array([17, 33, 55])
    ports.port2.postMessage(fail ? { id, error: 'compile rejected' } : { id, value }, fail ? [] : [value.buffer])
  }
  try {
    const a = kernel.compile_gpu_packet('{}').then(bytes => {
      // A caller can transfer immediately, before other waiters resume.
      return structuredClone(bytes, { transfer: [bytes.buffer] })
    })
    const [first, second, third] = await Promise.all([a, kernel.compile_gpu_packet('{}'), kernel.compile_gpu_packet('{}')])
    expect(compilations).toBe(1); expect(kernel.packetCoalesced).toBe(2)
    expect(first).toEqual(second); expect(second).toEqual(third)
    expect(first.buffer).not.toBe(second.buffer); expect(second.buffer).not.toBe(third.buffer)
    second[0] = 0; expect(third[0]).toBe(17)
    await kernel.load_document('{}'); fail = true
    const rejected = await Promise.allSettled([kernel.compile_gpu_packet('{}'), kernel.compile_gpu_packet('{}')])
    expect(rejected.every(result => result.status === 'rejected')).toBe(true); expect(compilations).toBe(2)
    fail = false; expect(await kernel.compile_gpu_packet('{}')).toEqual(first); expect(compilations).toBe(3)
  } finally { channel.close(); ports.port2.close(); assets.free() }
})

test('completion from an old revision cannot remove or share the newer in-flight packet', async () => {
  const assets = new VectorEngine(), ports = new MessageChannel()
  const channel = unorderedPreparation(ports.port1), kernel = new RenderKernel(assets, 'canvas', channel)
  const requests: (() => void)[] = []
  let notice: (() => void) | undefined, compilations = 0
  ports.port2.onmessage = event => {
    const { id, method } = event.data
    if (method !== 'compile_gpu_packet') { ports.port2.postMessage({ id }); return }
    const value = new Uint8Array([++compilations])
    requests.push(() => ports.port2.postMessage({ id, value }, [value.buffer])); notice?.()
  }
  const arrived = () => new Promise<void>(resolve => notice = resolve)
  try {
    let event = arrived(); const old = kernel.compile_gpu_packet('{}'); await event
    await kernel.load_document('{}')
    event = arrived(); const current = kernel.compile_gpu_packet('{}'); await event
    requests[0](); expect(await old).toEqual(new Uint8Array([1]))
    const join = kernel.compile_gpu_packet('{}')
    requests[1](); expect(await current).toEqual(new Uint8Array([2])); expect(await join).toEqual(new Uint8Array([2]))
    expect(compilations).toBe(2)
    expect(await kernel.compile_gpu_packet('{}')).toEqual(new Uint8Array([2]))
  } finally { channel.close(); ports.port2.close(); assets.free() }
})

test('cancelling one packet waiter neither cancels exact output nor waits for a shared compile', async () => {
  const assets = new VectorEngine(), ports = new MessageChannel()
  const channel = new PreparationChannel(ports.port1), kernel = new RenderKernel(assets, 'canvas', channel)
  const requests: any[] = []
  ports.port2.onmessage = event => requests.push(event.data)
  const waitFor = async (count: number) => { while (requests.length < count) await new Promise(resolve => setTimeout(resolve, 1)) }
  try {
    const exact = kernel.compile_gpu_packet('{}')
    await waitFor(1)
    const controller = new AbortController()
    const preview = kernel.compile_gpu_packet('{}', controller.signal)
    const cancelled = expect(preview).rejects.toThrow('PREVIEW_CANCELLED')
    controller.abort()
    ports.port2.postMessage({ id: requests[0].id, value: new Uint8Array([7]) })
    await cancelled
    expect(await exact).toEqual(new Uint8Array([7]))
  } finally { channel.close(); ports.port2.close(); assets.free() }
})

test('a cancellable first consumer never owns an exact output sharing its options', async () => {
  const assets = new VectorEngine(), ports = new MessageChannel()
  const channel = new PreparationChannel(ports.port1), kernel = new RenderKernel(assets, 'canvas', channel)
  const requests: any[] = []
  ports.port2.onmessage = event => requests.push(event.data)
  const waitFor = async (count: number) => { while (requests.length < count) await new Promise(resolve => setTimeout(resolve, 1)) }
  try {
    const controller = new AbortController()
    const preview = kernel.compile_gpu_packet('{}', controller.signal)
    const cancelled = expect(preview).rejects.toThrow('PREVIEW_CANCELLED')
    const exact = kernel.compile_gpu_packet('{}')
    // Attach immediately so this regression cannot hide as unhandled rejection.
    const outcome = exact.then(value => ({ value }), error => ({ error }))
    await waitFor(1); controller.abort(); await cancelled
    ports.port2.postMessage({ id: requests[0].id, value: new Uint8Array([1]) })
    // An exact consumer must get its own physical dispatch, not cancelled bytes.
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(requests).toHaveLength(2)
    ports.port2.postMessage({ id: requests[1].id, value: new Uint8Array([9]) })
    expect(await outcome).toEqual({ value: new Uint8Array([9]) })
  } finally { channel.close(); ports.port2.close(); assets.free() }
})

test('production receipt rejects an old packet after a delayed compile crosses a document mutation', async () => {
  const assets = new VectorEngine(), ports = new MessageChannel()
  const channel = unorderedPreparation(ports.port1), kernel = new RenderKernel(assets, 'canvas', channel)
  let release!: () => void, notice!: () => void
  const started = new Promise<void>(resolve => { notice = resolve })
  ports.port2.onmessage = event => {
    const { id, method } = event.data
    if (method === 'compile_gpu_packet') { release = () => ports.port2.postMessage({ id, value: new Uint8Array([3]) }); notice() }
    else ports.port2.postMessage({ id })
  }
  try {
    const packet = kernel.prepare_gpu_packet('{}')
    const rejected = expect(packet).rejects.toThrow('STALE_PREPARED_PACKET')
    await started; await kernel.load_document('{}'); release(); await rejected
  } finally { channel.close(); ports.port2.close(); assets.free() }
})

test('production receipt is bound to one lane, mutation epoch and pre-encoder cancellation', async () => {
  const assets = new VectorEngine(), ports = new MessageChannel()
  const channel = new PreparationChannel(ports.port1), kernel = new RenderKernel(assets, 'interaction', channel)
  ports.port2.onmessage = event => ports.port2.postMessage({ id: event.data.id, value: event.data.method === 'compile_gpu_packet' ? new Uint8Array([8]) : undefined })
  try {
    await kernel.load_document('{}')
    const first = await kernel.prepare_gpu_packet('{}')
    expect(first.certificate).toEqual({ lane: 'interaction', revision: 1, options: '{}', settings: 'null' })
    await kernel.load_document('{}')
    expect(() => first.consume()).toThrow('STALE_PREPARED_PACKET')
    const signal = new AbortController(), cancelled = await kernel.prepare_gpu_packet('{}', signal.signal)
    signal.abort(); expect(() => cancelled.consume()).toThrow('PREVIEW_CANCELLED')
    const exact = await kernel.prepare_gpu_packet('{}')
    expect(exact.consume()).toEqual(new Uint8Array([8]))
    expect(() => exact.consume()).toThrow('PREPARED_PACKET_CONSUMED')
  } finally { channel.close(); ports.port2.close(); assets.free() }
})

test('pending mutation cannot produce a receipt; aborted ready cache hits never return bytes', async () => {
  const assets = new VectorEngine(), ports = new MessageChannel()
  const channel = new PreparationChannel(ports.port1), kernel = new RenderKernel(assets, 'canvas', channel)
  let release!: () => void, notice!: () => void, held = false
  ports.port2.onmessage = event => {
    const { id, method } = event.data
    const send = () => ports.port2.postMessage({ id, value: method === 'compile_gpu_packet' ? new Uint8Array([6]) : undefined })
    if (held && method === 'load_document') { release = send; notice() } else send()
  }
  try {
    await kernel.compile_gpu_packet('{}')
    const signal = new AbortController(); signal.abort()
    await expect(kernel.prepare_gpu_packet('{}', signal.signal)).rejects.toThrow('PREVIEW_CANCELLED')
    held = true
    const started = new Promise<void>(resolve => { notice = resolve })
    const mutation = kernel.load_document('{}'); await started
    await expect(kernel.prepare_gpu_packet('{}')).rejects.toThrow('DOCUMENT_PREPARATION_PENDING')
    release(); await mutation
    expect((await kernel.prepare_gpu_packet('{}')).consume()).toEqual(new Uint8Array([6]))
  } finally { channel.close(); ports.port2.close(); assets.free() }
})
