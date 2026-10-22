// Pressure fixtures explicitly retain a 256 MiB override; the default is tested separately.
import { afterEach, expect, test, vi } from 'vitest'
import { GpuRenderer } from './renderer'
import type { Driver, Texture } from './types'

const MiB = 1024 * 1024
afterEach(() => vi.unstubAllEnvs())
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
  const renderer = new GpuRenderer(driver as unknown as Driver, undefined, undefined, undefined, undefined, undefined, 256) as any
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

test('real allocation pressure retains the ordinary completion fence before destroying current-frame pool entries', async () => {
  const f = fixture(48 * MiB), pending = f.renderer.reclaimScratch(64 * MiB)
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

test('candidate maintenance retains a used immutable image without an unnecessary allocation or completion wait', async () => {
  vi.stubEnv('VITE_DESIGN_EXACT_CLAMP_PREFIX', '1')
  const f = fixture(), image = { width: 1024, height: 1024, bytes: 16 * MiB, resource: {} } as Texture
  f.renderer.images.set('source', { texture: image }); f.renderer.used.add(image)
  for (let i = 0; i < 80; i++) await f.renderer.reclaimScratch()
  expect(f.driver.checkpoint).not.toHaveBeenCalled(); expect(f.driver.destroy).not.toHaveBeenCalled()
  expect(f.renderer.images.get('source').texture).toBe(image); expect(f.renderer.bytes).toBe(203 * MiB)
})

test('candidate allocation pressure consumes the covered current-frame pool before evicting its immutable upload', async () => {
  vi.stubEnv('VITE_DESIGN_EXACT_CLAMP_PREFIX', '1')
  const f = fixture(80 * MiB), image = { width: 512, height: 512, bytes: 4 * MiB, resource: {} } as Texture
  f.renderer.bytes = 250 * MiB; f.renderer.images.set('source', { texture: image }); f.renderer.used.add(image)
  f.pooled.width = 1024; f.pooled.height = 5120; f.renderer.free.clear(); f.renderer.free.set('1024:5120', [f.pooled])
  Object.assign(f.driver, { resourceEpoch: 4, completedResourceEpoch: 3 })
  f.renderer.poolReleaseEpoch.set(f.pooled, 4); f.renderer.used.add(f.pooled)
  // The bounded first batch reaches its resource-count limit before touching
  // the large pool. Its real checkpoint nevertheless covers that exact pool.
  for (let i = 0; i < 4096; i++) f.renderer.retiredUploads.push({ width: 1, height: 1, bytes: 16, resource: {} } as Texture)
  const pending = f.renderer.reclaimScratch(64 * MiB)
  expect(f.driver.checkpoint).toHaveBeenCalledOnce(); expect(f.driver.destroy).not.toHaveBeenCalled()
  f.complete(); await pending
  expect(f.driver.destroy).toHaveBeenCalledWith(f.pooled); expect(f.driver.destroy).not.toHaveBeenCalledWith(image)
  expect(f.renderer.images.get('source').texture).toBe(image)
  expect(f.renderer.overBudget(64 * MiB)).toBe(false)
  expect((f.driver as typeof f.driver & { completedResourceEpoch: number }).completedResourceEpoch).toBe(3)
  expect(f.renderer.frameBudget).toBe(256 * MiB)
})

test('candidate pressure can still evict an unpinned image when no covered pool can satisfy the actual allocation', async () => {
  vi.stubEnv('VITE_DESIGN_EXACT_CLAMP_PREFIX', '1')
  const f = fixture(), image = { width: 2048, height: 2048, bytes: 64 * MiB, resource: {} } as Texture
  f.renderer.bytes = 250 * MiB; f.renderer.free.clear(); f.renderer.images.set('source', { texture: image }); f.renderer.used.add(image)
  const pending = f.renderer.reclaimScratch(32 * MiB)
  expect(f.driver.destroy).not.toHaveBeenCalled(); f.complete(); await pending
  expect(f.driver.destroy).toHaveBeenCalledExactlyOnceWith(image)
  expect(f.renderer.images.has('source')).toBe(false); expect(f.renderer.overBudget(32 * MiB)).toBe(false)
})

test('candidate pressure preserves both current-frame pool and image after an uncertain completion', async () => {
  vi.stubEnv('VITE_DESIGN_EXACT_CLAMP_PREFIX', '1')
  const f = fixture(80 * MiB), image = { width: 512, height: 512, bytes: 4 * MiB, resource: {} } as Texture
  f.renderer.bytes = 250 * MiB; f.renderer.images.set('source', { texture: image }); f.renderer.used.add(image)
  f.pooled.width = 1024; f.pooled.height = 5120; f.renderer.free.clear(); f.renderer.free.set('1024:5120', [f.pooled])
  const pending = f.renderer.reclaimScratch(64 * MiB)
  f.fail(); await expect(pending).rejects.toThrow('lost fence')
  expect(f.driver.destroy).not.toHaveBeenCalled(); expect(f.renderer.images.get('source').texture).toBe(image)
  expect(f.renderer.free.get('1024:5120')).toEqual([f.pooled])
})

function sequential(poolBytes = 48 * MiB, bytes = 160 * MiB) {
  const f = fixture(poolBytes)
  f.renderer.scene = { sequentialDisplay: true }; f.renderer.bytes = bytes
  Object.assign(f.driver, { resourceEpoch: 4, completedResourceEpoch: 3 })
  // These entries were just consumed in this frame. An old completed epoch
  // cannot justify immediate destruction; queue-ordered reuse remains legal.
  f.renderer.poolReleaseEpoch.set(f.pooled, 4)
  return f
}

async function expectQueuedPoolReuse(f: ReturnType<typeof fixture>, bytes: number) {
  // A real-size 48 MiB RGBA32F allocation within WebGPU's dimension limits.
  f.renderer.free.clear(); f.pooled.width = 1024; f.pooled.height = 3072
  const key = `${f.pooled.width}:${f.pooled.height}`
  f.renderer.free.set(key, [f.pooled])
  const create = vi.fn(() => { throw Error('Pool reuse unexpectedly allocated') })
  Object.assign(f.driver, { create })
  const commands: (() => void)[] = [], observed: number[] = [], expected: number[] = []
  let pixel = 7
  // Scalar deferred transport models only command/resource order. It is not
  // a native GPU pixel-equivalence or memory-admission oracle.
  for (let i = 0; i < 8; i++) {
    commands.push(() => observed.push(pixel)); expected.push(i ? i + 9 : 7)
    await f.renderer.reclaimScratch()
    const surface = f.renderer.acquire({ x: 20, y: 30 + i, w: 1024, h: 3072 })
    expect(surface.texture).toBe(f.pooled)
    commands.push(() => { pixel = i + 10 }); commands.push(() => observed.push(pixel)); expected.push(i + 10)
    f.renderer.release(surface)
  }
  expect(observed).toEqual([])
  for (const command of commands) command()
  expect(observed).toEqual(expected)
  expect(create).not.toHaveBeenCalled(); expect(f.driver.checkpoint).not.toHaveBeenCalled()
  expect(f.driver.destroy).not.toHaveBeenCalled()
  expect(f.renderer.free.get(key)).toEqual([f.pooled]); expect(f.renderer.bytes).toBe(bytes * MiB)
  expect(f.renderer.frameBudget).toBe(256 * MiB)
}

test.each([160, 192, 240, 256])('sequential pool-only bands at %s MiB reuse the current-frame texture in queue order without a fence, destruction or allocation', async bytes => {
  await expectQueuedPoolReuse(sequential(48 * MiB, bytes * MiB), bytes)
})

test.each([160, 192, 240, 256])('ordinary pool-only work at %s MiB reuses the same queue-ordered storage without relying on resource epoch metadata', async bytes => {
  for (const enabled of [undefined, false]) {
    const f = fixture(48 * MiB); f.renderer.bytes = bytes * MiB
    f.renderer.scene.sequentialDisplay = enabled
    await expectQueuedPoolReuse(f, bytes)
  }
})

test.each([undefined, false])('ordinary pool-only work with sequentialDisplay=%s preserves even an incomplete current-frame owner', async enabled => {
  const f = sequential(); f.renderer.scene.sequentialDisplay = enabled
  await f.renderer.reclaimScratch()
  expect(f.driver.checkpoint).not.toHaveBeenCalled(); expect(f.driver.destroy).not.toHaveBeenCalled()
  expect(f.renderer.poolReleaseEpoch.get(f.pooled)).toBe(4)
  expect(f.renderer.free.get(`${f.pooled.width}:${f.pooled.height}`)).toEqual([f.pooled])
  expect(f.renderer.bytes).toBe(160 * MiB)
})

test('ordinary pool-only maintenance still fences an existing ledger above its current budget', async () => {
  const f = fixture(48 * MiB); f.renderer.bytes = 270 * MiB
  const pending = f.renderer.reclaimScratch()
  expect(f.driver.checkpoint).toHaveBeenCalledExactlyOnceWith('admission', undefined)
  expect(f.driver.destroy).not.toHaveBeenCalled()
  f.complete(); await pending
  expect(f.driver.destroy).toHaveBeenCalledExactlyOnceWith(f.pooled)
  expect(f.renderer.bytes).toBe(222 * MiB)
})

test.each([1, 16 * MiB, 96 * MiB])('a sequential allocation estimate of %s bytes that fits retains useful pooled storage', async required => {
  const f = sequential()
  await f.renderer.reclaimScratch(required)
  expect(f.driver.checkpoint).not.toHaveBeenCalled(); expect(f.driver.destroy).not.toHaveBeenCalled()
  expect(f.renderer.free.get(`${f.pooled.width}:${f.pooled.height}`)).toEqual([f.pooled])
  expect(f.renderer.bytes).toBe(160 * MiB); expect(f.renderer.frameBudget).toBe(256 * MiB)
  expect(f.renderer.overBudget(required)).toBe(false)
})

test.each([1, 16 * MiB, 96 * MiB])('an ordinary allocation estimate of %s bytes that fits retains pooled storage and image-table ownership without epoch evidence', async required => {
  for (const table of ['none', 'active', 'retired']) {
    const f = fixture(48 * MiB), image = { width: 1024, height: 1024, bytes: 16 * MiB, resource: {} } as Texture
    f.renderer.bytes = 160 * MiB
    if (table !== 'none') {
      f.renderer.images.set('table-source', { texture: image }); f.active.add(image)
      Object.assign(f.driver, { scratchBytes: 4 * MiB, retiredImageTableBytes: table === 'retired' ? 4 * MiB : 0 })
    }
    await f.renderer.reclaimScratch(required)
    expect(f.driver.checkpoint).not.toHaveBeenCalled(); expect(f.driver.destroy).not.toHaveBeenCalled()
    expect(f.renderer.free.get(`${f.pooled.width}:${f.pooled.height}`)).toEqual([f.pooled])
    expect(f.renderer.bytes).toBe(160 * MiB); expect(f.renderer.overBudget(required)).toBe(false)
    if (table !== 'none') {
      expect(f.active.has(image)).toBe(true); expect(f.renderer.images.get('table-source').texture).toBe(image)
      expect(f.driver.scratchBytes).toBe(4 * MiB)
      expect((f.driver as any).retiredImageTableBytes).toBe(table === 'retired' ? 4 * MiB : 0)
    }
  }
})

test.each([false, true])('one byte beyond a fitting ordinary allocation requires a real fence; failure=%s preserves owners', async fails => {
  for (const table of ['none', 'active', 'retired']) {
    const f = fixture(48 * MiB), image = { width: 1024, height: 1024, bytes: 16 * MiB, resource: {} } as Texture
    f.renderer.bytes = 160 * MiB
    if (table !== 'none') {
      f.renderer.images.set('table-source', { texture: image }); f.active.add(image)
      Object.assign(f.driver, { scratchBytes: 4 * MiB, retiredImageTableBytes: table === 'retired' ? 4 * MiB : 0 })
    }
    const required = 96 * MiB + 1, pending = f.renderer.reclaimScratch(required)
    expect(f.driver.checkpoint).toHaveBeenCalledExactlyOnceWith('admission', undefined)
    expect(f.driver.destroy).not.toHaveBeenCalled()
    if (fails) {
      f.fail(); await expect(pending).rejects.toThrow('lost fence')
      expect(f.driver.destroy).not.toHaveBeenCalled(); expect(f.renderer.bytes).toBe(160 * MiB)
      expect(f.renderer.free.get(`${f.pooled.width}:${f.pooled.height}`)).toEqual([f.pooled])
    } else {
      f.complete(); await pending
      expect(f.driver.destroy).toHaveBeenCalledExactlyOnceWith(f.pooled)
      expect(f.renderer.bytes).toBe(112 * MiB); expect(f.renderer.overBudget(required)).toBe(false)
    }
    if (table !== 'none') {
      expect(f.active.has(image)).toBe(true); expect(f.renderer.images.get('table-source').texture).toBe(image)
      expect(f.driver.scratchBytes).toBe(4 * MiB)
    }
  }
})

function requiredSequentialRetirement(kind: 'allocation' | 'retired-upload' | 'coordinate' | 'image') {
  const f = kind === 'allocation' ? sequential() : sequential(128 * 1024, kind === 'image' ? 203 * MiB : 160 * MiB)
  const resource = { width: 1024, height: 3072, bytes: 48 * MiB, resource: {} } as Texture
  if (kind === 'retired-upload') f.renderer.retiredUploads.push(resource)
  if (kind === 'coordinate') f.renderer.coordinateMaps.add(resource)
  if (kind === 'image') f.renderer.images.set('cold-image', { texture: resource })
  return { ...f, resource, required: kind === 'allocation' ? 128 * MiB : 0 }
}

// Optional no-pressure retirement may defer, but no ownership or charge is
// released until a real checkpoint. Then exercise the allocation boundary.
async function observeDeferredRetirement(f: ReturnType<typeof requiredSequentialRetirement>, kind: string) {
  if (kind !== 'retired-upload' && kind !== 'coordinate') return
  const bytes = f.renderer.bytes, key = `${f.pooled.width}:${f.pooled.height}`
  await f.renderer.reclaimScratch(0)
  expect(f.driver.checkpoint).not.toHaveBeenCalled(); expect(f.driver.destroy).not.toHaveBeenCalled()
  expect(f.renderer.bytes).toBe(bytes); expect(f.renderer.free.get(key)).toEqual([f.pooled])
  if (kind === 'retired-upload') expect(f.renderer.retiredUploads).toContain(f.resource)
  else expect(f.renderer.coordinateMaps.has(f.resource)).toBe(true)
  f.required = 1 // A known allocation is an explicit non-deferrable boundary.
}

test.each(['allocation', 'retired-upload', 'coordinate', 'image'] as const)(
  'sequential %s work still waits for completion before retiring resources', async kind => {
    const f = requiredSequentialRetirement(kind); await observeDeferredRetirement(f, kind)
    const pending = f.renderer.reclaimScratch(f.required)
    expect(f.driver.checkpoint).toHaveBeenCalledExactlyOnceWith('admission', undefined)
    expect(f.driver.destroy).not.toHaveBeenCalled()
    f.complete(); await pending
    expect(f.driver.destroy).toHaveBeenCalledWith(kind === 'allocation' ? f.pooled : f.resource)
    expect(f.renderer.frameBudget).toBe(256 * MiB)
    if (kind === 'allocation') expect(f.renderer.overBudget(160 * MiB)).toBe(true)
    if (kind === 'retired-upload') expect(f.renderer.retiredUploads).not.toContain(f.resource)
    if (kind === 'coordinate') expect(f.renderer.coordinateMaps.has(f.resource)).toBe(false)
    if (kind === 'image') expect(f.renderer.images.has('cold-image')).toBe(false)
  },
)

test.each(['allocation', 'retired-upload', 'coordinate', 'image'] as const)(
  'ordinary %s work still fences before retiring resources and preserves every owner on device-loss failure', async kind => {
    for (const fails of [false, true]) {
      const f = requiredSequentialRetirement(kind); f.renderer.scene.sequentialDisplay = false
      await observeDeferredRetirement(f, kind)
      const bytes = f.renderer.bytes, key = `${f.pooled.width}:${f.pooled.height}`
      const pending = f.renderer.reclaimScratch(f.required)
      expect(f.driver.checkpoint).toHaveBeenCalledExactlyOnceWith('admission', undefined)
      expect(f.driver.destroy).not.toHaveBeenCalled()
      if (fails) {
        f.fail(); await expect(pending).rejects.toThrow('lost fence')
        expect(f.driver.destroy).not.toHaveBeenCalled(); expect(f.renderer.bytes).toBe(bytes)
        expect(f.renderer.free.get(key)).toEqual([f.pooled])
        if (kind === 'retired-upload') expect(f.renderer.retiredUploads).toContain(f.resource)
        if (kind === 'coordinate') expect(f.renderer.coordinateMaps.has(f.resource)).toBe(true)
        if (kind === 'image') expect(f.renderer.images.get('cold-image').texture).toBe(f.resource)
      } else {
        f.complete(); await pending
        expect(f.driver.destroy).toHaveBeenCalledWith(kind === 'allocation' ? f.pooled : f.resource)
        expect(f.renderer.frameBudget).toBe(256 * MiB)
        if (kind === 'allocation') expect(f.renderer.overBudget(160 * MiB)).toBe(true)
        if (kind === 'retired-upload') expect(f.renderer.retiredUploads).not.toContain(f.resource)
        if (kind === 'coordinate') expect(f.renderer.coordinateMaps.has(f.resource)).toBe(false)
        if (kind === 'image') expect(f.renderer.images.has('cold-image')).toBe(false)
      }
    }
  },
)

function pinnedSequentialImage(kind: 'image' | 'atlas' | 'empty-atlas') {
  const f = sequential(128 * 1024, 203 * MiB)
  const image = { width: 1024, height: 3072, bytes: 48 * MiB, resource: {} } as Texture
  if (kind !== 'empty-atlas') f.renderer.images.set('image', { texture: image })
  if (kind !== 'image') f.renderer.atlasPages.push({ texture: image,
    entries: new Map(kind === 'empty-atlas' ? [] : [['image', {}]]) })
  f.renderer.sequentialImagePins.add(image)
  return { ...f, image }
}

test('real sequential allocation pressure still fences while its pinned source stays owned and the 256 MiB limit remains authoritative', async () => {
  const f = pinnedSequentialImage('image'), pending = f.renderer.reclaimScratch(64 * MiB)
  expect(f.driver.checkpoint).toHaveBeenCalledExactlyOnceWith('admission', undefined)
  expect(f.driver.destroy).not.toHaveBeenCalled()
  f.complete(); await pending
  expect(f.driver.destroy).toHaveBeenCalledExactlyOnceWith(f.pooled)
  expect(f.renderer.images.get('image').texture).toBe(f.image)
  expect(f.renderer.sequentialImagePins.has(f.image)).toBe(true)
  expect(f.renderer.frameBudget).toBe(256 * MiB)
  expect(f.renderer.overBudget(64 * MiB)).toBe(true)
  expect(f.driver.destroy).not.toHaveBeenCalledWith(f.image)
})

test.each(['image', 'atlas', 'empty-atlas'] as const)(
  'a pinned sequential %s above 75 percent avoids empty maintenance and survives forced eviction until unpinned', async kind => {
    const f = pinnedSequentialImage(kind)
    await f.renderer.reclaimScratch()
    // Explicit forced eviction is also forbidden while later bands still
    // own this real texture; a URI or count-only pin would not be sufficient.
    f.renderer.evictImages(64 * MiB, true)
    expect(f.driver.checkpoint).not.toHaveBeenCalled(); expect(f.driver.destroy).not.toHaveBeenCalled()
    expect(f.renderer.bytes).toBe(203 * MiB)
    if (kind !== 'empty-atlas') expect(f.renderer.images.get('image').texture).toBe(f.image)
    if (kind !== 'image') expect(f.renderer.atlasPages).toHaveLength(1)
    f.renderer.sequentialImagePins.delete(f.image)
    const pending = f.renderer.reclaimScratch()
    expect(f.driver.checkpoint).toHaveBeenCalledExactlyOnceWith('admission', undefined)
    expect(f.driver.destroy).not.toHaveBeenCalled()
    f.complete(); await pending
    expect(f.driver.destroy).toHaveBeenCalledWith(f.image)
    expect(f.renderer.images.size).toBe(0); expect(f.renderer.atlasPages).toHaveLength(0)
  },
)

test.each(['image', 'atlas', 'empty-atlas'] as const)(
  'a failed image-pressure fence after sequential %s unpinning preserves the source and pool owners', async kind => {
    const f = pinnedSequentialImage(kind)
    await f.renderer.reclaimScratch()
    f.renderer.sequentialImagePins.delete(f.image)
    const pending = f.renderer.reclaimScratch()
    expect(f.driver.checkpoint).toHaveBeenCalledOnce()
    f.fail(); await expect(pending).rejects.toThrow('lost fence')
    expect(f.driver.destroy).not.toHaveBeenCalled(); expect(f.renderer.bytes).toBe(203 * MiB)
    expect(f.renderer.free.get(`${f.pooled.width}:${f.pooled.height}`)).toEqual([f.pooled])
    if (kind !== 'empty-atlas') expect(f.renderer.images.get('image').texture).toBe(f.image)
    if (kind !== 'image') expect(f.renderer.atlasPages).toHaveLength(1)
  },
)

test.each(['allocation', 'retired-upload', 'coordinate', 'image'] as const)(
  'a failed sequential %s fence leaves all resource owners intact', async kind => {
    const f = requiredSequentialRetirement(kind); await observeDeferredRetirement(f, kind)
    const bytes = f.renderer.bytes
    const key = `${f.pooled.width}:${f.pooled.height}`, pending = f.renderer.reclaimScratch(f.required)
    expect(f.driver.checkpoint).toHaveBeenCalledOnce()
    f.fail(); await expect(pending).rejects.toThrow('lost fence')
    expect(f.driver.destroy).not.toHaveBeenCalled()
    expect(f.renderer.free.get(key)).toEqual([f.pooled]); expect(f.renderer.bytes).toBe(bytes)
    if (kind === 'retired-upload') expect(f.renderer.retiredUploads).toContain(f.resource)
    if (kind === 'coordinate') expect(f.renderer.coordinateMaps.has(f.resource)).toBe(true)
    if (kind === 'image') expect(f.renderer.images.get('cold-image').texture).toBe(f.resource)
  },
)
