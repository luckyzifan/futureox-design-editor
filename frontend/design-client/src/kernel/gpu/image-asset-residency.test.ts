import { afterEach, expect, test, vi } from 'vitest'
import { GpuRenderer } from './renderer'
import { WebGpuDriver } from './webgpu'
import type { Driver, GpuScene, Texture } from './types'
import { DecodedImageCache, createDecodedImageOwner, decodedImageScope } from '../decoded-image-cache'
import { imageLoaderResidencyOwner, imageResidencyOwnerCurrent, managedSceneImageLoader, type ImageContext } from '../scene-image-hydration'

afterEach(() => vi.unstubAllEnvs())
const A = 'data:image/png;base64,QQ==', B = 'data:image/png;base64,Qg=='
function scene(uris: string[]): GpuScene {
  return { version: 8, width: 8, height: 8, extent: { x: 0, y: 0, w: 8, h: 8 },
    view: { x: 0, y: 0, zoom: 1 }, transparent: true, background: '#ffffff', grid: false,
    roots: uris.map((_, i) => String(i)), vertices: [], floatCompositing: true,
    nodes: Object.fromEntries(uris.map((image, i) => [String(i), { id: String(i), children: [],
      fills: [{ kind: 'image', image, visible: true }], strokes: [], effects: [], matrix: [1, 0, 0, 1, 0, 0] }])) } as unknown as GpuScene
}
function fixture() {
  vi.stubEnv('VITE_DESIGN_EXACT_CLAMP_PREFIX', '0')
  vi.stubEnv('VITE_DESIGN_IMAGE_ASSET_RESIDENCY', '1')
  let pixels = .125, ownerCurrent = true, requestCurrent = true
  const decode = () => new Float32Array(16).fill(pixels)
  const kernel = { image_info: vi.fn(() => '[2,2]'), image_info_at_level: vi.fn(() => '[1,1]'),
    image_linear: vi.fn(decode), image_linear_at_level: vi.fn(() => new Float32Array(4).fill(pixels)),
    image_rgba8: vi.fn(() => new Uint8Array(16)), image_rgba8_at_level: vi.fn(() => new Uint8Array(4)) }
  let context: ImageContext = { kernel, scope: 'private-owner-A', settings: 'null',
    current: () => requestCurrent, ownerCurrent: () => ownerCurrent }
  const load = managedSceneImageLoader(new DecodedImageCache(0), () => context,
    { key: async () => undefined, read: async () => undefined, write() {} })
  const uploaded: { texture: Texture; pixels: Float32Array }[] = []
  const driver = { name: 'webgpu', managed: true, hdr: false, linearLight: true,
    scratchBytes: 0, resourceEpoch: 1, completedResourceEpoch: 1,
    uploadLinear: vi.fn((data: Float32Array, width: number, height: number) => {
      const texture = { width, height, bytes: data.byteLength, resource: {} } as Texture
      uploaded.push({ texture, pixels: data.slice() }); return texture
    }), destroy: vi.fn(), dispose: vi.fn(), waitForSubmittedWork: vi.fn(async () => {}), checkpoint: vi.fn(async () => {
      // Production checkpoint covers the submitted prefix but reserves the
      // current frame epoch for commands encoded after that prefix.
      driver.completedResourceEpoch = Math.max(driver.completedResourceEpoch, driver.resourceEpoch - 1)
    }) }
  const renderer = new GpuRenderer(driver as unknown as Driver, true, false, load) as any
  const region = async (uris: string[]) => {
    renderer.scene = scene(uris); renderer.used.clear(); await renderer.loadImages(renderer.scene)
  }
  return { renderer, driver, kernel, load, uploaded, region,
    get context() { return context }, set context(value: ImageContext) { context = value },
    setPixels(value: number) { pixels = value }, setOwner(value: boolean) { ownerCurrent = value },
    setRequest(value: boolean) { requestCurrent = value } }
}

