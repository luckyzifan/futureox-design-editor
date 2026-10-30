import { afterEach, expect, test, vi } from 'vitest'
import { GpuRenderer, type Surface } from './renderer'
import { WebGpuDriver } from './webgpu'
import type { Driver, Rect, Texture } from './types'

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

/** Transport/ownership tests only. They intentionally do not execute WGSL,
 * create a device or claim arithmetic parity with the independent oracle. */
function fixture() {
  vi.stubEnv('VITE_DESIGN_EXACT_WHOLE_TENT_2048', '1')
  const owned = new Set<Texture>(), allocations: Texture[] = [], calls: { target: Texture; source: Texture; u: Float32Array; filter?: { radius: number } }[] = []
  const create = (width: number, height: number) => {
    const texture = { width, height, bytes: width * height * 16, resource: {} } as Texture
    owned.add(texture); allocations.push(texture); return texture
  }
  const driver = {
    name: 'webgpu', managed: true, displayMath: false, hdr: false, resourceEpoch: 2, completedResourceEpoch: 1,
    scratchBytes: 0, create, destroy: vi.fn((texture: Texture) => owned.delete(texture)), clear: vi.fn(),
    supportsExactWholeTentSource: vi.fn((texture: Texture) => owned.has(texture) &&
      !texture.binaryCoverage && !texture.scalarCoverage && !texture.uniformColor && !texture.transparentZero),
    pass: vi.fn((target: Texture, u: Float32Array, sources: Texture[], region?: Rect, channels?: number, filter?: { radius: number }) => {
      expect(region).toBeUndefined(); expect(channels).toBe(15)
      expect(target).not.toBe(sources[0]); expect(target.resource).not.toBe(sources[0].resource)
      calls.push({ target, source: sources[0], u: u.slice(), filter })
    }),
  }
  const renderer = new GpuRenderer(driver as unknown as Driver, true, false) as any
  const rect = { x: -30, y: 50, w: 7, h: 5 }
  renderer.scene = { integratedBlur: true, extent: rect, width: 7, height: 5, view: { x: 0, y: 0, zoom: 1 }, roots: [], nodes: {} }
  const input = renderer.acquire(rect) as Surface
  // Coefficient construction is a separate Rust/gpu oracle gate. Keep the
  // original real renderer exactTentAxis/run/destination/admission path here.
  const kernel = { texture: { width: 8, height: 1, bytes: 128, resource: {} } as Texture, rect: { x: 0, y: 0, w: 8, h: 1 } }
  renderer.filterKernel = vi.fn(() => kernel)
  renderer.certifiedKernel = vi.fn(() => undefined)
  return { renderer, driver, input, kernel, owned, allocations, calls,
    blur: (radius: number, clamp = false, admit = false) => renderer.blur(input, radius / 2, clamp, false, false, admit) as Surface | Promise<Surface> }
}

test.each([512 + 2 ** -43, 512.125, 1177.43901234567, 2048])('original radius %s takes full H then V without display selection', radius => {
  for (const clamp of [false, true]) for (const prefix of [false, true]) {
    const f = fixture(); f.renderer.prefixAllowed = prefix
    vi.stubEnv('VITE_DESIGN_DISPLAY_TENT_RADIUS', '1'); vi.stubEnv('VITE_DESIGN_EXACT_CLAMP_PREFIX', '1')
    f.renderer.scene.displayTentRadius = true
    const inputRect = { ...f.input.rect }, source = f.input.texture, alias = f.renderer.retain(f.input)
    const result = f.blur(radius, clamp) as Surface
    expect(f.calls).toHaveLength(2)
    const [h, v] = f.calls
    expect(h.source).toBe(source); expect(v.source).toBe(h.target); expect(result.texture).toBe(v.target)
    expect(result.rect).toEqual(inputRect); expect(f.input.rect).toEqual(inputRect)
    for (const [axis, call] of f.calls.entries()) {
      expect(Array.from(call.u.slice(0, 8))).toEqual([inputRect.x, inputRect.y, inputRect.w, inputRect.h, inputRect.x, inputRect.y, inputRect.w, inputRect.h])
      expect(Array.from(call.u.slice(36, 40))).toEqual([Math.fround(radius), axis, Number(clamp), 1])
      expect(call.filter?.radius).toBe(prefix ? radius : undefined)
    }
    expect(f.renderer.filterKernel.mock.calls.every((call: any[]) => call[0] === 'rational-tent' && Object.is(call[1], radius))).toBe(true)
    expect(f.renderer.displayTentRadiusPasses).toBe(0)
    expect(f.renderer.aliases.get(source)).toBe(2); expect(f.renderer.releasedAliases.has(f.input)).toBe(false)
    expect([...f.renderer.busy]).toEqual([source, result.texture])
    expect(f.renderer.poolReleaseEpoch.get(h.target)).toBe(2)
    expect(f.driver.completedResourceEpoch).toBe(1); expect(f.driver.destroy).not.toHaveBeenCalled()
    f.renderer.release(alias, result)
    expect([...f.renderer.busy]).toEqual([source])
  }
})

