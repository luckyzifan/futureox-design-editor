import { afterEach, expect, test, vi } from 'vitest'
import { GpuRenderer, type Surface } from './renderer'
import type { Driver, GpuNode, Texture } from './types'

afterEach(() => vi.unstubAllEnvs())
const MiB = 1024 * 1024

function pressureFixture() {
  vi.stubEnv('VITE_DESIGN_EXACT_CLAMP_PREFIX', '1')
  let resolve!: () => void, reject!: (error: Error) => void, covered = false, current = true
  const create = (width: number, height: number) => ({ width, height, bytes: width * height * 16, resource: {} }) as Texture
  const driver = { name: 'webgpu', managed: true, create, clear: vi.fn(), pass: vi.fn(), scratchBytes: 0,
    resourceEpoch: 3, completedResourceEpoch: 2,
    destroy: vi.fn((_texture: Texture) => expect(covered).toBe(true)),
    checkpoint: vi.fn(async () => {
      await new Promise<void>((yes, no) => { resolve = yes; reject = no }); covered = true
    }) }
  const renderer = new GpuRenderer(driver as unknown as Driver, true, false) as any
  renderer.scene = { extent: { x: 0, y: 0, w: 768, h: 512 }, coherentSamples: true, rootInputBox: [0, 0, 768, 512] }
  renderer.frameBudget = 24 * MiB; renderer.frameCurrent = () => current
  const targets = Array.from({ length: 4 }, () => renderer.acquire({ x: 0, y: 0, w: 512, h: 512 })) as Surface[]
  const free = create(256, 512), image = create(512, 512)
  renderer.free.set('256:512', [free]); renderer.used.add(free); renderer.poolReleaseEpoch.set(free, 3)
  renderer.images.set('fixture', { texture: image, rect: { x: 0, y: 0, w: 512, h: 512 } }); renderer.used.add(image)
  renderer.bytes += free.bytes + image.bytes
  const n = { id: 'backdrop', rect: { x: 0, y: 0, w: 512, h: 512 }, backdropBox: [0, 0, 768, 512], matrix: [1, 0, 0, 1, 0, 0] } as unknown as GpuNode
  const run = renderer.run.bind(renderer)
  renderer.run = vi.fn((mode: number, ...args: any[]) => {
    const output = run(mode, ...args)
    if (mode === 26) { renderer.release(output); throw Error('captured') }
    return output
  })
  return { renderer, driver, targets, free, image, n, run: () => renderer.drawBackdropLeaf(n, targets, undefined, { kind: 'background-blur', radius: 1, visible: true }),
    complete: () => resolve(), fail: () => reject(Error('uncertain fence')), cancel: () => { current = false } }
}

test('the actual capture allocation waits for covered pool and last-resort image reclamation before reading its four live planes', async () => {
  const f = pressureFixture(), pending = f.run()
  expect(f.renderer.run).not.toHaveBeenCalled(); expect(f.driver.checkpoint).toHaveBeenCalledOnce()
  expect(f.driver.destroy).not.toHaveBeenCalled(); expect(f.renderer.busy.size).toBe(4)
  f.complete()
  await expect(pending).rejects.toThrow('captured')
  expect(f.driver.destroy.mock.calls.map(call => call[0])).toEqual([f.free, f.image])
  expect(f.renderer.run).toHaveBeenCalledExactlyOnceWith(26, { x: 0, y: 0, w: 768, h: 512 }, f.targets)
  expect(f.driver.pass.mock.calls[0][2]).toEqual(f.targets.map(s => s.texture))
  expect(f.renderer.bytes).toBe(22 * MiB); expect(f.renderer.bytes).toBeLessThanOrEqual(f.renderer.frameBudget)
  expect(f.targets.every(s => f.renderer.busy.has(s.texture))).toBe(true)
})

