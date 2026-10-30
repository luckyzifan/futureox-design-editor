import { KernelClient } from './client'
import type { DesignDocument } from '../model'

const output = document.querySelector('#results')!
const report: { status: string; stages: unknown[]; error?: string } = { status: 'running', stages: [] }
const publish = () => {
  output.textContent = JSON.stringify(report, null, 2)
  void fetch('/__render_report', { method: 'POST', body: JSON.stringify(report) })
}
const client = new KernelClient()
try {
  const response = await fetch('/__render_fixture')
  if (!response.ok) throw Error('Real document required')
  const input = await response.json(), doc: DesignDocument = input.document || input
  const root = doc.nodes[doc.pages[0].children[1] || doc.pages[0].children[0]]
  client.attachPresentation(document.querySelector<HTMLCanvasElement>('#display')!.transferControlToOffscreen())
  const tile = { key: 'resource-probe', x: Math.floor(root.transform[4] + 200),
    y: Math.floor(root.transform[5] + 100), width: 514, height: 514, zoom: 1 }
  const options = { pageId: doc.pages[0].id, width: 514, height: 514,
    view: { x: 0, y: 0, zoom: 1 }, transparent: false, grid: false,
    rasterProfile: 'figmaSubpixel' as const, renderIntent: 'canvas' as const, tileViewport: [tile] }
  const render = () => client.render(doc, options, false, 'webgpu', false, false, undefined, result => {
    result.bitmap?.close()
    if (result.gpuTile) client.releasePresented([result.gpuTile])
  })
  await render()
  const bytes = async () => (await client.gpuMemorySnapshot()).driverStats?.displayTextureBytes || 0
  const before = await bytes()
  let cancelled = 0
  for (let i = 0; i < 12; i++) {
    const pending = render()
    const timer = setTimeout(() => client.cancelPreview(), 8)
    try { await pending } catch (error) {
      if (!String(error).includes('PREVIEW_CANCELLED')) throw error
      cancelled++
    } finally { clearTimeout(timer) }
    report.stages.push({ iteration: i, cancelled, displayBytes: await bytes() })
    publish()
  }
  const after = await bytes()
  report.stages.push({ name: 'cancelled tile ownership', nodes: Object.keys(doc.nodes).length,
    cancelled, before, after, retainedGrowth: after - before })
  if (!cancelled) throw Error('Cancellation was not exercised')
  if (after !== before) throw Error(`Cancelled requests leaked ${after - before} display bytes`)
  report.status = 'passed'
} catch (error) { report.status = 'failed'; report.error = String(error) }
finally { client.dispose(); publish() }
