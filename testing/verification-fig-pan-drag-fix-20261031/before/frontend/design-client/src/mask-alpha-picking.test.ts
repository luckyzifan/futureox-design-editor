import { expect, test } from 'vitest'
import { VectorEngine } from './generated/design-kernel/design_kernel'
import { Editor } from './engine'
import { apply, SpatialIndex } from './geometry'
import { kernelFillWorld } from './kernel/picking'
import { isEmptyLeafAlphaMask } from './mask-coverage'
import { emptySystem } from './design-system'
import { insertInstance, stampKeys } from './components'
import { originNode } from './component-fixtures'
import {
  blank,
  node,
  paint,
  stroke,
  effect,
  type DesignDocument,
  type DesignNode,
  type Matrix,
} from './model'

const center = { x: 32, y: 32 }
function fixture(opacity = 0) {
  const doc = blank(),
    group = node('group', 0, 0, 64, 64),
    mask = node('rectangle', 0, 0, 64, 64),
    child = node('rectangle', 0, 0, 64, 64)
  mask.mask = true
  mask.locked = true
  mask.fills = [{ ...paint('#ffffff'), opacity }]
  child.fills = [paint('#ff0000')]
  group.children = [mask.id, child.id]
  for (const n of [group, mask, child]) doc.nodes[n.id] = n
  doc.pages[0].children = [group.id]
  return { doc, group, mask, child }
}
function alphaAt(doc: DesignDocument, p = center, profile = 'analytic', zoom = 1) {
  const core = new VectorEngine()
  try {
    core.load_document(JSON.stringify(doc))
    return core.render_rgba(
      JSON.stringify({
        pageId: doc.pages[0].id,
        width: 8,
        height: 8,
        transparent: true,
        rasterProfile: profile,
        view: { x: 4.5 - p.x * zoom, y: 4.5 - p.y * zoom, zoom },
      }),
    )[(4 * 8 + 4) * 4 + 3]
  } finally {
    core.free()
  }
}

test('zero solid paint alpha masks exclude opaque children in all CPU profiles', () => {
  for (const profile of ['analytic', 'figma', 'figmaSubpixel']) {
    for (const opacity of [0, 0.5, 1]) {
      const { doc, mask, child } = fixture(opacity)
      expect(alphaAt(doc, center, profile)).toBe(Math.round(opacity * 255))
      expect(new Editor(doc).hit(center, true)).toBe(opacity === 0 ? null : child.id)
      expect(kernelFillWorld(mask, center, mask.transform, 1)).toBe(true)
    }
  }
})

test('empty or explicitly hidden solid fills are empty; positive paint alpha is never thresholded', () => {
  for (const fills of [
    [],
    [{ ...paint(), visible: false }],
    Array.from({ length: 16 }, () => ({ ...paint(), opacity: 0 })),
  ]) {
    const { doc, mask } = fixture()
    mask.fills = fills
    expect(alphaAt(doc)).toBe(0)
    expect(new Editor(doc).hit(center, true)).toBe(null)
  }
  for (const opacity of [Number.MIN_VALUE, 1e-9, 0.5, 1]) {
    const { doc, mask, child } = fixture()
    mask.fills.push({ ...paint(), opacity })
    expect(new Editor(doc).hit(center, true)).toBe(child.id)
  }
})

test('ordinary transparent object selection and paint-free ancestor clips retain their contracts', () => {
  const { doc, group, mask, child } = fixture()
  mask.mask = false
  child.fills[0].opacity = 0
  expect(alphaAt(doc)).toBe(0)
  expect(new Editor(doc).hit(center, true)).toBe(child.id)
  group.kind = 'frame'
  group.clip = true
  group.fills = []
  expect(new Editor(doc).hit(center, true)).toBe(child.id)
  expect(new Editor(doc).hit({ x: 65, y: 32 }, true)).toBe(null)
})

