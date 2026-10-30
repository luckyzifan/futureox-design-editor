import { afterEach, expect, test, vi } from 'vitest'
import { planDisplayBackdropBands } from './display-backdrop-bands'
import { GpuRenderer, type Surface } from './renderer'
import type { Driver, GpuNode, Rect, Texture } from './types'

afterEach(() => vi.unstubAllEnvs())
const radius = 18.39398384094238 * 32
function fixture(origin = [0, 0]) {
  vi.stubEnv('VITE_DESIGN_DISPLAY_TENT_RADIUS', '1'); vi.stubEnv('VITE_DESIGN_EXACT_CLAMP_PREFIX', '1')
  const words = new Map<Texture, Uint32Array>(), events: string[] = []
  const create = (width: number, height: number) => {
    const t = { width, height, bytes: width * height * 16, resource: {} } as Texture
    words.set(t, new Uint32Array(width * height * 4)); return t
  }
  const copy = vi.fn((to: Texture, from: Texture, region: Rect, offset: [number, number]) => {
    expect(to).not.toBe(from)
    expect([region.x, region.y, region.w, region.h, ...offset].every(Number.isInteger)).toBe(true)
    for (let row = 0; row < region.h; row++) words.get(to)!.set(words.get(from)!.subarray(
      ((region.y + row) * from.width + region.x) * 4, ((region.y + row) * from.width + region.x + region.w) * 4),
    ((offset[1] + row) * to.width + offset[0]) * 4)
    events.push('copy')
  })
  const driver = { name: 'webgpu', managed: true, hdr: false, displayMath: false, resourceEpoch: 7, completedResourceEpoch: 6,
    create, destroy: vi.fn(), clear: vi.fn(), pass: vi.fn(), copyColorRegion: copy }
  const renderer = new GpuRenderer(driver as unknown as Driver, true, false) as any
  const r = { x: origin[0], y: origin[1], w: 130, h: 129 }
  renderer.scene = { extent: r, width: 8, height: 8, output: { x: 0, y: 0, w: 8, h: 8 }, view: { x: 0, y: 0, zoom: 1 },
    roots: ['bg'], nodes: {}, displayTentRadius: true, integratedBlur: true, interactionRetained: true,
    nativeInteraction: true, interactionWindow: { x: 0, y: 0, w: 8, h: 8 }, coherentSamples: false }
  const n = { id: 'bg', rect: r, blend: 'normal', opacity: 1, matrix: [1, 0, 0, 1, 0, 0], fills: [], strokes: [], children: [],
    effects: [{ kind: 'background-blur', radius, visible: true }], fill: { rect: r } } as unknown as GpuNode
  renderer.scene.nodes.bg = n
  const input = renderer.acquire(r) as Surface
  words.get(input.texture)!.set(Array.from({ length: r.w * r.h * 4 }, (_, i) =>
    [0x80000000, 0x7f7fffff, 0x7fc12345, 0x80000001, 0x3f800001][i % 5]))
  renderer.reclaimScratch = vi.fn(async () => { events.push('admit'); expect(renderer.busy.has(input.texture)).toBe(true) })
  renderer.yieldEncoding = () => undefined
  renderer.filterKernel = vi.fn(() => input); renderer.certifiedKernel = vi.fn(() => undefined)
  const originalAxis = renderer.exactTentAxis.bind(renderer)
  renderer.exactTentAxis = vi.fn((source: Surface, raw: number, axis: number, output: Rect, destination: Surface, clamp: boolean, eligible: boolean) => {
    expect(raw).toBe(radius); expect(eligible).toBe(true); expect(renderer.interactionCapturing).toBe(true)
    expect(renderer.drawRegion(output)).toBeUndefined()
    expect(source.texture).not.toBe(destination.texture)
    const x = Math.round(output.x - source.rect.x), y = Math.round(output.y - source.rect.y)
    copy(destination.texture, source.texture, { x, y, w: output.w, h: output.h }, [0, 0])
    events.push(`axis${axis}:${clamp}`); return destination
  })
  return { renderer, driver, words, events, input, n, radius, originalAxis,
    run: (clamp = false) => renderer.blurDisplayBackdropBands(input, radius / 2, n, clamp) as Promise<Surface | undefined> }
}

