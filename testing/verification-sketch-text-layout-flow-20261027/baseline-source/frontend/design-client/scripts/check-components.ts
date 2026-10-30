import { tmpdir } from 'node:os'
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises'
import { resolve } from 'node:path'
import { initializePicking, kernelLayout } from '../src/kernel/picking'
import { componentFixture } from '../src/component-fixtures'
import { Editor } from '../src/engine'
import { paint } from '../src/model'
const root = resolve(import.meta.dir, '../../..'),
  out = process.env.DESIGN_TEST_OUTPUT || await mkdtemp(resolve(tmpdir(), 'forma-components-'))
await mkdir(out, { recursive: true })
await initializePicking({
  wasm: new Uint8Array(
    await readFile(resolve(root, 'frontend/design-client/public/kernel/design_kernel_bg.wasm')),
  ),
  font: new Uint8Array(
    await readFile(resolve(root, 'frontend/design-client/public/fonts/NotoSansSC.ttf')),
  ),
})
const { doc, ids } = componentFixture(),
  editor = new Editor(doc)
editor.setComponentProperty(ids.a, ids.title, '实例覆盖')
editor.setComponentProperty(ids.a, ids.icon, ids.iconB)
const variant = editor.addVariant(ids.button)
editor.update([variant], { fills: [paint('#ffdfbf')] })
editor.swapInstance(ids.a, variant)
const document = editor.state.doc,
  json = JSON.stringify(document)
if (JSON.stringify(kernelLayout(document)) !== json)
  throw new Error('Component resolution is not idempotent')
await writeFile(resolve(out, 'component.fd'), JSON.stringify(document, null, 2))
const module = await import(
    resolve(root, 'frontend/design-client/src/generated/design-kernel/design_kernel.js')
  ),
  engine = new module.VectorEngine()
engine.load_font(
  new Uint8Array(
    await readFile(resolve(root, 'frontend/design-client/public/fonts/NotoSansSC.ttf')),
  ),
)
engine.load_document(json)
const options = {
  pageId: document.pages[0].id,
  width: 320,
  height: 240,
  view: { x: 0, y: 0, zoom: 0.25 },
  transparent: false,
  grid: false,
}
const png = engine.render_png(JSON.stringify(options))
await writeFile(resolve(out, 'component-wasm.png'), png)
engine.free()
console.log(
  JSON.stringify({
    nodes: Object.keys(document.nodes).length,
    mainComponents: Object.values(document.nodes).filter((n) => n.component).length,
    pngBytes: png.length,
    roundtrip: 'passed',
  }),
)
