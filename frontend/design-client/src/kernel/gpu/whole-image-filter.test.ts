import { afterEach, expect, test, vi } from 'vitest'
import { GpuRenderer, type Surface } from './renderer'
import { prefixAlignedRgbStrip, prefixRgbBandSize } from './prefix-band'
import { PREFIX_SCRATCH_BYTES } from './texture-prefix'
import { certifyExactImageRange } from './exact-image-x-table'
import type { Driver, GpuNode, GpuScene, Rect, Texture } from './types'

afterEach(() => vi.unstubAllEnvs())
test('RGB strips use the actual output layout and retain the 64-row ceiling', () => {
  expect(prefixRgbBandSize(1108, 1032)).toBe(54)
  expect(prefixAlignedRgbStrip(1108, 1032)).toBe(54)
  expect(prefixRgbBandSize(3484, 1032)).toBe(29)
  expect(prefixAlignedRgbStrip(3484, 1032)).toBe(58)
  for (const length of [1, 64, 1108, 3484, 16384]) for (const output of [1, 8, 1032, 16384]) {
    const band = prefixRgbBandSize(length, output), strip = prefixAlignedRgbStrip(length, output)
    expect(strip).toBeGreaterThan(0); expect(strip).toBeLessThanOrEqual(64)
    if (band > 0 && band <= 64) expect(strip % band).toBe(0)
  }
  for (const length of [0, -1, 1.5, NaN, Infinity, 16385]) expect(prefixAlignedRgbStrip(length, 1032)).toBe(64)
})

/** The actual run/exactTentAxis/stream dispatch uses a CPU transport and an
 * independent neighborhood model. It proves dispatch, lattice, writes and
 * ownership, never actual WGSL or GPU rounding. */
