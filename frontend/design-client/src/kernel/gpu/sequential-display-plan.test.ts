import { expect, test } from 'vitest'
import { planSequentialDisplay, sequentialDisplayRejection, type SequentialDisplayOptions } from './sequential-display-plan'
import type { GpuNode, GpuScene, PathMesh, Rect } from './types'

const output = { x: 20, y: 30, w: 100, h: 80 }
const bounds = { x: 0, y: 0, w: 200, h: 200 }
const options: SequentialDisplayOptions = { managed: true, hdr: false, present: true }
function fixture() {
  const curves = new Float32Array(28)
  curves.set([4, 0, bounds.w, bounds.h])
  const fill: PathMesh = { rect: { ...bounds }, count: 1, first: 0, rule: 'nonzero', sampleCount: 4,
    area: { first: 0, count: 7 } }
  const node = (id: string, children: string[] = [], filled = true): GpuNode => ({ id, rect: { ...bounds },
    size: [bounds.w, bounds.h], matrix: [1, 0, 0, 1, 0, 0], inverse: [1, 0, 0, 1, 0, 0],
    fill: filled ? structuredClone(fill) : { ...structuredClone(fill), count: 0, area: undefined },
    fills: filled ? [{ id: `${id}-paint`, kind: 'solid', visible: true, blend: 'normal', opacity: 1,
      color: '#123456', stops: [], angle: 0, fit: 'cover' }] : [], children, strokes: [], effects: [],
    opacity: 1, blend: 'normal', mask: false, clip: false })
  const root = node('root', ['a', 'group'], false), a = node('a'), group = node('group', ['b'], false), b = node('b')
  const scene: GpuScene = { version: 8, width: output.w, height: output.h, extent: { ...bounds },
    output: { ...output }, floatCompositing: true, coherentSamples: true, integratedBlur: true,
    view: { x: 0, y: 0, zoom: 1 }, roots: ['root'], nodes: { root, a, group, b }, curves,
    vertices: [], background: '#ffffff', transparent: false, grid: false }
  return { scene, root, a, group, b, curves, node }
}

test('retains original tree order, clips only color regions and never rewrites any native input', () => {
  const f = fixture(), before = structuredClone(f.scene), originalPath = f.a.fill, originalRect = f.a.fill.rect
  f.group.rect = { x: 50, y: 40, w: 120, h: 100 }
  before.nodes.group.rect = { ...f.group.rect }
  const plan = planSequentialDisplay(f.scene, output, options)!
  expect(plan.roots).toEqual(['root']); expect([...plan.regions.keys()]).toEqual(['root', 'a', 'group', 'b'])
  expect(plan.regions.get('a')).toEqual(output)
  expect(plan.regions.get('group')).toEqual({ x: 50, y: 40, w: 70, h: 70 })
  expect(plan.regions.get('b')).toEqual(plan.regions.get('group'))
  expect(plan.maxDepth).toBe(3); expect(plan.estimatedPeakBytes).toBeGreaterThan(output.w * output.h * 16 * 3)
  expect(f.scene).toEqual(before); expect(f.a.fill).toBe(originalPath); expect(f.a.fill.rect).toBe(originalRect)
  expect(f.a.fill.rect).toEqual(bounds)
})

test('multiple normal solid paints and authored group opacity retain admission', () => {
  const f = fixture(); f.group.opacity = .25; f.a.fills.push({ ...f.a.fills[0], id: 'second', opacity: .5 })
  expect(planSequentialDisplay(f.scene, output, options)).toBeDefined()
})

test.each([
  { managed: false }, { hdr: true }, { present: false }, { readback: true },
])('rejects a non-screen arithmetic boundary %j', boundary => {
  expect(planSequentialDisplay(fixture().scene, output, { ...options, ...boundary })).toBeUndefined()
})

test.each([
  { coherentSamples: false }, { floatCompositing: false }, { softwareRaster: true },
  { interactionRetained: true }, { nativeInteraction: true }, { interactionWindow: output },
  { grid: true }, { checkerboard: true }, { displayFilters: true },
  { resolve: { width: 100, height: 80, scale: 1, offsetX: 0, offsetY: 0 } },
  { presentation: { width: 100, height: 80, scale: 1, offsetX: 0, offsetY: 0 } },
])('rejects scene boundary %j', boundary => {
  const f = fixture(); Object.assign(f.scene, boundary)
  expect(planSequentialDisplay(f.scene, output, options)).toBeUndefined()
})

