import { expect, test } from 'vitest'
import { createHash } from 'node:crypto'
import { blank, effect, node, paint, stroke, type Bounds, type DesignDocument } from '../model'
import { scene, unionBounds, type SceneEntry } from '../geometry'
import { VectorEngine } from '../generated/design-kernel/design_kernel'
import { buildInteractionDependencyScope, interactionRootBounds } from './interaction-scene-bounds'

test('short travel reserve applies only to localized simple leaves without changing their footprint', () => {
  const document = blank(), root = node('frame', 10, 20, 200, 200), leaf = node('text', 30, 40, 67, 20)
  root.children = [leaf.id]; leaf.fills = [paint('#123456')]
  document.nodes = { [root.id]: root, [leaf.id]: leaf }; document.pages[0].children = [root.id]
  const scope = () => buildInteractionDependencyScope(document, document.pages[0].id,
    scene(document, document.pages[0].id), [leaf.id], { zoom: 1, dpr: 2, allowFixedBackdrop: true })
  const before = scope(); expect(before.shortTravelBounds.has(leaf.id)).toBe(true)
  leaf.effects = [effect('blur')]
  expect(scope().shortTravelBounds.has(leaf.id)).toBe(false)
  leaf.effects = []; leaf.strokes = [stroke('#abcdef', 1)]
  expect(scope().shortTravelBounds.has(leaf.id)).toBe(false)
  leaf.strokes = []; leaf.fills[0].kind = 'image'
  expect(scope().shortTravelBounds.has(leaf.id)).toBe(false)
  leaf.fills[0].kind = 'solid'; root.mask = true
  expect(scope().shortTravelBounds.has(leaf.id)).toBe(false)
  root.mask = false
  expect(scope().rootBounds.get(leaf.id)).toEqual(before.rootBounds.get(leaf.id))
})

// Frozen pre-optimization implementation. Keep this independent of the
// production helper: membership, padding and all floating-point operations
// must remain exactly equivalent, including empty roots and scene order.
function referenceRootBounds(document: DesignDocument, pageId: string, entries: readonly SceneEntry[]) {
  return new Map((document.pages.find(p => p.id === pageId)?.children || []).map(id =>
    [id, unionBounds(entries.filter(e => e.id === id || e.ancestors[0] === id).map(e => {
      const n = document.nodes[e.id], scale = Math.max(Math.hypot(e.matrix[0], e.matrix[1]), Math.hypot(e.matrix[2], e.matrix[3]))
      const pad = Math.max(0, ...n.effects.filter(f => f.visible).map(f => f.radius * 3 + Math.abs(f.x || 0) + Math.abs(f.y || 0) + Math.abs(f.spread || 0)),
        ...n.strokes.filter(s => s.visible).map(s => s.width * 4)) * scale
      return { x: e.bounds.x - pad, y: e.bounds.y - pad, width: e.bounds.width + pad * 2, height: e.bounds.height + pad * 2 }
    }))]))
}

function expectExact(actual: Map<string, Bounds>, expected: Map<string, Bounds>) {
  expect([...actual.keys()]).toEqual([...expected.keys()])
  for (const [id, bounds] of expected) {
    const result = actual.get(id)!
    for (const axis of ['x', 'y', 'width', 'height'] as const)
      expect(Object.is(result[axis], bounds[axis]), `${id}.${axis}`).toBe(true)
  }
}

function manyRoots(count = 3000) {
  const document = blank('Interaction bounds performance')
  for (let i = 0; i < count; i++) {
    const root = node('frame', i % 100 * 40 + .125, Math.floor(i / 100) * 40 - .375, 12, 14)
    root.id = `root-${i}`; root.blend = 'normal'; root.fills = [paint(i % 2 ? '#2146bd' : '#e24d77')]
    root.effects = [{ ...effect('shadow'), radius: .5 + (i % 3) / 8, x: -.125, y: .375, spread: -.25 }]
    document.nodes[root.id] = root; document.pages[0].children.push(root.id)
  }
  return document
}

