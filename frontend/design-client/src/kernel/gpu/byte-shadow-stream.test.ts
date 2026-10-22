import { afterEach, expect, test, vi } from 'vitest'
import { paint } from '../../model'
import { GpuRenderer, type Surface } from './renderer'
import type { Driver, GpuNode, Rect, Texture } from './types'
import { planByteTentPrefix } from './byte-tent-prefix-plan'

afterEach(() => vi.unstubAllEnvs())
function fixture() {
  vi.stubEnv('VITE_DESIGN_EXACT_CLAMP_PREFIX', '1'); vi.stubEnv('VITE_DESIGN_BYTE_TENT_PREFIX', '1')
  let scratch = 0, current = true
  const textures = new Set<Texture>(), sources = new Map<Texture, number>(), events: string[] = []
  const create = (w: number, h: number) => { const t = { width: w, height: h, bytes: w * h * 4, resource: {} } as Texture; textures.add(t); return t }
  const driver = { name: 'webgpu', managed: false, resourceEpoch: 7, completedResourceEpoch: 6,
    get scratchBytes() { return scratch }, create, maskRegion: vi.fn(), clear: vi.fn(),
    copyColorRegion: vi.fn((_target: Texture, _source: Texture, _region: Rect, _offset: [number, number]) => events.push('copy-resolved')),
    destroy: vi.fn((t: Texture) => textures.delete(t)), prepareByteTent: vi.fn(async () => true),
    encodeByteTentAlpha: vi.fn((_target: Texture, _source: Texture, options: any) => {
      scratch += 128; events.push(`axis${options.axis}`); return true
    }),
    abortFrameAndReleaseFilterScratch: vi.fn(async () => { events.push('abort'); scratch = 0 }),
    pass: vi.fn((_target: Texture, u: Float32Array, inputs: Texture[]) => {
      if (u[16] === 23) { expect(inputs.map(t => sources.get(t))).toEqual([0, 1, 2, 3]); events.push('old-byte-resolve') }
      if (u[16] === 6) events.push('old-shadow')
    }), over: vi.fn() }
  const renderer = new GpuRenderer(driver as unknown as Driver) as any
  const extent = { x: 0, y: 0, w: 12, h: 130 }, output = { x: 2, y: 64, w: 4, h: 4 }
  renderer.scene = { extent, rootInputBox: [2, 64, 4, 4], coherentSamples: true, integratedBlur: true }
  renderer.reclaimScratch = vi.fn(async () => {}); renderer.frameCurrent = () => current
  const n = { id: 'single-shadow', rect: extent, matrix: [1, 0, 0, 1, 0, 0], inverse: [1, 0, 0, 1, 0, 0], size: [12, 130],
    fill: { rect: extent, count: 3, area: { first: 0, count: 1 } }, fills: [paint('#ffffff')], strokes: [], children: [],
    blend: 'normal', opacity: .5, shadowOutputBox: [2, 64, 4, 4],
    effects: [{ visible: true, kind: 'shadow', radius: 3, spread: 0, x: 0, y: 2, color: '#123456', opacity: .75 }] } as unknown as GpuNode
  const sourceCalls: { region: Rect; sample: number }[] = []
  renderer.filterSource = (_n: GpuNode, region: Rect, sample: number) => {
    sourceCalls.push({ region: { ...region }, sample }); renderer.sampleIndex = sample
    const out = renderer.acquire(region); sources.set(out.texture, sample); return out
  }
  const targets = Array.from({ length: 4 }, () => renderer.acquire(output)) as Surface[]
  return { renderer, driver, n, targets, events, sourceCalls, textures, cancel: () => { current = false } }
}

test('byte shadow streams original four samples, keeps old mode23 rounding, and renders sharp phases only at the consumer', async () => {
  const f = fixture(), out = await f.renderer.streamByteShadow(f.n, f.targets) as Surface[]
  expect(out).toBe(f.targets); expect(f.driver.prepareByteTent).toHaveBeenCalledOnce()
  expect(f.sourceCalls.slice(0, 12).map(call => call.sample)).toEqual([0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3])
  expect(f.sourceCalls.slice(0, 12).map(call => call.region.h)).toEqual([64, 64, 64, 64, 64, 64, 64, 64, 2, 2, 2, 2])
  expect(f.sourceCalls.slice(12).map(call => call.region)).toEqual(Array.from({ length: 4 }, () => ({ x: 2, y: 64, w: 4, h: 4 })))
  expect(f.driver.copyColorRegion).toHaveBeenCalledTimes(3)
  expect(f.driver.encodeByteTentAlpha.mock.calls.map(call => ({ axis: call[2].axis, source: call[2].source, output: call[2].output })))
    .toEqual([{ axis: 0, source: f.n.rect, output: { x: 2, y: 0, w: 4, h: 130 } },
      { axis: 1, source: { x: 2, y: 0, w: 4, h: 130 }, output: { x: 2, y: 62, w: 4, h: 4 } }])
  expect(f.events.indexOf('old-byte-resolve')).toBeLessThan(f.events.indexOf('axis0'))
  expect(f.events.indexOf('axis0')).toBeLessThan(f.events.indexOf('axis1'))
  expect(f.events.indexOf('axis1')).toBeLessThan(f.events.indexOf('old-shadow'))
  expect(f.driver.pass.mock.calls.filter(call => call[1][16] === 6)).toHaveLength(4)
  expect(f.driver.scratchBytes).toBe(256)
  expect(f.renderer.bytes).toBe([...f.textures].reduce((sum, t) => sum + t.bytes, 256))
  expect(f.renderer.sampleIndex).toBeUndefined()
})