test('same private owner retains exact GPU assets for region A -> B -> A without a third upload or new range proof', async () => {
  const f = fixture()
  await f.region([A]); const a = f.renderer.imageFor(A)
  await f.region([B]); f.renderer.imageFor(B)
  await f.region([A]); expect(f.renderer.imageFor(A)).toBe(a)
  expect(f.driver.uploadLinear).toHaveBeenCalledTimes(2); expect(f.kernel.image_linear).toHaveBeenCalledTimes(2)
  expect(f.driver.destroy).not.toHaveBeenCalled(); expect(f.driver.checkpoint).not.toHaveBeenCalled()
  expect(f.driver.waitForSubmittedWork).not.toHaveBeenCalled()
  expect(f.renderer.bytes).toBe(128); expect(f.renderer.imageAssetCounters).toEqual({ hits: 1, uploads: 2,
    scopeRetiredTextures: 0, legacyPrunes: 0, pressureEvictions: 0 })
})

test('admitted canvas / interaction snapshots share GPU pixels across decoder and request lifetimes',async()=>{
  const f=fixture(),resourceOwner=createDecodedImageOwner(),scope=decodedImageScope(resourceOwner,'null')
  let canvas=true,interaction=true
  f.context={...f.context,resourceOwner,scope,ownerCurrent:()=>canvas}
  await f.region([A]);const original=f.renderer.imageFor(A),proof=imageLoaderResidencyOwner(f.load)
  canvas=false
  f.context={...f.context,kernel:{...f.kernel},current:()=>true,ownerCurrent:()=>interaction}
  await f.region([A]);expect(f.renderer.imageFor(A)).toBe(original)
  expect(imageLoaderResidencyOwner(f.load)).toBe(proof)
  expect(f.driver.uploadLinear).toHaveBeenCalledOnce();expect(f.driver.destroy).not.toHaveBeenCalled()
  expect(f.driver.waitForSubmittedWork).not.toHaveBeenCalled()
  interaction=false;expect(imageResidencyOwnerCurrent(proof!)).toBe(false)
  f.context={...f.context,kernel:f.kernel,ownerCurrent:()=>true}
  await f.region([A]);expect(f.renderer.imageFor(A).texture).not.toBe(original.texture)
  expect(f.driver.uploadLinear).toHaveBeenCalledTimes(2)
})

test.each(['foreign-token','scope-mismatch','different-token','changed-settings'] as const)('cross-decoder %s cannot borrow the old GPU asset',async mode=>{
  const f=fixture(),resourceOwner=createDecodedImageOwner(),scope=decodedImageScope(resourceOwner,'null')
  f.context={...f.context,resourceOwner,scope}
  await f.region([A]);const original=f.renderer.imageFor(A)
  f.context={...f.context,kernel:{...f.kernel}}
  if(mode==='foreign-token')f.context={...f.context,resourceOwner:{} as any}
  if(mode==='scope-mismatch')f.context={...f.context,scope:'unproven'}
  if(mode==='different-token')f.context={...f.context,resourceOwner:createDecodedImageOwner()}
  if(mode==='changed-settings')f.context={...f.context,settings:'{}'}
  await f.region([A]);expect(f.renderer.imageFor(A).texture).not.toBe(original.texture)
  expect(f.driver.uploadLinear).toHaveBeenCalledTimes(2)
})

test('the existing filter candidate retains its image ownership policy', async () => {
  const f = fixture()
  vi.stubEnv('VITE_DESIGN_EXACT_CLAMP_PREFIX', '1')
  vi.stubEnv('VITE_DESIGN_IMAGE_ASSET_RESIDENCY', '0')
  await f.region([A]); const a = f.renderer.imageFor(A)
  await f.region([B]); f.renderer.imageFor(B)
  await f.region([A]); expect(f.renderer.imageFor(A)).toBe(a)
  expect(f.driver.uploadLinear).toHaveBeenCalledTimes(2)
})

