// Reproduce the captured 117 support with the actual production WASM compiler.
// First export a fresh imported document using DESIGN_SAVE_FIXTURE=1 in the
// Electron harness. Nothing is written to the original Sketch or workspace.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const [documentPath, output] = process.argv.slice(2)
if (!documentPath || !output) throw Error('document JSON and new output directory required')
const root = process.cwd(), client = path.join(root, 'frontend/design-client')
const { initSync, VectorEngine } = await import(pathToFileURL(path.join(client, 'src/generated/design-kernel/design_kernel.js')))
const wasm = await readFile(path.join(client, 'public/kernel/design_kernel_bg.wasm'))
const bytes = await readFile(documentPath), document = JSON.parse(bytes)
const id = '1AB99304-455A-4A9E-9473-8923A1330FA4'
if (document.nodes[id]?.fills?.[0]?.kind !== 'image') throw Error('Expected actual 117 image node')
initSync({ module: wasm })
const engine = new VectorEngine()
try {
  engine.load_font(await readFile(path.join(client, 'public/fonts/NotoSansSC.ttf')))
  engine.load_document(JSON.stringify(document))
  const options = { pageId: document.pages[0].id, width: 514, height: 514,
    view: { x: -52201.00195312501, y: -35527.998046875, zoom: 64 },
    transparent: false, grid: true, rasterProfile: 'figma',
    prepareViewport: { x: 0, y: 0, w: 1026, h: 1026 }, gpuViewport: { x: 0, y: 0, w: 514, h: 514 } }
  const scene = JSON.parse(engine.compile_gpu(JSON.stringify(options)))
  const node = scene.nodes[id], radius = node.effects[0].radius * Math.max(Math.hypot(...node.matrix.slice(0, 2)), Math.hypot(...node.matrix.slice(2, 4)))
  if (radius !== 1224.3035888671875 || scene.extent.w !== 1032 || scene.extent.h !== 1032)
    throw Error('Captured native support changed; do not substitute another workload')
  const canonical = JSON.stringify(document), sceneJson = JSON.stringify(scene)
  const hash = value => createHash('sha256').update(value).digest('hex')
  await mkdir(output, { recursive: false })
  await writeFile(path.join(output, 'document.json'), canonical, { flag: 'wx' })
  await writeFile(path.join(output, 'scene.json'), sceneJson, { flag: 'wx' })
  const metadata = { options, radius, nodeId: id, documentSha256: hash(canonical), sceneSha256: hash(sceneJson), wasmSha256: hash(wasm),
    scope: 'CPU preparation using production WASM; no GPU or latency acceptance' }
  await writeFile(path.join(output, 'manifest.json'), JSON.stringify(metadata, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify(metadata))
} finally { engine.free() }
