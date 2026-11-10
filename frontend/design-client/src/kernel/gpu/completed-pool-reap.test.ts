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
