import { afterEach, expect, test, vi } from 'vitest'
import { exactFilterKey, fullAnalyticCoverage, fullSampleCoverage, HorizontalFilterCache, HORIZONTAL_FILTER_CACHE_BYTES } from './horizontal-filter-cache'
import { GpuRenderer, type Surface } from './renderer'
import type { Driver, GpuNode, GpuPaint, GpuScene, PathMesh, Rect, Texture } from './types'

afterEach(() => vi.unstubAllEnvs())
function coverage(rect: Rect) {
  const header = 1 + rect.h * 4, curves = new Float32Array((header + rect.h * 4 * 3) * 4)
  curves.set([3, 1, rect.w, rect.h])
  for (let row = 0; row < rect.h * 4; row++) {
    curves.set([header + row * 3, 1, 0, 0], 4 + row * 4)
    curves.set([0, rect.w, 0, 0], (header + row * 3) * 4)
  }
  return { curves, path: { rect, count: 3, first: 0, rule: 'nonzero', sampleCount: 4,
    area: { first: 0, count: curves.length / 4 } } as PathMesh }
}
function plane(r: Rect = { x: 0, y: 0, w: 8, h: 12 }): Surface {
  return { rect: r, texture: { width: r.w, height: r.h, bytes: r.w * r.h * 16, resource: {} } as Texture }
}
test('actual interval layout certifies every selected sample row, but a tiny endpoint remainder declines', () => {
  const c = coverage({ x: -1229, y: -1229, w: 3486, h: 3486 }), r = { x: -1228, y: -1228, w: 3484, h: 3484 }
  expect(fullSampleCoverage(c.path, c.curves, r)).toBe(true)
  c.curves[c.curves[4 + (1750 * 4 + 2) * 4] * 4 + 4] = 1
  expect(fullSampleCoverage(c.path, c.curves, r)).toBe(false)
})
test('partial coverage, holes, multiple intervals, corrupt offsets and non-sample programs decline', () => {
  for (const change of [
    (c: ReturnType<typeof coverage>) => { c.curves[0] = 4 },
    (c: ReturnType<typeof coverage>) => { c.curves[5] = 0 },
    (c: ReturnType<typeof coverage>) => { c.curves[5] = 2 },
    (c: ReturnType<typeof coverage>) => { c.curves[4] = 0 },
    (c: ReturnType<typeof coverage>) => { c.curves[4] = c.curves.length },
    (c: ReturnType<typeof coverage>) => { c.curves[c.curves[4] * 4 + 1] = 7 },
    (c: ReturnType<typeof coverage>) => { c.curves[c.curves[4] * 4 + 2] = 1 },
  ]) { const c = coverage({ x: -2, y: 5, w: 8, h: 9 }); change(c); expect(fullSampleCoverage(c.path, c.curves, c.path.rect)).toBe(false) }
  const c = coverage({ x: 0, y: 0, w: 8, h: 9 })
  for (const r of [{ x: -.5, y: 0, w: 8, h: 9 }, { x: 0, y: -1, w: 8, h: 9 }, { x: 0, y: 0, w: 9, h: 9 }]) expect(fullSampleCoverage(c.path, c.curves, r)).toBe(false)
})
test('analytic Gaussian reuse requires each of the eight source scanlines to cover the row exactly', () => {
  const rect={x:-3,y:-5,w:8,h:2},rows=rect.h*8,header=1+rows
  const curves=new Float32Array((header+rows*3)*4)
  curves.set([0,1,rect.w,rect.h])
  for(let row=0;row<rows;row++){
    curves.set([header+row*3,1,0,0],4+row*4)
    curves.set([0,rect.w,0,0],(header+row*3)*4)
  }
  const path={rect,count:3,first:0,rule:'nonzero',area:{first:0,count:curves.length/4}} as PathMesh
  expect(fullAnalyticCoverage(path,curves,rect)).toBe(true)
  curves[(header+8*3)*4+4]=1
  expect(fullAnalyticCoverage(path,curves,rect)).toBe(false)
  expect(fullAnalyticCoverage(path,curves,{...rect,h:1})).toBe(true)
  expect(fullAnalyticCoverage(path,curves,{...rect,w:9})).toBe(false)
})
test('keys retain f64 bits, value types and nested adjustments; nonfinite values decline', () => {
  const keys = [0, -0, 1, 1 + 2 ** -52, '0', ['number', 0, 0], { negativeZero: true }].map(v => exactFilterKey([v]))
  expect(new Set(keys).size).toBe(keys.length)
  expect(exactFilterKey([{ b: 2, a: 1 }])).toBe(exactFilterKey([{ a: 1, b: 2 }]))
  expect(exactFilterKey([{ adjust: { exposure: 0 } }])).not.toBe(exactFilterKey([{ adjust: { exposure: -0 } }]))
  expect(exactFilterKey([Infinity])).toBeUndefined(); expect(exactFilterKey([{ radius: NaN }])).toBeUndefined()
})
test('pending planes require successful finish and matching owner, key, image and column', () => {
  const released: Surface[] = [], cache = new HorizontalFilterCache(p => released.push(p)), lease = {}, image = plane().texture, p = plane()
  expect(cache.stage(lease, 'key', image, p)).toBe(true); expect(cache.get(lease, 'key', image, p.rect)).toBeUndefined(); cache.finish(true)
  const next = { x: 0, y: 4, w: 8, h: 12 }
  expect(cache.get(lease, 'key', image, next)?.overlap).toEqual({ x: 0, y: 4, w: 8, h: 8 })
  expect(cache.get({}, 'key', image, next)).toBeUndefined(); expect(cache.get(lease, 'other', image, next)).toBeUndefined()
  expect(cache.get(lease, 'key', plane().texture, next)).toBeUndefined(); expect(cache.get(lease, 'key', image, { ...next, x: 1 })).toBeUndefined()
  cache.begin(lease); expect(cache.has(p.texture)).toBe(true); cache.begin({}); expect(cache.bytes).toBe(0); expect(released).toEqual([p])
})
test('single-entry ceiling, failure and owner retirement release ownership exactly once', () => {
  const released: Surface[] = [], cache = new HorizontalFilterCache(p => released.push(p)), lease = {}, image = plane().texture
  const huge = plane(); huge.texture.bytes = HORIZONTAL_FILTER_CACHE_BYTES + 1
  expect(cache.stage(lease, 'key', image, huge)).toBe(false); expect(released).toEqual([])
  const a = plane(), b = plane(); cache.stage(lease, 'a', image, a); cache.finish(true); cache.stage(lease, 'b', image, b)
  expect(released).toEqual([a]); expect(cache.bytes).toBe(b.texture.bytes); cache.clear({}); expect(cache.has(b.texture)).toBe(true)
  cache.finish(false); cache.clear(); expect(released).toEqual([a, b]); expect(cache.bytes).toBe(0)
})
/** CPU command model: production stream/cache control, independent sample and
 * neighborhood arithmetic. Actual shader/device parity is a separate gate. */