test.each([512 - 2 ** -44, 512])('radius %s retains the established <=512 lane', radius => {
  const f = fixture(), large = vi.spyOn(f.renderer, 'blurLargeExact')
  f.blur(radius)
  expect(large).not.toHaveBeenCalled(); expect(f.calls).toHaveLength(2)
})

test.each([513, 2048])('new-lane prehydration and both axes carry row policy explicitly at radius %s', radius => {
  const f = fixture(); f.blur(radius)
  expect(f.renderer.filterKernel.mock.calls).toHaveLength(3)
  expect(f.renderer.filterKernel.mock.calls.every((call: any[]) => call[4] === true)).toBe(true)
  expect(f.renderer.certifiedKernel.mock.calls).toHaveLength(3)
  expect(f.renderer.certifiedKernel.mock.calls.every((call: any[]) => call[2] === true)).toBe(true)
})

test('old <=512 axis calls do not carry the new row policy', () => {
  const f = fixture(); f.blur(512)
  expect(f.renderer.filterKernel.mock.calls.every((call: any[]) => call[4] !== true)).toBe(true)
  expect(f.renderer.certifiedKernel.mock.calls.every((call: any[]) => call[2] !== true)).toBe(true)
})

test.each(['off', 'unset', 'truthy', 'too-large', 'infinite', 'webgl', 'unmanaged', 'display-math', 'display-source',
  'display-image', 'software', 'logical', 'compact', 'identity', 'fractional-origin', 'large-origin',
  'size-mismatch', 'bytes-mismatch', 'binary', 'foreign', 'released', 'driver-decline', 'missing-proof'] as const)(
  '%s keeps the old guard without a large-path coefficient build or pass', mode => {
    const f = fixture(); let radius = 513
    if (mode === 'off') vi.stubEnv('VITE_DESIGN_EXACT_WHOLE_TENT_2048', '0')
    if (mode === 'unset') vi.stubEnv('VITE_DESIGN_EXACT_WHOLE_TENT_2048', undefined)
    if (mode === 'truthy') vi.stubEnv('VITE_DESIGN_EXACT_WHOLE_TENT_2048', 'true')
    if (mode === 'too-large') radius = 2048 + 2 ** -41
    if (mode === 'infinite') radius = Infinity
    if (mode === 'webgl') f.driver.name = 'webgl2'
    if (mode === 'unmanaged') f.driver.managed = false
    if (mode === 'display-math') f.driver.displayMath = true
    if (mode === 'display-source') f.renderer.scene.displayMaterialSource = true
    if (mode === 'display-image') f.renderer.scene.displayImageSource = true
    if (mode === 'software') f.renderer.scene.softwareRaster = true
    if (mode === 'logical') f.input.logicalBounds = { ...f.input.rect }
    if (mode === 'compact') f.input.compactMaxAbs = [1, 1, 1, 1]
    if (mode === 'identity') f.input.imageZeroOverIdentity = true
    if (mode === 'fractional-origin') f.input.rect.x = .1
    if (mode === 'large-origin') f.input.rect.x = 1048576
    if (mode === 'size-mismatch') f.input.texture.width--
    if (mode === 'bytes-mismatch') f.input.texture.bytes--
    if (mode === 'binary') f.input.texture.binaryCoverage = true
    if (mode === 'foreign') f.renderer.busy.delete(f.input.texture)
    if (mode === 'released') f.renderer.release(f.input)
    if (mode === 'driver-decline') f.driver.supportsExactWholeTentSource.mockReturnValue(false)
    if (mode === 'missing-proof') delete (f.driver as Partial<typeof f.driver>).supportsExactWholeTentSource
    expect(() => f.blur(radius)).toThrow('GPU 积分模糊半径超过 512 像素')
    expect(f.renderer.filterKernel).not.toHaveBeenCalled(); expect(f.driver.pass).not.toHaveBeenCalled()
  })

