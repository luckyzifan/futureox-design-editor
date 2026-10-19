/** Owned-server fixture only. VITE_DESIGN_GPU_TIMINGS=1 enables GPU timestamps. */
import { KernelClient } from './client'
import type { DesignDocument } from '../model'
const output = document.querySelector<HTMLElement>('#results')!, canvas = document.querySelector<HTMLCanvasElement>('#preview')!
const client = new KernelClient()
try {
  const response = await fetch('/__render_fixture')
  if (!response.ok) throw Error('Start the isolated fixture server')
  const input = await response.json(), document = (input.document || input) as DesignDocument
  const node = document.nodes[document.pages[0].children[0]]
  const zoom = Number(new URLSearchParams(location.search).get('zoom') || 15.278)
  if (!(zoom >= .001 && zoom <= 128)) throw Error('Invalid sampling density')
  const tile = { key: 'profile', x: Math.floor((node.transform[4] + node.width / 2) * zoom / 512) * 512,
    y: Math.floor((node.transform[5] + node.height / 2) * zoom / 512) * 512, width: 514, height: 514, zoom }
  const result = await client.render(document, { pageId: document.pages[0].id, width: 514, height: 514,
    view: { x: 0, y: 0, zoom }, grid: false, transparent: false, renderIntent: 'canvas', rasterProfile: 'figmaSubpixel', tileViewport: [tile],
  }, false, 'webgpu', false, false, { disableExactTileCache: true }, pixels => {
    canvas.width = pixels.width; canvas.height = pixels.height
    const context = canvas.getContext('2d')!
    if (pixels.bitmap) { context.drawImage(pixels.bitmap, 0, 0); pixels.bitmap.close() }
    else context.putImageData(new ImageData(new Uint8ClampedArray(pixels.bytes), pixels.width, pixels.height), 0, 0)
  })
  output.textContent = JSON.stringify({ status: 'passed', nodes: Object.keys(document.nodes).length, zoom,
    roundTripMs: result.roundTripMs, loadMs: result.loadMs, compileMs: result.compileMs, graphMs: result.graphMs,
    finishMs: result.finishMs, checkpointMs: result.checkpointMs, drawCalls: result.drawCalls,
    memory: await client.gpuMemorySnapshot(), scope: 'Single real high-density tile; GPU timestamps are per last completed subframe' }, null, 2)
} catch (error) { output.textContent = JSON.stringify({ status: 'failed', error: String(error) }) }
finally { client.dispose() }
