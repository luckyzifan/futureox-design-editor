import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { initializePicking } from '../src/kernel/picking'
import { figmaFixture } from '../src/figma-fixtures'
import { VectorEngine } from '../src/generated/design-kernel/design_kernel'
const root = resolve(import.meta.dir, '../../..'),
  out = resolve(root, '.local/design-validation/figma-reference')
await mkdir(out, { recursive: true })
await initializePicking({
  wasm: new Uint8Array(
    await readFile(resolve(root, 'frontend/design-client/public/kernel/design_kernel_bg.wasm')),
  ),
  font: new Uint8Array(
    await readFile(resolve(root, 'frontend/design-client/public/fonts/NotoSansSC.ttf')),
  ),
})
const doc = figmaFixture('rotated-curve'),
  engine = new VectorEngine()
engine.load_document(JSON.stringify(doc))
await writeFile(resolve(out, 'rotated-curve.fd'), JSON.stringify(doc, null, 2))
const options = {
  pageId: doc.pages[0].id,
  width: 320,
  height: 240,
  view: { x: 0, y: 0, zoom: 0.25 },
  transparent: false,
  grid: false,
}
for (const density of [0, 1, 2]) {
  const png = engine.render_png(
    JSON.stringify({ ...options, ...(density ? { pixelPreview: density } : {}) }),
  )
  await writeFile(resolve(out, `native-preview-${density}-wasm.png`), png)
}
engine.free()
console.log('Saved native/WASM reference PNGs for normal, 1x and 2x pixel preview')
