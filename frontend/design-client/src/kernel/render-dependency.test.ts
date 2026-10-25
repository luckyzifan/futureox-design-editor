import { expect, test } from 'vitest'
import { blank, node, effect, type Effect } from '../model'
import { VectorEngine } from '../generated/design-kernel/design_kernel'
import { decodeScenePacket } from './gpu/scene-packet'
import { sceneIndex, inheritTranslatedIndex } from './gpu/scene-index'
import { preparePreviewSelection } from './gpu/translated-scene'
import { classifyCompiledSourceReuse, effectsAreKnown } from './render-dependency'
import { staticBackdropKey, movingBackdropKey } from './gpu/static-backdrop'

// Frozen effective backdrop predicate, independently evaluated for differential coverage.
function oldBackdrop(effects: Effect[]) {
  const first = effects.find(e => e.visible && (e.kind === 'glass' || e.kind === 'background-blur'))
  return first && ((first.kind === 'glass' && first.glass ? Math.max(1, first.radius) : first.radius) > 0 ||
    (first.kind === 'glass' && (first.glass ? first.glass.refraction !== 0 || first.glass.dispersion !== 0 || first.glass.lightIntensity !== 0 : first.amount !== 0 || first.opacity !== 0))) ? first : undefined
}
function fixture() {
  const document = blank(), root = node('frame', 0, 0, 50, 50), child = node('rectangle', 2, 2, 10, 10)
  root.children = [child.id]; root.blend = 'normal'
  document.nodes[root.id] = root; document.nodes[child.id] = child; document.pages[0].children = [root.id]
  const kernel = new VectorEngine()
  try {
    kernel.load_document(JSON.stringify(document))
    const scene = decodeScenePacket(kernel.compile_gpu_packet(JSON.stringify({ pageId: document.pages[0].id, width: 80, height: 80, view: { x: 0, y: 0, zoom: 1 }, transparent: true, grid: false })))
    return { document, root, child, scene }
  } finally { kernel.free() }
}
test('shared compiled source classification preserves the old predicate for known effects', () => {
  const { scene, root } = fixture(), source = scene.nodes[root.id]
  for (const kind of ['shadow', 'inner-shadow', 'blur', 'background-blur', 'glass', 'noise', 'texture'] as const)
    for (const visible of [false, true]) for (const radius of [0, 2.5])
      for (const mask of [false, true]) for (const passthrough of [false, true]) for (const previewDynamic of [false, true]) {
        const n = { ...source, mask, passthrough, previewDynamic, effects: [{ ...effect(kind), visible, radius }] }
        const baseline = !n.previewDynamic && !n.mask && !n.passthrough && !oldBackdrop(n.effects) && n.rect.w > 0 && n.rect.h > 0
        expect(classifyCompiledSourceReuse(n).reusable).toBe(baseline)
      }
  // Non-unit opacity and clipping are applied after raw source reuse, not dropped.
  expect(classifyCompiledSourceReuse({ ...source, clip: true, opacity: .3 }).reusable).toBe(true)
  expect(classifyCompiledSourceReuse({ ...source, rect: { ...source.rect, w: Infinity } }).reason).toBe('invalid-bounds')
})
test('unsupported subtree capabilities reject source, stationary and moving backdrop reuse', () => {
  const { scene, root, child } = fixture()
  scene.nodes = { ...scene.nodes, [child.id]: { ...scene.nodes[child.id], effects: [{ ...effect('blur'), kind: 'future-effect' as never }] } }
  const index = sceneIndex(scene)
  expect([...index.unknownEffectSubtrees].sort()).toEqual([root.id, child.id].sort())
  expect(classifyCompiledSourceReuse(scene.nodes[root.id], index.unknownEffectSubtrees.has(root.id)).reason).toBe('unknown-effect')
  scene.interactionRetained = true; scene.interactionSelection = [child.id]
  scene.nodes = { ...scene.nodes, [root.id]: { ...scene.nodes[root.id], clip: true } }
  expect(staticBackdropKey(scene, scene.nodes[root.id])).toBeUndefined()
  scene.nativeInteraction = true; scene.interactionLease = {}; scene.interactionSelection = [root.id]
  expect(movingBackdropKey(scene, scene.nodes[root.id])).toBeUndefined()
  expect(effectsAreKnown([{ ...effect('blur'), visible: false, kind: 'future-effect' as never }])).toBe(true)
})
test('translated immutable scene inherits capability facts without hiding dynamic containers', () => {
  const { document, scene, root, child } = fixture()
  scene.nodes = { ...scene.nodes, [child.id]: { ...scene.nodes[child.id], effects: [{ ...effect('blur'), kind: 'future-effect' as never }] } }
  const index = sceneIndex(scene)
  const moved = { ...scene, nodes: { ...scene.nodes } }
  inheritTranslatedIndex(scene, moved.nodes)
  expect(sceneIndex(moved)).toBe(index)
  expect(classifyCompiledSourceReuse(moved.nodes[root.id], sceneIndex(moved).unknownEffectSubtrees.has(root.id)).reusable).toBe(false)
  const dynamic = preparePreviewSelection(scene, [child.id])
  expect(classifyCompiledSourceReuse(dynamic.nodes[root.id]).reusable).toBe(false)
})
