import { expect, test } from 'vitest'
import { GpuRenderer } from './renderer'
import type { Driver, Texture } from './types'

test('completed free-pool duplicates are destroyed while an in-flight texture stays', () => {
  const destroyed: Texture[] = []
  const renderer = new GpuRenderer({
    managed: true, scratchBytes: 0, completedResourceEpoch: 3, resourceEpoch: 4,
    destroy: (texture: Texture) => { destroyed.push(texture) },
  } as unknown as Driver) as unknown as {
    bytes: number
    free: Map<string, Texture[]>
    poolReleaseEpoch: WeakMap<Texture, number>
    lastUsed: Map<Texture, number>
    used: Set<Texture>
    ledger: { completedFreeBytes: number }
    reapCompletedFreeTextures(): void
  }
  const textures = [1, 2, 3, 4, 5].map(id => ({ id, width: 4, height: 4, bytes: 64, resource: {} }) as unknown as Texture)
  for (const [index, texture] of textures.entries()) {
    renderer.bytes += texture.bytes
    renderer.poolReleaseEpoch.set(texture, index === 4 ? 4 : 3)
    renderer.lastUsed.set(texture, index + 1)
    renderer.used.add(texture)
  }
  renderer.free.set('4:4', textures)
  renderer.reapCompletedFreeTextures()
  const left = renderer.free.get('4:4') ?? []
  expect(left.map(texture => (texture as unknown as { id: number }).id).sort()).toEqual([3, 4, 5])
  expect(destroyed.map(texture => (texture as unknown as { id: number }).id).sort()).toEqual([1, 2])
  expect(renderer.bytes).toBe(64 * 3)
  expect(renderer.ledger.completedFreeBytes).toBe(128)
})

test('tracked surfaces keep class, life and peak apart from completed free bytes', () => {
  const driver = {
    managed: true, scratchBytes: 32, completedResourceEpoch: 1, resourceEpoch: 4,
    destroy: () => {},
    create: () => { throw new Error('unused') },
  }
  const renderer = new GpuRenderer(driver as unknown as Driver) as unknown as {
    busy: Set<Texture>
    chargeTexture(texture: Texture, klass: 'surface'): void
    release(surface: { texture: Texture; rect: { x: number; y: number; w: number; h: number } }): void
    reapCompletedFreeTextures(): void
    texturePeakAttribution(): {
      chargedBytes: number
      peakBytes: number
      completedFreeBytes: number
      classes: { scratch: number; surface: number }
      life: { active: number; 'retired-pending-completion': number; reclaimable: number }
    }
  }
  const textures = [1, 2, 3].map(id => ({ id, width: 4, height: 4, bytes: 64, resource: {} }) as unknown as Texture)
  for (const texture of textures) {
    renderer.chargeTexture(texture, 'surface')
    renderer.busy.add(texture)
    renderer.release({ texture, rect: { x: 0, y: 0, w: 4, h: 4 } })
  }
  let sample = renderer.texturePeakAttribution()
  expect(sample.classes.scratch).toBe(32)
  expect(sample.classes.surface).toBe(192)
  expect(sample.chargedBytes).toBe(224)
  expect(sample.peakBytes).toBe(224)
  expect(sample.life.active).toBe(0)
  expect(sample.life['retired-pending-completion']).toBe(192)
  driver.completedResourceEpoch = 4
  renderer.reapCompletedFreeTextures()
  sample = renderer.texturePeakAttribution()
  expect(sample.completedFreeBytes).toBe(64)
  expect(sample.chargedBytes).toBe(160)
  expect(sample.peakBytes).toBe(224)
  expect(sample.classes.surface).toBe(128)
  expect(sample.classes.scratch).toBe(32)
  expect(sample.life.reclaimable).toBe(128)
  expect(sample.life.active).toBe(0)
})

test('an in-flight free texture survives budget pressure and the next frame sweep until its epoch completes', () => {
  const destroyed: Texture[] = []
  const driver = {
    managed: true, scratchBytes: 0, resourceEpoch: 5, completedResourceEpoch: 3,
    destroy: (texture: Texture) => { destroyed.push(texture) },
  }
  const renderer = new GpuRenderer(driver as unknown as Driver, undefined, undefined, undefined, undefined, undefined, 256) as unknown as {
    bytes: number
    frameBudget: number
    free: Map<string, Texture[]>
    used: Set<Texture>
    poolReleaseEpoch: WeakMap<Texture, number>
    overBudget(required: number): boolean
    retireUnreferencedFreeTextures(trimLarge?: boolean, upcoming?: ReadonlySet<string>): void
  }
  const pending = { width: 8, height: 8, bytes: 1024, resource: {} } as unknown as Texture
  const finished = { width: 4, height: 4, bytes: 256, resource: {} } as unknown as Texture
  const unstamped = { width: 2, height: 2, bytes: 64, resource: {} } as unknown as Texture
  renderer.frameBudget = pending.bytes
  renderer.bytes = pending.bytes + finished.bytes + unstamped.bytes
  renderer.free.set('8:8', [pending])
  renderer.free.set('4:4', [finished])
  renderer.free.set('2:2', [unstamped])
  renderer.poolReleaseEpoch.set(pending, 4)
  renderer.poolReleaseEpoch.set(finished, 3)
  expect(renderer.overBudget(1)).toBe(true)
  expect(destroyed.map(texture => texture.bytes).sort((a, b) => a - b)).toEqual([64, 256])
  expect(renderer.free.get('8:8')).toEqual([pending])
  expect(renderer.bytes).toBe(pending.bytes)
  driver.completedResourceEpoch = 4
  expect(renderer.overBudget(1)).toBe(false)
  expect(destroyed).toContain(pending)
  expect(renderer.free.has('8:8')).toBe(false)

  const swept = { width: 16, height: 16, bytes: 4096, resource: {} } as unknown as Texture
  const readable = { width: 3, height: 3, bytes: 128, resource: {} } as unknown as Texture
  destroyed.length = 0
  driver.completedResourceEpoch = 3
  renderer.bytes = swept.bytes + readable.bytes
  renderer.free.set('16:16', [swept])
  renderer.free.set('3:3', [readable])
  renderer.poolReleaseEpoch.set(swept, 5)
  renderer.poolReleaseEpoch.set(readable, 3)
  renderer.used.add(readable)
  renderer.retireUnreferencedFreeTextures()
  expect(destroyed).toEqual([])
  expect(renderer.free.get('16:16')).toEqual([swept])
  expect(renderer.free.get('3:3')).toEqual([readable])
  renderer.used.delete(readable)
  driver.completedResourceEpoch = 5
  renderer.retireUnreferencedFreeTextures()
  expect(destroyed).toEqual([swept, readable])
  expect(renderer.free.size).toBe(0)
  expect(renderer.bytes).toBe(0)
})
