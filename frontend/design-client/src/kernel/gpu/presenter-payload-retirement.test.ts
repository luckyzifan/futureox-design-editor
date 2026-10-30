/** CPU-only presenter diagnostic characterization.
 * Mock nominal outstanding payload is NOT real VRAM. Synchronous mock validation
 * stands in for async WebGPU validation. Queue completion does not prove memory freed.
 */
import { afterEach, expect, test, vi } from 'vitest'
import { ResidentPresenter, type ResidentFrame } from './resident-presenter'
import { registerDeviceDiagnosticOwner } from './device-lifecycle-diagnostics'
afterEach(() => vi.unstubAllGlobals())
const MiB=1024*1024
class Resource {
  destroyed=false; destroyCalls=0; lastUse=0
  constructor(readonly model: QueueModel, readonly bytes:number, public owner:string, readonly width=0, readonly height=0){model.resources.push(this)}
  destroy(){this.destroyed=true;this.destroyCalls++}
  createView(){return{texture:this}}
  get size(){return this.bytes}
  async mapAsync(){await this.model.onSubmittedWorkDone()}
  getMappedRange(){return new Uint8Array([10,20,30,255]).buffer}
  unmap(){}
}
class QueueModel {
  epoch=0;completed=0;resources:Resource[]=[];submissions:Set<Resource>[]=[]
  fences:{epoch:number;resolve:()=>void}[]=[]
  submit=(commands:{uses:Set<Resource>}[])=>{
    const uses=new Set(commands.flatMap(command=>[...command.uses]))
    if([...uses].some(resource=>resource.destroyed))throw Error('mock destroyed resource at submit')
    this.epoch++;for(const resource of uses)resource.lastUse=this.epoch;this.submissions.push(uses)
  }
  copyExternalImageToTexture=(_source:unknown,target:{texture:Resource})=>this.submit([{uses:new Set([target.texture])}])
  writeBuffer=(buffer:Resource)=>this.submit([{uses:new Set([buffer])}])
  onSubmittedWorkDone=()=>{
    const epoch=this.epoch;if(epoch<=this.completed)return Promise.resolve()
    return new Promise<void>(resolve=>this.fences.push({epoch,resolve}))
  }
  completeThrough(epoch:number){
    this.completed=Math.max(this.completed,epoch)
    const ready=this.fences.filter(fence=>fence.epoch<=this.completed)
    this.fences=this.fences.filter(fence=>fence.epoch>this.completed);for(const fence of ready)fence.resolve()
  }
  outstanding(owner:string){return this.resources.filter(resource=>resource.owner===owner&&(!resource.destroyed||resource.lastUse>this.completed)).reduce((sum,resource)=>sum+resource.bytes,0)}
}
function fixture(){
  vi.stubGlobal('GPUTextureUsage',{RENDER_ATTACHMENT:1,TEXTURE_BINDING:2,COPY_DST:4,COPY_SRC:8})
  vi.stubGlobal('GPUBufferUsage',{UNIFORM:1,COPY_DST:2,MAP_READ:4})
  vi.stubGlobal('GPUShaderStage',{VERTEX:1,FRAGMENT:2});vi.stubGlobal('GPUMapMode',{READ:1})
  const queue=new QueueModel(),reports:Record<string,unknown>[]=[],canvases:MockCanvas[]=[]
  class MockCanvas{
    current?:Resource;configured=false;owner='transient-canvas'
    context={configure:()=>{this.configured=true},unconfigure:()=>{this.configured=false;this.current?.destroy();this.current=undefined},
      getCurrentTexture:()=>this.current??=new Resource(queue,this.width*this.height*4,this.owner,this.width,this.height)}
    constructor(public width:number,public height:number){canvases.push(this)}
    getContext(){return this.context}
    transferToImageBitmap(){const resource=this.current!;this.current=undefined;resource.owner='transferred-bitmap';return{width:this.width,height:this.height,close:()=>resource.destroy()}}
  }
  vi.stubGlobal('OffscreenCanvas',MockCanvas)
  let lose!: (info: {reason:string;message:string}) => void
  const lost = new Promise<{reason:string;message:string}>(resolve => { lose=resolve })
  const device={queue,lost,limits:{maxTextureDimension2D:16384},createBindGroupLayout:()=>({}),createShaderModule:()=>({}),createPipelineLayout:()=>({}),
    createRenderPipeline:()=>({getBindGroupLayout:()=>({})}),createSampler:()=>({}),
    createBuffer:({size}:{size:number})=>new Resource(queue,size,'owned-buffer'),
    createTexture:({size,format}:{size:number[];format:string})=>new Resource(queue,size[0]*size[1]*(size[2]||1)*(format==='rgba16float'?8:4),'owned-texture',size[0],size[1]),
    createBindGroup:({entries}:{entries:{resource:{texture?:Resource;buffer?:Resource}}[]})=>({uses:entries.flatMap(entry=>entry.resource.texture||entry.resource.buffer||[])}),
    createCommandEncoder:()=>{
      const uses=new Set<Resource>()
      return{copyTextureToTexture:(source:{texture:Resource},target:{texture:Resource})=>{uses.add(source.texture);uses.add(target.texture)},
        copyTextureToBuffer:(source:{texture:Resource},target:{buffer:Resource})=>{uses.add(source.texture);uses.add(target.buffer)},
        beginRenderPass:({colorAttachments}:{colorAttachments:{view:{texture:Resource}}[]})=>{
          colorAttachments.forEach(attachment=>uses.add(attachment.view.texture))
          return{setScissorRect(){},setPipeline(){},setBindGroup(_index:number,bind:{uses:Resource[]}){bind.uses.forEach(resource=>uses.add(resource))},
            setVertexBuffer(_index:number,buffer:Resource){uses.add(buffer)},draw(){},end(){}}
        },finish:()=>({uses})}
    }}
  const canvas=new MockCanvas(16,16);canvas.owner='display-canvas'
  const presenter=new ResidentPresenter(device as unknown as GPUDevice,canvas as unknown as OffscreenCanvas,'rgba8unorm',report=>reports.push(report))
  return{queue,presenter,device,canvas,canvases,reports,lose}
}
function frame(id?:number,width=16,height=16):ResidentFrame{
  return{items:id===undefined?[]:[{active:true,layer:0,gutter:0,tile:{gpuTile:id,serial:id,width,height,zoom:1,x:0,y:0}as any}],
    view:{x:0,y:0,zoom:1},width,height,dpr:1,allowEmpty:true}
}

