import {afterEach,expect,test,vi} from 'vitest'
import {GpuRenderer, type Surface} from './renderer'
import type {GpuNode,GpuScene,Rect,Texture} from './types'

afterEach(()=>vi.unstubAllEnvs())

const bounds={x:0,y:0,w:96,h:96}
const plane:Rect={x:16,y:16,w:64,h:64}
const near:Rect={x:24,y:24,w:8,h:8},far:Rect={x:40,y:40,w:8,h:8}
const fill=(kind:string)=>({kind,color:'#3478ab',opacity:1,visible:true,blend:'normal',stops:[]})
const leaf=(rect:Rect,kind='solid'):GpuNode=>({id:'leaf',rect,matrix:[1,0,0,1,rect.x,rect.y],inverse:[1,0,0,1,-rect.x,-rect.y],size:[rect.w,rect.h],
  fill:{first:0,count:3,rule:'nonzero',rect,sampleCount:4,area:{first:0,count:7}},
  fills:[fill(kind)],
  strokes:[],effects:[],children:[],mask:false,clip:false,opacity:1,blend:'normal'} as unknown as GpuNode)

function fixture(flag?:string){
  if(flag)vi.stubEnv('VITE_DESIGN_TEXTURE_BACKUPS',flag)
  const create=(width:number,height:number)=>({width,height,bytes:width*height*16,resource:{}}) as Texture
  const events:string[]=[]
  const driver:any={name:'webgpu',managed:true,constantTextureSampling:true,zeroTextureSampling:true,exactSolidPaintOver:true,
    create,createBinaryCoverage:create,clear:vi.fn(),destroy:vi.fn(),checkpoint:vi.fn(async()=>{}),
    pass:vi.fn((_t:Texture,u:Float32Array)=>{events.push('pass'+u[16])}),
    copyTexture:vi.fn((_t:Texture,_s:Texture,region:Rect)=>{events.push(`copy ${region.x},${region.y},${region.w},${region.h}`);return true})}
  const renderer=new GpuRenderer(driver,true,false) as any
  renderer.scene={coherentSamples:true,colorManagement:{documentSpace:'srgb'},curves:new Float32Array(0),extent:bounds,view:{x:0,y:0,zoom:1},nodes:{},roots:[]} as unknown as GpuScene
  renderer.fastWork.reset(true)
  // Four sample planes of one tile share a rectangle and own separate textures.
  const planes=(count=4):Surface[]=>Array.from({length:count},()=>renderer.acquire(plane))
  return {renderer,driver,events,planes}
}

test('a regional paint keeps its render-pass backup unless the candidate is enabled',()=>{
  for(const flag of [undefined,'0']){
    const {renderer,driver,events,planes}=fixture(flag)
    const [dst]=planes(1)
    expect(renderer.regionalOver(47,near,dst,[],()=>{})).toBe(dst)
    expect(driver.copyTexture).not.toHaveBeenCalled()
    expect(events).toEqual(['pass0','pass47'])
  }
})

test('the candidate copies the destination rectangle with texture-local coordinates and keeps the in-place pass',()=>{
  const {renderer,driver,events,planes}=fixture('1')
  const [dst]=planes(1)
  expect(renderer.regionalOver(47,near,dst,[],()=>{})).toBe(dst)
  expect(events).toEqual(['copy 8,8,9,9','pass47'])
  const [target,source,region,origin]=driver.copyTexture.mock.calls[0]
  expect(source).toBe(dst.texture)
  expect([target.width,target.height,region,origin]).toEqual([9,9,{x:8,y:8,w:9,h:9},[0,0]])
  expect(renderer.fastWork.snapshot().textureBackups).toBe(1)
  // The backup is read by the encoded in-place pass and stays busy with it.
  renderer.release(dst)
  expect(renderer.busy.size).toBe(0)
})

test.each([
  ['a constant target',(t:Texture)=>{t.uniformColor=true},(_:Surface)=>{}],
  ['a compact painter target',(_:Texture)=>{},(s:Surface)=>{s.logicalBounds={...plane}}],
  ['a physical texture that is not its own rectangle',(t:Texture)=>{t.width=32},(_:Surface)=>{}],
  ['a byte coverage texture',(t:Texture)=>{t.binaryCoverage=true},(_:Surface)=>{}],
])('%s keeps the render-pass backup',(_name,changeTexture,changeSurface)=>{
  const {renderer,driver,events,planes}=fixture('1')
  const [dst]=planes(1)
  changeTexture(dst.texture);changeSurface(dst)
  renderer.regionalOver(47,near,dst,[],()=>{})
  expect(driver.copyTexture).not.toHaveBeenCalled()
  expect(events).toEqual(['pass0','pass47'])
})

test('an interaction-scissored backup is left to the render-pass path',()=>{
  const {renderer,driver,planes}=fixture('1')
  renderer.scene={...renderer.scene,interactionRetained:true,interactionWindow:{x:0,y:0,w:32,h:32}} as unknown as GpuScene
  const [dst]=planes(1)
  expect(renderer.backupRegion(dst,{x:24,y:24,w:9,h:9})).toBeUndefined()
  expect(driver.copyTexture).not.toHaveBeenCalled()
  expect(renderer.fastWork.snapshot().textureBackups).toBeUndefined()
})

