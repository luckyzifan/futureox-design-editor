/** CPU contracts for the production translation admission. No GPU or WASM. */
import assert from 'node:assert/strict'
import type { DesignDocument, Matrix } from '../../model'
import type { GpuNode, GpuScene } from './types'
import { translatePreviewOffsets, translatePreviewScene } from './translated-scene'
import { TranslationPatchSession } from './translation-patch-session'

type Register = (name: string, body: () => void | Promise<void>) => unknown
const window = { x: 200, y: 200, w: 600, h: 600 }
function fixture(nested = false) {
  const leafMatrix: Matrix = nested ? [0, 32, -32, 0, 640, 640] : [32, 0, 0, 32, 640, 640]
  const leafRect = { x: 620, y: 620, w: 100, h: 100 }
  const leaf: GpuNode = {
    id: 'leaf', matrix: leafMatrix,
    inverse: nested ? [0, -1 / 32, 1 / 32, 0, -20, 20] : [1 / 32, 0, 0, 1 / 32, -20, -20],
    rect: leafRect, size: [2, 2], fill: { rect: leafRect, first: 0, count: 0, rule: 'nonzero',
      area: { first: 0, count: 1 }, opaqueRect: { x: 641, y: 641, w: 60, h: 60 } },
    fills: [], strokes: [], children: [], effects: [], opacity: 1, blend: 'normal', clip: false, mask: false,
  }
  const parent: GpuNode = { ...leaf, id: 'parent', matrix: [0, 32, -32, 0, 800, 320],
    rect: { x: 300, y: 300, w: 600, h: 600 }, children: ['leaf'], clip: true }
  const scene: GpuScene = {
    version: 8, width: 1024, height: 1024, output: { x: 0, y: 0, w: 1024, h: 1024 },
    extent: { x: 0, y: 0, w: 1024, h: 1024 }, view: { x: 0, y: 0, zoom: 32 },
    interactionWindow: window, roots: nested ? ['parent'] : ['leaf'],
    nodes: nested ? { parent, leaf } : { leaf }, vertices: new Float32Array(), curves: new Float32Array(4),
    transparent: false, background: '#ffffff', grid: false,
  }
  const authored = (id: string, transform: Matrix, children: string[] = []) => ({
    id, kind: id === 'parent' ? 'frame' : 'rectangle', transform, children, width: 20, height: 20,
    visible: true, effects: [], clip: id === 'parent', mask: false,
  })
  const document = { id: 'translation-contract', nodes: {
    leaf: authored('leaf', nested ? [1, 0, 0, 1, 10, 5] : [1, 0, 0, 1, 20, 20]),
    ...(nested ? { parent: authored('parent', [0, 1, -1, 0, 25, 10], ['leaf']) } : {}),
  } } as unknown as DesignDocument
  const move = (dx: number, dy = 0) => {
    const old = document.nodes.leaf
    return { ...document, nodes: { ...document.nodes, leaf: { ...old,
      transform: [...old.transform.slice(0, 4), old.transform[4] + dx, old.transform[5] + dy] as Matrix } } }
  }
  return { scene, document, move }
}

