import { expect, test } from 'vitest'
import { VectorEngine } from './generated/design-kernel/design_kernel'

type Json = Record<string, unknown>
function document(id: string, nodes: Json) {
  return {
    schemaVersion: 4,
    id: 'd',
    name: 'Composed inverse',
    pages: [{ id: 'p', name: 'p', background: '#ffffff', children: [id] }],
    nodes,
  }
}
function pair(scale: number, orientation: number[], kind: string) {
  const paint = {
    kind,
    color: '#224466',
    angle: 37,
    stops: [
      { offset: 0, color: '#ff0000' },
      { offset: 1, color: '#0000ff' },
    ],
  }
  const nested = document('g', {
    g: {
      id: 'g',
      kind: 'group',
      width: 1,
      height: 1,
      children: ['n'],
      transform: [scale, 0, 0, scale, 0, 0],
    },
    n: {
      id: 'n',
      kind: 'rectangle',
      width: 10000000,
      height: 10000000,
      transform: [...orientation.map((x) => x * scale), 0, 0],
      fills: [paint],
    },
  })
  // Independent geometry: absorb scalar size into dimensions, keeping only
  // orientation. No production inverse/layout determines the expected result.
  const side = 10000000 * scale * scale
  const direct = document('r', {
    r: {
      id: 'r',
      kind: 'rectangle',
      width: side,
      height: side,
      transform: [...orientation, 0, 0],
      fills: [paint],
    },
  })
  return { nested, direct }
}
function render(document: Json, zoom: number, profile: string) {
  const engine = new VectorEngine()
  try {
    engine.load_document(JSON.stringify(document))
    return engine.render_rgba(
      JSON.stringify({
        pageId: 'p',
        width: 64,
        height: 64,
        view: { x: 24.25, y: 20.5, zoom },
        transparent: true,
        rasterProfile: profile,
      }),
    )
  } finally {
    engine.free()
  }
}

test('real CPU WASM nested scales, reflection and shear match independent geometry at repeated zoom', () => {
  for (const scale of [0.01, 0.001, 0.0005])
    for (const orientation of [
      [1, 0, 0, 1],
      [-1, 0, 0, 1],
      [1.5, 0.25, 0.5, 1.1],
    ])
      for (const kind of ['solid', 'linear']) {
        const { nested, direct } = pair(scale, orientation, kind)
        for (const zoom of [0.25, 1, 1.375, 4, 0.25])
          for (const profile of ['analytic', 'figma']) {
            const expected = render(direct, zoom, profile)
            expect(expected.some((v, i) => i % 4 === 3 && v > 0)).toBe(true)
            const actual = render(nested, zoom, profile)
            expect(actual.every((v, i) => Math.abs(v - expected[i]) <= 1)).toBe(true)
          }
      }
})

test('CPU procedural effects use bounded inverse in scalar and managed sample planes', () => {
  for (const kind of ['noise', 'texture'])
    for (const managed of [false, true]) {
      const { nested } = pair(0.0005, [1, 0, 0, 1], 'solid')
      ;(nested.nodes.n as Json).effects = [{ kind, amount: 0.25, opacity: 0.5, color: '#000000' }]
      const d = managed
        ? {
            ...nested,
            colorManagement: {
              documentSpace: 'srgb',
              referenceWhiteNits: 203,
              peakLuminanceNits: 1000,
            },
          }
        : nested
      const actual = render(d, 0.25, managed ? 'figmaSubpixel' : 'analytic')
      expect(actual.some((v, i) => i % 4 === 3 && v > 0)).toBe(true)
    }
})

test('real WASM retains authored transform rejection and composed precision budget', () => {
  for (const transform of [
    [1e-7, 0, 0, 1e-7, 0, 0],
    [1, 1, 1, 1, 0, 0],
    [1e7 + 1, 0, 0, 1, 0, 0],
  ]) {
    const { nested } = pair(0.001, [1, 0, 0, 1], 'solid')
    ;(nested.nodes.n as Json).transform = transform
    expect(() => render(nested, 1, 'analytic')).toThrow(/Invalid scene node/)
  }
  const { nested } = pair(0.001, [1, 0, 0, 1], 'solid')
  for (const id of ['g', 'n']) (nested.nodes[id] as Json).transform = [1e7, 0, 0, 1e7, 0, 0]
  expect(() => render(nested, 1, 'analytic')).toThrow(/Composed transform exceeds precision budget/)
})

test('CPU inverse sampling window follows camera cancellation and nonzero tiles', () => {
  for (const origin of [-1e7, 1e7]) {
    const { nested, direct } = pair(0.001, [1.5, 0.25, 0.5, 1.1], 'linear')
    for (const n of [nested.nodes.g, direct.nodes.r] as Json[]) {
      const transform = n.transform as number[]
      transform[4] = origin
      transform[5] = -origin
    }
    for (const profile of ['analytic', 'figma']) {
      const options = JSON.stringify({
        pageId: 'p',
        width: 600,
        height: 64,
        view: { x: 510.25 - origin * 0.25, y: 20.5 + origin * 0.25, zoom: 0.25 },
        transparent: true,
        rasterProfile: profile,
      })
      const pixels = [direct, nested].map((d) => {
        const engine = new VectorEngine()
        try {
          engine.load_document(JSON.stringify(d))
          return engine.render_rgba(options)
        } finally {
          engine.free()
        }
      })
      expect(pixels[0].some((v, i) => i % 4 === 3 && v > 0)).toBe(true)
      expect(pixels[1].every((v, i) => Math.abs(v - pixels[0][i]) <= 1)).toBe(true)
    }
  }
})