test.each(['unknown', 'no-owner', 'default-off'] as const)('%s loader retains the old region pruning policy', async mode => {
  const f = fixture()
  if (mode === 'unknown') {
    const custom = (_uri: string) => ({ width: 2, height: 2, pixels: new Float32Array(16) })
    Object.assign(custom, { ownerCurrent: () => true, scope: 'private-owner-A' })
    f.renderer.managedImageLoader = custom
  }
  if (mode === 'no-owner') f.context = { ...f.context, ownerCurrent: undefined }
  if (mode === 'default-off') vi.stubEnv('VITE_DESIGN_IMAGE_ASSET_RESIDENCY', '0')
  await f.region([A]); const a = f.renderer.imageFor(A)
  await f.region([B]); f.renderer.imageFor(B)
  expect(f.renderer.images.has(A)).toBe(false); expect(f.driver.destroy).toHaveBeenCalledWith(a.texture)
  expect(f.renderer.imageAssetCounters.legacyPrunes).toBe(1)
})

test.each(['scope', 'settings', 'kernel', 'scene-policy', 'loader'] as const)('%s change never reuses the old same-URI GPU resource', async mode => {
  const f = fixture(); await f.region([A]); const first = f.renderer.imageFor(A)
  if (mode === 'scope') { f.context = { ...f.context, scope: 'private-owner-B' }; f.setPixels(.75) }
  if (mode === 'settings') f.context = { ...f.context, settings: '{"space":"other"}' }
  if (mode === 'kernel') f.context = { ...f.context, kernel: { ...f.kernel } }
  if (mode === 'scene-policy') {
    f.renderer.scene = { ...scene([A]), colorManagement: { fixture: 'changed' } }
    await f.renderer.loadImages(f.renderer.scene)
  } else {
    if (mode === 'loader') f.renderer.managedImageLoader = managedSceneImageLoader(new DecodedImageCache(0), () => f.context,
      { key: async () => undefined, read: async () => undefined, write() {} })
    await f.region([A])
  }
  expect(f.renderer.imageFor(A).texture).not.toBe(first.texture)
  expect(f.driver.destroy).toHaveBeenCalledWith(first.texture); expect(f.driver.uploadLinear).toHaveBeenCalledTimes(2)
  if (mode === 'scope') expect(f.uploaded[1].pixels).toEqual(new Float32Array(16).fill(.75))
  expect(f.renderer.imageAssetCounters.scopeRetiredTextures).toBe(1)
})

test('request cancellation grants no pixels but a new same-owner request reuses the asset', async () => {
  const f = fixture(); await f.region([A]); const a = f.renderer.imageFor(A)
  const oldContext = f.context
  f.setRequest(false)
  expect(() => f.renderer.imageFor(A)).toThrow('PREVIEW_CANCELLED')
  expect(f.renderer.images.get(A)).toBe(a); expect(f.driver.destroy).not.toHaveBeenCalled()
  f.context = { ...oldContext, current: () => true }
  await f.region([A]); expect(f.renderer.imageFor(A)).toBe(a)
  expect(f.driver.uploadLinear).toHaveBeenCalledTimes(1)
  f.context = oldContext; f.setRequest(true)
  expect(() => f.renderer.imageFor(A)).toThrow('PREVIEW_CANCELLED')
  expect(f.renderer.images.get(A)).toBe(a)
})

test('owner revocation and owner ABA remove lookup authority and create a fresh upload', async () => {
  const f = fixture(); await f.region([A]); const a = f.renderer.imageFor(A), owner = imageLoaderResidencyOwner(f.load)
  f.setOwner(false)
  expect(() => f.renderer.imageFor(A)).toThrow('PREVIEW_CANCELLED')
  expect(f.renderer.images.size).toBe(0); expect(f.driver.destroy).not.toHaveBeenCalled()
  expect(f.renderer.retiredImageAssets.size).toBe(1)
  f.setOwner(true); f.setPixels(.5)
  await f.region([A]); expect(imageLoaderResidencyOwner(f.load)).not.toBe(owner)
  expect(f.driver.destroy).toHaveBeenCalledWith(a.texture)
  expect(f.renderer.imageFor(A).texture).not.toBe(a.texture)
  expect(f.uploaded[1].pixels).toEqual(new Float32Array(16).fill(.5))
})

