import { tmpdir } from 'node:os'
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises'
import { resolve } from 'node:path'
import { layoutFixture, named } from '../src/layout-fixtures'
const root = resolve(import.meta.dir, '../../..'),
  out = process.env.DESIGN_TEST_OUTPUT || await mkdtemp(resolve(tmpdir(), 'forma-layout-'))
await mkdir(out, { recursive: true })
const kernel = await import(
  resolve(root, 'frontend/design-client/src/generated/design-kernel/design_kernel.js')
)
await kernel.default({
  module_or_path: await readFile(
    resolve(root, 'frontend/design-client/public/kernel/design_kernel_bg.wasm'),
  ),
})
const e = new kernel.VectorEngine()
e.load_font(
  new Uint8Array(
    await readFile(resolve(root, 'frontend/design-client/public/fonts/NotoSansSC.ttf')),
  ),
)
const doc = layoutFixture('grid')
await writeFile(resolve(out, 'responsive.fd'), JSON.stringify(doc, null, 2))
const patches = JSON.parse(e.resolve_layout(JSON.stringify(doc)))
const resolved = structuredClone(doc)
for (const [id, patch] of Object.entries(patches)) {
  Object.assign(resolved.nodes[id], patch)
  for (const k of ['network', 'constraints', 'sizing'] as const)
    if (resolved.nodes[id][k] === null) delete resolved.nodes[id][k]
}
if (e.resolve_layout(JSON.stringify(resolved)) !== '{}') throw new Error('Layout is not idempotent')
e.load_document(JSON.stringify(doc))
const options = {
  pageId: doc.pages[0].id,
  width: 320,
  height: 240,
  view: { x: 0, y: 0, zoom: 0.25 },
  transparent: false,
  grid: false,
}
const png = e.render_png(JSON.stringify(options))
await writeFile(resolve(out, 'responsive-wasm.png'), png)
console.log(
  JSON.stringify({
    layout: 'grid',
    nodes: Object.keys(doc.nodes).length,
    frame: named(resolved, '容器').width,
    pngBytes: png.length,
  }),
)
e.free()
