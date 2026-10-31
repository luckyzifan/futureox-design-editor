import { expect, test, vi } from 'vitest'
import { GpuRenderer, type Surface } from './renderer'
import { effect, paint } from '../../model'
import type { Driver, GpuNode, GpuScene, Texture } from './types'

function fixture(patch: Partial<GpuNode> = {}, optimized = true) {
  const live = new Set<Texture>(), maskSizes: number[] = []
  const passObservers: ((mode: number) => void)[] = []
  const passes: { mode: number; target: Texture; inputs: Texture[]; uniforms: Float32Array }[] = []
  const driver: Driver = {
    name: 'webgl2', managed: true, canvas: {} as OffscreenCanvas,
    description: 'pass-through coverage lifetime verifier', lost: false, drawCalls: 0, triangles: 0,
    begin() {},
    create(width, height) {
      const texture: Texture = { width, height, bytes: width * height * 16, resource: {} as WebGLTexture }
      live.add(texture); return texture
    },
    destroy(texture) { expect(live.delete(texture)).toBe(true) },
    clear(texture) { expect(live.has(texture)).toBe(true) },
    mask(path, texture) { expect(live.has(texture)).toBe(true); maskSizes.push(path.rect.w) },
    pass(target, uniforms, inputs) {
      passes.push({ mode: uniforms[16], target, inputs: [...inputs], uniforms: uniforms.slice() })
      for (const observer of passObservers) observer(uniforms[16])
      expect(inputs).not.toContain(target)
      for (const texture of [target, ...inputs]) expect(live.has(texture)).toBe(true)
    },
    over(target, uniforms, inputs) { this.pass(target, uniforms, inputs) },
    upload() { throw Error('Unexpected image upload') },
    uploadParameters(_values, width, height) { return this.create(width, height) },
    uploadRgba8(_bytes, width, height) { return this.create(width, height) },
    async finish() { return {} },
    dispose() { for (const texture of [...live]) this.destroy(texture) },
    async loseDeviceForTesting() { throw Error('No real GPU in lifetime test') },
  }
  const make = (id: string, size: number): GpuNode => ({
    id, rect: { x: 0, y: 0, w: size, h: size }, size: [size, size],
    matrix: [1, 0, 0, 1, 0, 0], inverse: [1, 0, 0, 1, 0, 0],
    fill: { rect: { x: 0, y: 0, w: size, h: size }, first: 0, count: 3, rule: 'nonzero' },
    fills: [], strokes: [], effects: [], children: [], mask: false, clip: false, opacity: 1, blend: 'normal',
  })
  const container = { ...make('container', 24), passthrough: true, children: ['leaf'], ...patch }
  const leaf = { ...make('leaf', 16), fills: [paint('#ff8040')] }
  const scene: GpuScene = {
    version: 7, width: 32, height: 32, extent: { x: 0, y: 0, w: 32, h: 32 },
    background: '#ffffff', transparent: false, grid: false, view: { x: 0, y: 0, zoom: 1 },
    coherentSamples: true, integratedBlur: true, floatCompositing: true, roots: ['container'],
    vertices: [0, 0, 16, 0, 0, 16], nodes: { container, leaf },
  }
  const renderer = new GpuRenderer(driver, optimized)
  const coverage = vi.spyOn(renderer as unknown as { nodeMask(node: GpuNode): unknown }, 'nodeMask')
  return { renderer, driver, scene, coverage, maskSizes, live, passObservers, passes }
}

test('a coverage-free pass-through container renders children without allocating its four sample masks', async () => {
  const f = fixture()
  await f.renderer.render(f.scene)
  expect(f.coverage.mock.calls.map(([node]) => node.id)).toEqual(['leaf', 'leaf', 'leaf', 'leaf'])
  expect(f.maskSizes).not.toContain(24)
  expect(f.maskSizes).toContain(16)
  f.renderer.dispose(); expect(f.live.size).toBe(0)
})

for (const [reason, patch] of [
  ['clip', { clip: true }],
  ['opacity', { opacity: 0.5 }],
  ['isolated blend', { passthrough: false, blend: 'multiply' }],
  ['effect', { effects: [effect('noise')] }],
] as [string, Partial<GpuNode>][]) test(`${reason} preserves composition while only clipping requires container coverage`, async () => {
  const f = fixture(patch)
  await f.renderer.render(f.scene)
  expect(f.coverage.mock.calls.filter(([node]) => node.id === 'container')).toHaveLength(patch.clip ? 4 : 0)
  expect(f.maskSizes.includes(24)).toBe(!!patch.clip)
  expect(f.passes.some(p => p.mode === (patch.effects ? 7 : patch.clip || patch.passthrough === false ? 3 : 28))).toBe(true)
  f.renderer.dispose(); expect(f.live.size).toBe(0)
})

test('the independent unoptimized reference still builds container coverage', async () => {
  const f = fixture({}, false)
  await f.renderer.render(f.scene)
  expect(f.coverage.mock.calls.filter(([node]) => node.id === 'container')).toHaveLength(4)
  f.renderer.dispose(); expect(f.live.size).toBe(0)
})

test('backdrop capture runs before isolation layer allocation; samples still receive distinct layers', async () => {
  const f = fixture({ passthrough: false, effects: [{ ...effect('background-blur'), radius: 1 }] })
  const empty = vi.spyOn(f.renderer as unknown as { empty(rect: unknown): unknown }, 'empty')
  const atCapture: number[] = []
  f.passObservers.push(mode => { if (mode === 26) atCapture.push(empty.mock.calls.length) })
  await f.renderer.render(f.scene)
  expect(atCapture).toEqual([0])
  expect(empty.mock.calls.length).toBeGreaterThanOrEqual(4)
  expect(new Set(empty.mock.results.slice(0, 4).map(result => result.value)).size).toBe(4)
  f.renderer.dispose(); expect(f.live.size).toBe(0)
})