test('a shared decoder with a different private scope does not lend old pixels or dimensions', async () => {
  const f = fixture(); await f.region([A]); f.renderer.imageFor(A); f.renderer.baseDims(A)
  f.context = { ...f.context, scope: 'new-document-same-id' }; f.setPixels(.875)
  await f.region([A]); expect(f.renderer.imageDims.size).toBe(0); f.renderer.imageFor(A)
  expect(f.uploaded[1].pixels).toEqual(new Float32Array(16).fill(.875))
})

test('a changed resource generation replaces the ticket even when decoder, settings and scope text match', async () => {
  const f = fixture(); let generation = 1
  f.context = { ...f.context, ownerCurrent: () => generation === 1 }
  await f.region([A]); const a = f.renderer.imageFor(A)
  generation = 2; f.context = { ...f.context, ownerCurrent: () => generation === 2 }
  await f.region([A]); expect(f.renderer.imageFor(A).texture).not.toBe(a.texture)
  expect(f.driver.destroy).toHaveBeenCalledWith(a.texture); expect(f.driver.uploadLinear).toHaveBeenCalledTimes(2)
})

test('adjustment variants get fresh uploads without mutating the decoded source; undo may reuse the original variant', async () => {
  const f = fixture(), values = Float32Array.from({ length: 16 }, (_, i) => i % 4 === 3 ? 1 : .125)
  const before = values.slice(); f.kernel.image_linear.mockReturnValue(values)
  await f.region([A]); const original = f.renderer.imageFor(A)
  const adjusted = f.renderer.imageFor(A, 0, false, { exposure: .25, contrast: 0, temperature: 0,
    tint: 0, highlights: 0, shadows: 0, color: 0 })
  expect(adjusted.texture).not.toBe(original.texture); expect(f.driver.uploadLinear).toHaveBeenCalledTimes(2)
  expect(f.uploaded[1].pixels).not.toEqual(f.uploaded[0].pixels); expect(values).toEqual(before)
  expect(f.renderer.imageFor(A)).toBe(original); expect(f.driver.uploadLinear).toHaveBeenCalledTimes(2)
})

test('hard working pressure evicts only unused assets and revisits re-upload original exact pixels', async () => {
  const f = fixture(); f.renderer.frameBudget = 64
  await f.region([A]); const a = f.renderer.imageFor(A)
  await f.region([B]); f.renderer.imageFor(B)
  expect(f.renderer.bytes).toBe(64); expect(f.renderer.images.size).toBe(1)
  expect(f.driver.destroy).toHaveBeenCalledWith(a.texture)
  await f.region([A]); f.renderer.imageFor(A)
  expect(f.renderer.bytes).toBe(64); expect(f.driver.uploadLinear).toHaveBeenCalledTimes(3)
  expect(f.uploaded[2].pixels).toEqual(f.uploaded[0].pixels)
  expect(f.renderer.imageAssetCounters.pressureEvictions).toBe(2)
})

test('a pinned source cannot be evicted to admit another image or exceed the hard budget', async () => {
  const f = fixture(); f.renderer.frameBudget = 64
  await f.region([A]); const a = f.renderer.imageFor(A)
  await f.region([B]); f.renderer.pendingImageTableSources.add(a.texture)
  expect(() => f.renderer.imageFor(B)).toThrow('GPU 浮点图片内存预算超限')
  expect(f.driver.uploadLinear).toHaveBeenCalledTimes(1); expect(f.driver.destroy).not.toHaveBeenCalled()
  expect(f.renderer.bytes).toBe(64); expect(f.renderer.images.get(A)).toBe(a)
})