function fixture(whole: boolean, options: { rejectBudget?: boolean; tinyBudget?: boolean; noTable?: boolean; radius?: number; negativeSource?: boolean } = {}) {
  // Both controls admit radius 32..64; the reference transport withholds the
  // private sign proof, retaining the original strip path with identical input.
  vi.stubEnv('VITE_DESIGN_WHOLE_IMAGE_FILTER', '1')
  vi.stubEnv('VITE_DESIGN_PREFIX_ALIGNED_STRIPS', '1')
  vi.stubEnv('VITE_DESIGN_PREFIX_RGB_RESOLVE', '0')
  const radius = options.radius ?? 38.25948715209961, reach = Math.ceil(radius) + 1
  // Budget refusal needs a full plane larger than the bounded strip working
  // set, including retained 64-row/remainder pool allocations.
  const output = { x: 100, y: 100, w: 12, h: options.rejectBudget && !options.tinyBudget ? 96 : 20 }
  const input = { x: 100 - reach, y: 100 - reach, w: output.w + reach * 2, h: output.h + reach * 2 }
  const sourcePixels = new Float32Array(input.w * input.h * 4)
  for (let y = 0; y < input.h; y++) for (let x = 0; x < input.w; x++) for (let c = 0; c < 4; c++) {
    const value = c === 3 ? 1 : Math.fround(((input.x + x) % 17) * .03125 + ((input.y + y) % 19) * .015625 + c * .0078125)
    sourcePixels[(y * input.w + x) * 4 + c] = options.negativeSource && c === 0 ? -value : value
  }
  const sourceRange = certifyExactImageRange(sourcePixels)!
  const pixels = new Map<Texture, Float32Array>(), events: string[] = [], resolves: Rect[] = [], filters: any[] = [], allocations: Texture[] = []
  let tableAlive = false, prefix = false, current = true, completedAbort = false
  let pauseAdmission: Promise<void> | undefined, resumeAdmission: (() => void) | undefined
  let pauseAbort: Promise<void> | undefined, resumeAbort: (() => void) | undefined
  const create = (w: number, h: number): Texture => {
    const texture = { width: w, height: h, bytes: w * h * 16, resource: {} } as Texture
    allocations.push(texture); pixels.set(texture, new Float32Array(w * h * 4)); return texture
  }
  const copy = (destination: Texture, source: Texture) => pixels.get(destination)!.set(pixels.get(source)!)
  const driver = { name: 'webgpu', managed: true, description: 'CPU command model', drawCalls: 0, triangles: 0,
    lost: false, resourceEpoch: 1, completedResourceEpoch: 0, scratchBytes: 0, begin() {},
    create, createBinaryCoverage: create, maskRegion() {}, sequentialSampleResolve: true,
    clear(texture: Texture) { delete texture.opaqueAlpha; pixels.get(texture)!.fill(0) },
    destroy(texture: Texture) { events.push('destroy'); pixels.delete(texture) },
    checkpoint: vi.fn(async () => { events.push('checkpoint'); driver.completedResourceEpoch = driver.resourceEpoch || 0 }),
    prepareFilterPass: vi.fn((_target: Texture, _u: Float32Array, _sources: Texture[], _channels: number, _filter: unknown, available: number) => {
      if (!prefix) { expect(available).toBeGreaterThanOrEqual(PREFIX_SCRATCH_BYTES); driver.scratchBytes += PREFIX_SCRATCH_BYTES; prefix = true }
    }),
    resolveImageTable(target: Texture, _table: unknown, x: number, y: number) {
      events.push('resolve'); resolves.push({ x, y, w: target.width, h: target.height })
      const data = pixels.get(target)!
      for (let yy = 0; yy < target.height; yy++) for (let xx = 0; xx < target.width; xx++) for (let c = 0; c < 4; c++)
        data[(yy * target.width + xx) * 4 + c] = sourcePixels[((y + yy) * input.w + x + xx) * 4 + c]
      target.opaqueAlpha = true
    },
    retireImageTable: vi.fn(async () => { events.push('retire-fence'); tableAlive = false; driver.scratchBytes -= 1024 }),
    pass(target: Texture, u: Float32Array, sources: Texture[], region?: Rect, channels?: number, filter?: { radius: number }) {
      delete target.opaqueAlpha
      const mode = u[16], data = pixels.get(target)!
      if (mode === 12) { data.fill(0); return }
      if (mode === 23) { copy(target, sources[0]); return }
      if (mode === 0) {
        events.push('blit'); const before = pixels.get(sources[0])!
        for (let y = 0; y < sources[0].height; y++) for (let x = 0; x < sources[0].width; x++) for (let c = 0; c < 4; c++)
          data[((y + region!.y) * target.width + x + region!.x) * 4 + c] = before[(y * sources[0].width + x) * 4 + c]
        return
      }
      expect(mode).toBe(22); expect(channels).toBe(15); expect(region).toBeUndefined()
      if (filter) expect(filter.radius).toBe(radius)
      else expect(u[36]).toBe(Math.fround(radius)) // existing non-prefix budget retry
      const axis = u[37], span = Math.ceil(radius), before = pixels.get(sources[0])!
      events.push(`axis:${axis}`); filters.push({ target, source: sources[0], axis, rect: Array.from(u.slice(0, 8)) })
      for (let y = 0; y < target.height; y++) for (let x = 0; x < target.width; x++) for (let c = 0; c < 4; c++) {
        let sum = 0
        for (let tap = -span; tap <= span; tap++) {
          const sx = u[0] + x - u[4] + (axis === 0 ? tap : 0), sy = u[1] + y - u[5] + (axis === 1 ? tap : 0)
          const value = sx < 0 || sy < 0 || sx >= sources[0].width || sy >= sources[0].height ? 0 : before[(sy * sources[0].width + sx) * 4 + c]
          const weight = Math.fround((span + 1 - Math.abs(tap)) / (span + 1) ** 2)
          sum = Math.fround(sum + Math.fround(value * weight))
        }
        data[(y * target.width + x) * 4 + c] = sum
      }
    },
    finish: vi.fn(async () => { events.push('finish'); return {} }),
    abortFrameAndReleaseFilterScratch: vi.fn(async () => {
      events.push('abort'); if (pauseAbort) await pauseAbort
      completedAbort = true; tableAlive = false; driver.scratchBytes = 0; events.push('abort-fence')
    }),
  } as unknown as Driver & { scratchBytes: number; completedResourceEpoch: number }
  const renderer = new GpuRenderer(driver, true, false) as any
  const node = { id: 'image', rect: { x: -1000, y: -1000, w: 2400, h: 2400 }, matrix: [1, 0, 0, 1, 0, 0],
    fill: { count: 0 }, children: [], fills: [], strokes: [], effects: [{ kind: 'blur', radius, visible: true }], opacity: 1, blend: 'normal' } as unknown as GpuNode
  const scene = { version: 7, width: output.w, height: output.h, extent: output, floatCompositing: true, coherentSamples: true, integratedBlur: true,
    background: '#ffffff', transparent: false, grid: false, view: { x: 0, y: 0, zoom: 1 }, roots: [node.id], nodes: { [node.id]: node }, vertices: [] } as GpuScene
  renderer.scene = scene; renderer.loadImages = async () => {}
  const kernel = { texture: create(1, 1), rect: { x: 0, y: 0, w: 1, h: 1 } }
  renderer.filterKernel = () => kernel; renderer.certifiedKernel = () => undefined
  renderer.resolveFilterImageSample = vi.fn(() => { throw Error('No new image sampling allowed after table admission') })
  renderer.prepareFilterImageTable = vi.fn(async () => {
    if (options.noTable) return undefined
    tableAlive = true; driver.scratchBytes += 1024; renderer.bytes += 1024
    return Object.freeze({ width: input.w, height: input.h, bytes: 1024, opaqueAlpha: true, resource: {},
      ...(whole && sourceRange.nonnegativeRgb ? { nonnegativeResolved: true as const } : {}) })
  })
  renderer.merge = (source: Surface, target: Surface) => {
    const out = renderer.acquire(output); copy(out.texture, source.texture); renderer.release(target); return out
  }
  const reclaim = renderer.reclaimScratch.bind(renderer), fullRequired = input.w * input.h * 16 + PREFIX_SCRATCH_BYTES
  renderer.reclaimScratch = async (required = 0) => {
    if (required === fullRequired && whole) {
      events.push('whole-admission')
      if (pauseAdmission) await pauseAdmission
      if (options.rejectBudget) renderer.frameBudget = renderer.workingBytes + required - 1
    }
    return reclaim(required)
  }
  const run = async () => {
    const out = await renderer.streamIsolatedFilter(node, Array.from({ length: 4 }, () => renderer.acquire(output))) as Surface[]
    return new Uint32Array(pixels.get(out[0].texture)!.buffer).slice()
  }
  return { renderer, driver, node, scene, run, events, filters, resolves, input, output, allocations, fullRequired,
    isCurrent: () => current, cancel() { current = false }, get tableAlive() { return tableAlive }, get completedAbort() { return completedAbort },
    pause() { pauseAdmission = new Promise<void>(resolve => { resumeAdmission = resolve }); pauseAbort = new Promise<void>(resolve => { resumeAbort = resolve }) },
    releaseAdmission() { resumeAdmission!() }, releaseAbort() { resumeAbort!() } }
}