const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }
test('an explicitly partial camera preview cannot certify full native coverage, and final frames still wait for it',()=>{
 const f=fixture(),tile=f.presenter.capture(16,16),partial=frame(tile.id,32,32)
 partial.items[0].tile.width=16;partial.items[0].tile.height=16
 partial.terminalQuality={qualitySequence:1,qualityRevision:1,pageToken:1}
 f.presenter.draw(partial)
 expect(f.reports.at(-1)).toMatchObject({pixelCoverageComplete:false,nativeCoverageComplete:false,qualityTerminal:false})
 const submissions=f.queue.epoch
 f.presenter.draw({...partial,allowEmpty:false})
 expect(f.queue.epoch).toBe(submissions)
 expect(f.reports.at(-1)).toMatchObject({coverageDeferred:1})
 f.presenter.dispose()
})
test('four retained phases share the unchanged ledger and cannot use byte encoding',()=>{
 const f=fixture()
 expect(()=>f.presenter.capture(1,1,undefined,undefined,false,4)).toThrow(/sample encoding/)
 const captured=f.presenter.capture(4096,4096,undefined,undefined,true,4)
 expect(f.presenter.payloadStats.liveBytes).toBe(512*MiB)
 expect(captured.texture).toHaveProperty('bytes',512*MiB)
 expect(()=>f.presenter.capture(1,1)).toThrow(/display resident budget exceeded/)
 f.presenter.dispose();expect(captured.texture).toHaveProperty('destroyCalls',1)
})
test('four phase composition charges all accumulation layers and retires them on replacement',async()=>{
 const f=fixture(),captured=f.presenter.capture(16,16,undefined,undefined,true,4)
 const current=frame(captured.id);current.linearBlend=true;current.items[0].blend=true
 f.presenter.draw(current)
 const old=(f.presenter as any).linearTarget
 expect(old.samples).toBe(4)
 expect(f.presenter.residentBytes).toBe(16*16*(32+32+4))
 expect(f.reports.at(-1)).toMatchObject({compositorDraws:5})
 const replacement=frame(captured.id,32,32);replacement.linearBlend=true;replacement.items[0].blend=true
 f.presenter.draw(replacement)
 expect(old.texture.destroyCalls).toBe(1)
 expect(f.presenter.payloadStats.retiringBytes).toBe(16*16*(32+4))
 f.queue.completeThrough(f.queue.epoch);await flush()
 expect(f.presenter.payloadStats.retiringBytes).toBe(0)
 f.presenter.dispose()
})
test('linear retained captures charge all eight bytes per pixel against the unchanged display ledger',()=>{
 const f=fixture(),captured=f.presenter.capture(8192,8192,undefined,undefined,true)
 expect(f.presenter.payloadStats.liveBytes).toBe(512*MiB)
 expect((f.presenter as any).textures.get(captured.id).linear).toBe(true)
 expect(()=>f.presenter.capture(1,1)).toThrow(/display resident budget exceeded/)
 f.presenter.release([captured.id]);f.presenter.dispose()
})
test('linear retained pixels cannot be silently interpreted as encoded display bytes',()=>{
 const f=fixture(),captured=f.presenter.capture(16,16,undefined,undefined,true)
 expect(()=>f.presenter.draw(frame(captured.id))).toThrow(/require linear composition/)
 const normal=frame(captured.id);normal.linearBlend=true;normal.items[0].blend=true
 expect(()=>f.presenter.draw(normal)).not.toThrow();f.presenter.dispose()
})
// All allocation sizes below are descriptors only. No real GPU or large arrays.
test('queued released payload remains charged until its prefix, not immediately reusable', async () => {
  const f=fixture(),close=vi.fn(),id=f.presenter.import({width:8192,height:8192,close} as unknown as ImageBitmap)
  const old=(f.presenter as any).textures.get(id).texture as Resource
  f.presenter.release([id,id]);expect(old.destroyCalls).toBe(1)
  expect(f.presenter.payloadStats).toMatchObject({liveBytes:0,retiringBytes:256*MiB})
  f.presenter.capture(8192,8192)
  expect(()=>f.presenter.capture(1,1)).toThrow(/display resident budget exceeded/)
  f.queue.completeThrough(f.queue.epoch);await flush()
  expect(f.presenter.payloadStats.retiringBytes).toBe(0)
  f.presenter.capture(8192,8192);expect(close).toHaveBeenCalledOnce()
})
test('stable replacement retires separate allocations, preserves new handle and releases last owner once', async () => {
  const f=fixture(),old=f.presenter.capture(16,16),next=f.presenter.capture(16,16)
  f.presenter.draw(frame(old.id));f.presenter.replace(old.id,next.id)
  const prefix=f.queue.epoch
  f.presenter.draw(frame(old.id));f.presenter.release([next.id]);expect((next.texture as unknown as Resource).destroyed).toBe(false)
  f.presenter.release([old.id,old.id]);expect((next.texture as unknown as Resource).destroyCalls).toBe(1)
  expect(f.presenter.payloadStats.retiringBytes).toBe(2048)
  f.queue.completeThrough(prefix);await flush();expect(f.presenter.payloadStats.retiringBytes).toBe(1024)
  f.queue.completeThrough(f.queue.epoch);await flush();expect(f.presenter.payloadStats.retiringBytes).toBe(0)
  expect(f.queue.submissions.at(-1)?.has(old.texture as unknown as Resource)).toBe(false)
})
test('replacement peak rejection preserves old target, last frame and visible canvas dimensions', () => {
  const f=fixture(),oldFrame=frame(undefined,8192,8192);f.presenter.draw(oldFrame)
  const old=(f.presenter as any).backbuffer,epoch=f.queue.epoch
  expect(()=>f.presenter.draw(frame(undefined,8192,8193))).toThrow(/display resident budget exceeded/)
  expect((f.presenter as any).backbuffer).toBe(old);expect(old.texture.destroyed).toBe(false)
  expect((f.presenter as any).drawn).toBe(oldFrame);expect(f.canvas.height).toBe(8192);expect(f.queue.epoch).toBe(epoch)
  expect(f.presenter.payloadStats).toMatchObject({allocationReservedBytes:0,liveBytes:256*MiB})
})
test('second target setup failure unwinds both reservations without replacing the old targets', () => {
  const f=fixture(),tile=f.presenter.capture(16,16);f.presenter.draw(frame(tile.id))
  const old=(f.presenter as any).backbuffer,before=f.presenter.residentBytes
  vi.spyOn(f.device,'createBindGroup').mockImplementation(()=>{throw Error('synthetic bind failure')})
  const next=frame(tile.id,32,32);next.linearBlend=true;next.items[0].blend=true
  expect(()=>f.presenter.draw(next)).toThrow(/synthetic bind failure/)
  expect((f.presenter as any).backbuffer).toBe(old);expect(old.texture.destroyed).toBe(false);expect(f.canvas.width).toBe(16)
  expect(f.presenter.residentBytes).toBe(before);expect(f.presenter.payloadStats.allocationReservedBytes).toBe(0)
  expect(f.queue.resources.filter(r=>r.owner==='owned-texture'&&r.width===32).every(r=>r.destroyed)).toBe(true)
})
test('concurrent explicit captures reserve one output and each caller receives its own result', async () => {
  const f=fixture();f.presenter.draw(frame(undefined,8192,8192))
  const pending=[f.presenter.captureContentBitmap(),f.presenter.captureContentBitmap(),f.presenter.captureContentBitmap()]
  await flush();expect(f.queue.fences).toHaveLength(1);expect(f.presenter.payloadStats).toMatchObject({pendingCaptures:1,captureReservedBytes:256*MiB,waiters:2})
  for(const output of pending){f.queue.completeThrough(f.queue.epoch);const result=await output;result.bitmap.close();await flush()}
  expect(f.presenter.payloadStats).toMatchObject({pendingCaptures:0,captureReservedBytes:0,waiters:0})
})
test('explicit impossible-fit capture fails clearly before creating another canvas', async () => {
  const f=fixture();f.presenter.capture(16,16);f.presenter.draw(frame(undefined,8192,8192))
  const canvases=f.canvases.length
  await expect(f.presenter.captureContentBitmap()).rejects.toThrow(/required payload cannot fit/)
  expect(f.canvases).toHaveLength(canvases);expect(f.presenter.payloadStats.waiters).toBe(0)
})
test('snapshot encoder failure releases its registered handle instead of leaking an owner', async () => {
  const f=fixture();f.presenter.draw(frame());const before=f.presenter.residentBytes
  vi.spyOn(f.device,'createCommandEncoder').mockImplementation(()=>{throw Error('synthetic encoder failure')})
  expect(()=>f.presenter.snapshot()).toThrow(/synthetic encoder failure/)
  expect((f.presenter as any).textures.size).toBe(0);expect(f.presenter.residentBytes).toBe(before)
  expect(f.presenter.payloadStats.retiringBytes).toBe(1024)
  f.queue.completeThrough(f.queue.epoch);await flush();expect(f.presenter.payloadStats.retiringBytes).toBe(0)
})
test('known loss rejects waiting outputs and a loss-compatible fence cannot transfer a stale bitmap', async () => {
  const f=fixture();f.presenter.draw(frame())
  const first=f.presenter.captureContentBitmap(),second=f.presenter.captureContentBitmap()
  const firstRejected=expect(first).rejects.toThrow(/retired or completion unavailable/)
  const secondRejected=expect(second).rejects.toThrow(/retired or device lost/)
  await flush();f.presenter.lost('synthetic loss');f.queue.completeThrough(f.queue.epoch)
  await firstRejected;await secondRejected
  expect(f.queue.resources.some(r=>r.owner==='transferred-bitmap')).toBe(false)
  expect(f.presenter.payloadStats).toMatchObject({closed:2,retiringBytes:1024,pendingCaptures:0})
  expect(()=>f.presenter.capture(1,1)).toThrow(/retired/)
})
test('disposing pending capture rejects stale output, clears live targets and destroys each owner once', async () => {
  const f=fixture(),tile=f.presenter.capture(16,16);f.presenter.draw(frame(tile.id))
  const output=f.presenter.captureContentBitmap(),rejected=expect(output).rejects.toThrow(/retired/)
  await flush();f.presenter.dispose();f.presenter.dispose();f.queue.completeThrough(f.queue.epoch);await rejected
  expect(f.presenter.residentBytes).toBe(0);expect((tile.texture as unknown as Resource).destroyCalls).toBe(1)
  expect(f.presenter.payloadStats).toMatchObject({closed:1,liveBytes:0,retiringBytes:3072})
})

