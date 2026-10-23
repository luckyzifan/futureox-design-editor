// Real production mask/paint/filter allocation and reclaim methods, GPU double.
// Supplied log sizes are allocation/accounting evidence, not GPU timing fixtures.
import { afterEach, expect, test, vi } from 'vitest'
import { GpuRenderer } from './renderer'
import { paint } from '../../model'
import type { Driver, Texture } from './types'
afterEach(() => vi.unstubAllEnvs())
function fixture(managed = true, bytes = 1_071_617_564) {
  let complete!: () => void, reject!: (error: Error) => void, completed = false, current = true
  const create = (width: number, height: number, bpp = managed ? 16 : 4): Texture => ({ width, height, bytes: width * height * bpp, resource: {} })
  const driver = { name: 'webgpu', managed, resourceEpoch: 7, completedResourceEpoch: 6, scratchBytes: 0,
    create: vi.fn(create), createBinaryCoverage: vi.fn((w: number,h: number) => ({ ...create(w,h,4), binaryCoverage: true })),
    createScalarCoverage: vi.fn((w: number,h: number) => ({ ...create(w,h,4), scalarCoverage: true })),
    pass: vi.fn((_target: Texture, _uniforms: Float32Array, _inputs: Texture[]) => {}), over: vi.fn(),
    imageTableRange: (_texture: Texture): object | undefined => undefined,
    mask: vi.fn(), clear: vi.fn(), uploadRgba8: vi.fn((v: Uint8Array,w: number,h: number) => create(w,h)),
    uploadLinear: vi.fn((v: Float32Array,w: number,h: number) => create(w,h)),
    destroy: vi.fn((_texture: Texture) => { expect(completed).toBe(true) }),
    checkpoint: vi.fn(async () => { await new Promise<void>((res,rej) => { complete=res;reject=rej }); completed=true }) }
  const renderer = new GpuRenderer(driver as unknown as Driver, true, true, undefined, false, false, 1024) as any
  renderer.scene = { coherentSamples: false, integratedBlur: true }; renderer.bytes = bytes
  renderer.meshBits = new Uint32Array(6); renderer.curveBits = new Uint32Array(new Float32Array([3,0,0,0]).buffer)
  renderer.frameCurrent = () => current; renderer.configurePaint = () => {}
  const pool: Texture[] = []
  for (let i = 0; i < 33; i++) {
    const texture = { ...create(100+i,100), bytes: i < 32 ? 25_470_526 : 25_470_540 }
    pool.push(texture); renderer.free.set(`${texture.width}:100`,[texture]); renderer.used.add(texture); renderer.poolReleaseEpoch.set(texture,7)
  }
  const surface = (w: number,h: number) => { const s={ texture:create(w,h),rect:{x:0,y:0,w,h} }; renderer.busy.add(s.texture);renderer.used.add(s.texture);return s }
  return { renderer, driver, create, surface, pool, complete:()=>complete(), reject:()=>reject(Error('uncertain queue')), cancel:()=>{current=false} }
}
test('req209 pathCoverage exact miss waits before 1666x753 allocation with 801MiB free-but-used pool', async () => {
  const f=fixture(false),path={first:0,count:3,rule:'nonzero',rect:{x:0,y:0,w:1666,h:753}}
  const pending=f.renderer.mask(path,true)
  expect(pending).toBeInstanceOf(Promise); expect(f.driver.create).not.toHaveBeenCalled();expect(f.driver.destroy).not.toHaveBeenCalled()
  f.complete();const result=await pending
  expect(result.texture.bytes).toBe(5_017_992);expect(f.driver.mask).toHaveBeenCalledOnce()
  expect(f.driver.checkpoint).toHaveBeenCalledOnce();expect(f.renderer.bytes).toBeLessThanOrEqual(1_073_741_824)
})
test('req211 mode2 paint output admits after lazy inputs without releasing its coordinate source',async()=>{
  const f=fixture(),mask=f.surface(2253,1452),field=f.surface(8,2)
  f.renderer.coordinateMaps.add(field.texture)
  f.renderer.gradientGrid=()=>field
  const p={...paint('#fff'),kind:'linear'},node={rect:mask.rect}
  const pending=f.renderer.paint(node,p,mask,undefined,true)
  expect(pending).toBeInstanceOf(Promise);expect(f.driver.pass).not.toHaveBeenCalled();expect(f.driver.destroy).not.toHaveBeenCalled()
  f.complete();const result=await pending
  expect(result.texture.bytes).toBe(52_341_696)
  expect(f.driver.destroy.mock.calls.some(([texture])=>texture===field.texture)).toBe(false)
  expect(f.driver.pass.mock.calls[0][2]).toContain(field.texture)
  expect(f.renderer.bytes).toBeLessThanOrEqual(1_073_741_824)
})
test('req212 mode22 tent admits both exact full-size axes without changing density or radius',async()=>{
  const f=fixture(),input=f.surface(2125,1368)
  const pending=f.renderer.blur(input,2,false,false,false,true)
  expect(pending).toBeInstanceOf(Promise);expect(f.driver.pass).not.toHaveBeenCalled();expect(f.driver.destroy).not.toHaveBeenCalled()
  f.complete();const result=await pending
  expect(result.texture.bytes).toBe(46_512_000)
  expect(f.driver.pass.mock.calls.map(call=>[call[1][16],call[1][36],call[1][37]])).toEqual([[22,4,0],[22,4,1]])
  expect(f.renderer.bytes).toBeLessThanOrEqual(1_073_741_824)
})
const pathFor = (w=1666,h=753) => ({ first:0,count:3,rule:'nonzero',rect:{x:0,y:0,w,h} })
function directNode(path=pathFor()) { return { id:'leaf', fill:path, rect:path.rect, opacity:1, blend:'normal', children:[],effects:[],strokes:[], fills:[paint('#ffffff')] } }
test('production unmanaged drawNode reaches pre-mask admission rather than failing before its async paint boundary', async()=>{
  const f=fixture(false),node=directNode(),target=f.surface(1666,753)
  f.renderer.scene.nodes={leaf:node};f.driver.over=vi.fn()
  const pending=f.renderer.drawNode('leaf',target)
  expect(f.driver.checkpoint).toHaveBeenCalledOnce();expect(f.driver.over).not.toHaveBeenCalled()
  f.complete();expect(await pending).toBe(target)
  expect(f.driver.mask).toHaveBeenCalledOnce();expect(f.driver.over).toHaveBeenCalledOnce()
})
test('hot drawNode cache hits retain synchronous encoding and perform no completion wait',async()=>{
  const f=fixture(false,0),node=directNode(pathFor(8,8)),target=f.surface(8,8)
  f.renderer.scene.nodes={leaf:node};f.driver.over=vi.fn()
  f.renderer.mask(node.fill,true)
  const pending=f.renderer.drawNode('leaf',target)
  // async method has not returned to a microtask before encoding its hit.
  expect(f.driver.over).toHaveBeenCalledOnce();expect(f.driver.mask).toHaveBeenCalledOnce()
  expect(f.driver.checkpoint).not.toHaveBeenCalled();expect(await pending).toBe(target)
})
test.each(['binary','scalar'] as const)('%s coverage admits its actual four-byte format, not a sixteen-byte estimate',kind=>{
  const path={...pathFor(100,100),area:{first:0,count:1}},f=fixture(true,1_073_741_824-40_000)
  if(kind==='binary')f.renderer.sampleIndex=0
  const result=f.renderer.mask(path,true)
  expect(result).not.toBeInstanceOf(Promise);expect(result.texture.bytes).toBe(40_000)
  expect(result.texture[kind==='binary'?'binaryCoverage':'scalarCoverage']).toBe(true)
  expect(f.driver.checkpoint).not.toHaveBeenCalled()
})
test('a same-size wrong-format pool cannot masquerade as matching coverage storage',async()=>{
  const f=fixture(),path={...pathFor(100,100),area:{first:0,count:1}},wrong=f.create(100,100)
  f.renderer.bytes=1_073_741_824;f.renderer.sampleIndex=0
  f.renderer.free.set('100:100',[wrong]);f.renderer.used.add(wrong)
  const pending=f.renderer.mask(path,true)
  expect(pending).toBeInstanceOf(Promise);f.complete();const result=await pending
  expect(result.texture).not.toBe(wrong);expect(result.texture.binaryCoverage).toBe(true)
})
test('matching mask pool and an existing mask hit never add an admission wait',()=>{
  const f=fixture(false),path=pathFor(),reusable=f.create(1666,753)
  f.renderer.free.set('1666:753',[reusable]);f.renderer.used.add(reusable)
  const first=f.renderer.mask(path,true),second=f.renderer.mask(path,true)
  expect(first.texture).toBe(reusable);expect(second.texture).toBe(reusable)
  expect(f.driver.create).not.toHaveBeenCalled();expect(f.driver.mask).toHaveBeenCalledOnce();expect(f.driver.checkpoint).not.toHaveBeenCalled()
})
test.each(['cancel','reject'] as const)('pending paint %s clears its pins without encoding an unowned continuation',async kind=>{
  const f=fixture(),mask=f.surface(2253,1452),field=f.surface(8,2)
  f.renderer.coordinateMaps.add(field.texture);f.renderer.gradientGrid=()=>field
  const pending=f.renderer.paint({rect:mask.rect},{...paint('#fff'),kind:'linear'},mask,undefined,true)
  expect(f.renderer.admissionPins.has(field.texture)).toBe(true)
  if(kind==='cancel'){f.cancel();f.complete()}else f.reject()
  await expect(pending).rejects.toThrow(kind==='cancel'?'PREVIEW_CANCELLED':'uncertain queue')
  expect(f.driver.pass).not.toHaveBeenCalled();expect(f.renderer.admissionPins.size).toBe(0)
  expect(f.renderer.busy.has(mask.texture)).toBe(true);expect(f.renderer.busy.has(field.texture)).toBe(true)
  if(kind==='reject')expect(f.driver.destroy).not.toHaveBeenCalled()
})
test('paint captures its atlas page and coordinate inputs across forced eviction of other assets',async()=>{
  const f=fixture(),mask=f.surface(2253,1452),image={texture:f.create(2048,2048),rect:{x:0,y:0,w:2048,h:2048}},field=f.surface(8,2)
  f.renderer.free.clear();f.renderer.imageAtlas=true;f.renderer.imageLevel=()=>0
  f.renderer.imageFor=vi.fn(()=>image);f.renderer.imageGrid=vi.fn(()=>field)
  f.renderer.coordinateMaps.add(field.texture)
  const pinned={texture:image.texture,entries:new Map([['source@a','source']])},other={texture:{...f.create(1,1),bytes:300*1024*1024},entries:new Map([['other@a','other']])}
  f.renderer.atlasPages=[pinned,other];f.renderer.images.set('source@a',image);f.renderer.images.set('other@a',{texture:other.texture,rect:mask.rect})
  const pending=f.renderer.paint({rect:mask.rect},{...paint('#fff'),kind:'image',image:'source'},mask,undefined,true)
  expect(f.renderer.admissionPins.has(image.texture)).toBe(true);expect(f.driver.destroy).not.toHaveBeenCalled()
  f.complete();const result=await pending
  expect(f.driver.destroy.mock.calls.map(([texture])=>texture)).toContain(other.texture)
  expect(f.driver.destroy.mock.calls.map(([texture])=>texture)).not.toContain(image.texture)
  expect(f.renderer.atlasPages).toContain(pinned);expect(f.renderer.images.get('source@a')).toBe(image)
  expect(f.driver.pass.mock.calls[0][2]).toContain(image.texture);expect(f.driver.pass.mock.calls[0][2]).toContain(field.texture)
  expect(f.renderer.imageFor).toHaveBeenCalledOnce();expect(f.renderer.imageGrid).toHaveBeenCalledOnce()
  expect(result.texture).not.toBe(image.texture);expect(result.texture).not.toBe(field.texture);expect(f.renderer.admissionPins.size).toBe(0)
})
test('pending static-cache ownership release cannot pool the incoming plane as its own paint output',async()=>{
  const f=fixture(true,1_073_741_824-512),mask=f.surface(8,8),source=f.create(8,8),proof={}
  f.driver.imageTableRange=(texture:Texture)=>texture===source?proof:undefined
  const cache=f.renderer.staticImageBlurs
  const token=cache.registerUpload(source,proof,'source','policy');cache.begin('context',6)
  expect(cache.stage(token,'mapping',mask.rect,mask,7)).toBe(true)
  const pending=f.renderer.paint({rect:mask.rect},paint('#fff'),mask,undefined,true)
  // discardPending called during pressure, but the continuation holds a ref.
  expect(cache.count).toBe(0);expect(f.renderer.busy.has(mask.texture)).toBe(true)
  expect(f.renderer.free.get('8:8')||[]).not.toContain(mask.texture)
  f.complete();const result=await pending
  expect(result.texture).not.toBe(mask.texture);expect(f.driver.pass.mock.calls[0][2]).toContain(mask.texture)
  expect(f.driver.destroy.mock.calls.map(([texture])=>texture)).not.toContain(mask.texture)
})
test('two-axis filter preserves one matching reusable slot while admitting only its missing plane',async()=>{
  const f=fixture(),input=f.surface(2125,1368),reusable=f.create(2125,1368)
  f.renderer.free.set('2125:1368',[reusable]);f.renderer.used.add(reusable)
  const pending=f.renderer.blur(input,2,false,false,false,true)
  expect(f.renderer.admissionPins.has(reusable)).toBe(true)
  f.complete();await pending
  expect(f.driver.destroy.mock.calls.map(([texture])=>texture)).not.toContain(reusable)
  expect(f.driver.pass.mock.calls[0][0]).toBe(reusable)
  expect(f.driver.create).toHaveBeenCalledExactlyOnceWith(2125,1368)
})
test('genuinely excessive live allocation still rejects once without a replay or a raised budget',async()=>{
  const f=fixture(),path=pathFor(20000,20000)
  const pending=f.renderer.mask(path,true);f.complete()
  await expect(pending).rejects.toThrow('GPU 表面内存预算超限')
  expect(f.driver.checkpoint).toHaveBeenCalledOnce();expect(f.driver.create).not.toHaveBeenCalled();expect(f.driver.mask).not.toHaveBeenCalled()
  expect(f.renderer.frameBudget).toBe(1_073_741_824);expect(f.renderer.admissionPins.size).toBe(0)
})
test('current material-field cache input survives pressure and is not rebuilt after its fence',async()=>{
  const f=fixture(),mask=f.surface(2253,1452),r={x:0,y:0,w:8,h:2}
  f.renderer.materialFields.begin()
  f.renderer.gradientGrid=vi.fn(()=>f.renderer.materialField(['test-grid'],r,()=>new Float32Array(64),f.driver.uploadLinear))
  const pending=f.renderer.paint({rect:mask.rect},{...paint('#fff'),kind:'linear'},mask,undefined,true)
  const field=f.driver.uploadLinear.mock.results[0].value
  expect(f.renderer.materialFields.has(field)).toBe(true)
  f.complete();await pending
  expect(f.driver.destroy.mock.calls.map(([texture])=>texture)).not.toContain(field)
  expect(f.renderer.gradientGrid).toHaveBeenCalledOnce();expect(f.driver.uploadLinear).toHaveBeenCalledOnce()
  expect(f.driver.pass.mock.calls[0][2]).toContain(field)
})
test('pressure does not change two-axis pass uniforms, kernel upload values or output dimensions',async()=>{
  const plain=fixture(true,0),pressure=fixture(true)
  const direct=plain.renderer.blur(plain.surface(2125,1368),2,false,false,false,true)
  const pending=pressure.renderer.blur(pressure.surface(2125,1368),2,false,false,false,true)
  expect(direct).not.toBeInstanceOf(Promise);pressure.complete();const result=await pending
  expect(pressure.driver.pass.mock.calls.map(call=>Array.from(call[1]))).toEqual(plain.driver.pass.mock.calls.map(call=>Array.from(call[1])))
  expect(pressure.driver.uploadLinear.mock.calls.map(call=>[Array.from(call[0]),call[1],call[2]])).toEqual(plain.driver.uploadLinear.mock.calls.map(call=>[Array.from(call[0]),call[1],call[2]]))
  expect([result.texture.width,result.texture.height,result.texture.bytes]).toEqual([direct.texture.width,direct.texture.height,direct.texture.bytes])
  for(const call of pressure.driver.pass.mock.calls)expect(call[2]).not.toContain(call[0])
})
