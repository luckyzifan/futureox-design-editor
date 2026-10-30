import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
const root = resolve(import.meta.dir, '../../..')
const module = await import(
  resolve(root, 'frontend/design-client/src/generated/design-kernel/design_kernel.js')
)
await module.default({
  module_or_path: await readFile(
    resolve(root, 'frontend/design-client/public/kernel/design_kernel_bg.wasm'),
  ),
})
const engine = new module.VectorEngine()
engine.load_font(
  new Uint8Array(
    await readFile(
      process.argv[3] || resolve(root, 'frontend/design-client/public/fonts/NotoSansSC.ttf'),
    ),
  ),
)
const document = JSON.parse(
  await readFile(process.argv[2] || resolve(root, '.local/design-validation/demo.fd'), 'utf8'),
)
engine.load_document(JSON.stringify(document))
const options = {
  pageId: document.pages[0].id,
  width: 1280,
  height: 900,
  view: { x: 0, y: 0, zoom: 1 },
  transparent: false,
  grid: true,
}
const start = performance.now()
const png = engine.render_png(JSON.stringify(options))
await writeFile(resolve(root, '.local/design-validation/kernel-wasm.png'), png)
const rect = (id: string, x: number) => ({
  id,
  kind: 'rectangle',
  transform: [1, 0, 0, 1, x, 0],
  width: 100,
  height: 100,
  fills: [],
})
const result = JSON.parse(
  module.geometry_json(
    JSON.stringify({ operation: 'intersect', nodes: [rect('a', 0), rect('b', 50)] }),
  ),
)
if (result.length !== 1 || result[0].length !== 1) throw new Error('WASM geometry contract failed')
const pickNode = { ...rect('pick', 0), fills: [{ kind: 'solid', color: '#ff0000', opacity: 1 }] }
if (
  !module.hit_test_json(JSON.stringify(pickNode), 50, 50, 0) ||
  module.hit_test_json(JSON.stringify(pickNode), 150, 50, 0)
)
  throw new Error('WASM picking contract failed')
console.log(
  JSON.stringify({
    wasmPngBytes: png.length,
    milliseconds: performance.now() - start,
    stats: JSON.parse(engine.stats()),
    geometry: 'intersection passed',
  }),
)
engine.free()
