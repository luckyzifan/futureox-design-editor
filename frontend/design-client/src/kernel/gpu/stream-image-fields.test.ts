import { afterEach, expect, test, vi } from 'vitest'
import { GpuRenderer } from './renderer'
import * as kernel from '../../generated/design-kernel/design_kernel'
import { image_sampling_grid_placed } from '../../generated/design-kernel/design_kernel'
import type { Driver, GpuNode, GpuPaint, Rect, Texture } from './types'

afterEach(() => {vi.unstubAllEnvs();vi.restoreAllMocks()})
function fixture(retain = true) {
  vi.stubEnv('VITE_DESIGN_RETAIN_PARAMETER_FIELDS', retain ? '1' : '0')
  const uploads: { texture: Texture; values: Float32Array }[] = [], destroyed: Texture[] = []
  const driver = { name: 'webgpu', managed: true, scratchBytes: 0,
    uploadParameters(values: Float32Array, width: number, height: number) {
      const texture = { width, height, bytes: values.byteLength, resource: {} as GPUTexture }
      uploads.push({texture, values: values.slice()}); return texture
    }, destroy(texture: Texture) { destroyed.push(texture) }, checkpoint: vi.fn(async () => {}) } as unknown as Driver
  const renderer = new GpuRenderer(driver) as any
  renderer.scene = { compactImageFields: true }
  const support = {x: -13, y: 19, w: 80, h: 192}
  renderer.filterImageFields = {rect: support, fields: new Map(), pinned: new Set()}
  const paint = {kind: 'image', color: '#ffffff', fit: 'stretch', angle: 0, opacity: 1, stops: []} as unknown as GpuPaint
  const node = {id: 'image', rect: support, matrix: [1,0,0,1,0,0], inverse: [1,0,0,1,0,0], size: [100,250], fills: [paint]} as unknown as GpuNode
  const image = {rect: {x:0,y:0,w:100,h:250}, texture: {width:100,height:250,bytes:400000,resource:{}} as Texture}
  const field = (region: Rect, sample: number) => {
    renderer.sampleIndex = sample
    return renderer.imageGrid({...node,rect:region}, {...paint}, image)
  }
  return {renderer,driver,support,paint,node,image,field,uploads,destroyed}
}

test('three row strips share exactly four support fields and retain dense metadata bits', () => {
  const f = fixture()
  for (let sample=0;sample<4;sample++) {
    let known: Texture | undefined
    for (let y=f.support.y;y<f.support.y+f.support.h;y+=64) {
      const region={...f.support,y,h:64}, surface=f.field(region,sample)
      if(known)expect(surface.texture).toBe(known);known=surface.texture
      expect(surface.rect).toEqual(f.support)
      const values=f.uploads.find(x=>x.texture===surface.texture)!.values,span=Math.max(f.support.w,f.support.h)
      const dense=image_sampling_grid_placed(JSON.stringify(region),new Float64Array(f.node.matrix),new Float64Array(f.node.size),
        new Uint32Array([100,250]),JSON.stringify({kind:'image',color:'#ffffff',fit:'stretch'}),sample,0,new Int32Array([0,0]))
      const denseBits=new Uint32Array(dense.buffer,dense.byteOffset,dense.length)
      const bits=new Uint32Array(values.buffer,values.byteOffset,values.length)
      for(let row=0;row<region.h;row++)for(let col=0;col<region.w;col++){
        const at=(row*region.w+col)*4,x=col*4,y=(span+row+region.y-f.support.y)*4
        expect([bits[x],bits[y],bits[x+1],bits[y+1]]).toEqual([...denseBits.slice(at,at+4)])
      }
    }
  }
  expect(f.uploads).toHaveLength(4)
  expect(f.renderer.fieldBuilds).toBe(4)
})

test('full-support proof failure retains dense per-strip fallback', () => {
  const f=fixture();f.node.matrix=[1,.25,0,1,0,0]
  const first=f.field({...f.support,h:64},0),second=f.field({...f.support,y:f.support.y+64,h:64},0)
  expect(first.texture).not.toBe(second.texture)
  expect(first.texture.height).toBe(64);expect(second.texture.height).toBe(64)
  expect([...f.renderer.filterImageFields.fields.values()]).toEqual([null])
})

test('uncached full-support uploads survive strip checkpoints and retire after scope end', async () => {
  const f=fixture(false),field=f.field({...f.support,h:64},0)
  f.renderer.bytes=80*1024*1024
  await f.renderer.reclaimScratch()
  expect(f.destroyed).not.toContain(field.texture)
  expect(f.field({...f.support,y:f.support.y+64,h:64},0).texture).toBe(field.texture)
  f.renderer.filterImageFields=undefined
  f.renderer.bytes=220*1024*1024
  await f.renderer.reclaimScratch()
  expect(f.driver.checkpoint).not.toHaveBeenCalled()
  expect(f.destroyed).not.toContain(field.texture)
  await f.renderer.reclaimScratch(64*1024*1024)
  expect(f.driver.checkpoint).toHaveBeenCalled()
  expect(f.destroyed).toContain(field.texture)
})

test('image paint transports the coordinate field origin independently of strip target', () => {
  const f=fixture();f.renderer.imageFor=()=>f.image;f.renderer.imageLevel=()=>0
  let parameters: Float32Array | undefined
  f.renderer.run=(_mode: number,_rect: Rect,_inputs: unknown[],configure: (u: Float32Array)=>void)=>{
    parameters=new Float32Array(256);configure(parameters);return f.image
  }
  const region={...f.support,y:f.support.y+64,h:64}
  f.renderer.sampleIndex=0
  f.renderer.paint({...f.node,rect:region},f.paint,{rect:region,texture:f.image.texture})
  expect([...parameters!.slice(204,206)]).toEqual([f.support.x,f.support.y])
})


test('an optional full-support precision failure still tries the valid strip', () => {
  const f=fixture(), original=kernel.image_sampling_axes_placed
  vi.spyOn(kernel,'image_sampling_axes_placed').mockImplementation((region,...args)=>{
    if(JSON.parse(region).h>64)throw Error('Composed precision guard')
    return original(region,...args)
  })
  const region={...f.support,h:64}, field=f.field(region,0)
  expect(field.rect).toEqual(region)
  expect(field.texture.width).toBe(80)
  expect([...f.renderer.filterImageFields.fields.values()]).toEqual([null])
})

test('optional support allocation falls back when only a strip field fits', () => {
  const f=fixture();f.renderer.bytes=f.renderer.frameBudget-3000
  const region={...f.support,h:64},field=f.field(region,0)
  expect(field.rect).toEqual(region)
  expect(field.texture.bytes).toBe(80*2*16)
  expect(f.renderer.workingBytes).toBeLessThanOrEqual(f.renderer.frameBudget)
})

test('a retained support cache hit avoids the WASM proof entirely', () => {
  const f=fixture(),first=f.field({...f.support,h:64},0)
  f.renderer.filterImageFields={rect:f.support,fields:new Map(),pinned:new Set()}
  const proof=vi.spyOn(kernel,'image_sampling_axes_placed')
  expect(f.field({...f.support,y:f.support.y+64,h:64},0).texture).toBe(first.texture)
  expect(proof).not.toHaveBeenCalled()
  expect(f.uploads).toHaveLength(1)
})
