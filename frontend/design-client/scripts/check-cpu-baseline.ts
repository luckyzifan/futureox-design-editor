// Compare an explicitly saved JS+WASM build with the current build. This checks
// CPU pixel preservation, not Figma compatibility or browser/GPU parity.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  figmaFixture,
  type ReferenceCase,
  referenceScale,
  referenceSize,
} from '../src/figma-fixtures'
import { precisionFixtures } from '../src/kernel-regression-fixtures'

const baselinePath = process.argv[2]
if (!baselinePath)
  throw new Error('Usage: bun scripts/check-cpu-baseline.ts <saved/design_kernel.js>')
const currentPath = resolve('src/generated/design-kernel/design_kernel.js')
const baseline = await import(pathToFileURL(resolve(baselinePath)).href)
const current = await import(pathToFileURL(currentPath).href)
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const baselineWasm = readFileSync(join(dirname(resolve(baselinePath)), 'design_kernel_bg.wasm'))
const currentWasm = readFileSync(join(dirname(currentPath), 'design_kernel_bg.wasm'))
await baseline.default({ module_or_path: baselineWasm })
await current.default({ module_or_path: currentWasm })
const font = readFileSync('public/fonts/NotoSansSC.ttf')
const kinds: ReferenceCase[] = [
  'mask-overlap',
  'mask-outside',
  'rectangle',
  'curve',
  'rotated-curve',
  'alpha-curve',
  'shadow',
  'layer-blur',
  'blur-radii',
  'coverage-overlap',
  'coverage-overlap-2x',
  'group-blur',
  'group-shadow',
  'group-inner-shadow',
  'backdrop-blur',
  'pass-through',
  'pass-through-opacity',
  'isolated-opacity',
  'pass-through-blur',
  'large-nested',
]
const fixtures = kinds.map((kind) => ({
  name: String(kind),
  document: figmaFixture(kind),
  ...referenceSize(kind),
  zoom: referenceScale(kind),
}))
fixtures.push(
  ...precisionFixtures().map((document, i) => ({
    name: `precision-${i}`,
    document,
    width: 256,
    height: 192,
    zoom: 1,
  })),
)
const results = []
for (const fixture of fixtures) {
  for (const rasterProfile of ['analytic', 'figma', 'figmaSubpixel']) {
    const options = JSON.stringify({
      pageId: fixture.document.pages[0].id,
      width: fixture.width,
      height: fixture.height,
      view: { x: 0, y: 0, zoom: fixture.zoom },
      transparent: true,
      grid: false,
      rasterProfile,
    })
    const engines = [new baseline.VectorEngine(), new current.VectorEngine()]
    try {
      const rendered = engines.map((engine) => {
        engine.load_font(font)
        engine.load_document(JSON.stringify(fixture.document))
        return engine.render_rgba(options) as Uint8Array
      })
      const [before, after] = rendered.map(hash)
      if (before !== after)
        throw new Error(
          `CPU pixels changed: ${fixture.name}/${rasterProfile}: ${before} -> ${after}`,
        )
      results.push({
        name: fixture.name,
        rasterProfile,
        rgbaSha256: after,
        peakCompositingBytes: JSON.parse(engines[1].stats()).peakCompositingBytes,
      })
    } finally {
      for (const engine of engines) engine.free()
    }
  }
}
console.log(
  JSON.stringify(
    {
      baselineWasm: hash(baselineWasm),
      currentWasm: hash(currentWasm),
      checks: results.length,
      results,
    },
    null,
    2,
  ),
)
