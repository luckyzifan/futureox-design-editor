import { expect, test } from 'vitest'
import { effect, paint } from '../../model'
import { certifyExactImageRange } from './exact-image-x-table'
import { planDisplayMaterialSource } from './display-material-source'
import type { GpuNode, GpuScene } from './types'

function fixture(width = 8, height = 4) {
  const pixels = new Float32Array(width * height * 4)
  for (let i = 0; i < pixels.length; i += 4) pixels.set([.125, .5, .75, 1], i)
  const range = certifyExactImageRange(pixels)!
  const rect = { x: -32, y: -32, w: 256, h: 192 }
  const node: GpuNode = { id: 'material', rect, size: [width * 2, height * 2],
    matrix: [4, 0, 0, 4, 100, -50], inverse: [.25, 0, 0, .25, -25, 12.5],
    fill: { rect, first: 0, count: 1, rule: 'nonzero', sampleCount: 4 }, children: [], strokes: [],
    fills: [{ ...paint('#000000', 'image'), image: 'fixture-actual-upload', fit: 'cover' }],
    effects: [{ ...effect('blur'), radius: 8 }], opacity: .48, blend: 'normal', clip: false, mask: false }
  const scene: GpuScene = { version: 8, width: 128, height: 96, extent: rect,
    view: { x: 0, y: 0, zoom: 4 }, roots: [node.id], nodes: { [node.id]: node },
    vertices: [], curves: [], background: '#ffffff', transparent: false, grid: false,
    floatCompositing: true, coherentSamples: true, integratedBlur: true }
  const input = { x: 0, y: 0, w: 128, h: 96 }
  const plan = () => planDisplayMaterialSource(scene, node, input, width, height, range)
  return { scene, node, input, width, height, range, pixels, plan }
}

test('admits a source-radius plan without changing the input or granting an image certificate', () => {
  const f = fixture(), before = JSON.stringify({ scene: f.scene, input: f.input, range: f.range })
  const plan = f.plan()!
  expect(plan).toEqual({ radius: 4 })
  expect(Object.isFrozen(plan)).toBe(true)
  expect(Object.keys(plan)).toEqual(['radius'])
  expect(JSON.stringify({ scene: f.scene, input: f.input, range: f.range })).toBe(before)
  expect(f.node.opacity).toBe(.48)
})

test('real 117 geometry has a stable source radius across zoom and preserves its tiny reflected rotation', () => {
  const f = fixture(736, 414)
  f.node.size = [1920, 1080]; f.node.effects[0].radius = 9.564871788024902
  for (const scale of [1, 2, 32, 64, 128]) {
    f.scene.view.zoom = scale
    f.node.matrix = [-scale, -2.4492935982947064e-16 * scale, -2.4492935982947064e-16 * scale,
      scale, 88877.99609375003, -25232.01171874997]
    const matrix = [...f.node.matrix]
    expect(f.plan()?.radius).toBe(3.6665341854095463)
    expect(f.node.matrix).toEqual(matrix)
  }
})

test('scene precision and effects-route changes reject material admission', () => {
  for (const change of [{ floatCompositing: false }, { coherentSamples: false }, { integratedBlur: false },
    { softwareRaster: true }, { displayFilters: true }, { resolve: {} }, { presentation: {} }]) {
    const f = fixture(); Object.assign(f.scene, change)
    expect(f.plan()).toBeUndefined()
  }
})

test('node composition dependencies and preview-source aliases reject', () => {
  for (const change of [{ children: ['child'] }, { strokes: [{}] }, { mask: true }, { maskId: 'mask' },
    { clip: true }, { passthrough: true }, { previewSource: {} }, { captureReplay: {} },
    { textureReplay: {} }, { blend: 'multiply' }]) {
    const f = fixture(); Object.assign(f.node, change)
    expect(f.plan()).toBeUndefined()
  }
})