test.each(['passthrough', 'mask', 'clip', 'maskId', 'captureReplay', 'textureReplay', 'previewSource', 'previewDynamic'] as const)(
  'rejects contributing %s semantics', key => {
    const f = fixture(); (f.a as unknown as Record<string, unknown>)[key] = key === 'maskId' ? 'b' : true
    expect(planSequentialDisplay(f.scene, output, options)).toBeUndefined()
  })

test.each(['stroke', 'effect', 'unknown-effect', 'image', 'gradient', 'non-normal-paint', 'non-normal-node'])(
  'rejects unsupported contributing operator %s', kind => {
    const f = fixture()
    if (kind === 'stroke') f.a.strokes.push({ path: f.a.fill, paint: f.a.fills[0], align: 'center' })
    if (kind === 'effect' || kind === 'unknown-effect') f.a.effects.push({ visible: true,
      kind: kind === 'effect' ? 'blur' : 'future-effect', radius: 1 } as GpuNode['effects'][number])
    if (kind === 'image' || kind === 'gradient') f.a.fills[0].kind = kind === 'image' ? 'image' : 'linear'
    if (kind === 'non-normal-paint') f.a.fills[0].blend = 'multiply'
    if (kind === 'non-normal-node') f.a.blend = 'multiply'
    expect(planSequentialDisplay(f.scene, output, options)).toBeUndefined()
  })

function material() {
  const f = fixture(); f.a.fills = [{ ...f.a.fills[0], kind: 'image', image: 'immutable-upload-id', fit: 'cover' }]
  f.a.effects = [{ kind: 'blur', visible: true, radius: 4 } as GpuNode['effects'][number]]
  return f
}
test('only an explicitly prepared single image/blur leaf may cross the effect boundary', () => {
  const f = material(), prepared = { ...options, preparedMaterialIds: new Set(['a']) }
  expect(planSequentialDisplay(f.scene, output, options)).toBeUndefined()
  expect(planSequentialDisplay(f.scene, output, prepared)).toBeDefined()
  f.a.children.push('b')
  expect(planSequentialDisplay(f.scene, output, prepared)).toBeUndefined()
})

test.each(['two-ids', 'unknown-id', 'no-image', 'two-fills', 'two-effects', 'gradient-blur', 'paint-opacity', 'masked'])(
  'prepared ID cannot bypass material structure: %s', kind => {
    const f = material(); let ids = new Set(['a'])
    if (kind === 'two-ids') ids = new Set(['a', 'b'])
    if (kind === 'unknown-id') ids = new Set(['absent'])
    if (kind === 'no-image') f.a.fills[0].image = ''
    if (kind === 'two-fills') f.a.fills.push({ ...f.a.fills[0] })
    if (kind === 'two-effects') f.a.effects.push({ ...f.a.effects[0] })
    if (kind === 'gradient-blur') Object.assign(f.a.effects[0], { gradientBlur: {} })
    if (kind === 'paint-opacity') f.a.fills[0].opacity = .5
    if (kind === 'masked') f.a.mask = true
    expect(planSequentialDisplay(f.scene, output, { ...options, preparedMaterialIds: ids })).toBeUndefined()
  })

test.each(['missing', 'cycle', 'duplicate-root', 'duplicate-child', 'shared-child', 'mismatched-id'])(
  'rejects non-tree topology %s, including offscreen branches', kind => {
    const f = fixture()
    if (kind === 'missing') { f.b.rect = { x: 150, y: 150, w: 10, h: 10 }; f.b.children.push('absent') }
    if (kind === 'cycle') f.b.children.push('root')
    if (kind === 'duplicate-root') f.scene.roots.push('root')
    if (kind === 'duplicate-child') f.root.children.push('a')
    if (kind === 'shared-child') f.group.children.push('a')
    if (kind === 'mismatched-id') f.a.id = 'different'
    expect(planSequentialDisplay(f.scene, output, options)).toBeUndefined()
  })

test('offscreen/zero-opacity operators produce no regions but cannot hide malformed topology', () => {
  const f = fixture(); f.a.rect = { x: 150, y: 150, w: 10, h: 10 }; f.a.effects.push({ kind: 'glass', visible: true } as GpuNode['effects'][number])
  f.group.opacity = 0; f.b.effects.push({ kind: 'blur', visible: true, radius: 4 } as GpuNode['effects'][number])
  const plan = planSequentialDisplay(f.scene, output, options)!
  expect([...plan.regions.keys()]).toEqual(['root'])
  f.b.children.push('absent'); expect(planSequentialDisplay(f.scene, output, options)).toBeUndefined()
})