test('whole H/V uses the original exact axis dispatcher, one table resolve and no strip copies', async () => {
  const f = fixture(true), actual = await f.run()
  expect(f.renderer.wholeFilterAxes).toBe(2)
  expect(f.resolves).toEqual([{ x: 0, y: 0, w: f.input.w, h: f.input.h }])
  expect(f.filters.map(filter => filter.axis)).toEqual([0, 1])
  expect(f.events).not.toContain('blit')
  expect(f.renderer.resolveFilterImageSample).not.toHaveBeenCalled()
  expect(f.events.indexOf('axis:0')).toBeLessThan(f.events.indexOf('retire-fence'))
  expect(f.events.indexOf('retire-fence')).toBeLessThan(f.events.indexOf('axis:1'))
  expect(f.driver.prepareFilterPass).toHaveBeenCalledTimes(2)
  const reference = fixture(false), expected = await reference.run()
  expect(reference.renderer.wholeFilterAxes).toBe(0)
  expect(reference.resolves.length).toBeGreaterThan(1); expect(reference.events).toContain('blit')
  expect(actual).toEqual(expected)
})
test.each(['identical', 'different-target', 'clip', 'same-clip', 'clip-phase', 'coverage-gap'] as const)(
  'resolved foreground samples share only a fully covered identical destination: %s', async variant => {
    const f = fixture(true), { renderer, node, output } = f
    const header = 1 + output.h * 4, curves = new Float32Array((header + output.h * 4 * 3) * 4)
    curves.set([3, 1, output.w, output.h])
    for (let row = 0; row < output.h * 4; row++) {
      curves.set([header + row * 3, 1, 0, 0], 4 + row * 4)
      curves.set([variant === 'coverage-gap' ? 1 : 0, output.w, 0, 0], (header + row * 3) * 4)
    }
    node.fill = { count: 3, rect: output, first: 0, rule: 'nonzero', sampleCount: 4, area: { first: 0, count: curves.length / 4 } }
    f.scene.curves = curves
    const initial = renderer.acquire(output), targets = [initial, renderer.retain(initial), renderer.retain(initial), renderer.retain(initial)]
    if (variant === 'different-target') { renderer.release(targets[3]); targets[3] = renderer.acquire(output) }
    const merge = renderer.merge = vi.fn(renderer.merge)
    const mask = variant === 'same-clip' || variant === 'clip-phase' ? renderer.acquire(output) : undefined
    const masks = variant === 'clip' ? Array.from({ length: 4 }, () => renderer.acquire(output)) :
      mask ? [mask, renderer.retain(mask), renderer.retain(mask), renderer.retain(mask)] : undefined
    if (variant === 'clip-phase') masks![3].rect = { ...output, x: output.x + 1 }
    const result = await renderer.streamIsolatedFilter(node, targets, masks)
    expect(merge).toHaveBeenCalledTimes(variant === 'identical' || variant === 'same-clip' ? 1 :
      variant === 'different-target' || variant === 'clip-phase' ? 2 : 4)
    if (variant === 'identical') {
      expect(result.every((surface: Surface) => surface.texture === result[0].texture)).toBe(true)
      expect(renderer.aliases.get(result[0].texture)).toBe(4)
      expect(renderer.busy.has(initial.texture)).toBe(false)
    }
    renderer.release(...result, ...(masks || []))
    expect(renderer.busy.size).toBe(0)
  })