test('scope retirement removes old lookup immediately but waits for a real covered boundary', async () => {
  const f = fixture(); await f.region([A]); const a = f.renderer.imageFor(A)
  f.driver.resourceEpoch = 2
  let finish!: () => void
  f.driver.waitForSubmittedWork.mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
  f.context = { ...f.context, scope: 'new-owner' }
  const pending = f.region([A])
  expect(f.renderer.images.size).toBe(0); expect(f.renderer.bytes).toBe(64)
  expect(f.renderer.retiredImageAssets.size).toBe(1); expect(f.driver.destroy).not.toHaveBeenCalled()
  finish(); await pending
  expect(f.driver.completedResourceEpoch).toBe(1)
  expect(f.driver.destroy).toHaveBeenCalledWith(a.texture); expect(f.renderer.retiredImageAssets.size).toBe(0)
  expect(f.renderer.bytes).toBe(0); f.renderer.imageFor(A); expect(f.renderer.bytes).toBe(64)
})

test('failed retirement completion keeps charged old storage and never republishes its same-URI lookup', async () => {
  const f = fixture(); await f.region([A]); f.renderer.imageFor(A)
  f.driver.resourceEpoch = 2; f.driver.waitForSubmittedWork.mockRejectedValueOnce(Error('completion rejected'))
  f.context = { ...f.context, scope: 'new-owner' }
  await expect(f.region([A])).rejects.toThrow('completion rejected')
  expect(f.renderer.images.size).toBe(0); expect(f.renderer.retiredImageAssets.size).toBe(1)
  expect([...f.renderer.retiredImageAssets.values()][0].covered).toBe(false)
  expect(f.renderer.bytes).toBe(64); expect(f.driver.destroy).not.toHaveBeenCalled()
  f.renderer.dispose()
  expect(f.renderer.images.size).toBe(0); expect(f.renderer.retiredImageAssets.size).toBe(0)
  expect(f.renderer.bytes).toBe(0); expect(f.driver.dispose).toHaveBeenCalledTimes(1)
})

test('scope change detaches all aliases of one atlas page but keeps its ledger until the last source pin ends', async () => {
  const f = fixture()
  Object.assign(f.driver, { create: vi.fn((width: number, height: number) =>
    ({ width, height, bytes: width * height * 16, resource: {} } as Texture)), uploadAtlasLinear: vi.fn() })
  await f.region([A, B]); const a = f.renderer.imageFor(A, 0, true), b = f.renderer.imageFor(B, 0, true)
  expect(a.texture).toBe(b.texture); const bytes = f.renderer.bytes
  f.driver.resourceEpoch = 2; f.renderer.pendingImageTableSources.add(a.texture)
  f.context = { ...f.context, scope: 'new-owner' }; await f.region([A])
  expect(f.renderer.images.size).toBe(0); expect(f.renderer.atlasPages).toHaveLength(0)
  expect(f.renderer.imageOrigins.size).toBe(0); expect(f.renderer.retiredImageAssets.size).toBe(1)
  expect(f.renderer.bytes).toBe(bytes); expect(f.driver.destroy).not.toHaveBeenCalled()
  f.renderer.collectRetiredImageAssets(); expect(f.driver.destroy).not.toHaveBeenCalled()
  f.renderer.pendingImageTableSources.delete(a.texture); f.renderer.collectRetiredImageAssets()
  expect(f.driver.destroy).not.toHaveBeenCalled()
  await f.region([A])
  expect(f.driver.destroy).toHaveBeenCalledTimes(1); expect(f.driver.destroy).toHaveBeenCalledWith(a.texture)
  expect(f.renderer.bytes).toBe(0); expect(f.renderer.imageAssetCounters.scopeRetiredTextures).toBe(1)
})