test.each(['partial-encode', 'cancel-after-horizontal'] as const)('%s aborts its whole encoder before unwinding owners and scratch accounting', async mode => {
  const f = fixture(), original = f.driver.encodeByteTentAlpha.getMockImplementation()!
  f.driver.encodeByteTentAlpha.mockImplementation((...args) => {
    const result = original(...args)
    if (mode === 'partial-encode') throw Error('partial-encode')
    f.cancel(); return result
  })
  await expect(f.renderer.streamByteShadow(f.n, f.targets)).rejects.toThrow(mode === 'partial-encode' ? 'partial-encode' : 'PREVIEW_CANCELLED')
  expect(f.driver.abortFrameAndReleaseFilterScratch).toHaveBeenCalledOnce()
  expect(f.events).not.toContain('old-shadow'); expect(f.driver.scratchBytes).toBe(0)
  expect(f.driver.completedResourceEpoch).toBe(6)
  expect(f.targets.every(target => f.renderer.busy.has(target.texture))).toBe(true)
  expect(f.renderer.bytes).toBe([...f.textures].reduce((sum, t) => sum + t.bytes, 0))
})

test('a matching byte-axis target is held busy before admitting new prefix scratch', async () => {
  const f = fixture(), source = f.renderer.acquire({ x: 0, y: 0, w: 12, h: 130 }) as Surface
  const output = { x: 2, y: 0, w: 4, h: 130 }, pooled = f.renderer.acquire(output) as Surface
  f.renderer.release(pooled)
  f.renderer.reclaimScratch = vi.fn(async () => {
    expect(f.renderer.busy.has(pooled.texture)).toBe(true)
    expect(f.renderer.free.get('4:130') || []).not.toContain(pooled.texture)
  })
  const result = await f.renderer.byteShadowAxis(source, planByteTentPrefix({ radius: 3, axis: 0, source: source.rect, output })!) as Surface
  expect(result.texture).toBe(pooled.texture); expect(f.driver.encodeByteTentAlpha).toHaveBeenCalledOnce()
})

function ancestorClips(f: ReturnType<typeof fixture>) {
  return [
    { x: 2, y: 64, w: 4, h: 4 }, { x: 3, y: 64, w: 2, h: 4 },
    { x: 2, y: 65, w: 4, h: 2 }, { x: 20, y: 64, w: 2, h: 2 },
  ].map(r => f.renderer.acquire(r) as Surface)
}
test.each([.5, 1])('four distinct partial/outside ancestor clips retain their original final merge at opacity %s', async opacity => {
  const f = fixture(), clip = ancestorClips(f)
  f.n.opacity = opacity
  const merge = f.renderer.merge.bind(f.renderer)
  f.renderer.merge = vi.fn((...args: any[]) => merge(...args))
  expect(await f.renderer.streamByteShadow(f.n, f.targets, clip)).toBe(f.targets)
  expect(f.driver.encodeByteTentAlpha).toHaveBeenCalledTimes(2)
  expect(f.renderer.merge.mock.calls.map((call: any[]) => call[4])).toEqual(clip)
  expect(f.sourceCalls.slice(0, 12).every(call => call.region.x === 0 && call.region.w === 12)).toBe(true)
  expect(f.driver.encodeByteTentAlpha.mock.calls.map(call => call[2].output)).toEqual([
    { x: 2, y: 0, w: 4, h: 130 }, { x: 2, y: 62, w: 4, h: 4 },
  ])
  expect(clip.every(surface => f.renderer.busy.has(surface.texture))).toBe(true)
  const merges = f.driver.pass.mock.calls.filter(call => call[1][16] === 29)
  expect(merges.map(call => call[2][2])).toEqual(clip.slice(0, 3).map(surface => surface.texture))
  expect(merges.every(call => call[1][19] === 1 && call[1][18] === opacity)).toBe(true)
  // The unchanged integrated byte merge uses mode29, even at opacity1;
  // the fourth clip is disjoint and needs no write or destination save.
  expect(f.driver.over).not.toHaveBeenCalled()
})

