import { expect, test } from 'vitest'
import type { GpuNode, GpuScene } from './types'
import { planNestedPrefix } from './nested-prefix-plan'

function node(id: string, children: string[] = []): GpuNode {
  const rect = { x: 0, y: 0, w: 128, h: 96 }
  return { id, rect, matrix: [1, 0, 0, 1, 0, 0], inverse: [1, 0, 0, 1, 0, 0], size: [128, 96],
    fill: { rect, first: 0, count: 0, rule: 'nonzero' }, fills: [], strokes: [], children,
    effects: [], opacity: 1, blend: 'normal', clip: false, mask: false }
}
function fixture() {
  const nodes = { root: node('root', ['blur', 'static', 'moving']), blur: node('blur'),
    static: node('static', ['glyph']), glyph: node('glyph'), moving: node('moving', ['label']), label: node('label') }
  nodes.root.previewDynamic = true
  nodes.blur.effects = [{ kind: 'blur', visible: true }] as GpuNode['effects']
  const scene: GpuScene = { version: 8, width: 128, height: 96, output: { x: 0, y: 0, w: 128, h: 96 },
    extent: { x: -16, y: -16, w: 160, h: 128 }, view: { x: 0, y: 0, zoom: 2 },
    roots: ['root'], nodes, vertices: new Float32Array(), curves: new Float32Array(),
    transparent: false, background: '#ffffff', grid: false, coherentSamples: true,
    interactionRetained: true, nativeInteraction: true, interactionLease: {}, interactionSelection: ['moving'] }
  return { scene, nodes, changing: new Set(['root', 'moving', 'label']) }
}

test('plans the original static prefix of a neutral root without moving its background or modifying the scene', () => {
  const { scene, nodes, changing } = fixture(), before = JSON.stringify(scene)
  const plan = planNestedPrefix(scene, 'root', changing)!
  expect(plan.count).toBe(2)
  expect(plan.prefixIds).toEqual(['blur', 'static'])
  expect(plan.sources.map(entry => entry.id)).toEqual(['blur', 'static', 'glyph'])
  expect(plan.sources.map(entry => entry.node)).toEqual([nodes.blur, nodes.static, nodes.glyph])
  expect(plan.lease).toBe(scene.interactionLease)
  expect(plan.selectedId).toBe('moving')
  expect(JSON.stringify(scene)).toBe(before)
  expect(Object.isFrozen(plan)).toBe(true)
  expect(Object.isFrozen(plan.prefixIds)).toBe(true)
  expect(Object.isFrozen(plan.sources)).toBe(true)
  expect(plan.sources.every(Object.isFrozen)).toBe(true)
})

test('retains complete ordered known backdrop effects inside the original isolated prefix', () => {
  const { scene, nodes, changing } = fixture()
  for (const kind of ['background-blur', 'glass', 'shadow', 'inner-shadow', 'blur', 'noise', 'texture']) {
    nodes.blur.effects = [{ kind, visible: true }] as GpuNode['effects']
    expect(planNestedPrefix(scene, 'root', changing)?.count).toBe(2)
  }
})

test('native recompilation can retain proven source identities while a descendant change breaks identity', () => {
  const { scene, nodes, changing } = fixture(), old = planNestedPrefix(scene, 'root', changing)!
  const fresh = { ...scene, nodes: Object.fromEntries(Object.entries(nodes).map(([id, value]) =>
    [id, { ...value, ...(changing.has(id) ? {} : { previewSource: value }) }])) }
  expect(planNestedPrefix(fresh, 'root', changing)!.sources.map(entry => entry.node))
    .toEqual(old.sources.map(entry => entry.node))
  fresh.nodes.glyph = { ...fresh.nodes.glyph, previewSource: undefined }
  expect(planNestedPrefix(fresh, 'root', changing)!.sources[2].node).not.toBe(old.sources[2].node)
})

test('compiler-culled IDs remain ordered sentinels and appearing support cannot reuse the old source list', () => {
  const { scene, nodes, changing } = fixture()
  nodes.root.children = ['culled-before', 'blur', 'static', 'moving', 'culled-after']
  const plan = planNestedPrefix(scene, 'root', changing)!
  expect(plan.count).toBe(3)
  expect(plan.prefixIds).toEqual(['culled-before', 'blur', 'static'])
  expect(plan.sources[0]).toEqual({ id: 'culled-before', node: undefined })
  scene.nodes['culled-before'] = node('culled-before')
  expect(planNestedPrefix(scene, 'root', changing)!.sources[0].node).toBe(scene.nodes['culled-before'])
  scene.nodes['culled-after'] = node('culled-after')
  expect(planNestedPrefix(scene, 'root', changing)).toBeUndefined()
})

test('zero-opacity trailing nodes are no-ops, but later visible siblings and roots reject final-branch admission', () => {
  const { scene, nodes, changing } = fixture()
  scene.nodes.tail = { ...node('tail'), opacity: 0 }; nodes.root.children.push('tail')
  expect(planNestedPrefix(scene, 'root', changing)).toBeDefined()
  scene.nodes.tail.opacity = 1
  expect(planNestedPrefix(scene, 'root', changing)).toBeUndefined()
  scene.nodes.tail.opacity = 0; scene.roots.push('tail')
  expect(planNestedPrefix(scene, 'root', changing)).toBeDefined()
  scene.nodes.tail.opacity = 1
  expect(planNestedPrefix(scene, 'root', changing)).toBeUndefined()
})

