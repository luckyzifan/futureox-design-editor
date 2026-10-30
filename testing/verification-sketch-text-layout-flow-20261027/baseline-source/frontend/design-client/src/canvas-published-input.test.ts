import { afterEach, expect, test } from 'vitest'
import { presentedPenVertex, remapPointerAnchor } from './canvas-published-input'
import { Editor } from './engine'
import { apply, worldMatrix } from './geometry'
import { blank, defaultLayout, node, type Network } from './model'

const editors: Editor[] = []
afterEach(() => editors.splice(0).forEach(editor => editor.dispose()))
test('pen continuation maps a visible endpoint ID into the current network', () => {
  const shown: Network = { vertices: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 100, y: 0 }], edges: [], fillRule: 'nonzero' }
  const live = structuredClone(shown); live.vertices[1].x = 140
  expect(presentedPenVertex(live, shown, [1, 0, 0, 1, 100, 100], { x: 200, y: 100 }, 1)).toBe(live.vertices[1])
  expect(live.vertices[1].x).toBe(140)
  live.vertices.pop()
  expect(presentedPenVertex(live, shown, [1, 0, 0, 1, 100, 100], { x: 200, y: 100 }, 1)).toBeUndefined()
})
test('pen endpoint tolerance is in screen pixels after the full transform', () => {
  const net: Network = { vertices: [{ id: 'a', x: 2, y: 3 }], edges: [], fillRule: 'nonzero' }
  const matrix = [0, 4, -2, 0, 50, 60] as const
  const world = apply([...matrix], net.vertices[0])
  expect(presentedPenVertex(net, net, [...matrix], { x: world.x + 3, y: world.y }, 2)).toBe(net.vertices[0])
  expect(presentedPenVertex(net, net, [...matrix], { x: world.x + 5, y: world.y }, 2)).toBeUndefined()
})
test('pointer anchors preserve the same local point across translated, rotated and scaled pending transforms', () => {
  const displayed = [0, 2, -2, 0, 20, 30] as const, current = [3, 0, 0, 4, 400, 500] as const
  const pointer = apply([...displayed], { x: 12, y: 7 })
  const mapped = remapPointerAnchor([...displayed], [...current], pointer)
  expect(mapped).toEqual({ x: 436, y: 528 })
})
test('pending parent movement cannot turn a vertical gesture into an auto-layout reorder', () => {
  const doc = blank(), frame = node('frame', 100, 100, 200, 80), a = node('rectangle', 0, 0, 50, 50), b = node('rectangle', 0, 0, 50, 50)
  frame.layout = { ...defaultLayout(), mode: 'horizontal', gap: 10, padding: [0, 0, 0, 0] }
  frame.children = [a.id, b.id]; doc.nodes = { [frame.id]: frame, [a.id]: a, [b.id]: b }; doc.pages[0].children = [frame.id]
  const editor = new Editor(doc); editors.push(editor)
  const shown = worldMatrix(editor.state.doc, b.id), down = apply(shown, { x: 25, y: 25 })
  editor.update([frame.id], { transform: [1, 0, 0, 1, 500, 100] }, 'Move frame')
  const anchor = remapPointerAnchor(shown, worldMatrix(editor.state.doc, b.id), down)
  editor.select([b.id]); editor.begin('Move child')
  expect(editor.previewLayoutOrder(b.id, { x: anchor.x, y: anchor.y + 3 })).toBe(true)
  expect(editor.state.doc.nodes[frame.id].children).toEqual([a.id, b.id])
  editor.previewLayoutOrder(b.id, { x: anchor.x - 70, y: anchor.y })
  expect(editor.state.doc.nodes[frame.id].children).toEqual([b.id, a.id])
  editor.commit(); editor.undo()
  expect(editor.state.doc.nodes[frame.id].children).toEqual([a.id, b.id])
  expect(editor.state.doc.nodes[frame.id].transform[4]).toBe(500)
})
