import { expect, test } from 'vitest'
import { blank, node, paint, stroke, effect } from './model'
import { Editor } from './engine'
import { layerTreeRows } from './layer-tree'
import { marqueeScope } from './selection-hierarchy'
import { styleSlots, editStyleSlot, setStyleValue } from './style-stack'
import { supportsEditPreview, movePreviewPlan, movePreviewOffset } from './edit-preview'

test('search retains ancestor context and entered marquee uses the same parent', () => {
  const doc = blank(), frame = node('frame', 0, 0, 500, 400), group = node('group', 10, 20, 100, 100), text = node('text', 0, 0, 20, 20)
  text.name = 'needle'; frame.children = [group.id]; group.children = [text.id]
  doc.nodes = { [frame.id]: frame, [group.id]: group, [text.id]: text }; doc.pages[0].children = [frame.id]
  expect(layerTreeRows(doc, doc.pages[0].id, new Set([frame.id, group.id]), 'needle')).toEqual([
    { id: frame.id, depth: 0, context: true }, { id: group.id, depth: 1, context: true }, { id: text.id, depth: 2, context: false },
  ])
  expect(marqueeScope(doc, doc.pages[0].id, [text.id])).toBe(group.id)
  expect(marqueeScope(doc, doc.pages[0].id, [group.id])).toBe(frame.id)
})

test('single-layer alignment uses rotated parent coordinates and can be undone', () => {
  const doc = blank(), frame = node('frame', 0, 0, 500, 300), child = node('rectangle', 10, 20, 100, 50)
  frame.transform = [0, 1, -1, 0, 500, 0]; frame.children = [child.id]
  doc.nodes = { [frame.id]: frame, [child.id]: child }; doc.pages[0].children = [frame.id]
  const editor = new Editor(doc)
  try {
    editor.select([child.id]); const before = editor.state.doc
    editor.align('x', 'center'); expect(editor.state.doc.nodes[child.id].transform[4]).toBe(200)
    editor.align('y', 'end'); expect(editor.state.doc.nodes[child.id].transform[5]).toBe(250)
    editor.undo(); editor.undo(); expect(editor.state.doc).toEqual(before)
  } finally { editor.dispose() }
})

test('mixed style edits change only represented slots and retain unrelated fields', () => {
  const a = node('rectangle', 0, 0, 10, 10), b = node('rectangle', 20, 0, 10, 10)
  a.strokes = [stroke()]; b.strokes = [stroke(), stroke()]
  a.strokes[0].width = 2; b.strokes[0].width = 8
  const unchanged = structuredClone(b.strokes[1]), slot = styleSlots([a, b], 'strokes')[0]
  for (const n of [a, b]) editStyleSlot(n, 'strokes', slot, s => setStyleValue(s, 'width', 4))
  expect([a.strokes[0].width, b.strokes[0].width]).toEqual([4, 4])
  expect(b.strokes[1]).toEqual(unchanged)
  a.fills = [paint('#ff0000')]; b.fills = [paint('#00ff00', 'linear')]
  const solid = styleSlots([a, b], 'fills').find(s => s.kind === 'solid')!
  editStyleSlot(b, 'fills', solid, p => setStyleValue(p, 'color', '#000000'))
  expect(b.fills[0].color).toBe('#00ff00')
})

test('unsupported optics never masquerade as an exact interactive preview', () => {
  const doc = blank(), shape = node('rectangle', 0, 0, 20, 20)
  doc.nodes[shape.id] = shape; doc.pages[0].children = [shape.id]
  expect(supportsEditPreview(doc)).toBe(true)
  shape.effects = [effect('glass')]; expect(supportsEditPreview(doc)).toBe(false)
})

test('independent drag layers require topmost order and preserve backdrop/clip dependencies', () => {
  const doc = blank(), frame = node('frame', 10, 20, 500, 300), lower = node('rectangle', 0, 0, 40, 40), upper = node('rectangle', 80, 0, 40, 40)
  frame.clip = false; frame.children = [lower.id, upper.id]
  doc.nodes = { [frame.id]: frame, [lower.id]: lower, [upper.id]: upper }; doc.pages[0].children = [frame.id]
  expect(movePreviewPlan(doc, doc.pages[0].id, [lower.id])).toBeNull()
  const plan = movePreviewPlan(doc, doc.pages[0].id, [upper.id])!
  expect(plan.background.nodes[upper.id].visible).toBe(false)
  expect(doc.nodes[upper.id].visible).toBe(true)
  const next = { ...doc, nodes: { ...doc.nodes, [upper.id]: { ...upper, transform: [1,0,0,1,90,15] as typeof upper.transform } } }
  expect(movePreviewOffset(plan, next)).toEqual({ x: 10, y: 15 })
  expect(movePreviewOffset(plan, { ...next, nodes: { ...next.nodes, [lower.id]: { ...lower, opacity: .5 } } })).toBeNull()
  frame.clip = true; expect(movePreviewPlan(doc, doc.pages[0].id, [upper.id])).toBeNull()
  frame.clip = false; lower.mask = true; expect(movePreviewPlan(doc, doc.pages[0].id, [upper.id])).toBeNull()
  lower.mask = false; upper.effects = [effect('background-blur')]
  expect(movePreviewPlan(doc, doc.pages[0].id, [upper.id])).toBeNull()
})