test('scalar, uniform, alpha-only and display-filter source contracts are not granted by the narrow operator', () => {
  for (const flag of ['scalarCoverage', 'uniformColor', 'transparentZero'] as const) {
    const f = fixture(); f.input.texture[flag] = true
    expect(f.renderer.blurLargeExact(f.input, 513, false, false, false)).toBeUndefined()
    expect(f.driver.pass).not.toHaveBeenCalled()
  }
  const f = fixture()
  expect(() => f.renderer.blur(f.input, 513 / 2, false, true)).toThrow('512')
  f.renderer.scene.displayFilters = true
  expect(f.renderer.blurLargeExact(f.input, 513, false, false, false)).toBeUndefined()
  expect(f.driver.pass).not.toHaveBeenCalled()
})

test.each(['scalarCoverage', 'uniformColor'] as const)('real blur entry cannot launder original %s through expansion', flag => {
  for (const gate of ['0', '1']) {
    const f = fixture(); vi.stubEnv('VITE_DESIGN_EXACT_WHOLE_TENT_2048', gate)
    f.input.texture[flag] = true
    const large = vi.spyOn(f.renderer, 'blurLargeExact')
    expect(() => f.blur(513)).toThrow('GPU 积分模糊半径超过 512 像素')
    // Keep the pre-existing expansion/error ordering, but never encode H/V
    // or build a new-lane coefficient packet from the expanded RGBA texture.
    expect(f.calls.map(call => call.u[16])).toEqual([0])
    expect(large).not.toHaveBeenCalled(); expect(f.renderer.filterKernel).not.toHaveBeenCalled()
    expect(f.renderer.releasedAliases.has(f.input)).toBe(false)
  }
})

test.each(['scalarCoverage', 'uniformColor'] as const)('real %s entry retains the exclusion through an admission wait', async flag => {
  for (const gate of ['0', '1']) {
    const f = fixture(); vi.stubEnv('VITE_DESIGN_EXACT_WHOLE_TENT_2048', gate)
    f.input.texture[flag] = true; f.renderer.frameBudget = f.input.texture.bytes * 2
    let resume!: () => void
    f.renderer.reclaimScratch = vi.fn(async () => {
      expect(f.renderer.admissionPins.has(f.input.texture)).toBe(true)
      await new Promise<void>(resolve => { resume = resolve })
      f.renderer.frameBudget = f.input.texture.bytes * 3
    })
    const pending = f.blur(513, false, true) as Promise<Surface>
    expect(f.driver.pass).not.toHaveBeenCalled(); resume()
    await expect(pending).rejects.toThrow('GPU 积分模糊半径超过 512 像素')
    expect(f.calls.map(call => call.u[16])).toEqual([0])
    expect(f.renderer.reclaimScratch).toHaveBeenCalledOnce(); expect(f.renderer.filterKernel).not.toHaveBeenCalled()
    expect(f.renderer.admissionPins.has(f.input.texture)).toBe(false)
  }
})

test.each(['scalarCoverage', 'uniformColor'] as const)('removing %s during admission cannot restore a false original-source permission', async flag => {
  const f = fixture(); f.input.texture[flag] = true; f.renderer.frameBudget = f.input.texture.bytes * 2
  let resume!: () => void
  f.renderer.reclaimScratch = vi.fn(async () => {
    await new Promise<void>(resolve => { resume = resolve })
    f.renderer.frameBudget = f.input.texture.bytes * 3
  })
  const pending = f.blur(513, false, true) as Promise<Surface>
  delete f.input.texture[flag]; resume()
  await expect(pending).rejects.toThrow('GPU 积分模糊半径超过 512 像素')
  expect(f.driver.pass).not.toHaveBeenCalled(); expect(f.renderer.filterKernel).not.toHaveBeenCalled()
})

test.each(['scalarCoverage', 'uniformColor'] as const)('adding %s across an ordinary-source admission revokes new-lane authority', async flag => {
  const f = fixture(); f.renderer.frameBudget = f.input.texture.bytes * 2
  let resume!: () => void
  f.renderer.reclaimScratch = vi.fn(async () => {
    await new Promise<void>(resolve => { resume = resolve })
    f.renderer.frameBudget = f.input.texture.bytes * 3
  })
  const pending = f.blur(513, false, true) as Promise<Surface>
  f.input.texture[flag] = true; resume()
  await expect(pending).rejects.toThrow('GPU 积分模糊半径超过 512 像素')
  expect(f.calls.map(call => call.u[16])).toEqual([0])
  expect(f.renderer.reclaimScratch).toHaveBeenCalledOnce()
})