test('independent presenter loss listener rejects a pending output while driver parked callback is suppressed', async()=>{
  const f=fixture();f.presenter.draw(frame())
  // The parked driver retains the presenter, but its existing callback returns
  // when disposed. This callback deliberately does not call presenter.lost().
  const parkedDriver={disposed:true,lost:false}
  void f.device.lost.then(()=>{parkedDriver.lost=true;if(parkedDriver.disposed)return;f.presenter.lost('loss')})
  const pending=f.presenter.captureContentBitmap(),rejected=expect(pending).rejects.toThrow(/retired/)
  await flush();f.lose({reason:'unknown',message:'synthetic loss'});f.queue.completeThrough(f.queue.epoch)
  await rejected;expect(parkedDriver.lost).toBe(true)
  expect(f.presenter.payloadStats).toMatchObject({closed:2,retiringBytes:1024})
  expect(f.queue.resources.some(resource=>resource.owner==='transferred-bitmap')).toBe(false)
})

test('synchronous retirement observer failure cannot strand the second replacement target', ()=>{
  const f=fixture(),tile=f.presenter.capture(16,16)
  const first=frame(tile.id);first.linearBlend=true;first.items[0].blend=true;f.presenter.draw(first)
  const oldBack=(f.presenter as any).backbuffer,oldLinear=(f.presenter as any).linearTarget
  vi.spyOn(f.queue,'onSubmittedWorkDone').mockImplementation(()=>{throw Error('synthetic queue observer failure')})
  const next=frame(tile.id,32,32);next.linearBlend=true;next.items[0].blend=true
  expect(()=>f.presenter.draw(next)).toThrow(/retired or completion unavailable/)
  expect(f.presenter.payloadStats).toMatchObject({closed:3,allocationReservedBytes:0})
  const owners=new Set([(f.presenter as any).backbuffer.texture,(f.presenter as any).linearTarget.texture,tile.texture])
  expect(f.queue.resources.filter(resource=>resource.owner==='owned-texture'&&!resource.destroyed&&!owners.has(resource as any))).toEqual([])
  expect(oldBack.texture.destroyed).toBe(true);expect(oldLinear.texture.destroyed).toBe(true)
  expect(f.canvas.width).toBe(16) // visible canvas was not cleared by the failed frame
})