test('retained ancestor clipping stays within a bounded byte ledger without allocating any full-size clip or isolation copy', async () => {
  const f = fixture(), clip = ancestorClips(f)
  f.renderer.frameBudget = 64 * 1024
  expect(await f.renderer.streamByteShadow(f.n, f.targets, clip)).toBe(f.targets)
  expect(f.renderer.peak).toBeLessThanOrEqual(64 * 1024)
  expect(f.driver.copyColorRegion.mock.calls.every(call => call[2].h <= 64)).toBe(true)
  expect(clip.every(surface => f.renderer.busy.has(surface.texture))).toBe(true)
})

test.each(['short', 'hole', 'foreign', 'released', 'unused', 'fractional', 'wrong-dimensions', 'wrong-format', 'bad-alias', 'feedback', 'resource-feedback', 'internal-clip'] as const)(
  '%s ancestor clip cannot cross the byte-stream resource boundary', async mode => {
    const f = fixture(), clip = ancestorClips(f)
    if (mode === 'short') clip.pop()
    if (mode === 'hole') delete clip[1]
    if (mode === 'foreign') f.renderer.busy.delete(clip[1].texture)
    if (mode === 'released') f.renderer.releasedAliases.add(clip[1])
    if (mode === 'unused') f.renderer.used.delete(clip[1].texture)
    if (mode === 'fractional') clip[1].rect = { ...clip[1].rect, x: 3.25 }
    if (mode === 'wrong-dimensions') clip[1].rect = { ...clip[1].rect, w: 1 }
    if (mode === 'wrong-format') clip[1].texture.bytes *= 4
    if (mode === 'bad-alias') f.renderer.aliases.set(clip[1].texture, 0)
    if (mode === 'feedback') clip[1] = f.targets[1]
    if (mode === 'resource-feedback') clip[1].texture.resource = f.targets[1].texture.resource
    if (mode === 'internal-clip') f.n.clip = true
    expect(await f.renderer.streamByteShadow(f.n, f.targets, clip)).toBeUndefined()
    expect(f.driver.prepareByteTent).not.toHaveBeenCalled(); expect(f.driver.encodeByteTentAlpha).not.toHaveBeenCalled()
    expect(f.sourceCalls).toHaveLength(0)
  })

test('ancestor masks stay owned across pressure admissions and cancellation before filtering encodes no blend', async () => {
  const f = fixture(), clip = ancestorClips(f)
  f.renderer.reclaimScratch = vi.fn(async () => {
    expect(clip.every(surface => f.renderer.busy.has(surface.texture))).toBe(true)
    f.cancel()
  })
  await expect(f.renderer.streamByteShadow(f.n, f.targets, clip)).rejects.toThrow('PREVIEW_CANCELLED')
  expect(f.driver.encodeByteTentAlpha).not.toHaveBeenCalled(); expect(f.driver.over).not.toHaveBeenCalled()
  expect(f.renderer.busy.size).toBe(8)
  expect(f.driver.completedResourceEpoch).toBe(6)
})

test.each(['off', 'fractional-radius', 'fractional-offset', 'clip', 'child', 'mask', 'multiple-effects', 'missing-certificate', 'mips', 'prepare-decline'] as const)(
  '%s keeps its established shadow route without recording a partial byte filter', async mode => {
    const f = fixture()
    if (mode === 'off') vi.stubEnv('VITE_DESIGN_BYTE_TENT_PREFIX', '0')
    if (mode === 'fractional-radius') f.n.effects[0].radius = 3.25
    if (mode === 'fractional-offset') f.n.effects[0].y = .25
    if (mode === 'child') f.n.children = ['child']
    if (mode === 'mask') f.n.mask = true
    if (mode === 'multiple-effects') f.n.effects.push({ ...f.n.effects[0] })
    if (mode === 'missing-certificate') delete f.n.shadowOutputBox
    if (mode === 'mips') f.renderer.imageMips = true
    if (mode === 'prepare-decline') f.driver.prepareByteTent.mockResolvedValue(false)
    expect(await f.renderer.streamByteShadow(f.n, f.targets, mode === 'clip' ? f.targets : undefined)).toBeUndefined()
    expect(f.sourceCalls).toHaveLength(0); expect(f.driver.encodeByteTentAlpha).not.toHaveBeenCalled()
    expect(f.driver.abortFrameAndReleaseFilterScratch).not.toHaveBeenCalled()
  })
