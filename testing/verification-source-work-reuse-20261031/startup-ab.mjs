import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { Sidecar } from '../../frontend/design-desktop/src/sidecar.mjs'
import { NativePreparation } from '../../frontend/design-desktop/src/preparation.mjs'

const repo = process.cwd(), products = process.argv[2], out = process.argv[3]
const source = '/Users/Apple/Downloads/拓扑素材.sketch'
// A concurrent experiment adds an opt-in metadata-only loader. This increment
// measures the original complete-owner contract in both frozen products.
process.env.CORE_SOURCE_SNAPSHOT_METADATA_ONLY = '0'
process.env.CORE_SOURCE_LEGACY_REFS = '0'
if (!products || !out || !path.isAbsolute(products) || !path.isAbsolute(out)) throw Error('Absolute product and fresh output directories required')
await fs.mkdir(out)
async function hash(file) { const sum = createHash('sha256'); for await (const chunk of createReadStream(file)) sum.update(chunk); return sum.digest('hex') }
const binary = path.join(products, 'futureox-design-desktop-backend'), prepare = path.join(products, 'design-prepare')
const report = { source, sourceHash: await hash(source), backendHash: await hash(binary), prepareHash: await hash(prepare),
  node: process.version, metadataOnly: false, startedAt: new Date().toISOString(), stages: [], pixels: [], status: 'running' }
const backend = new Sidecar(binary, path.join(out, 'recovery'), { timeoutMs: 120000 })
let preparation
const record = async () => fs.writeFile(path.join(out, 'manifest.json'), JSON.stringify(report, null, 2))
try {
  let at = performance.now()
  const opened = await backend.request('large.open', { path: source, documentId: '01234567-89ab-4cde-8fab-0123456789ab', sessionEpoch: 1 })
  report.stages.push({ stage: 'source-open', ms: performance.now() - at }); await record()
  const request = { owner: opened.owner, expectedRevision: opened.revision }, layout = []
  at = performance.now()
  for (let offset = 0;; offset += 200) {
    const page = await backend.request('large.canvasLayout', { ...request, offset, limit: 200 })
    layout.push(...page.items); if (!page.hasMore) break
  }
  report.stages.push({ stage: 'source-layout', ms: performance.now() - at })
  await fs.writeFile(path.join(out, 'layout.json'), JSON.stringify(layout))
  at = performance.now(); const snapshot = await backend.request('large.canvasSnapshot', request)
  report.stages.push({ stage: 'whole-source-snapshot', ms: performance.now() - at, roots: snapshot.roots, nodes: snapshot.nodes, bytes: snapshot.bytes })
  const descriptor = { path: snapshot.path, store: snapshot.store, documentId: opened.owner.documentId,
    pageId: snapshot.pageId, stageId: snapshot.stageId, nodes: snapshot.nodes }
  await fs.writeFile(path.join(out, 'snapshot.json'), JSON.stringify(descriptor, null, 2))
  report.snapshotHash = await hash(snapshot.path)
  preparation = new NativePreparation(prepare, path.join(repo, 'frontend/design-client/public/fonts/NotoSansSC.ttf'))
  at = performance.now(); const loaded = await preparation.loadSourceSnapshot(descriptor)
  if (loaded.error) throw Error(loaded.error)
  report.stages.push({ stage: 'native-source-load', ms: performance.now() - at }); await record()
  // Explicit bounded CPU pixel checks are separate from the startup timings.
  // Do not present these as GPU or visible GUI performance.
  if (process.env.SOURCE_REUSE_PIXELS === '1') {
    for (const id of ['10c6999a-19ed-4836-be94-46a2609309d7', 'B4F79D9D-73A9-4CFA-A0C2-BA3610CC6105']) {
      const item = layout.find(item => item.id === id); assert(item, `Missing fixed root ${id}`)
      const width = 96, height = 64, zoom = 1
      const options = { pageId: snapshot.pageId, width, height, view: {
        x: width / 2 - (item.placed.x + item.placed.width / 2) * zoom,
        y: height / 2 - (item.placed.y + item.placed.height / 2) * zoom, zoom }, rasterProfile: 'figmaSubpixel', transparent: false }
      const result = await preparation.request({ lane: 'canvas', method: 'render_png', args: [JSON.stringify(options)] })
      if (result.error || !result.value?.byteLength) throw Error(result.error || 'Missing CPU PNG')
      const file = `cpu-${report.pixels.length}.png`; await fs.writeFile(path.join(out, file), result.value)
      report.pixels.push({ file, root: item.id, options, hash: await hash(path.join(out, file)) }); await record()
    }
  }
  report.status = 'passed'
} catch (error) { report.status = 'failed'; report.error = String(error); process.exitCode = 1 }
finally {
  await preparation?.close(); await backend.stop()
  report.sourceUnchanged = report.sourceHash === await hash(source); report.endedAt = new Date().toISOString(); await record()
  console.log(JSON.stringify({ status: report.status, stages: report.stages, snapshotHash: report.snapshotHash, error: report.error }))
}
