import { KernelClient, renderExecutionPolicy } from './client'
import { canvasSamplingProfile } from './render-policy'
import { initializePicking } from './picking'
import { forma_decode_json } from '../generated/design-kernel/design_kernel'
import type { DesignDocument } from '../model'

const output = document.getElementById('results')!
const input = document.getElementById('file') as HTMLInputElement
const button = document.getElementById('run') as HTMLButtonElement
const canvas = document.getElementById('preview') as HTMLCanvasElement
let documentModel: DesignDocument | undefined
let previous: Uint8ClampedArray | undefined
input.onchange = async () => {
  await initializePicking()
  documentModel = JSON.parse(forma_decode_json(new Uint8Array(await input.files![0].arrayBuffer())))
  button.disabled = false
  output.textContent = `Loaded ${Object.keys(documentModel!.nodes).length} nodes`
}
button.onclick = async () => {
  if (!documentModel) return
  button.disabled = true
  const client = new KernelClient()
  const rows: unknown[] = []
  output.textContent = 'running'
  try {
    for (let pass = 0; pass < 4; pass++) {
      const authored = documentModel.rasterProfile || (documentModel.colorManagement ? 'figma' : 'analytic')
      const rasterProfile = pass === 3 ? canvasSamplingProfile(renderExecutionPolicy, authored, 'webgpu', !!documentModel.colorManagement) : authored
      const started = performance.now()
      const result = await client.render(documentModel, {
        pageId: documentModel.pages[0].id, width: 514, height: 514,
        view: { x: 0, y: 0, zoom: 2 }, transparent: false, grid: false,
        rasterProfile, renderIntent: pass === 0 ? 'settled' : 'canvas',
        tileViewport: [{ key: 'probe', x: 5119, y: 2047, width: 514, height: 514, zoom: 2 }],
      }, false, 'webgpu', pass === 0, false, { disableExactTileCache: true }, tile => {
        canvas.width = tile.width; canvas.height = tile.height
        const ctx = canvas.getContext('2d', { willReadFrequently: true })!
        if (tile.bitmap) ctx.drawImage(tile.bitmap, 0, 0)
        else ctx.putImageData(new ImageData(new Uint8ClampedArray(tile.bytes), tile.width, tile.height), 0, 0)
        tile.bitmap?.close()
        const pixels = ctx.getImageData(0, 0, tile.width, tile.height).data
        let hash = 2166136261, maxDifference = 0, changed = 0
        for (let i = 0; i < pixels.length; i++) {
          hash = Math.imul(hash ^ pixels[i], 16777619)
          if (previous) { const delta = Math.abs(pixels[i] - previous[i]); maxDifference = Math.max(maxDifference, delta); if (delta) changed++ }
        }
        rows.push({ pass, rasterProfile, reason: tile.reason, wallMs: performance.now() - started, tileMs: tile.milliseconds,
          compileMs: tile.compileMs, graphMs: tile.graphMs, finishMs: tile.finishMs,
          checkpointMs: tile.checkpointMs, hash: hash >>> 0,
          passTimings: tile.passTimings,
          compared: !!previous, maxDifference, changed })
        if (pass === 1 && maxDifference > 1) throw new Error(`Canvas differs from exact readback by ${maxDifference}/255`)
        previous = pixels
      })
      rows.push({ pass, totalMs: result.roundTripMs, peakBytes: result.peakTextureBytes,
        drawCalls: result.drawCalls, triangles: result.triangles })
      output.textContent = JSON.stringify({ status: 'running', rows }, null, 2)
    }
    output.textContent = JSON.stringify({ status: 'passed', rows }, null, 2)
  } catch (error) { output.textContent = JSON.stringify({ status: 'failed', error: String(error), rows }, null, 2) }
  finally { client.dispose(); button.disabled = false }
}
