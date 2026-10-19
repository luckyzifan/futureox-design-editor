import { KernelClient, type TileResult } from './client'
import { planTiles } from './tile-cache'
import { tilePrepareViewport } from './tile-prepare-viewport'
import type { DesignDocument } from '../model'

const output = document.querySelector('#results')!
const report: { status: string; samples: unknown[]; error?: string } = { status: 'running', samples: [] }
const publish = async () => {
  output.textContent = JSON.stringify(report, null, 2)
  await fetch('/__render_report_lod', { method: 'POST', body: JSON.stringify(report) })
}
try {
  const response = await fetch('/__render_fixture')
  if (!response.ok) throw Error('Real document required')
  const input = await response.json(), doc: DesignDocument = input.document || input
  const page = doc.pages[0], node = doc.nodes[page.children[0]], zoom = .2, scale = zoom * devicePixelRatio
  const center = { x: node.transform[4] + node.width / 2, y: node.transform[5] + node.height / 2 }
  const tiles = planTiles({ x: center.x - 500 / zoom, y: center.y - 320 / zoom, width: 1000 / zoom, height: 640 / zoom }, scale)
  const view = { x: 0, y: 0, zoom: scale }
  const options = { pageId: page.id, width: 1000 * devicePixelRatio, height: 640 * devicePixelRatio,
    view, grid: false, transparent: false, rasterProfile: 'analytic' as const, renderIntent: 'preview' as const }
  let reference: string | undefined
  // Reverse the order in the second pair to expose driver/shader warmup bias.
  for (const batch of [2, 256, 256, 2]) {
    const client = new KernelClient(), received: TileResult[] = []
    try {
      const init = performance.now()
      await client.render(doc, { ...options, tileViewport: [] }, false, 'webgpu', false)
      const initializationMs = performance.now() - init, start = performance.now()
      let requests = 0, compileMs = 0, graphMs = 0, finishMs = 0
      for (let i = 0; i < tiles.length; i += batch) {
        const result = await client.render(doc, { ...options, tileViewport: tiles.slice(i, i + batch),
          tilePrepareViewport: batch === 256 ? tilePrepareViewport(tiles, view) : undefined },
        false, 'webgpu', false, false, undefined, tile => { received.push(tile) })
        requests++; compileMs += result.compileMs; graphMs += result.graphMs || 0; finishMs += result.finishMs || 0
      }
      const renderMs = performance.now() - start
      const hashes: string[] = []
      for (const tile of received) {
        let bytes: Uint8Array<ArrayBuffer>
        if (tile.bitmap) {
          const canvas = new OffscreenCanvas(tile.width, tile.height), context = canvas.getContext('2d')!
          context.drawImage(tile.bitmap, 0, 0)
          bytes = new Uint8Array(context.getImageData(0, 0, tile.width, tile.height).data)
        } else bytes = new Uint8Array(tile.bytes)
        if (bytes.length !== tile.width * tile.height * 4) throw Error('Tile pixels unavailable for equality check')
        hashes.push(tile.key + ':' + [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
          .map(value => value.toString(16).padStart(2, '0')).join(''))
      }
      const pixels = hashes.sort().join('|'); reference ??= pixels
      report.samples.push({ batch, initializationMs, renderMs, requests, compileMs, graphMs, finishMs,
        tileCount: received.length, pixelEqual: pixels === reference, hashes })
      await publish()
      if (received.length !== tiles.length || pixels !== reference) throw Error('LOD batch pixels differ')
    } finally {
      received.forEach(tile => tile.bitmap?.close())
      client.dispose()
    }
  }
  report.status = 'passed'; await publish()
} catch (error) { report.status = 'failed'; report.error = String(error); await publish() }