test.each([false, true])('full borrowed input uses one private H/V result, preserving its bits and clamp=%s while suppressing the dynamic scissor', async clamp => {
  const f = fixture(), before = f.words.get(f.input.texture)!.slice()
  const borrowed = f.renderer.retain(f.input)
  f.renderer.frameBudget = 1024 * 1024
  const out = (await f.run(clamp))!
  expect(out.texture).not.toBe(f.input.texture); expect(out.rect).toEqual(f.input.rect)
  expect(f.words.get(out.texture)).toEqual(before); expect(f.words.get(f.input.texture)).toEqual(before)
  expect(f.renderer.aliases.get(f.input.texture)).toBe(2); expect(f.renderer.releasedAliases.has(f.input)).toBe(false)
  expect([...f.renderer.busy]).toEqual([f.input.texture, out.texture])
  expect(f.renderer.peak).toBeLessThanOrEqual(f.renderer.frameBudget)
  const calls = f.renderer.exactTentAxis.mock.calls
  expect(calls.map((call: any[]) => [call[2], call[3].w, call[3].h, call[5]])).toEqual([
    [0, 130, 64, clamp], [0, 130, 64, clamp], [0, 130, 1, clamp],
    [1, 64, 129, clamp], [1, 64, 129, clamp], [1, 2, 129, clamp],
  ])
  expect(f.renderer.interactionCapturing).toBe(false); expect(f.driver.destroy).not.toHaveBeenCalled()
  f.renderer.release(out, borrowed)
  expect([...f.renderer.busy]).toEqual([f.input.texture])
})

test('same fractional capture uses certified private strip destinations, and raw copies keep integer local coordinates', async () => {
  const f = fixture([.1, -.2]), before = f.words.get(f.input.texture)!.slice()
  await f.run(true)
  expect(f.words.get(f.input.texture)).toEqual(before)
  // Execute the real private run/destination gate, with only terminal GPU
  // arithmetic mocked; arbitrary fractional destinations remain rejected.
  f.renderer.exactTentAxis = f.originalAxis
  await f.run(true)
  expect(f.driver.pass.mock.calls.filter(call => call[1][16] === 22)).toHaveLength(6)
  const unsupported = f.renderer.acquire({ x: .1, y: -.2, w: 8, h: 8 })
  expect(() => f.originalAxis(f.input, radius, 0, unsupported.rect, unsupported, false, true)).toThrow('Invalid private exact filter destination')
})

test('one matching saved-column pool slot is protected before the two-strip admission can reclaim free storage', async () => {
  const f = fixture(), region = { x: 0, y: 0, w: 64, h: 129 }, pooled = f.renderer.acquire(region)
  f.renderer.release(pooled)
  f.renderer.reclaimScratch = vi.fn(async () => {
    expect(f.renderer.busy.has(pooled.texture)).toBe(true)
    expect(f.renderer.free.get('64:129') || []).not.toContain(pooled.texture)
  })
  const strips = await f.renderer.acquireDisplayBackdropStrips(region, 2)
  expect(strips[0].texture).toBe(pooled.texture); expect(strips[1].texture).not.toBe(pooled.texture)
})

test.each(['off', 'hdr', 'readback-intent', 'gradient', 'glass', 'non-normal', 'small', 'too-large', 'extent', 'constant', 'foreign'] as const)(
  '%s declines before coefficient hydration or any filter pass', async mode => {
    const f = fixture()
    if (mode === 'off') vi.stubEnv('VITE_DESIGN_DISPLAY_TENT_RADIUS', '0')
    if (mode === 'hdr') f.driver.hdr = true
    if (mode === 'readback-intent') f.renderer.scene.displayTentRadius = false
    if (mode === 'gradient') f.n.effects[0].gradientBlur = {} as any
    if (mode === 'glass') f.n.effects[0].kind = 'glass'
    if (mode === 'non-normal') f.n.blend = 'multiply'
    if (mode === 'extent') f.input.rect = { ...f.input.rect, x: 1048576 }
    if (mode === 'constant') f.input.texture.uniformColor = true
    if (mode === 'foreign') f.renderer.busy.delete(f.input.texture)
    expect(await f.renderer.blurDisplayBackdropBands(f.input, mode === 'small' ? 256 : mode === 'too-large' ? 1024.5 : radius / 2, f.n, false)).toBeUndefined()
    expect(f.renderer.filterKernel).not.toHaveBeenCalled(); expect(f.renderer.exactTentAxis).not.toHaveBeenCalled()
    expect(f.driver.copyColorRegion).not.toHaveBeenCalled()
  })

