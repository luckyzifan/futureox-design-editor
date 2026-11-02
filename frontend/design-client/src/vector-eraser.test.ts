import { expect, test } from 'vitest'
import { blank, node, paint } from './model'
import { pointInContours } from './geometry'
import { applyEraserEdits, eraseStrokeNetwork, planVectorEraser } from './vector-eraser'
import type { Network } from './model'

test('a brush across an open stroke removes only the covered span and keeps both ends', () => {
  const network: Network = {
    fillRule: 'evenodd',
    vertices: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 100, y: 0 }],
    edges: [{ id: 'ab', from: 'a', to: 'b' }],
  }
  const cut = eraseStrokeNetwork(network, [{ c: { x: 50, y: 0 }, r: 10 }])
  expect(cut).not.toBe('unchanged')
  expect(cut).not.toBeNull()
  if (cut === 'unchanged' || !cut) return
  expect(cut.edges).toHaveLength(2)
  const points = cut.vertices.map(vertex => ({ x: vertex.x, y: vertex.y }))
  expect(points).toContainEqual({ x: 0, y: 0 })
  expect(points).toContainEqual({ x: 100, y: 0 })
  const xs = points.map(point => point.x).sort((a, b) => a - b)
  expect(xs[1]).toBeGreaterThan(39)
  expect(xs[1]).toBeLessThan(42)
  expect(xs[2]).toBeGreaterThan(58)
  expect(xs[2]).toBeLessThan(61)
})

test('covering a whole stroke deletes it, and a miss leaves the network untouched', () => {
  const network: Network = {
    fillRule: 'evenodd',
    vertices: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 8, y: 0 }],
    edges: [{ id: 'ab', from: 'a', to: 'b' }],
  }
  expect(eraseStrokeNetwork(network, [{ c: { x: 4, y: 0 }, r: 12 }])).toBeNull()
  expect(eraseStrokeNetwork(network, [{ c: { x: 80, y: 80 }, r: 4 }])).toBe('unchanged')
})

test('a filled rectangle loses a hole under the brush and stays one layer', () => {
  const doc = blank('eraser')
  const shape = node('rectangle', 0, 0, 160, 120)
  shape.fills = [paint('#ff0000')]
  doc.nodes[shape.id] = shape
  doc.pages[0].children = [shape.id]
  const plan = planVectorEraser(doc, doc.pages[0].id, [{ x: 40, y: 40 }], 12)
  expect(plan.rejected).toBe(0)
  expect(plan.edits).toHaveLength(1)
  expect(plan.edits[0].kind).toBe('update')
  if (plan.edits[0].kind !== 'update') return
  const network = plan.edits[0].node.network!
  expect(plan.edits[0].node.kind).toBe('vector')
  expect(plan.edits[0].node.fills[0].color).toBe('#ff0000')
  expect(network.vertices.length).toBeGreaterThan(4)
  const contours = walks(network)
  expect(contours.length).toBeGreaterThan(1)
  expect(pointInContours({ x: 40, y: 40 }, contours, 'evenodd')).toBe(false)
  expect(pointInContours({ x: 10, y: 10 }, contours, 'evenodd')).toBe(true)
  applyEraserEdits(doc, plan.edits)
  expect(doc.nodes[shape.id].kind).toBe('vector')
})

test('locked geometry is rejected and a stroked line is cut in document space', () => {
  const doc = blank('eraser')
  const line = node('line', 10, 10, 100, 100)
  line.fills = []
  const locked = node('line', 200, 10, 40, 0)
  locked.fills = []
  locked.locked = true
  doc.nodes[line.id] = line
  doc.nodes[locked.id] = locked
  doc.pages[0].children = [line.id, locked.id]
  const plan = planVectorEraser(doc, doc.pages[0].id, [{ x: 40, y: 40 }, { x: 220, y: 10 }], 12)
  expect(plan.rejected).toBe(1)
  expect(plan.edits.map(edit => edit.id)).toEqual([line.id])
  expect(plan.edits[0].kind).toBe('update')
})

function walks(network: Network) {
  const vertices = new Map(network.vertices.map(vertex => [vertex.id, vertex]))
  const used = new Set<string>()
  const contours: { x: number; y: number }[][] = []
  for (const start of network.edges) {
    if (used.has(start.id)) continue
    const points = []
    let edge = start
    let guard = 0
    while (edge && !used.has(edge.id) && guard++ < network.edges.length + 1) {
      used.add(edge.id)
      const from = vertices.get(edge.from)
      if (from) points.push({ x: from.x, y: from.y })
      edge = network.edges.find(item => item.from === edge.to && !used.has(item.id))!
    }
    if (points.length >= 3) contours.push(points)
  }
  return contours
}