test('same-epoch completion does not retire reads encoded after that earlier checkpoint', async () => {
  const f = fixture(); await f.region([A]); const a = f.renderer.imageFor(A)
  expect(f.driver.resourceEpoch).toBe(f.driver.completedResourceEpoch)
  f.setOwner(false)
  expect(() => f.renderer.imageFor(A)).toThrow('PREVIEW_CANCELLED')
  f.renderer.collectRetiredImageAssets()
  expect(f.driver.destroy).not.toHaveBeenCalled(); expect(f.renderer.bytes).toBe(64)
  let complete!: () => void
  f.driver.waitForSubmittedWork.mockImplementation(() => new Promise<void>(resolve => { complete = resolve }))
  f.setOwner(true); const waiting = f.region([A])
  expect(f.driver.destroy).not.toHaveBeenCalled(); expect(f.renderer.bytes).toBe(64)
  complete(); await waiting
  expect(f.driver.destroy).toHaveBeenCalledWith(a.texture); expect(f.renderer.bytes).toBe(0)
})

test.each([undefined, 256])('retired assets require a new checkpoint with budget override %s even when the pool has prior-epoch proof', async budgetMiB => {
  const f = fixture(); await f.region([])
  if (budgetMiB !== undefined) f.renderer.frameBudget = budgetMiB * 1024 * 1024
  else expect(f.renderer.frameBudget).toBe(1024 * 1024 * 1024)
  const edge = budgetMiB === 256 ? 2048 : 4096
  const asset = { width: edge, height: edge, bytes: f.renderer.frameBudget / 4, resource: {} } as Texture
  const pooled = { width: 512, height: 512, bytes: 4 * 1024 * 1024, resource: {} } as Texture
  f.driver.resourceEpoch = 3; f.driver.completedResourceEpoch = 2
  f.renderer.images.set(A, { texture: asset, rect: { x: 0, y: 0, w: edge, h: edge } })
  f.renderer.bytes = asset.bytes; f.renderer.retireImageResidency()
  f.renderer.free.set('512:512', [pooled]); f.renderer.poolReleaseEpoch.set(pooled, 1)
  f.renderer.bytes += pooled.bytes
  let complete!: () => void
  f.driver.checkpoint.mockImplementation(() => new Promise<void>(resolve => { complete = () => {
    f.driver.completedResourceEpoch = 2; resolve()
  } }))
  const waiting = f.renderer.reclaimScratch()
  expect(f.driver.checkpoint).toHaveBeenCalledTimes(1)
  expect(f.driver.waitForSubmittedWork).not.toHaveBeenCalled()
  expect(f.driver.checkpoint.mock.calls[0]).toHaveLength(2)
  expect(f.driver.destroy).not.toHaveBeenCalled()
  complete(); await waiting
  expect(f.driver.completedResourceEpoch).toBe(2)
  expect(f.driver.destroy).toHaveBeenCalledWith(asset); expect(f.renderer.retiredImageAssets.size).toBe(0)
})

test('pre-begin owner change releases a covered 200MiB old asset for the next 200MiB admission without crediting the frame epoch', async () => {
  const f = fixture(), MiB = 1024 * 1024
  await f.region([A])
  // Descriptor of a previously owned GPU allocation; no 200MiB CPU pixel
  // buffer is allocated by this resource-lifecycle control.
  const old = { width: 3200, height: 4096, bytes: 200 * MiB, resource: {} } as Texture
  f.renderer.images.set(A, { texture: old, rect: { x: 0, y: 0, w: 3200, h: 4096 } })
  f.renderer.bytes = old.bytes; f.renderer.frameBudget = 256 * MiB
  f.driver.resourceEpoch = 2; f.driver.completedResourceEpoch = 1
  f.context = { ...f.context, scope: 'new-document' }
  await f.region([B])
  expect(f.driver.waitForSubmittedWork).toHaveBeenCalledTimes(1)
  expect(f.driver.checkpoint).not.toHaveBeenCalled()
  expect(f.driver.completedResourceEpoch).toBe(1)
  expect(f.driver.destroy.mock.calls[0][0]).toBe(old)
  expect(f.renderer.retiredImageAssets.size).toBe(0); expect(f.renderer.bytes).toBe(0)
  expect(f.renderer.overBudget(200 * MiB, 3200, 4096)).toBe(false)
})

