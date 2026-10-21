import { expect, test, vi } from 'vitest'
import { GpuRenderer } from './renderer'
import type { Driver, Texture } from './types'

const MiB = 1024 * 1024
function fixture(poolBytes = 128 * 1024) {
  let complete!: () => void, fail!: (reason: Error) => void, finished = false
  const active = new Set<Texture>()
  const driver = { name: 'webgpu', managed: true, scratchBytes: 0,
    hasActiveImageTableSource: (texture: Texture) => active.has(texture),
    checkpoint: vi.fn(async () => {
      await new Promise<void>((resolve, reject) => { complete = resolve; fail = reject })
      finished = true
    }),
    destroy: vi.fn((_texture: Texture) => { expect(finished).toBe(true) }),
  }
  const renderer = new GpuRenderer(driver as unknown as Driver) as any
  renderer.scene = {}; renderer.bytes = 203 * MiB
  const pooled = { width: 128, height: poolBytes / (128 * 16), bytes: poolBytes, resource: {} } as Texture
  renderer.free.set(`${pooled.width}:${pooled.height}`, [pooled])
  return { renderer, driver, pooled, active, complete: () => complete(), fail: () => fail(Error('lost fence')) }
}

test('a high working set without evictable images accumulates tiny maintenance pools', async () => {
  const f = fixture()
  for (let i = 0; i < 80; i++) await f.renderer.reclaimScratch(i % 2 ? 1024 : 0)
  expect(f.driver.checkpoint).not.toHaveBeenCalled(); expect(f.driver.destroy).not.toHaveBeenCalled()
  expect(f.renderer.bytes).toBe(203 * MiB)
  expect(f.renderer.free.get('128:64')).toEqual([f.pooled])
})

test.each(['pending', 'active'] as const)('a %s table source does not trigger an empty maintenance fence', async owner => {
  for (const kind of ['image', 'atlas', 'empty-atlas']) {
    const f = fixture(), image = { width: 1024, height: 1024, bytes: 16 * MiB, resource: {} } as Texture
    if (kind !== 'empty-atlas') f.renderer.images.set('image', { texture: image })
    if (kind !== 'image') f.renderer.atlasPages.push({ texture: image, entries: new Map(kind === 'empty-atlas' ? [] : [['image', {}]]) })
    const pins = owner === 'pending' ? f.renderer.pendingImageTableSources : f.active
    pins.add(image)
    await f.renderer.reclaimScratch()
    expect(f.driver.checkpoint).not.toHaveBeenCalled(); expect(f.driver.destroy).not.toHaveBeenCalled()
    pins.delete(image)
    const pending = f.renderer.reclaimScratch()
    expect(f.driver.checkpoint).toHaveBeenCalledOnce(); expect(f.driver.destroy).not.toHaveBeenCalled()
    f.complete(); await pending
    expect(f.driver.destroy).toHaveBeenCalledWith(image)
    expect(f.renderer.images.size).toBe(0); expect(f.renderer.atlasPages).toHaveLength(0)
  }
})

test('a full maintenance batch still waits before destroying current-frame pool entries', async () => {
  const f = fixture(48 * MiB), pending = f.renderer.reclaimScratch()
  expect(f.driver.checkpoint).toHaveBeenCalledExactlyOnceWith('admission', undefined)
  expect(f.driver.destroy).not.toHaveBeenCalled()
  f.complete(); await pending
  expect(f.driver.destroy).toHaveBeenCalledExactlyOnceWith(f.pooled)
  expect(f.renderer.bytes).toBe(155 * MiB)
})

test('real allocation pressure fences even a tiny pool and never relaxes the 256 MiB gate', async () => {
  const f = fixture(), image = { width: 1, height: 1, bytes: 16, resource: {} } as Texture
  f.renderer.images.set('pinned', { texture: image }); f.active.add(image)
  const pending = f.renderer.reclaimScratch(64 * MiB)
  expect(f.driver.checkpoint).toHaveBeenCalledExactlyOnceWith('admission', undefined)
  expect(f.driver.destroy).not.toHaveBeenCalled()
  f.complete(); await pending
  expect(f.driver.destroy).toHaveBeenCalledExactlyOnceWith(f.pooled)
  expect(f.renderer.frameBudget).toBe(256 * MiB)
  expect(f.renderer.overBudget(64 * MiB)).toBe(true)
  expect(f.renderer.images.get('pinned').texture).toBe(image)
})

test('a failed pressure fence destroys no resource or pool entry', async () => {
  const f = fixture(), pending = f.renderer.reclaimScratch(64 * MiB)
  expect(f.driver.checkpoint).toHaveBeenCalledOnce()
  f.fail(); await expect(pending).rejects.toThrow('lost fence')
  expect(f.driver.destroy).not.toHaveBeenCalled()
  expect(f.renderer.bytes).toBe(203 * MiB); expect(f.renderer.free.get('128:64')).toEqual([f.pooled])
})
