import { afterEach, expect, test, vi } from 'vitest'
import { paint } from '../../model'
import { GpuRenderer, type Surface } from './renderer'
import type { Driver, GpuNode, Texture } from './types'
import { certifyExactImageRange } from './exact-image-x-table'

afterEach(() => vi.unstubAllEnvs())

const MiB = 1024 * 1024
function fixture() {
  let complete!: () => void, fail!: (error: Error) => void, completed = false, current = true
  const create = (width: number, height: number) => ({ width, height, bytes: width * height * 16, resource: {} }) as Texture
  const driver = { name: 'webgpu', managed: true, scratchBytes: 0, resourceEpoch: 7, completedResourceEpoch: 6, create,
    pass: vi.fn(), destroy: vi.fn(() => expect(completed).toBe(true)),
    checkpoint: vi.fn(async () => {
      await new Promise<void>((resolve, reject) => { complete = resolve; fail = reject })
      completed = true
    }) }
  const renderer = new GpuRenderer(driver as unknown as Driver, true, true, undefined, false, false, 1024) as any
  renderer.scene = { coherentSamples: true }; renderer.bytes = 885038016
  renderer.frameCurrent = () => current
  const free = create(2402, 2428)
  renderer.free.set('2402:2428', [free]); renderer.used.add(free); renderer.poolReleaseEpoch.set(free, 7)
  const r = { x: -1182, y: -222, w: 2428, h: 2428 }
  const dst = { texture: create(r.w, r.h), rect: r } as Surface
  renderer.busy.add(dst.texture)
  const mask = { texture: create(1, 1), rect: r } as Surface
  const node = { rect: r } as GpuNode, imagePaint = { ...paint('#ffffff'), kind: 'image', image: 'fixture' }
  renderer.configurePaint = () => {}
  renderer.imageFor = () => ({ texture: create(1, 1), rect: { x: 0, y: 0, w: 1, h: 1 } })
  // The actual paint path uploads a compact field before allocating its mode2
  // source. The retained scene's other live planes are represented by bytes.
  renderer.imageGrid = () => {
    renderer.bytes += MiB
    return { texture: create(256, 256), rect: r }
  }
  return { renderer, driver, free, dst, mask, node, imagePaint,
    complete: () => complete(), fail: () => fail(Error('uncertain fence')), cancel: () => { current = false } }
}

test('lazy fields crossing the exact image-merge boundary reclaim a real current-frame pool instead of aborting prefix work', async () => {
  const f = fixture()
  // Before the lazy upload, both new full planes fit by 57,920 bytes.
  expect(f.renderer.reclaimForPaintOver(f.node, f.imagePaint, f.mask, f.dst)).toBeUndefined()
  const pending = f.renderer.paintOver(f.node, f.imagePaint, f.mask, f.dst, undefined, true) as Promise<Surface>
  expect(pending).toBeInstanceOf(Promise)
  expect(f.renderer.bytes).toBe(980409536)
  expect(f.driver.pass.mock.calls.map(call => call[1][16])).toEqual([2])
  const source = f.driver.pass.mock.calls[0][0] as Texture
  expect(f.renderer.busy.has(source)).toBe(true); expect(f.renderer.busy.has(f.dst.texture)).toBe(true)
  expect(f.driver.checkpoint).toHaveBeenCalledOnce(); expect(f.driver.destroy).not.toHaveBeenCalled()
  f.complete()
  const result = await pending
  expect(f.driver.destroy).toHaveBeenCalledExactlyOnceWith(f.free)
  expect(f.driver.pass.mock.calls.map(call => call[1][16])).toEqual([2, 3])
  expect(f.renderer.busy.has(source)).toBe(false); expect(f.renderer.busy.has(f.dst.texture)).toBe(false)
  expect(f.renderer.busy.has(result.texture)).toBe(true)
  expect(f.renderer.bytes).toBeLessThanOrEqual(1024 * MiB)
  expect(f.driver.completedResourceEpoch).toBe(6)
})

test.each(['cancel', 'failed-fence'] as const)('an image-merge %s publishes no blend and releases only its local source ownership', async outcome => {
  const f = fixture(), pending = f.renderer.paintOver(f.node, f.imagePaint, f.mask, f.dst, undefined, true) as Promise<Surface>
  const source = f.driver.pass.mock.calls[0][0] as Texture
  if (outcome === 'cancel') { f.cancel(); f.complete() } else f.fail()
  await expect(pending).rejects.toThrow(outcome === 'cancel' ? 'PREVIEW_CANCELLED' : 'uncertain fence')
  expect(f.driver.pass.mock.calls.map(call => call[1][16])).toEqual([2])
  expect(f.renderer.busy.has(source)).toBe(false)
  expect(f.renderer.busy.has(f.dst.texture)).toBe(true)
  expect(f.renderer.poolReleaseEpoch.get(source)).toBe(7)
  expect(f.driver.completedResourceEpoch).toBe(6)
  if (outcome === 'failed-fence') {
    expect(f.driver.destroy).not.toHaveBeenCalled()
    expect(f.renderer.free.get('2402:2428')).toEqual([f.free])
  }
})