test.each(['scalarCoverage', 'uniformColor'] as const)('%s <=512 behavior and prior allocation-error ordering stay unchanged', flag => {
  for (const gate of ['0', '1']) {
    const f = fixture(); vi.stubEnv('VITE_DESIGN_EXACT_WHOLE_TENT_2048', gate)
    f.input.texture[flag] = true
    f.blur(512)
    expect(f.calls.map(call => call.u[16])).toEqual([0, 22, 22])
    const tight = fixture(); vi.stubEnv('VITE_DESIGN_EXACT_WHOLE_TENT_2048', gate)
    tight.input.texture[flag] = true; tight.renderer.frameBudget = tight.input.texture.bytes
    expect(() => tight.blur(513)).toThrow('GPU 表面内存预算超限')
    expect(tight.driver.pass).not.toHaveBeenCalled()
  }
})

test('existing all-zero shortcut stays ahead of large-radius/source eligibility under either gate', () => {
  for (const gate of ['0', '1']) {
    const f = fixture(); vi.stubEnv('VITE_DESIGN_EXACT_WHOLE_TENT_2048', gate)
    f.input.texture.transparentZero = true
    expect(f.blur(4096)).toBe(f.input)
    expect(f.driver.pass).not.toHaveBeenCalled(); expect(f.driver.supportsExactWholeTentSource).not.toHaveBeenCalled()
    expect(f.renderer.filterKernel).not.toHaveBeenCalled()
  }
})

test('HDR source admission does not require a finite/opaque certificate (not an arithmetic test)', () => {
  const f = fixture(); f.driver.hdr = true
  expect(f.input.texture.finitePixels).toBeUndefined(); expect(f.input.texture.opaqueAlpha).toBeUndefined()
  f.blur(612.0000000000001, true)
  expect(f.calls).toHaveLength(2); expect(f.calls.every(call => call.filter!.radius === 612.0000000000001)).toBe(true)
})

test('both outputs must fit the unchanged budget before H is encoded', () => {
  const f = fixture(); f.renderer.frameBudget = f.input.texture.bytes * 2
  expect(() => f.blur(513)).toThrow('GPU 表面内存预算超限')
  expect(f.driver.pass).not.toHaveBeenCalled(); expect([...f.renderer.busy]).toEqual([f.input.texture])
  expect(f.driver.destroy).not.toHaveBeenCalled(); expect(f.driver.completedResourceEpoch).toBe(1)
})

test.each([0, 1])('axis %s failure propagates and releases only the private outputs to the ordered pool', axis => {
  const f = fixture(); f.driver.pass.mockImplementationOnce(() => { if (!axis) throw Error('axis failure') })
  if (axis) f.driver.pass.mockImplementationOnce(() => { throw Error('axis failure') })
  expect(() => f.blur(513)).toThrow('axis failure')
  expect([...f.renderer.busy]).toEqual([f.input.texture]); expect(f.renderer.releasedAliases.has(f.input)).toBe(false)
  expect(f.driver.destroy).not.toHaveBeenCalled(); expect(f.driver.completedResourceEpoch).toBe(1)
  expect(f.driver.pass).toHaveBeenCalledTimes(axis + 1)
})

test.each(['complete', 'cancel', 'source-revoked'] as const)('one admission pins the original source, then rechecks %s', async mode => {
  const f = fixture(); f.renderer.frameBudget = f.input.texture.bytes * 2
  let current = true, resume!: () => void
  f.renderer.frameCurrent = () => current
  f.renderer.reclaimScratch = vi.fn(async () => {
    expect(f.renderer.admissionPins.has(f.input.texture)).toBe(true)
    expect(f.renderer.aliases.get(f.input.texture)).toBe(2)
    await new Promise<void>(resolve => { resume = resolve })
    f.renderer.frameBudget = f.input.texture.bytes * 3
  })
  const pending = f.blur(513, false, true) as Promise<Surface>
  expect(f.driver.pass).not.toHaveBeenCalled()
  if (mode === 'cancel') current = false
  if (mode === 'source-revoked') f.driver.supportsExactWholeTentSource.mockReturnValue(false)
  resume()
  if (mode === 'complete') {
    const result = await pending
    expect(f.calls).toHaveLength(2); f.renderer.release(result)
  } else await expect(pending).rejects.toThrow(mode === 'cancel' ? 'PREVIEW_CANCELLED' : '512')
  expect(f.renderer.reclaimScratch).toHaveBeenCalledOnce()
  expect(f.renderer.aliases.get(f.input.texture)).toBe(1); expect(f.renderer.admissionPins.has(f.input.texture)).toBe(false)
  expect([...f.renderer.busy]).toEqual([f.input.texture]); expect(f.driver.destroy).not.toHaveBeenCalled()
})

