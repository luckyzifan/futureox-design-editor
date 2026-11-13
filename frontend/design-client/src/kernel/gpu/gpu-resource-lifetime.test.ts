import { expect, test } from 'vitest'
import { GpuResourceLifetime, type LifetimeHost } from './gpu-resource-lifetime'
import { GpuRenderer } from './renderer'
import type { Driver, Texture } from './types'

type Tex = { id: number; bytes: number; width: number; height: number; resource: object }

function host(completed = 1, epoch = 4) {
  const destroyed: Tex[] = []
  const state = {
    destroyed,
    completed,
    epoch,
    protectedTexture: () => false,
    dropPhase: () => {},
    frameUse: () => false,
    dropFrameUse: () => {},
    pinned: () => false,
    destroy: (texture: Tex) => { destroyed.push(texture) },
    resourceEpoch: () => state.epoch,
    completedEpoch: () => state.completed,
  }
  return state satisfies LifetimeHost<Tex> & { destroyed: Tex[]; completed: number; epoch: number }
}

test('alias holders stay out of the pool until the last retire, which does not destroy', () => {
  const owner = host()
  const life = new GpuResourceLifetime<Tex, { texture: Tex }>(owner)
  const texture: Tex = { id: 7, width: 2, height: 2, bytes: 16, resource: {} }
  life.charge(texture, 'surface')
  life.busy.add(texture)
  const first = { texture }
  const second = life.hold(first)
  life.retire([first])
  expect(life.busy.has(texture)).toBe(true)
  expect(life.free.size).toBe(0)
  expect(owner.destroyed).toEqual([])
  life.retire([second])
  expect(life.busy.has(texture)).toBe(false)
  expect(owner.destroyed).toEqual([])
  expect(life.free.get('2:2')).toEqual([texture])
  expect(life.ledger.bytes).toBe(16)
  expect(life.ledger.life({
    busy: false,
    poolEpoch: life.ledger.poolEpochs.get(texture),
    completedEpoch: owner.completed,
  })).toBe('retired-pending-completion')
})

test('a late completion drops only the oldest completed duplicates and the next acquire reuses a survivor', () => {
  const owner = host(1, 4)
  const life = new GpuResourceLifetime<Tex, { texture: Tex }>(owner)
  const textures = [1, 2, 3].map(id => ({ id, width: 4, height: 4, bytes: 64, resource: {} }) as Tex)
  for (const texture of textures) {
    life.charge(texture, 'surface')
    life.busy.add(texture)
    life.retire([{ texture }])
  }
  life.reapCompletedFree()
  expect(owner.destroyed).toEqual([])
  expect(life.ledger.lifeBytes['retired-pending-completion']).toBe(192)
  owner.completed = 4
  life.reapCompletedFree()
  expect(owner.destroyed.map(texture => texture.id)).toEqual([1])
  expect(life.ledger.bytes).toBe(128)
  expect(life.ledger.peak).toBe(192)
  expect(life.ledger.completedFreeBytes).toBe(64)
  expect(life.ledger.lifeBytes.reclaimable).toBe(128)
  const reused = life.takePooled('4:4')
  expect(reused?.id).toBe(3)
  expect(owner.destroyed.includes(reused!)).toBe(false)
  expect(life.ledger.bytes).toBe(128)
})

test('a retired kernel waits for its encode epoch and is released once', () => {
  const owner = host(1, 5)
  const life = new GpuResourceLifetime<Tex, { texture: Tex }>(owner)
  const texture: Tex = { id: 9, width: 4, height: 1, bytes: 16, resource: {} }
  life.charge(texture, 'kernel')
  life.retiredKernels.push({ texture, epoch: 4 })
  life.reapRetiredKernels()
  expect(owner.destroyed).toEqual([])
  expect(life.ledger.bytes).toBe(16)
  owner.completed = 4
  life.reapRetiredKernels()
  expect(owner.destroyed).toEqual([texture])
  expect(life.ledger.bytes).toBe(0)
  expect(life.ledger.peak).toBe(16)
  expect(life.retiredKernels).toEqual([])
})