test.each(['under-budget', 'same-size-pool', 'sync-strip'] as const)('%s image composition retains its synchronous queue-ordered path', mode => {
  const f = fixture()
  if (mode === 'under-budget') f.renderer.bytes -= 2 * MiB
  if (mode === 'same-size-pool') {
    const reusable = f.driver.create(2428, 2428)
    f.renderer.free.set('2428:2428', [reusable])
  }
  const result = mode === 'sync-strip'
    ? (() => { expect(() => f.renderer.paintOver(f.node, f.imagePaint, f.mask, f.dst)).toThrow('GPU 表面内存预算超限') })()
    : f.renderer.paintOver(f.node, f.imagePaint, f.mask, f.dst, undefined, true)
  expect(result).not.toBeInstanceOf(Promise)
  expect(f.driver.checkpoint).not.toHaveBeenCalled(); expect(f.driver.destroy).not.toHaveBeenCalled()
})

function identityFixture(pixels = [.25, .5, 1, 1]) {
  vi.stubEnv('VITE_DESIGN_EXACT_CLAMP_PREFIX', '1')
  const create = (width: number, height: number) => ({ width, height, bytes: width * height * 16, resource: {} }) as Texture
  const image = { texture: create(1, 1), rect: { x: 0, y: 0, w: 1, h: 1 } }, range = certifyExactImageRange(new Float32Array(pixels))
  const driver = { name: 'webgpu', managed: true, zeroTextureSampling: true, create, pass: vi.fn(), destroy: vi.fn(),
    imageTableRange: (texture: Texture) => texture === image.texture ? range : undefined }
  const renderer = new GpuRenderer(driver as unknown as Driver, true, false) as any
  const r = { x: -20, y: 10, w: 8, h: 6 }, node = { rect: r } as GpuNode
  renderer.scene = { extent: r, rootInputBox: [-20, 10, 8, 6], coherentSamples: true }; renderer.sampleIndex = 0
  renderer.configurePaint = () => {}; renderer.imageFor = () => image
  renderer.imageGrid = () => ({ texture: create(8, 2), rect: r })
  const dst = { texture: create(1, 1), rect: r }; dst.texture.transparentZero = true; renderer.busy.add(dst.texture)
  const mask = { texture: create(8, 6), rect: r }; mask.texture.binaryCoverage = true
  return { renderer, driver, node, dst, mask, paint: { ...paint('#ffffff'), kind: 'image', image: 'fixture' } }
}
test('a privately proved opaque finite image over its same integer transparent target uses its stored source directly', () => {
  const f = identityFixture(), out = f.renderer.paintOver(f.node, f.paint, f.mask, f.dst, undefined, true) as Surface
  expect(f.driver.pass.mock.calls.map(call => call[1][16])).toEqual([2])
  expect(out.imageZeroOverIdentity).toBe(true); expect(out.texture).toBe(f.driver.pass.mock.calls[0][0])
  expect(f.renderer.busy.has(out.texture)).toBe(true); expect(f.renderer.busy.has(f.dst.texture)).toBe(false)
})
test.each(['off', 'unknown-upload', 'alpha', 'negative-rgb', 'hdr', 'mask', 'opacity', 'clip', 'lattice', 'extent', 'not-zero', 'unselected'] as const)(
  '%s retains the original image source-over', mode => {
    const f = identityFixture(mode === 'alpha' ? [.25, .5, 1, .5] : mode === 'negative-rgb' ? [-.25, .5, 1, 1] : mode === 'hdr' ? [2, .5, 1, 1] : undefined)
    let clip: Surface | undefined
    if (mode === 'off') vi.stubEnv('VITE_DESIGN_EXACT_CLAMP_PREFIX', '0')
    if (mode === 'unknown-upload') f.driver.imageTableRange = () => undefined
    if (mode === 'mask') delete f.mask.texture.binaryCoverage
    if (mode === 'opacity') f.paint.opacity = .5
    if (mode === 'clip') clip = f.mask
    if (mode === 'lattice') f.node.rect = { ...f.node.rect, x: -19.75 }
    if (mode === 'extent') f.dst.rect = { ...f.dst.rect, w: 9 }
    if (mode === 'not-zero') delete f.dst.texture.transparentZero
    if (mode === 'unselected') f.renderer.sampleIndex = undefined
    const out = f.renderer.paintOver(f.node, f.paint, f.mask, f.dst, clip, true) as Surface
    expect(f.driver.pass.mock.calls.map(call => call[1][16])).toEqual([2, 3])
    expect(out.imageZeroOverIdentity).toBeUndefined()
  })
