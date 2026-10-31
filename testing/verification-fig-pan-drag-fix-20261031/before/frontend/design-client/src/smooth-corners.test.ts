import { expect, test } from 'vitest'
import { VectorEngine } from './generated/design-kernel/design_kernel'
import { blank, node, type DesignNode } from './model'
import { cornerPoint, cubicCircleReference } from './cubic-corner-reference'
import { kernelHitWorld } from './kernel/picking'

function fixture(n: DesignNode) {
  const doc = blank()
  doc.nodes[n.id] = n
  doc.pages[0].children = [n.id]
  return doc
}
function render(n: DesignNode, zoom = 1, x = 0, y = 0, profile = 'analytic') {
  const doc = fixture(n),
    engine = new VectorEngine()
  try {
    engine.load_document(JSON.stringify(doc))
    const pixels = engine.render_rgba(
      JSON.stringify({
        pageId: doc.pages[0].id,
        width: 64,
        height: 64,
        transparent: true,
        view: { zoom, x, y },
        rasterProfile: profile,
      }),
    )
    return { pixels, segments: JSON.parse(engine.stats()).pathSegments }
  } finally {
    engine.free()
  }
}
function shape(radius: number) {
  const n = node('rectangle', 0, 0, radius * 2, radius * 2)
  n.radii = [radius, radius, radius, radius]
  n.smoothing = 1
  return n
}
function reference(radius: number) {
  return cubicCircleReference(shape(radius), radius)
}
function interior(radius: number) {
  return cornerPoint(radius).offset(-1.5 / 32)
}
test('real WASM high zoom smooth corner agrees with independent cubic reference interior', () => {
  const radius = 2000,
    p = interior(radius),
    x = 31.5 - p.x * 32,
    y = 31.5 - p.y * 32
  for (const profile of ['analytic', 'figma', 'figmaSubpixel']) {
    const actual = render(shape(radius), 32, x, y, profile),
      expected = render(reference(radius), 32, x, y, profile)
    expect(expected.pixels[(31 * 64 + 31) * 4 + 3]).toBe(255)
    expect(actual.pixels[(31 * 64 + 31) * 4 + 3]).toBe(255)
    expect(actual.pixels, profile).toEqual(expected.pixels)
  }
})
test('real WASM smooth corner refines with zoom and rerenders equivalent device geometry', () => {
  const n = shape(1),
    low = render(n),
    high = render(n, 32)
  expect(high.segments).toBeGreaterThan(low.segments)
  expect(high.pixels).toEqual(render(shape(32)).pixels)
})
test('smooth corner high zoom picking agrees with analytic interior', () => {
  const n = shape(2000),
    p = interior(2000)
  expect(kernelHitWorld(n, p, n.transform, 32)).toBe(true)
})

test('tiny local smooth shape and power-of-two zoom equivalents keep identical CPU pixels', () => {
  const expected = render(shape(32)).pixels
  for (const zoom of [0.125, 1, 32]) expect(render(shape(32 / zoom), zoom).pixels).toEqual(expected)
  const tiny = shape(0.000001)
  tiny.transform = [1000000, 0, 0, 1000000, 0, 0]
  expect(render(tiny, 32).pixels).toEqual(expected)
})

test('smooth CPU curve agrees with independent reference after reflection shear and large-origin cancellation', () => {
  const p = interior(2000)
  for (const matrix of [
    [-1, 0.25, 0.75, 1, 9999999.125, -9999999.125],
    [1, 0.125, 0.5, 1, -9999999.125, 9999999.125],
  ] as const) {
    const actualShape = shape(2000),
      referenceShape = reference(2000)
    actualShape.transform = [...matrix]
    referenceShape.transform = [...matrix]
    const at = {
      x: matrix[0] * p.x + matrix[2] * p.y + matrix[4],
      y: matrix[1] * p.x + matrix[3] * p.y + matrix[5],
    }
    const actual = render(actualShape, 32, 31.5 - at.x * 32, 31.5 - at.y * 32).pixels
    const expected = render(referenceShape, 32, 31.5 - at.x * 32, 31.5 - at.y * 32).pixels
    expect(actual).toEqual(expected)
    expect(kernelHitWorld(actualShape, at, actualShape.transform, 32)).toBe(true)
  }
})
