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
  const device={queue,limits:{maxTextureDimension2D:16384},createBindGroupLayout:()=>({}),createShaderModule:()=>({}),createPipelineLayout:()=>({}),
    createRenderPipeline:()=>({getBindGroupLayout:()=>({})}),createSampler:()=>({}),
    createBuffer:({size}:{size:number})=>new Resource(queue,size,'owned-buffer'),
    createTexture:({size,format}:{size:number[];format:string})=>new Resource(queue,size[0]*size[1]*(format==='rgba16float'?8:4),'owned-texture',size[0],size[1]),
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
  return{queue,presenter,device,canvas,canvases,reports}
}
function frame(id?:number,width=16,height=16):ResidentFrame{
  return{items:id===undefined?[]:[{active:true,layer:0,gutter:0,tile:{gpuTile:id,serial:id,width,height,zoom:1,x:0,y:0}as any}],
    view:{x:0,y:0,zoom:1},width,height,dpr:1,allowEmpty:true}
}

test('presenter diagnostics identify the same device and observe pending capture/readback without reserving or fencing extra work',async()=>{
  const f=fixture(),driverOwner={},driverFields=registerDeviceDiagnosticOwner(driverOwner,f.device,1)
  f.presenter.draw(frame())
  const report=f.reports.find(row=>row.compositorFrames===1)!
  expect(report).toMatchObject({deviceIncarnation:driverFields.deviceIncarnation,deviceWorkerScope:driverFields.deviceWorkerScope,deviceScope:2,deviceCounterMask:7})
  expect(report).not.toHaveProperty('deviceRetiringPayloadBytes')
  const before=f.queue.epoch,capture=f.presenter.captureContentBitmap(),read=f.presenter.readContentPixel(.5,.5)
  expect(f.presenter.diagnosticFields()).toMatchObject({devicePendingCaptures:1,devicePendingReadbacks:1,devicePendingCapturePayloadBytes:1024})
  expect(f.queue.epoch-before).toBe(2)
  expect(f.queue.fences).toHaveLength(2) // existing export fence and mock mapAsync, no observer fence
  f.queue.completeThrough(f.queue.epoch)
  const result=await capture;await read;result.bitmap.close()
  expect(f.presenter.diagnosticFields()).toMatchObject({devicePendingCaptures:0,devicePendingReadbacks:0,devicePendingCapturePayloadBytes:0})
})
test('diagnostic counts unwind even when original export cleanup throws',async()=>{
  const f=fixture();f.presenter.draw(frame())
  const pending=f.presenter.captureContentBitmap(),failure=Error('original unconfigure failure')
  vi.spyOn(f.canvases.at(-1)!.context,'unconfigure').mockImplementation(()=>{throw failure})
  f.queue.completeThrough(f.queue.epoch)
  await expect(pending).rejects.toBe(failure)
  expect(f.presenter.diagnosticFields()).toMatchObject({devicePendingCaptures:0,devicePendingCapturePayloadBytes:0})
})