test('the proof rejects only supported alpha leaf shapes and uses explicit paint visibility', () => {
  const { mask } = fixture()
  expect(isEmptyLeafAlphaMask(mask)).toBe(true)
  for (const maskType of ['alpha', undefined] as const)
    expect(isEmptyLeafAlphaMask({ ...mask, maskType })).toBe(true)
  for (const maskType of ['luminance', 'vector', 'future-mode', null])
    expect(isEmptyLeafAlphaMask({ ...mask, maskType } as DesignNode)).toBe(false)
  for (const kind of ['group', 'text', 'future-shape'])
    expect(isEmptyLeafAlphaMask({ ...mask, kind } as DesignNode)).toBe(false)
  for (const kind of ['linear', 'radial', 'angular', 'diamond', 'image', 'future-paint'])
    expect(
      isEmptyLeafAlphaMask({ ...mask, fills: [{ ...mask.fills[0], kind }] } as DesignNode),
    ).toBe(false)
  for (const patch of [
    { mask: false },
    { blend: 'multiply' },
    { blend: 'pass-through' },
    { children: ['descendant'] },
    { strokes: [stroke()] },
    { effects: [effect('blur')] },
    { fills: [{ ...mask.fills[0], blend: 'multiply' }] },
  ])
    expect(isEmptyLeafAlphaMask({ ...mask, ...patch } as DesignNode)).toBe(false)
  const fill = { ...paint(), visible: undefined }
  expect(isEmptyLeafAlphaMask({ ...mask, fills: [fill] } as unknown as DesignNode)).toBe(false)
  const { doc, mask: opaqueMask, child } = fixture(1)
  delete (opaqueMask.fills[0] as Partial<DesignNode['fills'][number]>).visible
  expect(alphaAt(doc)).toBe(255)
  expect(new Editor(doc).hit(center, true)).toBe(child.id)
})

test('unsupported mask sources keep the existing fallback and a mask subtree can still reveal content', () => {
  for (const patch of [
    { kind: 'group' },
    { kind: 'text' },
    { effects: [effect('blur')] },
    { strokes: [stroke()] },
    { fills: [{ ...paint(), kind: 'image', opacity: 0 }] },
    { maskType: 'luminance' },
  ]) {
    const { doc, mask, child } = fixture()
    Object.assign(mask, patch)
    if (mask.maskType) doc.schemaVersion = 4
    expect(new Editor(doc).hit(center, true)).toBe(child.id)
  }
  const { doc, mask, child } = fixture()
  const source = node('rectangle', 0, 0, 64, 64)
  mask.kind = 'frame'
  mask.children = [source.id]
  doc.nodes[source.id] = source
  expect(alphaAt(doc)).toBe(255)
  expect(new Editor(doc).hit(center, true)).toBe(child.id)
})

test('opacity, paint, mask mode and mask eligibility edits refresh without retained query state', () => {
  const { doc, mask, child } = fixture(1),
    editor = new Editor(doc)
  editor.update([mask.id], { locked: false }, '切换锁定')
  const hit = (expected: string | null) => {
    expect(editor.hit(center, true)).toBe(expected)
    const index = new SpatialIndex(editor.entries())
    expect(editor.hit(center, true, index)).toBe(expected)
  }
  hit(child.id)
  editor.update([mask.id], (n) => {
    n.fills[0].opacity = 0
  })
  hit(null)
  editor.undo()
  hit(child.id)
  editor.redo()
  hit(null)
  editor.update([mask.id], { maskType: 'luminance' })
  hit(child.id)
  editor.update([mask.id], { maskType: 'alpha' })
  hit(null)
  editor.update([mask.id], { fills: [{ ...paint(), kind: 'linear', opacity: 0 }] })
  hit(child.id)
  editor.update([mask.id], { fills: [{ ...paint(), opacity: 0 }] })
  hit(null)
  editor.update([mask.id], { mask: false })
  hit(child.id)
  editor.update([mask.id], { mask: true })
  hit(null)
  editor.update([mask.id], { visible: false }, '切换可见性')
  hit(child.id)
  editor.undo()
  hit(null)
  editor.begin('preview alpha')
  editor.preview({ [mask.id]: { fills: [paint()] } })
  hit(child.id)
  editor.cancel()
  hit(null)
  editor.update([mask.id], { fills: [paint()], opacity: 0 })
  hit(null)
  editor.undo()
  hit(null)
})

test('exact empty-mask rejection is independent of affine transform, pointer and zoom', () => {
  const transforms: Matrix[] = [
    [1, 0, 0, 1, 0.125, -0.375],
    [-1, 0, 0, 1, 100.125, 0.375],
    [1, 0.25, 0.75, 1, 9999999.125, -9999999.125],
  ]
  for (const transform of transforms) {
    const { doc, group, mask, child } = fixture()
    group.transform = transform
    const editor = new Editor(doc)
    for (const zoom of [0.025, 0.25, 1, 32, 1]) {
      editor.set({ view: { x: 0.125, y: -0.375, zoom } })
      for (const local of [center, { x: 8, y: 8 }]) {
        const p = apply(transform, local)
        expect(alphaAt(editor.state.doc, p, 'analytic', zoom)).toBe(0)
        expect(editor.hit(p, true)).toBe(null)
      }
    }
    editor.preview({ [mask.id]: { fills: [paint()] } })
    expect(editor.hit(apply(transform, center), true)).toBe(child.id)
  }
})

