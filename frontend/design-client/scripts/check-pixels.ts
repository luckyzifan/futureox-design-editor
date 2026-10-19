import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { initializePicking } from '../src/kernel/picking'
import { pixelCases } from '../src/pixel-fixtures'
import { VectorEngine } from '../src/generated/design-kernel/design_kernel'
const root = resolve(import.meta.dir, '../../..'),
  out = resolve(root, '.local/design-validation/pixels')
await mkdir(out, { recursive: true })
await initializePicking({
  wasm: new Uint8Array(
    await readFile(resolve(root, 'frontend/design-client/public/kernel/design_kernel_bg.wasm')),
  ),
  font: new Uint8Array(
    await readFile(resolve(root, 'frontend/design-client/public/fonts/NotoSansSC.ttf')),
  ),
})
const doc = pixelCases().find((c) => c.name === '任意小数像素')!.document,
  engine = new VectorEngine()
await writeFile(resolve(out, 'rectangle.fd'), JSON.stringify(doc, null, 2))
engine.load_document(JSON.stringify(doc))
const png = engine.render_png(
  JSON.stringify({
    pageId: doc.pages[0].id,
    width: 320,
    height: 240,
    view: { x: 0, y: 0, zoom: 0.25 },
    transparent: false,
    grid: false,
  }),
)
await writeFile(resolve(out, 'rectangle-wasm.png'), png)
engine.free()
console.log(JSON.stringify({ pngBytes: png.length }))