test('insufficient whole-source headroom falls back to the original bounded strips', async () => {
  const f = fixture(true, { rejectBudget: true }), actual = await f.run()
  expect(f.renderer.wholeFilterAxes).toBe(0)
  expect(f.resolves.every(region => region.h <= 64)).toBe(true)
  expect(f.allocations.some(texture => texture.width === f.input.w && texture.height === f.input.h)).toBe(false)
  expect(f.events).toContain('blit')
  const reference = fixture(false, { rejectBudget: true }); expect(actual).toEqual(await reference.run())
})
test('negative RGB without the resolved nonnegative proof retains both original strip blits', async () => {
  const f = fixture(true, { negativeSource: true }), actual = await f.run()
  expect(f.renderer.wholeFilterAxes).toBe(0)
  expect(f.resolves.length).toBeGreaterThan(1); expect(f.events).toContain('blit')
  expect(f.events).not.toContain('whole-admission')
  const reference = fixture(false, { negativeSource: true })
  expect(actual).toEqual(await reference.run())
})
test('an artificially reduced tiny budget rejects allocation and fences scratch abort before retry', async () => {
  const f = fixture(true, { rejectBudget: true, tinyBudget: true }); f.pause()
  const budgetError = vi.spyOn(f.renderer, 'budgetError')
  const pending = f.renderer.render(f.scene, false, true, f.isCurrent)
  await vi.waitFor(() => expect(f.events).toContain('whole-admission'))
  f.releaseAdmission()
  await vi.waitFor(() => expect(f.events).toContain('abort'))
  expect(budgetError).toHaveBeenCalledWith('GPU 表面内存预算超限',1,0,18,-1)
  expect(f.renderer.workingBytes).toBeLessThanOrEqual(f.renderer.frameBudget)
  expect(f.allocations.some(texture => texture.width === f.input.w && texture.height === f.input.h)).toBe(false)
  expect(f.tableAlive).toBe(true); expect(f.completedAbort).toBe(false)
  expect(f.driver.finish).not.toHaveBeenCalled()
  f.releaseAbort(); await pending
  expect(f.completedAbort).toBe(true)
  expect(f.events.indexOf('abort-fence')).toBeLessThan(f.events.indexOf('finish'))
  expect(f.renderer.workingBytes).toBeLessThanOrEqual(f.renderer.frameBudget)
})
test('cancellation during whole admission encodes no source/axis and fences cleanup before publishing', async () => {
  const f = fixture(true); f.pause()
  const pending = f.renderer.render(f.scene, false, true, f.isCurrent).catch((error: Error) => error)
  await vi.waitFor(() => expect(f.events).toContain('whole-admission'))
  expect(f.tableAlive).toBe(true); f.cancel(); f.releaseAdmission()
  await vi.waitFor(() => expect(f.events).toContain('abort'))
  expect(f.tableAlive).toBe(true); expect(f.completedAbort).toBe(false)
  expect(f.resolves).toHaveLength(0); expect(f.filters).toHaveLength(0)
  expect(f.driver.finish).not.toHaveBeenCalled(); expect(f.driver.retireImageTable).not.toHaveBeenCalled()
  f.releaseAbort(); expect(String(await pending)).toContain('PREVIEW_CANCELLED')
  expect(f.completedAbort).toBe(true); expect(f.tableAlive).toBe(false)
  expect(f.renderer.busy.size).toBe(0); expect(f.renderer.wholeFilterAxes).toBe(0)
})
test('private destination rejects feedback, wrong extents, aliases and released storage', () => {
  const f = fixture(true), input = f.renderer.acquire(f.input), destination = f.renderer.acquire(f.output)
  const axis = (source: Surface, output: Rect, target: Surface) => f.renderer.exactTentAxis(source, 38.25948715209961, 0, output, target)
  expect(() => axis(destination, f.output, destination)).toThrow('Invalid private')
  expect(() => axis({ ...input, texture: { ...input.texture, resource: destination.texture.resource } }, f.output, destination)).toThrow('Invalid private')
  expect(() => axis(input, { ...f.output, x: f.output.x + 1 }, destination)).toThrow('Invalid private')
  const alias = f.renderer.retain(destination)
  expect(() => axis(input, f.output, destination)).toThrow('Invalid private')
  f.renderer.release(alias)
  f.renderer.release(destination)
  expect(() => axis(input, f.output, destination)).toThrow('Invalid private')
  expect(f.driver.prepareFilterPass).not.toHaveBeenCalled()
})