function driverFixture() {
  vi.stubGlobal('OffscreenCanvas', class {})
  vi.stubGlobal('GPUTextureUsage', { TEXTURE_BINDING: 1, RENDER_ATTACHMENT: 2, COPY_SRC: 4, COPY_DST: 8 })
  const driver = new WebGpuDriver(true)
  Object.assign(driver, { encoder: {}, filterPipelines: [{}, {}, {}, {}], device: {
    limits: { maxTextureDimension2D: 8192 },
    createTexture: ({ size, format, usage }: any) => ({ width: size[0], height: size[1], format, usage,
      dimension: '2d', depthOrArrayLayers: 1, sampleCount: 1, destroy() {} }),
  } })
  const source = driver.create(7, 5)
  return { driver, source }
}

test('private driver record verifies physical format and lifetime without creating a GPU device', () => {
  const f = driverFixture()
  expect(f.driver.supportsExactWholeTentSource(f.source)).toBe(true)
  expect(f.driver.supportsExactWholeTentSource({ ...f.source })).toBe(false)
  f.driver.destroy(f.source)
  expect(f.driver.supportsExactWholeTentSource(f.source)).toBe(false)
})

test.each(['byte', 'scalar', 'resource', 'dimensions', 'bytes', 'format', 'array', 'samples', 'usage',
  'pipelines', 'display-math', 'display-filter', 'disposed'] as const)('%s cannot masquerade as an eligible exact RGBA32F allocation', mode => {
  const f = driverFixture(), raw = f.driver as any, resource = f.source.resource as any
  if (mode === 'byte') f.source.binaryCoverage = true
  if (mode === 'scalar') f.source.scalarCoverage = true
  if (mode === 'resource') f.source.resource = { ...resource }
  if (mode === 'dimensions') f.source.width--
  if (mode === 'bytes') f.source.bytes--
  if (mode === 'format') resource.format = 'rgba16float'
  if (mode === 'array') resource.depthOrArrayLayers = 2
  if (mode === 'samples') resource.sampleCount = 4
  if (mode === 'usage') resource.usage = 4
  if (mode === 'pipelines') raw.filterPipelines = []
  if (mode === 'display-math') raw.displayMath = true
  if (mode === 'display-filter') raw.displayFilters = true
  if (mode === 'disposed') raw.disposed = true
  expect(f.driver.supportsExactWholeTentSource(f.source)).toBe(false)
})


test.each(['retained','capturing'])('explicit exact operator retains full source ownership during %s interaction',mode=>{
  const f=fixture()
  if(mode==='retained')f.renderer.scene.interactionRetained=true
  else f.renderer.interactionCapturing=true
  const result=f.blur(513) as Surface
  expect(f.calls.map(call=>call.u[37])).toEqual([0,1])
  expect(f.calls[0].source).toBe(f.input.texture)
  expect(f.renderer.releasedAliases.has(f.input)).toBe(false)
  f.renderer.release(result)
})

test('banded exact retained filter keeps complete H as V input and releases strips without completion credit',async()=>{
  const f=fixture();f.renderer.scene.interactionRetained=true
  const copies:any[]=[]
  ;(f.driver as any).copyRegion=(to:Texture,from:Texture,region:Rect,origin:number[])=>copies.push({to,from,region,origin})
  const result=await f.blur(513,true,true)
  expect(copies).toHaveLength(2)
  expect(copies[0].to).toBe(f.calls[1].source)
  expect(copies[1].to).toBe(result.texture)
  expect(copies.map(c=>c.origin)).toEqual([[0,0],[0,0]])
  expect(f.driver.completedResourceEpoch).toBe(1)
  expect([...f.renderer.busy]).toEqual([f.input.texture,result.texture])
})