test.each(['cancel', 'admission', 'axis', 'copy'] as const)('%s unwinds every private allocation, restores window policy and leaves source/epochs owned by the caller', async mode => {
  const f = fixture(); let current = true, admissions = 0
  f.renderer.frameCurrent = () => current
  f.renderer.reclaimScratch = vi.fn(async () => {
    if (++admissions === 3) { if (mode === 'cancel') current = false; else if (mode === 'admission') throw Error('uncertain admission') }
  })
  if (mode === 'axis') f.renderer.exactTentAxis.mockImplementation(() => { throw Error('axis failed') })
  if (mode === 'copy') f.driver.copyColorRegion.mockImplementation(() => { throw Error('copy failed') })
  await expect(f.run()).rejects.toThrow(mode === 'cancel' ? 'PREVIEW_CANCELLED' : mode === 'admission' ? 'uncertain admission' : `${mode} failed`)
  expect([...f.renderer.busy]).toEqual([f.input.texture]); expect(f.renderer.interactionCapturing).toBe(false)
  expect(f.renderer.releasedAliases.has(f.input)).toBe(false); expect(f.driver.completedResourceEpoch).toBe(6)
  expect(f.driver.destroy).not.toHaveBeenCalled()
})

test.each([true, false])('async nodeSource reaches the normal BG wrapper before the unchanged %s direct/ordinary composition', async direct => {
  const f = fixture(); f.renderer.scene.coherentSamples = true
  vi.stubEnv('VITE_DESIGN_DIRECT_BACKDROP', direct ? '1' : '0')
  f.renderer.mask = () => { f.events.push('mask'); return f.input }
  f.renderer.interactionBackdropDisplay = vi.fn(async () => { f.events.push('background'); return f.input })
  f.renderer.run = vi.fn((mode: number) => { if (mode === 15) { f.events.push('mode15'); throw Error('composed') } return f.input })
  f.renderer.compose = () => { f.events.push('compose'); throw Error('composed') }
  await expect(f.renderer.nodeSource('bg', f.input)).rejects.toThrow('composed')
  expect(f.renderer.interactionBackdropDisplay).toHaveBeenCalledOnce()
  expect(f.events.indexOf('mask')).toBeLessThan(f.events.indexOf('background'))
  expect(f.events.indexOf('background')).toBeLessThan(f.events.indexOf(direct ? 'mode15' : 'compose'))
})

test('coherent-region fallback keeps clamp=true and exact unsupported paths retain the old guard', async () => {
  const f = fixture(), original = f.renderer.blurDisplayBackdropBands.bind(f.renderer)
  f.renderer.blurDisplayBackdropBands = vi.fn((...args: any[]) => original(...args))
  const out = await f.renderer.blurBackdropRegion(f.input, radius / 2, f.n)
  expect(out).not.toBe(f.input); expect(f.renderer.blurDisplayBackdropBands.mock.calls[0][3]).toBe(true)
  f.renderer.scene.displayTentRadius = false
  await expect(f.renderer.blurBackdropRegion(f.input, radius / 2, f.n)).rejects.toThrow('512')
})

test('row/column plans reject unsupported guards before allocating and retain physical tail offsets', () => {
  const plan = planDisplayBackdropBands({ x: .1, y: -.2, w: 130, h: 129 }, Math.fround(radius), true)!
  expect(plan.rows.map(r => r.h)).toEqual([64, 64, 1]); expect(plan.columns.map(r => r.w)).toEqual([64, 64, 2])
  for (const input of [{ x: Infinity, y: 0, w: 2, h: 2 }, { x: 1048576, y: 0, w: 130, h: 129 },
    { x: 0, y: 0, w: 8193, h: 2 }, { x: 0, y: 0, w: 8192, h: 4096 }, { x: 0, y: 0, w: 0, h: 3 }])
    expect(planDisplayBackdropBands(input, Math.fround(radius), true)).toBeUndefined()
})