test('only explicit trusted-packet admission treats absent own keys as transparent culling leaves', () => {
  const f = fixture(); f.root.children.splice(1, 0, 'culled-root-child'); f.group.children.push('culled-nested-child')
  expect(planSequentialDisplay(f.scene, output, options)).toBeUndefined()
  const before = structuredClone(f.scene)
  const plan = planSequentialDisplay(f.scene, output, { ...options, allowCulledNodes: true })!
  expect(plan.roots).toEqual(['root'])
  expect([...plan.regions.keys()]).toEqual(['root', 'a', 'group', 'b'])
  expect(plan.regions.has('culled-root-child')).toBe(false)
  expect(plan.regions.has('culled-nested-child')).toBe(false)
  expect(f.scene).toEqual(before); expect(f.root.children).toEqual(['a', 'culled-root-child', 'group'])
})

test.each(['duplicate-sentinel', 'duplicate-root-sentinel', 'null', 'own-undefined', 'id-mismatch', 'cycle'])(
  'trusted culling cannot bypass defined corruption or repeated topology: %s', kind => {
    const f = fixture(); f.root.children.push('culled')
    if (kind === 'duplicate-sentinel') f.group.children.push('culled')
    if (kind === 'duplicate-root-sentinel') f.scene.roots.push('culled')
    if (kind === 'null') (f.scene.nodes as unknown as Record<string, unknown>).culled = null
    if (kind === 'own-undefined') (f.scene.nodes as unknown as Record<string, unknown>).culled = undefined
    if (kind === 'id-mismatch') f.scene.nodes.culled = f.node('different-id')
    if (kind === 'cycle') f.b.children.push('root')
    expect(planSequentialDisplay(f.scene, output, { ...options, allowCulledNodes: true })).toBeUndefined()
  })

test.each(['no-area', 'sixteen-samples', 'wrong-header', 'wrong-width', 'truncated-program', 'fractional-path-rect'])(
  'rejects incompatible regional coverage %s', kind => {
    const f = fixture()
    if (kind === 'no-area') f.a.fill.area = undefined
    if (kind === 'sixteen-samples') f.a.fill.sampleCount = 16
    if (kind === 'wrong-header') f.curves[0] = 1
    if (kind === 'wrong-width') f.curves[2]++
    if (kind === 'truncated-program') f.a.fill.area!.count = 6
    if (kind === 'fractional-path-rect') f.a.fill.rect.x += .25
    expect(planSequentialDisplay(f.scene, output, options)).toBeUndefined()
  })

test('accepts structurally bounded header3 rows, including empty samples, then rejects out-of-range spans', () => {
  const f = fixture(), rows = bounds.h * 4, firstSpan = 1 + rows
  const curves = new Float32Array((firstSpan + 3) * 4); curves.set([3, 1, bounds.w, bounds.h])
  curves.set([firstSpan, 1, 0, 0], 4); curves.set([0, bounds.w, 0, 0], firstSpan * 4)
  f.scene.curves = curves
  for (const node of [f.a, f.b]) node.fill.area!.count = curves.length / 4
  expect(planSequentialDisplay(f.scene, output, options)).toBeDefined()
  curves[4] = curves.length / 4
  expect(planSequentialDisplay(f.scene, output, options)).toBeUndefined()
})

test('empty coverage does not require an interval program; painted parent bounds need not equal its child bounds', () => {
  const f = fixture(); f.a.fill = { ...f.a.fill, count: 0, area: undefined }
  f.group.fills = [{ ...f.b.fills[0] }]; f.group.fill = { ...f.b.fill }
  f.group.fill.rect = { ...bounds }
  expect(planSequentialDisplay(f.scene, output, options)).toBeDefined()
})

test('depth and conservative memory guards reject only when requested; estimate is not the actual renderer ledger', () => {
  const f = fixture(), plan = planSequentialDisplay(f.scene, output, options)!
  expect(planSequentialDisplay(f.scene, output, { ...options, maxDepth: 2 })).toBeUndefined()
  expect(planSequentialDisplay(f.scene, output, { ...options, maxDepth: 3 })).toBeDefined()
  expect(planSequentialDisplay(f.scene, output, { ...options, maxWorkingBytes: plan.estimatedPeakBytes - 1 })).toBeUndefined()
  expect(planSequentialDisplay(f.scene, output, { ...options, maxWorkingBytes: plan.estimatedPeakBytes })).toBeDefined()
})

