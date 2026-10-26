import { expect, test, vi } from 'vitest'
import { GpuRenderer, type Surface } from './renderer'
import { CoverageCache } from './coverage-cache'
import { rect, type Driver, type GpuNode, type PathMesh, type Rect, type Texture } from './types'

type Lifetime = {
  bytes: number
  frameBudget:number
  activeNode: string
  masks: Map<string, Surface>
  maskOwners: Map<Texture, Set<string>>
  sharedMasks: Map<string, { bits: Uint32Array; texture: Texture }[]>
  coverage: CoverageCache
  busy: Set<Texture>
  free: Map<string, Texture[]>
  mask(path: PathMesh): Surface
  nodeMask(node: GpuNode): Surface
  acquire(rect: Rect): Surface
  retireLeafMasks(node: GpuNode, masks: Surface[] | undefined, clip: Surface[] | undefined, targets: Surface[]): void
}
function fixture() {
  let sequence = 0
  const driver = {
    managed: true,
    create: vi.fn((width: number, height: number): Texture => ({ width, height, bytes: width * height * 16, resource: { sequence: sequence++ } as unknown as GPUTexture })),
    destroy: vi.fn(), clear: vi.fn(), mask: vi.fn(), pass: vi.fn(),
  }
  const renderer = new GpuRenderer(driver as unknown as Driver), lifetime = renderer as unknown as Lifetime
  // Simulate already-live ancestor surfaces without allocating large CPU/GPU buffers.
  lifetime.bytes = lifetime.frameBudget * .375
  lifetime.coverage.begin(); lifetime.activeNode = 'leaf'
  const path: PathMesh = { rect: rect(0, 0, 2, 2), first: 0, count: 0, rule: 'nonzero' }
  const node = { id: 'leaf', children: [], rect: path.rect, fill: path } as unknown as GpuNode
  return { driver, lifetime, path, node }
}

test('retiring a completed leaf detaches every mask cache before its texture is reused', () => {
  const { driver, lifetime: state, path, node } = fixture()
  const mask = state.mask(path), bits = new Uint32Array([1])
  state.masks.set('alias', { ...mask })
  state.sharedMasks.set('alias', [{ bits, texture: mask.texture }])
  state.coverage.put('alias', bits, mask.texture)
  state.retireLeafMasks(node, [mask, mask, { ...mask }], undefined, [])
  expect(state.coverage.has(mask.texture)).toBe(false)
  expect([...state.masks.values()].some((value) => value.texture === mask.texture)).toBe(false)
  expect([...state.sharedMasks.values()].flat().some((value) => value.texture === mask.texture)).toBe(false)
  expect(state.maskOwners.has(mask.texture)).toBe(false)
  expect(state.free.get('2:2')).toEqual([mask.texture])
  expect(driver.destroy).not.toHaveBeenCalled()
  const nowUsedForPixels = state.acquire(path.rect)
  expect(nowUsedForPixels.texture).toBe(mask.texture)
  // This lookup must rerasterize, not interpret the now-reused color surface as coverage.
  const newMask = state.mask(path)
  expect(newMask.texture).not.toBe(nowUsedForPixels.texture)
  expect(driver.clear).toHaveBeenCalledTimes(2)
})

test('an ancestor or another node sharing the same mask keeps it pinned', () => {
  for (const via of ['local', 'coverage', 'shared'] as const) {
    const { driver, lifetime: state, path, node } = fixture()
    state.activeNode = 'ancestor'; const ancestorMask = state.mask(path)
    state.activeNode = 'leaf'
    if (via !== 'local') state.masks.clear()
    if (via === 'shared') state.coverage.remove(ancestorMask.texture)
    const leafMask = state.mask(path)
    expect(leafMask.texture).toBe(ancestorMask.texture)
    expect(state.maskOwners.get(leafMask.texture)).toEqual(new Set(['ancestor', 'leaf']))
    state.retireLeafMasks(node, [leafMask], undefined, [])
    expect(state.busy.has(leafMask.texture)).toBe(true)
    expect(state.free.get('2:2')).toBeUndefined()
    expect(driver.destroy).not.toHaveBeenCalled()
  }
})

test('incoming clip, current target, unknown owner and nonleaf masks cannot retire', () => {
  for (const protectedBy of ['clip', 'target', 'unknown', 'children'] as const) {
    const { lifetime: state, path, node } = fixture()
    if (protectedBy === 'unknown') state.activeNode = ''
    const mask = state.mask(path)
    if (protectedBy === 'unknown') { state.activeNode = 'leaf'; state.mask(path) }
    state.retireLeafMasks(protectedBy === 'children' ? { ...node, children: ['child'] } : node,
      [mask], protectedBy === 'clip' ? [mask] : undefined, protectedBy === 'target' ? [mask] : [])
    expect(state.busy.has(mask.texture)).toBe(true)
    expect(state.coverage.has(mask.texture)).toBe(true)
    expect(state.free.get('2:2')).toBeUndefined()
  }
})

test('opaque aliases also track all owners and repeated leaf references release only once', () => {
  const { lifetime: state, node, driver } = fixture(), opaque = { ...node, opaqueCoverage: true }
  const mask = state.nodeMask(opaque), same = state.nodeMask(opaque)
  expect(same.texture).toBe(mask.texture)
  expect(state.maskOwners.get(mask.texture)).toEqual(new Set(['leaf']))
  state.retireLeafMasks(opaque, [mask, same], undefined, [])
  expect(state.free.get('2:2')).toEqual([mask.texture])
  expect(driver.destroy).not.toHaveBeenCalled()
})
test('low-pressure frames retain exact coverage reuse', () => {
  const { lifetime: state, path, node } = fixture()
  state.bytes = 0
  const mask = state.mask(path)
  state.retireLeafMasks(node, [mask], undefined, [])
  expect(state.mask(path).texture).toBe(mask.texture)
  expect(state.coverage.has(mask.texture)).toBe(true)
  expect(state.busy.has(mask.texture)).toBe(true)
})

test('retiring one leaf never enumerates unrelated frame masks or collision buckets', () => {
  const { lifetime: state, path, node } = fixture(), mask = state.mask(path)
  for (let i = 0; i < 5000; i++) {
    const texture = { width: 1, height: 1, bytes: 16, resource: {} } as Texture
    state.masks.set(`foreign-${i}`, { texture, rect: rect(0, 0, 1, 1) })
    state.sharedMasks.set(`foreign-${i}`, [{ texture, bits: new Uint32Array([i]) }])
    state.maskOwners.set(texture, new Set([`foreign-${i}`]))
  }
  const localScan = vi.spyOn(state.masks, Symbol.iterator).mockImplementation(() => { throw Error('Global mask scan') })
  const sharedScan = vi.spyOn(state.sharedMasks, Symbol.iterator).mockImplementation(() => { throw Error('Global alias scan') })
  state.retireLeafMasks(node, undefined, undefined, [])
  expect(state.free.get('2:2')).toEqual([mask.texture])
  expect(state.masks.size).toBe(5000)
  expect(localScan).not.toHaveBeenCalled(); expect(sharedScan).not.toHaveBeenCalled()
})