test.each(['epoch', 'axis', 'radius', 'source', 'source-rect', 'target-rect', 'resource', 'source-flags', 'clamp', 'cancel'] as const)(
  '%s invalidates a single-use strip certificate before encoding', async mode => {
    const f = fixture([.1, -.2]), r = { ...f.input.rect, h: 64 }, selected = Math.fround(radius)
    const [target] = await f.renderer.acquireDisplayBackdropStrips(r, 1)
    f.renderer.certifyDisplayBackdropDestination(target, f.input, selected, 0, false)
    let current = true; f.renderer.frameCurrent = () => current
    if (mode === 'epoch') f.driver.resourceEpoch++
    if (mode === 'source-rect') f.input.rect = { ...f.input.rect, x: .2 }
    if (mode === 'target-rect') target.rect = { ...target.rect, x: .2 }
    if (mode === 'resource') f.input.texture.resource = {}
    if (mode === 'source-flags') f.input.texture.opaqueAlpha = true
    if (mode === 'cancel') { await Promise.resolve(); current = false }
    const source = mode === 'source' ? { ...f.input } : f.input
    expect(() => f.renderer.run(22, target.rect, [source], (u: Float32Array) =>
      u.set([mode === 'radius' ? selected + 1 : selected, mode === 'axis' ? 1 : 0, mode === 'clamp' ? 1 : 0, 1], 36),
    15, { kind: 'tent', radius: mode === 'radius' ? selected + 1 : selected }, false, target)).toThrow()
    expect(f.driver.pass).not.toHaveBeenCalled()
    expect(f.renderer.displayBackdropDestinations.has(target)).toBe(false)
    expect(f.renderer.busy.has(f.input.texture)).toBe(true)
  })

test('a successful strip certificate is consumed exactly once and cannot authorize an alias or cached destination', async () => {
  const f = fixture([.1, -.2]), r = { ...f.input.rect, h: 64 }, selected = Math.fround(radius)
  f.renderer.interactionCapturing = true
  const [target] = await f.renderer.acquireDisplayBackdropStrips(r, 1)
  f.renderer.certifyDisplayBackdropDestination(target, f.input, selected, 0, false)
  f.originalAxis(f.input, radius, 0, r, target, false, true)
  expect(f.driver.pass).toHaveBeenCalledOnce(); expect(f.renderer.displayBackdropDestinations.has(target)).toBe(false)
  expect(() => f.originalAxis(f.input, radius, 0, r, target, false, true)).toThrow('Invalid private exact filter destination')
  const alias = f.renderer.retain(target)
  expect(() => f.renderer.certifyDisplayBackdropDestination(target, f.input, selected, 0, false)).toThrow('strip proof')
  f.renderer.release(alias)
  f.renderer.constantTargets.set('cache-owner', target)
  expect(() => f.renderer.certifyDisplayBackdropDestination(target, f.input, selected, 0, false)).toThrow('strip proof')
  f.renderer.constantTargets.delete('cache-owner'); target.texture.resource = f.input.texture.resource
  expect(() => f.renderer.certifyDisplayBackdropDestination(target, f.input, selected, 0, false)).toThrow('strip proof')
})

test('independent literal binary32 scalar addressing agrees across whole, row and saved-column phases before filtering', () => {
  const f = Math.fround
  const address = (origin: number, size: number, point: number, tap: number, clamp: boolean) => {
    origin = f(origin)
    let p = f(point + tap)
    if (clamp) p = Math.min(f(f(origin + size) - .5), Math.max(f(origin + .5), p))
    const index = Math.floor(f(p - origin))
    return index < 0 || index >= size ? undefined : index
  }
  const point = (origin: number, pixel: number) => f(f(pixel + .5) + f(origin))
  for (const [x, y] of [[.1, -.2], [-1182.8828125, 964.162109375], [-65535.999, 16383.999]]) for (const clamp of [false, true]) {
    const source = { x, y, w: 130, h: 129 }, plan = planDisplayBackdropBands(source, Math.fround(radius), clamp)!
    expect(plan).toBeDefined()
    for (const [rowIndex, row] of plan.rows.entries()) for (const local of [0, row.h - 1]) {
      const global = rowIndex * 64 + local
      expect(address(y, source.h, point(y, global), 0, clamp)).toBe(address(y, source.h, point(row.y, local), 0, clamp))
    }
    for (const [columnIndex, column] of plan.columns.entries()) for (const local of [0, column.w - 1]) {
      const global = columnIndex * 64 + local
      expect(address(x, source.w, point(x, global), 0, clamp)).toBe(address(column.x, column.w, point(column.x, local), 0, clamp)! + columnIndex * 64)
      for (const pixel of [0, 63, 64, 65, 128]) for (const tap of [-Math.ceil(radius), -1, 0, 1, Math.ceil(radius)])
        expect(address(y, source.h, point(y, pixel), tap, clamp)).toBe(address(column.y, column.h, point(column.y, pixel), tap, clamp))
    }
  }
})
