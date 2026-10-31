import { createHash } from 'node:crypto'
import { expect, test } from 'vitest'
import { VectorEngine, hit_test_device_json } from './generated/design-kernel/design_kernel'
import { opaqueStrokeOracle } from './sample-count-oracle'
const paint = { kind: 'solid', color: '#223344' }
function shape(cap: string, join: string, profile: boolean, dash: boolean) {
  const vertices = [
    { id: 'a', x: 0, y: 24 },
    { id: 'b', x: 10, y: 4 },
    { id: 'c', x: 22, y: 24 },
    { id: 'd', x: 38, y: 6 },
  ]
  const edges = vertices
    .slice(0, profile ? 4 : 3)
    .map((v, i) => ({ id: 'e' + i, from: v.id, to: vertices[(i + 1) % 4].id }))
  return {
    id: 'n',
    kind: 'rectangle',
    width: 40,
    height: 28,
    transform: [1, 0, 0.25, 1, 0, 0],
    network: { vertices, edges, fillRule: 'evenodd' },
    strokes: [
      {
        width: 2.75,
        cap,
        join,
        align: ['center', 'inside', 'outside'][['butt', 'square', 'round'].indexOf(cap)],
        paint,
        dash: dash ? '6 2 0 3' : '',
        dashOffset: dash ? -2.75 : 0,
        widthProfile: profile
          ? [
              { position: 0, left: 0.5, right: 1 },
              { position: 0.4, left: 1.5, right: 0.5 },
              { position: 1, left: 0.5, right: 1 },
            ]
          : [],
      },
    ],
  }
}
function document(n: ReturnType<typeof shape>, parent = 1) {
  return {
    schemaVersion: 1,
    id: 'd',
    name: 'stroke precision',
    pages: [{ id: 'p', name: 'p', background: '#ffffff', children: ['g'] }],
    nodes: {
      g: {
        id: 'g',
        kind: 'group',
        width: 1,
        height: 1,
        transform: [parent, 0, 0, parent, 0, 0],
        children: ['n'],
      },
      n,
    },
  }
}
function options(profile: string) {
  return {
    pageId: 'p',
    width: 64,
    height: 64,
    view: { x: 8, y: 8, zoom: 1 },
    transparent: true,
    rasterProfile: profile,
  }
}
const baseline = {
  analytic: '12a745d4836e96778d50eae643cacc963fc9c639214f68928b353eed98847d44',
  figma: '773a4e683afd5e0f249e70631c783c46a4d8f1e207e00fc72f65a21f38758d64',
  figmaSubpixel: '5703ebb21f41d6a23413bbcba7254cdc8caafea652bea776bb5899bf276ee5c9',
}
// Analytic retains the pre-normalization baseline at 8e556c55. Fine profiles
// use four ordered RGBA8 jitter passes, float spatial filtering and the measured
// constant-colour accumulator. These hashes were refreshed only after all 36
// frames per profile matched the independent JS pixel oracle below byte-for-byte.
for (const raster of ['analytic', 'figma', 'figmaSubpixel'] as const)
  test(`ordinary stroke pixels satisfy the ${raster} precision contract`, () => {
    const engine = new VectorEngine(),
      hash = createHash('sha256')
    try {
      for (const cap of ['butt', 'square', 'round'])
        for (const join of ['miter', 'bevel', 'round'])
          for (const profile of [false, true])
            for (const dash of [false, true]) {
              const n = shape(cap, join, profile, dash)
              // Preserve the original baseline's direct-root scene structure.
              engine.load_document(
                JSON.stringify({
                  schemaVersion: 1,
                  id: 'd',
                  name: 'stroke precision',
                  pages: [{ id: 'p', name: 'p', background: '#ffffff', children: ['n'] }],
                  nodes: { n },
                }),
              )
              const bytes = engine.render_rgba(JSON.stringify(options(raster)))
              if (raster !== 'analytic') {
                const scene = JSON.parse(engine.compile_gpu(JSON.stringify(options(raster))))
                expect(bytes).toEqual(opaqueStrokeOracle(scene, 'n', [34, 51, 68], 64, 64))
              }
              hash.update(bytes)
            }
      expect(hash.digest('hex')).toBe(baseline[raster])
    } finally {
      engine.free()
    }
  }, 30_000) // Includes 36 complete frames and the independent per-sample oracle.
test('real WASM preserves nested tiny strokes across reflection, shear, width profiles and raster modes', () => {
  const engine = new VectorEngine(),
    scale = 2 ** 38,
    parent = 2 ** 19
  try {
    for (const raster of ['analytic', 'figma', 'figmaSubpixel'])
      for (const affine of [
        [1, 0, 0, 1],
        [-1, 0, 0.4, 1],
        [1, 0.25, 0.5, 1],
        [0.2, 0, 0.25, 1],
      ])
        for (const profile of [false, true])
          for (const cap of ['butt', 'square', 'round']) {
            const n = shape(cap, 'round', profile, false)
            n.strokes[0].align = 'center'
            n.transform = [...affine, 20, 0]
            engine.load_document(JSON.stringify(document(n)))
            const expected = engine.render_rgba(JSON.stringify(options(raster)))
            const tiny = structuredClone(n)
            tiny.network.vertices = tiny.network.vertices.map((v) => ({
              ...v,
              x: v.x / scale,
              y: v.y / scale,
            }))
            tiny.strokes[0].width /= scale
            tiny.transform = [...affine.map((v) => v * parent), 20 / parent, 0]
            engine.load_document(JSON.stringify(document(tiny, parent)))
            const actual = engine.render_rgba(JSON.stringify(options(raster)))
            expect(actual).toEqual(expected)
            expect(actual.some((v, i) => i % 4 === 3 && v > 0)).toBe(true)
            // A subpixel-width stroke need not contain a fully opaque pixel.
            // Query the known centerline midpoint rather than assuming alpha=255.
            const x = affine[0] * 5 + affine[2] * 14 + 28,
              y = affine[1] * 5 + affine[3] * 14 + 8
            expect(
              hit_test_device_json(
                JSON.stringify(tiny),
                JSON.stringify([...affine.map((v) => v * scale), 28, 8]),
                x,
                y,
                0,
              ),
            ).toBe(true)
          }
  } finally {
    engine.free()
  }
})