test('variable and shared style overrides use resolved fills like the CPU renderer', () => {
  for (const mode of ['binding', 'style'] as const) {
    const { doc, mask, child } = fixture()
    doc.schemaVersion = 4
    const system = emptySystem()
    doc.designSystem = system
    if (mode === 'binding') {
      system.collections.c = { name: 'Opacity', modes: ['shown', 'hidden'], defaultMode: 'shown' }
      system.variables.a = {
        name: 'Alpha',
        collection: 'c',
        kind: 'number',
        values: { shown: 1, hidden: 0 },
      }
      mask.bindings = { 'fills.0.opacity': 'a' }
    } else {
      system.styles.s = { name: 'Shown', kind: 'paint', value: [paint()] }
      mask.styleRefs = { fills: 's' }
    }
    expect(mask.fills[0].opacity).toBe(0)
    expect(alphaAt(doc)).toBe(255)
    const editor = new Editor(doc)
    expect(editor.state.doc.nodes[mask.id].fills[0].opacity).toBe(1)
    expect(editor.hit(center, true)).toBe(child.id)
    editor.change('Hide through resolved source', (d) => {
      const system = d.designSystem
      if (!system) throw new Error('Missing fixture design system')
      if (mode === 'binding') system.activeModes.c = 'hidden'
      else system.styles.s.value = [{ ...paint(), opacity: 0 }]
    })
    expect(editor.state.doc.nodes[mask.id].fills[0].opacity).toBe(0)
    expect(alphaAt(editor.state.doc)).toBe(0)
    expect(editor.hit(center, true)).toBe(null)
    editor.undo()
    expect(alphaAt(editor.state.doc)).toBe(255)
    expect(editor.hit(center, true)).toBe(child.id)
  }
})

test('component instance paint overrides are resolved before the empty-mask proof', () => {
  const { doc, group, mask, child } = fixture()
  group.component = { variants: {}, properties: {} }
  stampKeys(doc, group.id)
  const maskKey = mask.componentKey,
    childKey = child.componentKey
  if (!maskKey || !childKey) throw new Error('Missing fixture component key')
  const instance = insertInstance(doc, group.id, doc.pages[0].id, { x: 128, y: 0 })
  const editor = new Editor(doc)
  const instanceMask = originNode(editor.state.doc, instance, maskKey),
    instanceChild = originNode(editor.state.doc, instance, childKey)
  const p = { x: 160, y: 32 }
  expect(alphaAt(editor.state.doc, p)).toBe(0)
  expect(editor.hit(p, true)).toBe(null)
  editor.update([instanceMask.id], { locked: false }, '切换锁定')
  editor.update([instanceMask.id], { fills: [paint()] })
  expect(editor.state.doc.nodes[mask.id].fills[0].opacity).toBe(0)
  expect(editor.state.doc.nodes[instanceMask.id].fills[0].opacity).toBe(1)
  expect(alphaAt(editor.state.doc, p)).toBe(255)
  expect(editor.hit(p, true)).toBe(instanceChild.id)
  editor.undo()
  expect(alphaAt(editor.state.doc, p)).toBe(0)
  expect(editor.hit(p, true)).toBe(null)
  editor.redo()
  expect(editor.hit(p, true)).toBe(instanceChild.id)
})

test('an empty first-visible mask constrains children instead of falling through to the next mask', () => {
  const { doc, group, mask, child } = fixture()
  const nextMask = node('rectangle', 0, 0, 64, 64)
  nextMask.mask = nextMask.locked = true
  doc.nodes[nextMask.id] = nextMask
  group.children = [mask.id, nextMask.id, child.id]
  const editor = new Editor(doc)
  expect(alphaAt(editor.state.doc)).toBe(0)
  expect(editor.hit(center, true)).toBe(null)
  editor.update([mask.id], { visible: false }, '切换可见性')
  expect(alphaAt(editor.state.doc)).toBe(255)
  expect(editor.hit(center, true)).toBe(child.id)
  editor.undo()
  expect(editor.hit(center, true)).toBe(null)
})