test.each(['cancel', 'failed-completion'] as const)('%s before capture encodes no stale mode26 and retains all four source planes', async mode => {
  const f = pressureFixture(), pending = f.run()
  if (mode === 'cancel') { f.cancel(); f.complete() } else f.fail()
  await expect(pending).rejects.toThrow(mode === 'cancel' ? 'PREVIEW_CANCELLED' : 'uncertain fence')
  expect(f.renderer.run).not.toHaveBeenCalled(); expect(f.driver.pass).not.toHaveBeenCalled()
  expect(f.targets.every(s => f.renderer.busy.has(s.texture))).toBe(true)
  if (mode === 'failed-completion') { expect(f.driver.destroy).not.toHaveBeenCalled(); expect(f.renderer.images.size).toBe(1) }
  expect(f.driver.completedResourceEpoch).toBe(2)
})

test('an existing exact-size capture pool does not add an admission wait', async () => {
  const f = pressureFixture(), texture = f.driver.create(768, 512)
  f.renderer.free.set('768:512', [texture]); f.renderer.bytes += texture.bytes; f.renderer.frameBudget = 32 * MiB
  await expect(f.run()).rejects.toThrow('captured')
  expect(f.driver.checkpoint).not.toHaveBeenCalled(); expect(f.driver.destroy).not.toHaveBeenCalled()
})

test('the generic backdrop capture waits as well, while replay does not request a nonexistent capture allocation', async () => {
  for (const replay of [false, true]) {
    const f = pressureFixture(), n = { ...f.n, opacity: 1, blend: 'normal', fills: [], strokes: [], children: [],
      effects: [{ kind: 'glass', radius: 1, visible: true, glass: { refraction: 1 } }], captureReplay: replay, glassShape: {} } as unknown as GpuNode
    f.driver.managed = false
    f.renderer.scene.nodes = { backdrop: n }; f.renderer.scene.roots = ['backdrop']
    f.renderer.yieldEncoding = () => undefined; f.renderer.reclaimScratch = vi.fn(async () => {})
    f.renderer.replayTexture = () => false; f.renderer.streamIsolatedFilter = async () => undefined
    f.renderer.nodeMask = () => f.targets[0]
    f.renderer.glass = () => { throw Error('replay reached') }
    let complete!: () => void
    f.renderer.reclaimForSurface = vi.fn(() => new Promise<void>(yes => { complete = yes }))
    const pending = f.renderer.drawBundle(['backdrop'], f.targets)
    // drawBundle has several intentional task boundaries before this branch.
    for (let i = 0; i < 30 && !f.renderer.reclaimForSurface.mock.calls.length && !replay; i++) await Promise.resolve()
    if (replay) {
      await expect(pending).rejects.toThrow('replay reached')
      expect(f.renderer.reclaimForSurface).not.toHaveBeenCalled()
      expect(f.renderer.run).not.toHaveBeenCalled()
    } else {
      expect(f.renderer.reclaimForSurface).toHaveBeenCalledExactlyOnceWith(n.rect)
      expect(f.renderer.run).not.toHaveBeenCalled()
      complete()
      await expect(pending).rejects.toThrow('captured')
    }
  }
})

test('color-surface admission charges the actual managed or byte format and skips an exact-size pool', async () => {
  const f = pressureFixture(); f.renderer.reclaimScratch = vi.fn(async () => {})
  await f.renderer.reclaimForSurface({ x: 0, y: 0, w: 9, h: 7 })
  expect(f.renderer.reclaimScratch).toHaveBeenLastCalledWith(9 * 7 * 16)
  f.driver.managed = false
  await f.renderer.reclaimForSurface({ x: 0, y: 0, w: 9, h: 7 })
  expect(f.renderer.reclaimScratch).toHaveBeenLastCalledWith(9 * 7 * 4)
  f.renderer.reclaimScratch.mockClear(); f.renderer.free.set('9:7', [f.driver.create(9, 7)])
  await f.renderer.reclaimForSurface({ x: 0, y: 0, w: 9, h: 7 })
  expect(f.renderer.reclaimScratch).not.toHaveBeenCalled()
})
