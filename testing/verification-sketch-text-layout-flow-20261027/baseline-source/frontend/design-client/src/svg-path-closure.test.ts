import { expect, test } from 'vitest'
import { pathNetwork } from './import-svg'
import { node } from './model'
import { kernelSvgPaths } from './kernel/picking'

test('SVG horizontal/vertical lines retain a topologically closed fill contour', () => {
  const n = node('vector', 0, 0, 10, 10)
  n.network = pathNetwork('M0 0 H10 V10 H0 Z')
  expect(n.network.vertices).toHaveLength(4)
  expect(n.network.edges).toHaveLength(4)
  expect(n.network.edges.at(-1)?.to).toBe(n.network.vertices[0].id)
  expect(kernelSvgPaths(n)?.fill).toContain('Z')
})
test('SVG relative compound paths retain independent closure and winding', () => {
  const n = node('vector', 0, 0, 20, 20)
  n.network = pathNetwork('M0 0 h20 v20 h-20 z M5 5 v10 h10 v-10 z')
  const paths = kernelSvgPaths(n)!
  expect(paths.fill.match(/Z/g)).toHaveLength(2)
  expect(n.network.fillRule).toBe('nonzero')
  expect(n.network.vertices).toHaveLength(8)
  expect(n.network.edges).toHaveLength(8)
})
