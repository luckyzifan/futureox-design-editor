import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
const root = new URL('../../', import.meta.url)
const module = await import(new URL('frontend/design-client/src/generated/design-kernel/design_kernel.js', root))
const wasm = await readFile(new URL('frontend/design-client/public/kernel/design_kernel_bg.wasm', root))
await module.default({ module_or_path: wasm })
for (const managed of [false, true]) for (const rasterProfile of ['analytic', 'figma', 'figmaSubpixel']) {
  const document = {
    schemaVersion: 4, id: 'raster-wasm', name: 'Raster WASM verification',
    ...(managed ? { colorManagement: { documentSpace: 'srgb', referenceWhiteNits: 203, peakLuminanceNits: 1000 } } : {}),
    pages: [{ id: 'p', name: 'p', background: '#ffffff', children: ['g'] }],
    nodes: {
      g: { id: 'g', kind: 'rectangle', width: 20.25, height: 18.75, clip: true, children: ['a'], transform: [1,0,0,1,1.125,1.375] },
      a: { id: 'a', kind: 'ellipse', width: 24, height: 20, fills: [{ kind: 'solid', color: managed ? 'color(srgb-linear 4 -0.2 0.5)' : '#397db5' }], strokes: [{ width: 1.25, align: 'inside', paint: { kind: 'solid', color: '#000000' } }] }
    }
  }
  const options = JSON.stringify({ pageId: 'p', width: 32, height: 32, view: { x: 0, y: 0, zoom: 1 }, transparent: true, rasterProfile })
  const engine = new module.VectorEngine()
  try {
    engine.load_document(JSON.stringify(document))
    const png = engine.render_png(options)
    if (png.length < 100 || png[0] !== 137 || png[1] !== 80) throw new Error('Invalid WASM PNG')
    let hdr = null
    if (managed) {
      const pixels = engine.render_linear(options)
      if (!pixels.every(Number.isFinite) || !pixels.some(v => v > 1) || !pixels.some(v => v < 0)) throw new Error('HDR values lost')
      hdr = { finite: true, extendedRange: true }
    }
    console.log(JSON.stringify({ managed, rasterProfile, pngBytes: png.length, hdr, wasmSha256: createHash('sha256').update(wasm).digest('hex') }))
  } finally { engine.free() }
}