test.each([
  { x: 20.5, y: 30, w: 100, h: 80 }, { x: 20, y: 30, w: 0, h: 80 },
  { x: -1, y: 30, w: 100, h: 80 }, { x: 20, y: 30, w: 9000, h: 80 },
] satisfies Rect[])('rejects unsupported ROI %j', roi => {
  expect(planSequentialDisplay(fixture().scene, roi, options)).toBeUndefined()
})

test('regional samples keep bounded finite HDR colors and reject NaN-neighbour domains', () => {
  const f = fixture()
  f.scene.colors = { '#123456': [-65536, 4, 65536, .5] }
  expect(planSequentialDisplay(f.scene, output, options)).toBeDefined()
  for (const value of [Infinity, -Infinity, NaN, 65536.01, -65536.01]) {
    f.scene.colors['#123456'] = [value, 0, 1, .5]
    expect(planSequentialDisplay(f.scene, output, options)).toBeUndefined()
  }
  f.scene.colors = { '#ffffff': [Infinity, 1, 1, 1] }
  expect(planSequentialDisplay(f.scene, output, options)).toBeUndefined()
})

test('the diagnostic distinguishes effect rejection without changing admission', () => {
  const f = fixture(), reasons: number[] = []
  f.a.effects.push({ kind: 'blur', visible: true, radius: 2 } as GpuNode['effects'][number])
  expect(planSequentialDisplay(f.scene, output, options)).toBeUndefined()
  expect(planSequentialDisplay(f.scene, output, { ...options, onReject: code => reasons.push(code) })).toBeUndefined()
  expect(reasons).toEqual([sequentialDisplayRejection.effects])
})

test('the diagnostic reports the first duplicate edge exactly once', () => {
  const f = fixture(), reasons: number[] = []
  f.root.children.push('a'); f.group.children.push('root')
  expect(planSequentialDisplay(f.scene, output, { ...options, onReject: code => reasons.push(code) })).toBeUndefined()
  expect(reasons).toEqual([sequentialDisplayRejection.duplicate])
})

test('area rejection retains its decision even if the diagnostic observer throws', () => {
  const f = fixture(); f.a.fill.sampleCount = 16
  let observed = 0
  expect(planSequentialDisplay(f.scene, output, { ...options, onReject(code) {
    observed = code; throw Error('diagnostic-only observer failure')
  } })).toBeUndefined()
  expect(observed).toBe(sequentialDisplayRejection.area)
})

test('only explicitly prepared plain images join unchanged normal solid paints', () => {
  const f = fixture()
  f.a.fills.push({ ...f.a.fills[0], kind: 'image', image: 'actual-privately-proved-upload', opacity: .375 })
  const before = structuredClone(f.scene)
  expect(planSequentialDisplay(f.scene, output, options)).toBeUndefined()
  expect(planSequentialDisplay(f.scene, output, { ...options, preparedImageIds: new Set(['a']) })).toBeDefined()
  expect(f.scene).toEqual(before)
})

test.each(['empty-uri', 'invisible', 'opacity', 'blend', 'gradient', 'effect', 'clip', 'mask', 'stroke'])(
  'a prepared image ID cannot bypass other admission: %s', kind => {
    const f = fixture()
    f.a.fills = [{ ...f.a.fills[0], kind: 'image', image: 'actual-privately-proved-upload' }]
    if (kind === 'empty-uri') f.a.fills[0].image = ''
    if (kind === 'invisible') f.a.fills[0].visible = false
    if (kind === 'opacity') f.a.fills[0].opacity = 1.01
    if (kind === 'blend') f.a.fills[0].blend = 'multiply'
    if (kind === 'gradient') f.a.fills.push({ ...f.a.fills[0], kind: 'linear' })
    if (kind === 'effect') f.a.effects.push({ kind: 'blur', visible: true, radius: 1 } as GpuNode['effects'][number])
    if (kind === 'clip') f.a.clip = true
    if (kind === 'mask') f.a.mask = true
    if (kind === 'stroke') f.a.strokes.push({ path: f.a.fill, paint: f.a.fills[0], align: 'center' })
    expect(planSequentialDisplay(f.scene, output, { ...options, preparedImageIds: new Set(['a']) })).toBeUndefined()
  })

test('unused, absent or solid-only prepared image IDs do not assert a proof', () => {
  const f = fixture()
  for (const id of ['absent', 'a', 'group']) {
    const reasons: number[] = []
    expect(planSequentialDisplay(f.scene, output, { ...options, preparedImageIds: new Set([id]),
      onReject: code => reasons.push(code) })).toBeUndefined()
    expect(reasons).toEqual([sequentialDisplayRejection.unusedImage])
  }
})
