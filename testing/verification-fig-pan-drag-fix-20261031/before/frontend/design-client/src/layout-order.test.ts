import { expect, test } from 'vitest'
import { node } from './model'
import { wrappedInsertion } from './layout-order'
function rows(vertical = false) {
  const values = [
    [118, 16],
    [16, 58],
    [118, 58],
    [16, 100],
  ].map(([x, y]) =>
    node('rectangle', vertical ? y : x, vertical ? x : y, vertical ? 30 : 90, vertical ? 90 : 30),
  )
  return { nodes: Object.fromEntries(values.map((n) => [n.id, n])), flow: values.map((n) => n.id) }
}
test('wrapped drag near the last row does not jump to the first row', () => {
  const { nodes, flow } = rows()
  expect(wrappedInsertion(nodes, flow, { x: 100, y: 135 }, 0)).toBeUndefined()
  expect(wrappedInsertion(nodes, flow, { x: 40, y: 111 }, 0)).toBe(flow[3])
})
test('vertical wrap orders by column before row', () => {
  const { nodes, flow } = rows(true)
  expect(wrappedInsertion(nodes, flow, { x: 135, y: 100 }, 1)).toBeUndefined()
  expect(wrappedInsertion(nodes, flow, { x: 111, y: 40 }, 1)).toBe(flow[3])
})
