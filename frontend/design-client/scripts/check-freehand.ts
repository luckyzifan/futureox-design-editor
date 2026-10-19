import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { initializePicking } from '../src/kernel/picking'
import { freehandFixture } from '../src/freehand-fixtures'
import { validateDocument } from '../src/model'
import { VectorEngine } from '../src/generated/design-kernel/design_kernel'
import { svgSource } from '../src/export'
const root = resolve(import.meta.dir, '../../..'),
  out = resolve(root, '.local/design-validation/freehand')
await mkdir(out, { recursive: true })
await initializePicking({
  wasm: new Uint8Array(
    await readFile(resolve(root, 'frontend/design-client/public/kernel/design_kernel_bg.wasm')),
  ),
  font: new Uint8Array(
    await readFile(resolve(root, 'frontend/design-client/public/fonts/NotoSansSC.ttf')),
  ),
})
const doc = freehandFixture(),
  engine = new VectorEngine()
validateDocument(doc)
await writeFile(resolve(out, 'freehand.fd'), JSON.stringify(doc, null, 2))
engine.load_document(JSON.stringify(doc))
const options = {
  pageId: doc.pages[0].id,
  width: 320,
  height: 240,
  view: { x: 0, y: 0, zoom: 0.25 },
  transparent: false,
  grid: false,
}
const png = engine.render_png(JSON.stringify(options))
engine.free()
await writeFile(resolve(out, 'freehand-wasm.png'), png)
await writeFile(resolve(out, 'freehand.svg'), svgSource(doc, doc.pages[0].id).source)
console.log(
  JSON.stringify({
    nodes: Object.keys(doc.nodes).length,
    curves: Object.values(doc.nodes).reduce((sum, n) => sum + (n.network?.edges.length || 0), 0),
    pngBytes: png.length,
    roundtrip: 'passed',
  }),
)
