import { expect, test } from 'vitest'
import { VectorEngine } from '../generated/design-kernel/design_kernel'
import { blank } from '../model'
import { PreparationChannel } from './preparation-channel'
import { RenderKernel } from './render-kernel'

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
  const channel=new PreparationChannel(ports.port1),kernel=new RenderKernel(assets,'canvas',channel)
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
  const channel = new PreparationChannel(ports.port1), kernel = new RenderKernel(assets, 'canvas', channel)
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