test('previewDynamic or native-changing prefix descendants are never certified by an unchanged parent', () => {
  const { scene, nodes, changing } = fixture()
  nodes.glyph.previewDynamic = true
  expect(planNestedPrefix(scene, 'root', changing)).toBeUndefined()
  nodes.glyph.previewDynamic = false; changing.add('glyph')
  expect(planNestedPrefix(scene, 'root', changing)).toBeUndefined()
  changing.delete('glyph'); nodes.glyph.previewSource = { ...nodes.glyph, previewDynamic: true }
  expect(planNestedPrefix(scene, 'root', changing)).toBeUndefined()
})

test('a reused source at another placement is not a stationary-prefix identity', () => {
  const { scene, nodes, changing } = fixture()
  nodes.blur.previewSource = { ...nodes.blur, rect: { ...nodes.blur.rect, x: -1 } }
  expect(planNestedPrefix(scene, 'root', changing)).toBeUndefined()
  nodes.blur.previewSource = { ...nodes.blur, matrix: [1, 0, 0, 1, 0.25, 0] }
  expect(planNestedPrefix(scene, 'root', changing)).toBeUndefined()
})

test('only a single native four-sample retained branch without another output lattice can enter', () => {
  const { scene, changing } = fixture()
  for (const change of [{ coherentSamples: false }, { interactionRetained: false }, { nativeInteraction: false },
    { interactionLease: undefined }, { softwareRaster: true }, { resolve: {} }, { presentation: {} },
    { interactionSelection: [] }, { interactionSelection: ['moving', 'glyph'] }, { interactionSelection: ['root'] },
    { interactionSelection: ['missing'] }])
    expect(planNestedPrefix({ ...scene, ...change } as GpuScene, 'root', changing)).toBeUndefined()
})

test('all neutral-scope boundaries remain strict', () => {
  for (const change of [{ opacity: 0.5 }, { blend: 'multiply' }, { passthrough: true }, { mask: true },
    { maskId: 'glyph' }, { clip: true }, { fills: [{}] }, { strokes: [{}] }, { effects: [{ visible: false }] },
    { captureReplay: {} }, { textureReplay: {} }]) {
    const { scene, nodes, changing } = fixture()
    Object.assign(nodes.root, change)
    expect(planNestedPrefix(scene, 'root', changing)).toBeUndefined()
  }
})

test('prefix masks, clipping, pass-through, unknown effects and replays fall back at any depth', () => {
  for (const change of [{ mask: true }, { maskId: 'other' }, { clip: true }, { passthrough: true },
    { effects: [{ kind: 'future-effect', visible: true }] }, { captureReplay: {} }, { textureReplay: {} }]) {
    const { scene, nodes, changing } = fixture()
    Object.assign(nodes.glyph, change)
    expect(planNestedPrefix(scene, 'root', changing)).toBeUndefined()
  }
})

test('multiple ancestor scopes, duplicate edges and cycles cannot masquerade as a simple branch', () => {
  const { scene, nodes, changing } = fixture()
  scene.roots = ['outer']; scene.nodes.outer = node('outer', ['root'])
  expect(planNestedPrefix(scene, 'root', changing)).toBeUndefined()
  scene.roots = ['root']; delete scene.nodes.outer
  nodes.static.children.push('moving')
  expect(planNestedPrefix(scene, 'root', changing)).toBeUndefined()
  nodes.static.children = ['glyph', 'glyph']
  expect(planNestedPrefix(scene, 'root', changing)).toBeUndefined()
  nodes.static.children = ['root']
  expect(planNestedPrefix(scene, 'root', changing)).toBeUndefined()
})

test('empty prefixes and noncontributing selections offer no reusable work', () => {
  const { scene, nodes, changing } = fixture()
  nodes.root.children = ['moving']
  expect(planNestedPrefix(scene, 'root', changing)).toBeUndefined()
  nodes.root.children = ['culled', 'moving']
  expect(planNestedPrefix(scene, 'root', changing)).toBeUndefined()
  nodes.root.children = ['blur', 'moving']; nodes.moving.opacity = 0
  expect(planNestedPrefix(scene, 'root', changing)).toBeUndefined()
})


test('a selected child mask is an ancestor dependency even when it is the final child', () => {
  const { scene, nodes, changing } = fixture()
  nodes.moving.mask = true
  expect(planNestedPrefix(scene, 'root', changing)).toBeUndefined()
})


test('opt-in suffix replays following content while only the complete stationary prefix is cached', () => {
  const {scene,nodes,changing}=fixture()
  scene.nodes.tail=node('tail');scene.nodes.tail.effects=[{kind:'background-blur',visible:true,radius:3}] as GpuNode['effects']
  nodes.root.children.push('tail')
  expect(planNestedPrefix(scene,'root',changing)).toBeUndefined()
  const plan=planNestedPrefix(scene,'root',changing,true)!
  expect(plan.count).toBe(2)
  expect(plan.sources.map(row=>row.id)).toEqual(['blur','static','glyph'])
  scene.nodes.tail.mask=true
  expect(planNestedPrefix(scene,'root',changing,true)).toBeUndefined()
})
