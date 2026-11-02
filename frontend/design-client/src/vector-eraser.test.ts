import { expect, test } from 'vitest'
import { node, paint } from './model'
import { contours, pointInContours } from './geometry'
import { cutNetwork, eraseNodeGeometry } from './vector-eraser'

test('a stroke eraser opens a straight line and leaves both stubs on one network', () => {
  const line = node('line', 0, 0, 100, 0)
  line.fills = []
  const cut = eraseNodeGeometry(line, [{ x: 50, y: 0 }], 8)
  expect(cut?.changed).toBe(true)
  expect(cut!.network.edges.length).toBeGreaterThan(1)
  expect(cut!.network.vertices.some(vertex => Math.hypot(vertex.x - 50, vertex.y) < 8)).toBe(false)
  const miss = eraseNodeGeometry(line, [{ x: 50, y: 40 }], 4)
  expect(miss?.changed).toBe(false)
})

test('covering the whole stroke removes every edge without inventing a second layer', () => {
  const cut = cutNetwork({ vertices: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 80, y: 0 }], edges: [{ id: 'e', from: 'a', to: 'b' }], fillRule: 'evenodd' }, [{ x: 0, y: 0 }, { x: 80, y: 0 }], 6)
  expect(cut.changed).toBe(true)
  expect(cut.network.edges).toEqual([])
})

test('a filled shape loses the brushed interior and keeps the outer fill', () => {
  const shape = node('rectangle', 0, 0, 160, 120)
  shape.fills = [paint('#ff0000')]
  const cut = eraseNodeGeometry(shape, [{ x: 40, y: 40 }], 12)
  expect(cut?.changed).toBe(true)
  expect(cut!.network.edges.length).toBeGreaterThan(4)
  const host = { ...shape, kind: 'vector' as const, network: cut!.network }
  expect(pointInContours({ x: 40, y: 40 }, contours(host))).toBe(false)
  expect(pointInContours({ x: 8, y: 8 }, contours(host))).toBe(true)
})