test('grouped root envelopes match every original float for nested, hidden, clipped and masked scenes', () => {
  const document = blank(), root = node('frame', -17.25, 8.125, 40, 50), group = node('group', 3, -5, 20, 20)
  const leaf = node('rectangle', -7, 11, 13, 17), hidden = node('frame', 1e5, 1e5, 100, 100)
  const hiddenChild = node('rectangle', -1e9, 1e9, 100, 100), empty = node('frame', 30, 40, 0, 0)
  root.transform = [0, 2, -3, 0, -17.25, 8.125]; root.clip = true; root.mask = true
  group.transform = [1.25, .5, -.25, .75, 3, -5]; group.children = [leaf.id]
  root.children = [group.id, hiddenChild.id]; hiddenChild.visible = false; hidden.visible = false
  root.effects = [{ ...effect('glass'), radius: 1.25, x: -.5, y: 2.5, spread: -.75 }]
  leaf.effects = [{ ...effect('shadow'), radius: 2.25, x: 3.5, y: -4.25, spread: 1.125 },
    { ...effect('blur'), radius: 10000, visible: false }]
  leaf.strokes = [{ ...stroke('#345678', .375), widthProfile: [{ position: 0, left: .25, right: .5 }, { position: 1, left: 4, right: 2 }] }]
  for (const n of [root, group, leaf, hidden, hiddenChild, empty]) document.nodes[n.id] = n
  document.pages[0].children = [root.id, hidden.id, empty.id]
  const entries = scene(document, document.pages[0].id)
  const actual = interactionRootBounds(document, document.pages[0].id, entries)
  expectExact(actual, referenceRootBounds(document, document.pages[0].id, entries))
  expect(actual.get(hidden.id)).toEqual({ x: 0, y: 0, width: 0, height: 0 })
  expect(actual.get(root.id)!.width).toBeGreaterThan(root.width)
  expect(entries.some(e => e.id === hiddenChild.id)).toBe(false)
  expect(interactionRootBounds(document, 'missing-page', entries).size).toBe(0)

  // A different page can explicitly expose an entry that is also below a
  // listed root. The original predicate includes it in both unions.
  document.pages.push({ ...document.pages[0], id: 'other-page', children: [leaf.id, root.id, leaf.id] })
  expectExact(interactionRootBounds(document, 'other-page', entries), referenceRootBounds(document, 'other-page', entries))
  leaf.effects = [{ ...effect('shadow'), radius: 19 }]
  expectExact(interactionRootBounds(document, document.pages[0].id, entries), referenceRootBounds(document, document.pages[0].id, entries))
})

test('root grouping preserves exact arithmetic at tiny and large coordinate magnitudes', () => {
  const document = manyRoots(8), ids = document.pages[0].children
  const magnitudes = [-0, Number.MIN_VALUE, 2 ** -40, -(2 ** -20), 2 ** 27, -(2 ** 40), 1e90, -1e120]
  const entries: SceneEntry[] = magnitudes.flatMap((x, i) => [0, 1, 2].map(j => ({
    id: ids[i], parent: document.pages[0].id, ancestors: j ? [ids[(i + 1) % ids.length]] : [],
    matrix: [1.125, -.5, .25, .875, 0, 0], bounds: { x, y: -x, width: Math.abs(x) * .25 + j / 8, height: j / 16 },
    depth: j ? 1 : 0, locked: false,
  })))
  expectExact(interactionRootBounds(document, document.pages[0].id, entries), referenceRootBounds(document, document.pages[0].id, entries))
  expectExact(interactionRootBounds(document, document.pages[0].id, [...entries].reverse()),
    referenceRootBounds(document, document.pages[0].id, [...entries].reverse()))
})

test('3,000-root bounds retain exact CPU/WASM pixels and avoid quadratic scene visits', () => {
  const document = manyRoots(), pageId = document.pages[0].id, entries = scene(document, pageId)
  const measure = (work: typeof interactionRootBounds) => {
    let reads = 0
    const traced = entries.map(entry => new Proxy(entry, {
      get(target, key, receiver) { if (key === 'id' || key === 'ancestors') reads++; return Reflect.get(target, key, receiver) },
    }))
    const bounds = work(document, pageId, traced)
    return { bounds, reads }
  }
  const before = measure(referenceRootBounds), after = measure(interactionRootBounds)
  expect(before.reads).toBe(18_000_000)
  expect(after.reads).toBe(9000)
  expectExact(after.bounds, before.bounds)

  const options = (bounds: Bounds) => {
    const x = Math.floor(bounds.x), y = Math.floor(bounds.y)
    return JSON.stringify({ pageId, width: Math.ceil(bounds.x + bounds.width) - x, height: Math.ceil(bounds.y + bounds.height) - y,
      view: { x: -x, y: -y, zoom: 1 }, transparent: false, grid: false, rasterProfile: 'analytic' })
  }
  const engine = new VectorEngine()
  let digest = '', bytes = 0
  try {
    engine.load_document(JSON.stringify(document))
    const baseline = engine.render_rgba(options(before.bounds.get('root-0')!))
    const optimized = engine.render_rgba(options(after.bounds.get('root-0')!))
    expect(optimized).toEqual(baseline)
    expect(new Set(baseline).size).toBeGreaterThan(10)
    expect(baseline.length).toBeGreaterThan(100)
    bytes = baseline.length; digest = createHash('sha256').update(baseline).digest('hex')
  } finally { engine.free() }
  if (process.env.DESIGN_INTERACTION_BENCHMARK) {
    const baseline: number[] = [], optimized: number[] = []
    for (let i = 0; i < 15; i++) {
      const run = (work: typeof interactionRootBounds, values: number[]) => {
        const start = performance.now(); const result = work(document, pageId, entries)
        values.push(performance.now() - start); expect(result.size).toBe(3000)
      }
      if (i % 2) { run(interactionRootBounds, optimized); run(referenceRootBounds, baseline) }
      else { run(referenceRootBounds, baseline); run(interactionRootBounds, optimized) }
    }
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
    console.info('INTERACTION_BOUNDS_BENCHMARK ' + JSON.stringify({ nodes: entries.length, baselineReads: before.reads,
      optimizedReads: after.reads, baselineMedianMs: median(baseline), optimizedMedianMs: median(optimized), baseline, optimized,
      cpuWasm: { options: JSON.parse(options(before.bounds.get('root-0')!)), comparedBytes: bytes, sha256: digest, byteDifferences: 0 } }))
  }
// The optional benchmark deliberately repeats the slow baseline 15 times.
}, process.env.DESIGN_INTERACTION_BENCHMARK ? 30_000 : 5_000)