test('device loss forgets owners without destroying textures or clearing the charge', () => {
  const owner = host()
  const life = new GpuResourceLifetime<Tex, { texture: Tex }>(owner)
  const texture: Tex = { id: 1, width: 1, height: 1, bytes: 64, resource: {} }
  life.charge(texture, 'surface')
  life.hold({ texture })
  life.onDeviceLoss()
  expect(life.deviceLossReceipts).toBe(1)
  expect(owner.destroyed).toEqual([])
  expect(life.ledger.bytes).toBe(64)
  expect(life.ledger.peak).toBe(64)
  expect(life.ledger.aliases.size).toBe(0)
  expect(() => {
    life.ledger.bytes = 1.5
    life.onDeviceLoss()
  }).toThrow('GPU 设备丢失不能改写已记账字节')
  expect(life.deviceLossReceipts).toBe(1)
  expect(life.ledger.bytes).toBe(1.5)
})

test('the renderer reuses a pooled survivor after the kernel reap and does not create', () => {
  let created = 0
  const destroyed: Texture[] = []
  const renderer = new GpuRenderer({
    managed: true, scratchBytes: 0, resourceEpoch: 4, completedResourceEpoch: 3,
    create: () => { created += 1; return { width: 4, height: 4, bytes: 64, resource: {} } },
    destroy: (texture: Texture) => { destroyed.push(texture) },
  } as unknown as Driver) as unknown as {
    bytes: number
    free: Map<string, Texture[]>
    poolReleaseEpoch: WeakMap<Texture, number>
    lastUsed: Map<Texture, number>
    used: Set<Texture>
    reapCompletedFreeTextures(): void
    acquire(rect: { x: number; y: number; w: number; h: number }): { texture: Texture & { id: number } }
  }
  const textures = [1, 2, 3, 4, 5].map(id => ({ id, width: 4, height: 4, bytes: 64, resource: {} }) as Texture & { id: number })
  for (const [index, texture] of textures.entries()) {
    renderer.bytes += texture.bytes
    renderer.poolReleaseEpoch.set(texture, index === 4 ? 4 : 3)
    renderer.lastUsed.set(texture, index + 1)
    renderer.used.add(texture)
  }
  renderer.free.set('4:4', textures)
  renderer.reapCompletedFreeTextures()
  const surface = renderer.acquire({ x: 0, y: 0, w: 4, h: 4 })
  expect(created).toBe(0)
  expect(surface.texture.id).toBe(5)
  expect(destroyed.map(texture => (texture as unknown as { id: number }).id).sort()).toEqual([1, 2])
  expect(renderer.bytes).toBe(192)
})

test('lost dispose records the owner reset and ordinary dispose does not', () => {
  const lost = new GpuRenderer({
    lost: true, scratchBytes: 8, managed: true, destroy: () => {}, dispose() {},
  } as unknown as Driver) as unknown as {
    chargeTexture(texture: Texture, klass: 'surface'): void
    busy: Set<Texture>
    retain(surface: { texture: Texture; rect: { x: number; y: number; w: number; h: number } }): unknown
    dispose(): void
    bytes: number
    peak: number
    lifetime: { deviceLossReceipts: number }
  }
  const texture = { width: 2, height: 2, bytes: 16, resource: {} } as Texture
  lost.chargeTexture(texture, 'surface')
  lost.busy.add(texture)
  lost.retain({ texture, rect: { x: 0, y: 0, w: 2, h: 2 } })
  lost.dispose()
  expect(lost.lifetime.deviceLossReceipts).toBe(1)
  expect(lost.bytes).toBe(0)
  expect(lost.peak).toBe(24)
  const ordinary = new GpuRenderer({ scratchBytes: 0, lost: false, dispose() {} } as unknown as Driver) as unknown as {
    dispose(): void
    lifetime: { deviceLossReceipts: number }
  }
  ordinary.dispose()
  expect(ordinary.lifetime.deviceLossReceipts).toBe(0)
})
