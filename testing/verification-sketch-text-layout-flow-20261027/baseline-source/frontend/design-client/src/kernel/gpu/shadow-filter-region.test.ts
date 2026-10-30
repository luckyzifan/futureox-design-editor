import { afterEach, expect, test, vi } from 'vitest'
import { shadowFilterRegion } from './shadow-filter-region'
import { GpuRenderer, type Surface } from './renderer'
import type { Driver, GpuNode, Rect, Texture } from './types'

afterEach(() => vi.unstubAllEnvs())
const original = { x: -3000, y: -3000, w: 6500, h: 6500 }, output = { x: 100, y: 200, w: 514, h: 514 }
function address(p: number, offset: number, origin: number) {
  const f = Math.fround, q = f(f(f(f(p) - f(offset)) - origin) - .5)
  return { phase: f(q - Math.floor(q)), base: f(f(Math.floor(q) + origin) + .5) }
}
test.each([[640,960],[-640,960],[.125,-.375],[388.5880458613523,582.8820687920285]])('shifted read window retains original shader phases and all bilinear taps (%s,%s)', (dx,dy) => {
  const region = shadowFilterRegion(original, output, dx, dy)
  expect(region).toBeDefined()
  if (!region) throw Error('missing read support')
  expect(region.w * region.h).toBeLessThan(original.w * original.h)
  for (let i=0;i<514;i++) for (const [key,offset] of [['x',dx],['y',dy]] as const) {
    const old = address(output[key]+i+.5,offset,original[key]), next = address(output[key]+i+.5,offset,region[key])
    expect(next).toEqual(old)
    expect(next.base).toBeGreaterThanOrEqual(region[key]+.5)
    expect(next.base+1).toBeLessThan(region[key]+(key==='x'?region.w:region.h))
  }
})
test('nonfinite, imprecise and empty support cannot enter the cropped lane', () => {
  for (const dx of [NaN, Infinity, -Infinity, 1e8]) expect(shadowFilterRegion(original,output,dx,0)).toBeUndefined()
  expect(shadowFilterRegion(original,{...output,x:.25},0,0)).toBeUndefined()
})
/** Executes the production stream, with GPU filter work replaced by an allocation
 * recorder. This verifies bounded graph/lifetime behavior, not GPU pixels. */
test.each([[false,false],[true,false],[true,true]])('offset shadow streams its filter reads (finite solid=%s, fractional=%s)', async (finiteSolid,fractional) => {
  vi.stubEnv('VITE_DESIGN_PREFIX_ALIGNED_STRIPS','0')
  const allocations:Rect[]=[], axes:{axis:number;input:Rect;output:Rect;channels:number}[]=[], sources:Rect[]=[]
  const driver={name:'webgpu',managed:true,maskRegion(){},sequentialSampleResolve:true,exactShadowOver:true,
    create(w:number,h:number):Texture{return {width:w,height:h,bytes:w*h*16,resource:{} as GPUTexture}},clear(){},pass(){}} as unknown as Driver
  const renderer=new GpuRenderer(driver,true,false) as any
  const node={id:'offset-shadow',rect:original,matrix:[64,0,0,64,0,0],children:[],strokes:[],fill:{count:0},fills:[],
    effects:[{kind:'shadow',radius:fractional?20.000000003:20,x:10,y:15,spread:0,visible:true}],opacity:1,blend:'normal'} as unknown as GpuNode
  if(finiteSolid){node.fill={count:3,first:0,rule:'nonzero',area:{first:0,count:1},rect:{x:-600,y:-900,w:800,h:900}};node.fills=[{kind:'solid',visible:true,color:'#ffffff',opacity:1,blend:'normal',stops:[]} as any]}
  renderer.scene={integratedBlur:true,coherentSamples:true,nodes:{'offset-shadow':node}}
  renderer.frameBudget=1024*1024*1024
  const acquire=renderer.acquire.bind(renderer)
  renderer.acquire=(r:Rect,...args:unknown[])=>{allocations.push({...r});return acquire(r,...args)}
  renderer.filterSource=(_n:GpuNode,r:Rect)=>{sources.push({...r});return renderer.acquire(r)}
  renderer.filterKernel=()=>({texture:{prefixRationalUnsupported:true}})
  renderer.exactTentAxis=(src:Surface,_r:number,axis:number,r:Rect,_dst:unknown,_clamp:unknown,_display:unknown,_rows:unknown,channels:number)=>{axes.push({axis,input:{...src.rect},output:{...r},channels});return renderer.acquire(r)}
  renderer.prepareFilterImageTable=async()=>undefined
  renderer.shadow=(sharp:Surface,blurred:Surface,n:GpuNode)=>{
    expect(sharp.rect).toEqual(output);expect(n.rect).toEqual(output)
    expect(blurred.rect.x).toBeLessThan(output.x-639);expect(blurred.rect.y).toBeLessThan(output.y-959)
    return renderer.acquire(output)
  }
  renderer.merge=(_src:Surface,dst:Surface)=>dst
  const targets=Array.from({length:4},()=>renderer.acquire(output))
  expect(await renderer.streamIsolatedFilter(node,targets)).toBe(targets)
  expect(axes.some(a=>a.axis===1)).toBe(true)
  expect(axes.every(a=>a.channels===(fractional?8:15))).toBe(true)
  if(finiteSolid){expect(Math.max(...axes.filter(a=>a.axis===1).map(a=>a.input.h))).toBeLessThan(1400);expect(axes.every(a=>a.output.x>=a.input.x&&a.output.y>=a.input.y&&a.output.x+a.output.w<=a.input.x+a.input.w&&a.output.y+a.output.h<=a.input.y+a.input.h)).toBe(true)}
  expect(sources.filter(r=>r.w===514&&r.h===514)).toHaveLength(4)
  expect(Math.max(...allocations.map(r=>r.w*r.h*16))).toBeLessThan(32*1024*1024)
  expect(allocations.some(r=>r.w===6500&&r.h===6500)).toBe(false)
})