test('full CPU viewport keeps nested masks, clipped roots and offscreen effect support byte-identical', () => {
  const document = manyRoots(), pageId = document.pages[0].id
  document.schemaVersion = 4
  for (const [i, root] of Object.values(document.nodes).entries()) {
    if (i >= 4) { root.transform[4] += 2000; root.transform[5] += 2000; continue }
    root.transform = [1, 0, 0, 1, i % 2 * 180 - 12.25, Math.floor(i / 2) * 168 - 8.375]
    root.width = 96; root.height = 88; root.clip = i !== 1
    if (!i) root.effects = [{ ...effect('background-blur'), radius: 3.25 }]
    const group = node('group', 7.125, 9.25, 70, 60)
    group.transform = [1, .125, -.25, 1.125, 7.125, 9.25]
    const mask = node('ellipse', 2, 3, 57, 49); mask.mask = true; mask.maskType = 'alpha'
    const foreground = node('rectangle', -11, 9, 90, 56)
    foreground.fills = [paint('#32b1f4')]; foreground.strokes = [stroke('#142835', 1.25)]
    foreground.effects = [{ ...effect('shadow'), radius: 2, x: -3.25, y: 1.125, spread: .5 }]
    const hidden = node('rectangle', -4000, -4000, 8000, 8000); hidden.visible = false
    hidden.effects = [{ ...effect('blur'), radius: 500 }]
    root.children = [group.id]; group.children = [mask.id, foreground.id, hidden.id]
    for (const child of [group, mask, foreground, hidden]) document.nodes[child.id] = child
  }
  const entries = scene(document, pageId), baselineBounds = referenceRootBounds(document, pageId, entries)
  const optimizedBounds = interactionRootBounds(document, pageId, entries)
  expectExact(optimizedBounds, baselineBounds)
  const viewport = (bounds: Map<string, Bounds>) => {
    const all = unionBounds([0, 1, 2, 3].map(i => bounds.get(`root-${i}`)!))
    const x = Math.floor(all.x), y = Math.floor(all.y)
    return { pageId, width: Math.ceil(all.x + all.width) - x, height: Math.ceil(all.y + all.height) - y,
      view: { x: -x, y: -y, zoom: 1 }, transparent: false, grid: false, rasterProfile: 'analytic' }
  }
  const before = viewport(baselineBounds), after = viewport(optimizedBounds)
  expect(after).toEqual(before)
  expect(before.width).toBeGreaterThan(256); expect(before.height).toBeGreaterThan(192)
  const engine = new VectorEngine()
  try {
    engine.load_document(JSON.stringify(document))
    const reference = engine.render_rgba(JSON.stringify(before)), result = engine.render_rgba(JSON.stringify(after))
    expect(result).toEqual(reference)
    const colors = new Set<string>()
    for (let i = 0; i < result.length; i += 4) colors.add(`${result[i]},${result[i + 1]},${result[i + 2]},${result[i + 3]}`)
    expect(colors.size).toBeGreaterThan(100)
    // Every viewport quadrant includes distinct authored content. A blank
    // crop or sampling just one root cannot satisfy this equivalence check.
    for (let i = 0; i < 4; i++) {
      const root = document.nodes[`root-${i}`]
      const x = Math.floor(root.transform[4] + 25 + before.view.x), y = Math.floor(root.transform[5] + 25 + before.view.y)
      const at = (y * before.width + x) * 4
      expect([...result.subarray(at, at + 3)]).not.toEqual([245, 245, 245])
    }
    if (process.env.DESIGN_INTERACTION_BENCHMARK)
      console.info('INTERACTION_VIEWPORT_CPU ' + JSON.stringify({ nodes: Object.keys(document.nodes).length, options: before,
        comparedBytes: result.length, colors: colors.size, sha256: createHash('sha256').update(result).digest('hex'), byteDifferences: 0 }))
  } finally { engine.free() }
})