test('repeated pre-begin owner changes never finish a previously consumed encoder', async () => {
  const f = fixture()
  const finish = vi.fn(() => { throw Error('Command encoding already finished') })
  const wait = vi.fn(async () => {})
  const boundary = Object.assign(Object.create(WebGpuDriver.prototype), {
    initialized: true, disposed: false, lost: false, submittedBoundaryReady: true, submittedBoundaryGeneration: 1,
    frameScopeOpen: false, resourceEpoch: 2, completedResourceEpoch: 1, errors: [],
    encoder: { finish }, device: {}, imageTables: new Map(), byteTentLeases: new Map(), waitForQueue: wait,
  }) as WebGpuDriver
  f.driver.waitForSubmittedWork.mockImplementation(() => boundary.waitForSubmittedWork())
  f.driver.checkpoint.mockImplementation(async () => { finish() })
  f.renderer.frameBudget = 64
  for (let i = 0; i < 5; i++) {
    f.context = { ...f.context, scope: `new-owner-${i}` }
    await f.region([A]); f.renderer.imageFor(A)
    expect(f.renderer.bytes).toBe(64)
  }
  expect(finish).not.toHaveBeenCalled(); expect(wait).toHaveBeenCalledTimes(4)
  expect(f.driver.checkpoint).not.toHaveBeenCalled(); expect(f.driver.uploadLinear).toHaveBeenCalledTimes(5)
  expect(boundary.completedResourceEpoch).toBe(1)
})

test('a completed retirement boundary cannot credit a later retirement outside its captured cohort', async () => {
  const f = fixture(); await f.region([A]); const a = f.renderer.imageFor(A)
  let complete!: () => void
  f.driver.waitForSubmittedWork.mockImplementation(() => new Promise<void>(resolve => { complete = resolve }))
  f.context = { ...f.context, scope: 'new-owner' }; const waiting = f.region([A])
  const later = { width: 2, height: 2, bytes: 64, resource: {} } as Texture
  f.renderer.retiredImageAssets.set(later, { epoch: 1, covered: false }); f.renderer.bytes += later.bytes
  complete(); await waiting
  expect(f.driver.destroy.mock.calls[0][0]).toBe(a.texture)
  expect(f.driver.destroy.mock.calls.some(call => call[0] === later)).toBe(false)
  expect(f.renderer.retiredImageAssets.size).toBe(1); expect(f.renderer.bytes).toBe(64)
  expect(f.renderer.retiredImageAssets.get(later).covered).toBe(false)
})

test.each([false, true])('abort completion failure=%s only retires the covered asset cohort after success', async fail => {
  const f = fixture(); await f.region([A]); const a = f.renderer.imageFor(A)
  f.renderer.retireImageResidency()
  Object.assign(f.driver, { abortFrameAndReleaseFilterScratch: vi.fn(async () => {
    if (fail) throw Error('abort completion rejected')
  }) })
  const completion = f.renderer.abortFrameAndReleaseFilterScratch('cancel')
  if (fail) await expect(completion).rejects.toThrow('abort completion rejected'); else await completion
  expect(f.driver.destroy).toHaveBeenCalledTimes(fail ? 0 : 1)
  if (!fail) expect(f.driver.destroy).toHaveBeenCalledWith(a.texture)
  expect(f.renderer.retiredImageAssets.size).toBe(fail ? 1 : 0)
  expect(f.renderer.bytes).toBe(fail ? 64 : 0)
})