function streamFixture() {
  const pixels = new Map<Texture, Float32Array>(), copies: Rect[] = [], samples: Rect[] = []
  const create = (w: number, h: number) => { const t = plane({ x: 0, y: 0, w, h }).texture; pixels.set(t, new Float32Array(w * h * 4)); return t }
  const rawCopy = (target: Texture, source: Texture, r: Rect, origin: [number, number]) => {
    const a = new Uint32Array(pixels.get(source)!.buffer), b = new Uint32Array(pixels.get(target)!.buffer)
    for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) for (let c = 0; c < 4; c++)
      b[((y + origin[1]) * target.width + x + origin[0]) * 4 + c] = a[((y + r.y) * source.width + x + r.x) * 4 + c]
  }
  const driver = { name: 'cpu-command-model', managed: true, exactImageResolveStep: true, sequentialSampleResolve: true,
    create, createBinaryCoverage: create, clear: (t: Texture) => pixels.get(t)!.fill(0), maskRegion() {}, destroy: (t: Texture) => pixels.delete(t),
    pass(target: Texture, u: Float32Array, inputs: Texture[], region?: Rect) { expect(u[16]).toBe(0); rawCopy(target, inputs[0], {x:0,y:0,w:inputs[0].width,h:inputs[0].height}, [region!.x,region!.y]) },
    copyRegion(target: Texture, source: Texture, r: Rect, origin: [number, number]) { copies.push(r); rawCopy(target, source, r, origin) },
  } as unknown as Driver
  const renderer = new GpuRenderer(driver, true, false) as any, lease = {}, shape = { x: -100, y: -100, w: 256, h: 256 }, c = coverage(shape)
  const paint = { id: 'paint', kind: 'image', color: '#000000', image: 'data:image/png;base64,eA==', fit: 'cover', visible: true,
    blend: 'normal', opacity: 1, angle: 0, stops: [] } as GpuPaint
  const node = { id: 'image', rect: shape, matrix: [1,0,0,1,0,0], inverse: [1,0,0,1,0,0], size: [256,256], fills: [paint],
    fill: c.path, children: [], strokes: [], opacity: .48, blend: 'normal', effects: [{ kind: 'blur', radius: 64, visible: true }] } as unknown as GpuNode
  renderer.scene = { integratedBlur: true, coherentSamples: true, filterBatchLease: lease, curves: c.curves, nodes: { image: node }, view: { x: 0, y: 0, zoom: 1 } }
  const image = { rect: {x:0,y:0,w:736,h:414}, texture: { ...plane().texture, finitePixels: true as true | undefined } }
  renderer.imageFor = () => image; renderer.baseDims = () => [736,414]
  renderer.resolveFilterImageSample = (_n: GpuNode, r: Rect, sample: number, previous?: Surface) => {
    samples.push(r); const out = renderer.acquire(r), data = pixels.get(out.texture)!, prior = previous && pixels.get(previous.texture)!
    for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) for (let c = 0; c < 4; c++) {
      const at = (y * r.w + x) * 4 + c, value = Math.fround(((r.x + x) * .13 + (r.y + y) * .07 + c + sample * .019) * .25)
      data[at] = sample ? Math.fround(prior![at] + value) : value
    } return out
  }
  renderer.exactTentAxis = (input: Surface, _radius: number, axis: number, output: Rect) => {
    const out = renderer.acquire(output), source = pixels.get(input.texture)!, data = pixels.get(out.texture)!
    for (let y = 0; y < output.h; y++) for (let x = 0; x < output.w; x++) for (let c = 0; c < 4; c++) {
      let sum = 0
      for (let offset = -2; offset <= 2; offset++) {
        const ix = output.x + x - input.rect.x + (axis === 0 ? offset : 0), iy = output.y + y - input.rect.y + (axis === 1 ? offset : 0)
        const v = ix < 0 || iy < 0 || ix >= input.rect.w || iy >= input.rect.h ? 0 : source[(iy * input.rect.w + ix) * 4 + c]
        sum = Math.fround(sum + Math.fround(v * .2))
      } data[(y * output.w + x) * 4 + c] = sum
    } return out
  }
  renderer.merge = (source: Surface, target: Surface) => { const out = renderer.acquire(target.rect); rawCopy(out.texture, source.texture, {x:0,y:0,w:target.rect.w,h:target.rect.h}, [0,0]); renderer.release(target); return out }
  const run = async (y: number) => {
    renderer.horizontalFilters.begin(lease)
    const r = { x: 0, y, w: 8, h: 8 }, targets = Array.from({length:4}, () => renderer.acquire(r))
    const out = await renderer.streamIsolatedFilter(node, targets) as Surface[], data = new Uint32Array(pixels.get(out[0].texture)!.buffer).slice()
    renderer.release(...out); renderer.horizontalFilters.finish(true); return data
  }
  return { renderer, driver, lease, node, image, copies, samples, run }
}
test('adjacent vertical tile copies exact overlap and computes only the missing rows', async () => {
  const f = streamFixture(); await f.run(0); const before = f.samples.length, actual = await f.run(4)
  expect(f.copies).toEqual([{ x: 0, y: 4, w: 8, h: 134 }]); expect(f.samples.slice(before)).toHaveLength(4)
  expect(f.samples.slice(before).every(r => r.y === 73 && r.h === 4)).toBe(true)
  expect(f.renderer.horizontalFilterHits).toBe(1); expect(f.renderer.horizontalFilterPixels).toBe(8 * 134)
  expect(f.renderer.horizontalFilterRows).toBe(134)
  const reference = streamFixture(); vi.stubEnv('VITE_DESIGN_HORIZONTAL_FILTER_REUSE', '0'); expect(actual).toEqual(await reference.run(4))
})
test('upward overlap stays exact; changed matrix, mip policy and missing finite proof decline', async () => {
  const f = streamFixture(); await f.run(4); const actual = await f.run(0)
  expect(f.copies[0]).toEqual({ x: 0, y: 0, w: 8, h: 134 })
  const reference = streamFixture(); vi.stubEnv('VITE_DESIGN_HORIZONTAL_FILTER_REUSE', '0'); expect(actual).toEqual(await reference.run(0)); vi.unstubAllEnvs()
  f.node.matrix[4] = -0; await f.run(4); expect(f.copies).toHaveLength(1)
  f.renderer.imageMips = true; await f.run(8); expect(f.copies).toHaveLength(1)
  f.renderer.imageMips = false; delete f.image.texture.finitePixels; await f.run(12); expect(f.copies).toHaveLength(1)
})
function lifecycleFixture() {
  let current = true, fail = false, inject = true, candidate: Surface | undefined
  const driver = { name:'webgpu',managed:true,description:'no-pixel lifecycle',lost:false,scratchBytes:0,drawCalls:0,triangles:0,resourceEpoch:7,
    begin() {},create:(w:number,h:number)=>plane({x:0,y:0,w,h}).texture,destroy:vi.fn(),clear(){},
    pass() {if(inject){inject=false;candidate=renderer.acquire({x:0,y:0,w:8,h:8});renderer.horizontalFilters.stage(lease,'key',image,candidate)}},
    async finish(){if(fail)throw Error('finish failed');return {}},abortFrameAndReleaseFilterScratch:vi.fn(async()=>{}),dispose(){},
  } as unknown as Driver
  const renderer = new GpuRenderer(driver,true,false) as any,lease={},image=plane().texture
  const scene = {version:7,width:8,height:8,extent:{x:0,y:0,w:8,h:8},floatCompositing:true,background:'#ffffff',transparent:false,grid:false,
    view:{x:0,y:0,zoom:1},roots:[],nodes:{},vertices:[],filterBatchLease:lease} as GpuScene
  return {renderer,driver,scene,lease,get candidate(){return candidate!},cancel(){current=false},fail(){fail=true},current:()=>current}
}
test('successful finish protects cache from busy sweep; batch retirement retains pool epoch', async () => {
  const f=lifecycleFixture();await f.renderer.render(f.scene,false,false,f.current)
  expect(f.renderer.horizontalFilters.has(f.candidate.texture)).toBe(true);expect(f.renderer.busy.has(f.candidate.texture)).toBe(true)
  f.renderer.releaseFilterBatch(f.lease);expect(f.renderer.horizontalFilters.bytes).toBe(0);expect(f.renderer.busy.has(f.candidate.texture)).toBe(false)
  expect(f.renderer.poolReleaseEpoch.get(f.candidate.texture)).toBe(7);expect(f.driver.destroy).not.toHaveBeenCalled()
})
test('failed finish and cancellation after finish publish no cache entry', async () => {
  const failed=lifecycleFixture();failed.fail();await expect(failed.renderer.render(failed.scene,false,false,failed.current)).rejects.toThrow('finish failed')
  expect(failed.renderer.horizontalFilters.bytes).toBe(0)
  const cancelled=lifecycleFixture();cancelled.driver.finish=vi.fn(async()=>{cancelled.cancel();return {}})
  await cancelled.renderer.render(cancelled.scene,false,false,cancelled.current);expect(cancelled.renderer.horizontalFilters.bytes).toBe(0)
})
test('allocation pressure retires optional cache through the existing pool without increasing the budget', async () => {
  const f=lifecycleFixture();await f.renderer.render(f.scene,false,false,f.current)
  f.renderer.used.clear()
  f.renderer.frameBudget=f.renderer.bytes
  const budget=f.renderer.frameBudget
  expect(f.renderer.overBudget(16)).toBe(false)
  expect(f.renderer.horizontalFilters.bytes).toBe(0)
  expect(f.renderer.frameBudget).toBe(budget)
  expect(f.renderer.workingBytes+16).toBeLessThanOrEqual(budget)
  expect(f.driver.destroy).toHaveBeenCalledWith(f.candidate.texture)
})