export function translationRegressions(test: Register) {
  for (const nested of [false, true]) {
    test(`32x ${nested ? 'rotated nested' : 'root'} movement preserves integer raster phase and rejects subpixel masks`, () => {
      const { scene, document, move } = fixture(nested)
      const snapshot = JSON.stringify(scene.nodes)
      const next = translatePreviewScene(scene, document, move(1 / 32))
      assert.ok(next)
      assert.equal(next.nodes.leaf.fill.area, scene.nodes.leaf.fill.area)
      assert.equal(next.nodes.leaf.previewSource, scene.nodes.leaf)
      assert.equal(next.nodes.leaf.rect.x, scene.nodes.leaf.rect.x + (nested ? 0 : 1))
      assert.equal(next.nodes.leaf.rect.y, scene.nodes.leaf.rect.y + (nested ? 1 : 0))
      assert.ok(next.nodes.leaf.fill.opaqueRect)
      for (const delta of [1 / 128, -1 / 128, 0.7 / 32, 0.0001 / 32])
        assert.equal(translatePreviewScene(scene, document, move(delta)), null)
      assert.equal(JSON.stringify(scene.nodes), snapshot)
    })
    test(`32x ${nested ? 'nested' : 'root'} patch session rejects fractional pose without changing its accepted snapshot`, () => {
      const { scene, document, move } = fixture(nested)
      const session = TranslationPatchSession.create(scene, document, ['leaf'])
      assert.ok(session)
      const nextDocument = move(1 / 32), transforms = { leaf: nextDocument.nodes.leaf.transform }
      const next = session.prepare(scene, transforms, window)
      assert.ok(next)
      session.accept(next, transforms)
      const snapshot = JSON.stringify(next.nodes)
      assert.equal(session.prepare(next, { leaf: move(1.25 / 32).nodes.leaf.transform }, window), null)
      assert.equal(JSON.stringify(next.nodes), snapshot)
      assert.deepEqual(session.snapshot(), nextDocument)
      const again = session.prepare(next, { leaf: move(2 / 32).nodes.leaf.transform }, window)
      assert.ok(again)
      assert.equal(again.nodes.leaf.previewSource, scene.nodes.leaf)
    })
  }
  test('subpixel cached antialiasing differs from freshly evaluated coverage', () => {
    // An edge at x=.25 has [.75, 1] coverage. Shift right .25 pixels:
    // linear sampling of that raster gives [.5625, .9375], whereas a fresh
    // area evaluation at x=.5 is [.5, 1]. The extra ramp distorts thin edges.
    const oldCoverage = [0, .75, 1]
    const cached = [oldCoverage[0] * .25 + oldCoverage[1] * .75,
      oldCoverage[1] * .25 + oldCoverage[2] * .75]
    assert.deepEqual(cached, [.5625, .9375])
    assert.notDeepEqual(cached, [.5, 1])
    const { scene, document, move } = fixture()
    assert.equal(translatePreviewScene(scene, document, move(.25 / 32)), null)
  })
  test('translation batch rejects fractional deltas before mutating reusable node tables', () => {
    const { scene } = fixture(true), targetNodes = { ...scene.nodes }
    const original = JSON.stringify(targetNodes)
    const offsets = new Map<string, [number, number]>([['parent', [1, 0]], ['leaf', [.25, 0]]])
    assert.equal(translatePreviewOffsets(scene, offsets, new Set(), new Set(), targetNodes), null)
    assert.equal(JSON.stringify(targetNodes), original)
    for (const bad of [NaN, Infinity, 2 ** 53])
      assert.equal(translatePreviewOffsets(scene, new Map([['leaf', [bad, 0]]]), new Set(), new Set()), null)
  })
  test('integer delta cannot certify a raster already shifted to a fractional phase', () => {
    const { scene } = fixture()
    const original = scene.nodes.leaf
    scene.nodes.leaf = { ...original, previewSource: original, rect: { ...original.rect, x: original.rect.x + .25 } }
    assert.equal(translatePreviewOffsets(scene, new Map([['leaf', [1, 0]]]), new Set(), new Set()), null)
  })
  test('integer translation keeps stationary clipped backdrop admission and rejects foreground/replay dependencies', () => {
    const { scene, document, move } = fixture(true)
    const parent = document.nodes.parent
    parent.effects = [{ kind: 'background-blur', visible: true }] as typeof parent.effects
    assert.ok(translatePreviewScene(scene, document, move(1 / 32)))
    parent.clip = false
    assert.equal(translatePreviewScene(scene, document, move(1 / 32)), null)
    parent.clip = true
    for (const kind of ['blur', 'glass']) {
      parent.effects = [{ kind, visible: true }] as typeof parent.effects
      assert.equal(translatePreviewScene(scene, document, move(1 / 32)), null)
    }
    parent.effects = []
    for (const field of ['captureReplay', 'textureReplay'] as const) {
      scene.nodes.leaf[field] = {} as never
      assert.equal(translatePreviewScene(scene, document, move(1 / 32)), null)
      delete scene.nodes.leaf[field]
    }
  })
}