test('image paint must be one unadjusted full-aspect cover with original opacity and mapping', () => {
  for (const change of [{ kind: 'solid' }, { image: undefined }, { visible: false }, { opacity: .5 },
    { blend: 'multiply' }, { fit: 'contain' }, { fit: 'stretch' }, { fit: 'crop' },
    { transform: [1, 0, 0, 1, 0, 0] }, { tile: {} }, { adjust: {} }]) {
    const f = fixture(); Object.assign(f.node.fills[0], change)
    expect(f.plan()).toBeUndefined()
  }
  const f = fixture(); f.node.fills.push({ ...f.node.fills[0] })
  expect(f.plan()).toBeUndefined()
  f.node.fills[1].visible = false
  expect(f.plan()).toBeDefined()
  f.node.size[0] += .000001
  expect(f.plan()).toBeUndefined()
})

test('only one ordinary visible blur with a bounded positive source radius is admitted', () => {
  for (const change of [{ kind: 'background-blur' }, { kind: 'shadow' }, { gradientBlur: {} },
    { visible: false }, { radius: 0 }, { radius: -1 }, { radius: NaN }, { radius: Infinity }, { radius: 64.001 }]) {
    const f = fixture(); Object.assign(f.node.effects[0], change)
    expect(f.plan()).toBeUndefined()
  }
  const f = fixture(); f.node.effects[0].radius = 64
  expect(f.plan()?.radius).toBe(32)
  f.node.effects.push(effect('shadow'))
  expect(f.plan()).toBeUndefined()
  f.node.effects[1].visible = false
  expect(f.plan()?.radius).toBe(32)
})

test('matrix tolerance is explicit and bounded, while singular transforms and anisotropy reject', () => {
  const f = fixture()
  f.node.matrix = [-4, 4e-12, -4e-12, 4, 0, 0]
  expect(f.plan()).toBeDefined()
  f.node.matrix[1] = 4.001e-12
  expect(f.plan()).toBeUndefined()
  f.node.matrix = [4, 0, 0, 4 + 1e-12, 0, 0]
  expect(f.plan()).toBeDefined()
  for (const matrix of [[4, 0, 0, 4.000000001, 0, 0], [0, 0, 0, 0, 0, 0],
    [4, 0, 0, 0, 0, 0], [0, 4, -4, 0, 0, 0], [4, 0, 0, 4, Infinity, 0]] as GpuNode['matrix'][]) {
    f.node.matrix = matrix
    expect(f.plan()).toBeUndefined()
  }
})

test('range shape, opacity, sign and exponent admission use actual range facts without mutating them', () => {
  const f = fixture()
  for (const change of [{ pixels: 1 }, { opaqueAlpha: false }, { nonnegativeRgb: false },
    { maximum: [128, 127, 127, 127] }, { maximum: [127, 127, 127] }, { maximum: [NaN, 127, 127, 127] }])
    expect(planDisplayMaterialSource(f.scene, f.node, f.input, f.width, f.height, { ...f.range, ...change })).toBeUndefined()
  expect(planDisplayMaterialSource(f.scene, f.node, f.input, f.width, f.height, undefined)).toBeUndefined()
  for (const [component, value] of [[0, -1], [0, 2], [3, 0], [3, 1.5], [0, Infinity]]) {
    const changed = f.pixels.slice(); changed[component] = value
    expect(planDisplayMaterialSource(f.scene, f.node, f.input, f.width, f.height,
      certifyExactImageRange(changed))).toBeUndefined()
  }
})

test('input support must remain an integer rectangle inside the native node bounds', () => {
  for (const change of [{ x: -33 }, { x: .125 }, { y: NaN }, { w: 0 }, { h: -1 }, { w: 8193 },
    { x: 200 }, { y: 150 }]) {
    const f = fixture(); Object.assign(f.input, change)
    expect(f.plan()).toBeUndefined()
  }
})

test('source dimensions and total material allocation stay bounded', () => {
  const f = fixture()
  for (const [width, height] of [[0, 4], [8.5, 4], [2049, 1], [2048, 1024], [Infinity, 1]]) {
    f.node.size = [width, height]
    // Structural negative inputs only; positive admission above uses a real
    // immutable upload-range scan. The owner must still bind its GPU resource.
    expect(planDisplayMaterialSource(f.scene, f.node, f.input, width, height,
      { ...f.range, pixels: width * height })).toBeUndefined()
  }
})