test('a declined copy falls back to the render-pass backup and returns the unused storage',()=>{
  const {renderer,driver,events,planes}=fixture('1')
  driver.copyTexture.mockReturnValue(false)
  const [dst]=planes(1)
  expect(renderer.regionalOver(47,near,dst,[],()=>{})).toBe(dst)
  expect(driver.copyTexture).toHaveBeenCalledTimes(1)
  expect(events).toEqual(['pass0','pass47'])
  expect(renderer.fastWork.snapshot().textureBackups).toBeUndefined()
})

test('a backup that does not fit without eviction is not taken',()=>{
  const {renderer,driver,planes}=fixture('1')
  const [dst]=planes(1)
  renderer.frameBudget=renderer.workingBytes+9*9*16-1
  expect(renderer.backupRegion(dst,{x:24,y:24,w:9,h:9})).toBeUndefined()
  expect(driver.copyTexture).not.toHaveBeenCalled()
  renderer.frameBudget=renderer.workingBytes+9*9*16
  expect(renderer.backupRegion(dst,{x:24,y:24,w:9,h:9})).toBeDefined()
})

test('every sample copies its backup before any sample draws, and each paint consumes its own',()=>{
  const {renderer,driver,events,planes}=fixture('1')
  const targets=planes(),node=leaf(near)
  renderer.stageSampleBackups(node,node.fills[0],targets)
  expect(events).toEqual(['copy 8,8,9,9','copy 8,8,9,9','copy 8,8,9,9','copy 8,8,9,9'])
  expect(driver.copyTexture.mock.calls.map((call:Texture[])=>call[1])).toEqual(targets.map(dst=>dst.texture))
  expect(renderer.fastWork.snapshot().stagedTextureBackups).toBe(4)
  for(const dst of targets) expect(renderer.regionalOver(47,near,dst,[],()=>{})).toBe(dst)
  expect(driver.copyTexture).toHaveBeenCalledTimes(4)
  expect(events.slice(4)).toEqual(['pass47','pass47','pass47','pass47'])
  renderer.clearStagedBackups()
  expect(renderer.stagedBackups).toBeUndefined()
  expect(renderer.busy.size).toBe(4)
})

test('a staged backup of another rectangle is not consumed and is released',()=>{
  const {renderer,driver,events,planes}=fixture('1')
  const [dst]=planes(1)
  renderer.stageSampleBackups(leaf(near),leaf(near).fills[0],[dst])
  expect(renderer.regionalOver(47,far,dst,[],()=>{})).toBe(dst)
  expect(driver.copyTexture.mock.calls.map((call:unknown[])=>(call[2] as Rect).x)).toEqual([8,24])
  expect(events).toEqual(['copy 8,8,9,9','copy 24,24,9,9','pass47'])
  expect(renderer.stagedBackups?.size ?? 0).toBe(0)
  // Both backups are gone: the consumed one after its pass, the stale one at once.
  expect(renderer.busy.size).toBe(1)
  renderer.release(dst)
  expect(renderer.busy.size).toBe(0)
})

test('unused staged backups are released and later staging replaces earlier ones',()=>{
  const {renderer,driver,planes}=fixture('1')
  const targets=planes(),node=leaf(near)
  renderer.stageSampleBackups(node,node.fills[0],targets)
  renderer.stageSampleBackups(node,node.fills[0],[targets[0]])
  expect([...renderer.stagedBackups.keys()]).toEqual([targets[0]])
  expect(renderer.busy.size).toBe(5)
  renderer.clearStagedBackups()
  expect(renderer.stagedBackups).toBeUndefined()
  expect(renderer.busy.size).toBe(4)
  expect(driver.copyTexture).toHaveBeenCalledTimes(5)
})

test('a destination that shares its texture keeps the render-pass path for every sample',()=>{
  const {renderer,driver,events,planes}=fixture('1')
  planes(0)
  const shared=renderer.acquire(plane)
  const retained=[shared,renderer.retain(shared),renderer.retain(shared),renderer.retain(shared)]
  renderer.stageSampleBackups(leaf(near),leaf(near).fills[0],retained)
  expect(driver.copyTexture).not.toHaveBeenCalled()
  expect(renderer.stagedBackups).toBeUndefined()
  // The regional plan itself declines a shared destination, exactly as before.
  expect(renderer.regionalOver(47,near,retained[0],[],()=>{})).toBeUndefined()
  expect(events).toEqual([])
  expect(driver.copyTexture).not.toHaveBeenCalled()
})

test.each([
  ['the candidate is off',undefined,undefined,'solid'],
  ['a sample is clipped','1',[undefined,undefined,undefined,{}],'solid'],
  ['the paint is not a solid','1',undefined,'linear'],
])('nothing is staged when %s',(_name,flag,clip,kind)=>{
  const {renderer,driver,planes}=fixture(flag)
  const targets=planes()
  renderer.stageSampleBackups(leaf(near,kind),leaf(near,kind).fills[0],targets,clip as (Surface|undefined)[]|undefined)
  expect(driver.copyTexture).not.toHaveBeenCalled()
  expect(renderer.stagedBackups).toBeUndefined()
  expect(renderer.busy.size).toBe(4)
})

test('nothing is staged when the driver cannot copy',()=>{
  const {renderer,driver,planes}=fixture('1')
  const copy=driver.copyTexture
  delete driver.copyTexture
  const targets=planes()
  renderer.stageSampleBackups(leaf(near),leaf(near).fills[0],targets)
  expect(copy).not.toHaveBeenCalled()
  expect(renderer.stagedBackups).toBeUndefined()
  expect(renderer.busy.size).toBe(4)
})
