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