for (const foregroundBlur of [false, true]) test(`replacement coverage ${foregroundBlur ? 'owns copies for foreground blur' : 'borrows shared masks without releasing them'}`, async () => {
  const f = fixture({ passthrough: false, clip: true, opacity: 0.5,
    effects: [{ ...effect('background-blur'), radius: 1 }, ...(foregroundBlur ? [{ ...effect('blur'), radius: 1 }] : [])] })
  // Coverage can be smaller than the effect rect; the original rect travels
  // with a borrowed mask instead of being mistaken for the expanded rect.
  f.scene.nodes.container.fill.rect = { x: 3, y: 2, w: 18, h: 17 }
  const renderer = f.renderer as unknown as { copy(surface: Surface): Surface; release(...surfaces: (Surface | undefined)[]): void }
  const copies = vi.spyOn(renderer, 'copy'), releases = vi.spyOn(renderer, 'release')
  await f.renderer.render(f.scene)
  const masks = new Set(f.coverage.mock.calls.flatMap(([node], index) => node.id === 'container'
    ? [(f.coverage.mock.results[index].value as Surface).texture] : []))
  expect(copies.mock.calls.filter(([surface]) => masks.has(surface.texture))).toHaveLength(foregroundBlur ? 4 : 0)
  expect(releases.mock.calls.flat().filter(surface => surface && masks.has(surface.texture))).toHaveLength(0)
  f.renderer.dispose(); expect(f.live.size).toBe(0)
})

test('backdrop leaf captures four original targets once before completing independent samples', async () => {
  const f = fixture({ passthrough: false, children: [], effects: [{ ...effect('background-blur'), radius: 1 }], fills: [paint('#4080ff')] })
  delete f.scene.nodes.leaf
  const masksAtReplacement: number[] = []
  f.passObservers.push(mode => { if (mode === 25) masksAtReplacement.push(f.coverage.mock.calls.length) })
  await f.renderer.render(f.scene)
  expect(masksAtReplacement).toEqual([1, 2, 3, 4])
  const capture = f.passes.filter(pass => pass.mode === 26)
  expect(capture).toHaveLength(1)
  const replacements = f.passes.filter(pass => pass.mode === 25)
  expect(replacements).toHaveLength(4)
  expect(replacements.map(pass => pass.inputs[1])).toEqual(capture[0].inputs)
  expect(f.passes.indexOf(capture[0])).toBeLessThan(f.passes.indexOf(replacements[0]))
  f.renderer.dispose(); expect(f.live.size).toBe(0)
})

for (const patch of [{ opacity: 0.5 }, { blend: 'multiply' }, { passthrough: true }, { effects: [{ ...effect('background-blur'), radius: 1 }, { ...effect('blur'), radius: 1 }] }] satisfies Partial<GpuNode>[]) {
  test(`coupled or non-normal backdrop leaf retains bundled sampling: ${JSON.stringify(patch)}`, async () => {
    const f = fixture({ passthrough: false, children: [], effects: [{ ...effect('background-blur'), radius: 1 }], ...patch })
    delete f.scene.nodes.leaf
    const specialized = vi.spyOn(f.renderer as unknown as { drawBackdropLeaf(...args: unknown[]): Promise<Surface[]> }, 'drawBackdropLeaf')
    await f.renderer.render(f.scene)
    expect(specialized).not.toHaveBeenCalled()
    expect(f.coverage.mock.calls).toHaveLength(4)
    f.renderer.dispose(); expect(f.live.size).toBe(0)
  })
}

for (const hasChildren of [false, true]) test(`glass culling contract is followed by the same masked compose (children=${hasChildren})`, async () => {
  const f = fixture({
    passthrough: false, children: hasChildren ? ['leaf'] : [],
    glassShape: { size: [24, 24], radius: 4 },
    effects: [{ ...effect('glass'), radius: 1, glass: { depth: 8, refraction: .5, dispersion: .2, lightAngle: 45, lightIntensity: .5 } }],
  })
  await f.renderer.render(f.scene)
  const optical = f.passes.filter(pass => pass.mode === 34)
  expect(optical).toHaveLength(4)
  for (const pass of optical) {
    expect(pass.uniforms[41]).toBe(1)
    const consumer = f.passes[f.passes.indexOf(pass) + 1]
    expect(consumer.mode).toBe(3)
    expect(consumer.uniforms[19]).toBe(1)
    expect(consumer.inputs[0]).toBe(pass.target)
    expect(consumer.inputs[2]).toBe(pass.inputs[2])
    expect(consumer.uniforms.slice(4, 8)).toEqual(pass.uniforms.slice(0, 4))
    expect(consumer.uniforms.slice(12, 16)).toEqual(pass.uniforms.slice(12, 16))
  }
  f.renderer.dispose(); expect(f.live.size).toBe(0)
})

test('unsampled optical output does not opt into zero-mask culling', async () => {
  const f = fixture({ passthrough: false, children: [], glassShape: { size: [24, 24], radius: 4 }, effects: [effect('glass')] })
  f.scene.coherentSamples = false
  await f.renderer.render(f.scene)
  const optical = f.passes.filter(pass => pass.mode === 34)
  expect(optical).toHaveLength(1)
  expect(optical[0].uniforms[41]).toBe(0)
  f.renderer.dispose(); expect(f.live.size).toBe(0)
})
