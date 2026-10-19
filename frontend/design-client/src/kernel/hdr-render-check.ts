import { KernelClient, renderExecutionPolicy, type KernelResult } from './client'
import { ColorPresenter } from './color-presenter'
import { initializeKernelModule } from './module'
import type { DesignDocument } from '../model'
const output = document.querySelector<HTMLElement>('#results')!, canvas = document.querySelector<HTMLCanvasElement>('#preview')!
const gpu = new KernelClient(), cpu = new KernelClient()
let presenter: ColorPresenter | undefined
const rows: unknown[] = []
let cpuReferenceLimited = false
try {
  if (!renderExecutionPolicy.hdrCompositing) throw Error('Run the owned server with VITE_DESIGN_HDR=1')
  await initializeKernelModule()
  const response = await fetch('/__render_fixture')
  if (!response.ok) throw Error('Private fixture unavailable')
  const input = await response.json(), document = (input.document || input) as DesignDocument
  if (!document.colorManagement) throw Error('A color-managed fixture is required')
  const root = document.nodes[document.pages[0].children[0]], center = { x: root.transform[4] + root.width / 2, y: root.transform[5] + root.height / 2 }
  presenter = await ColorPresenter.create(canvas)
  for (const zoom of [2, 4]) {
    const options = { pageId: document.pages[0].id, width: 64, height: 64, view: { x: 32 - center.x * zoom, y: 32 - center.y * zoom, zoom },
      grid: false, transparent: false, rasterProfile: 'figma' as const, renderIntent: 'settled' as const }
    const result = await gpu.render(document, options, false, 'webgpu', true, false, { displayMath: true })
    if (!(result.linear instanceof Float32Array) || result.linear.length !== 64 * 64 * 4 || result.displayMath)
      throw Error('HDR float payload or arithmetic isolation failed')
    await presenter.present(result.linear, 64, 64, document.colorManagement)
    const row = { zoom, backend: result.backend, floatValues: result.linear.length, displayMath: result.displayMath,
      rendererMs: result.roundTripMs, reference: 'CPU', cpuReferenceError: '', mismatchedBits: -1, maxDifference: -1 }
    rows.push(row)
    output.textContent = JSON.stringify({ status: 'running', rows }, null, 2)
    let reference: KernelResult
    try { reference = await cpu.render(document, options, false, 'cpu', true) }
    catch (error) {
      if (!String(error).includes('Compositing memory budget exceeded')) throw error
      // Preserve the CPU failure explicitly. The unchanged dense exact GPU
      // path is a separate regression oracle, not a claim of CPU validation.
      cpuReferenceLimited = true; row.cpuReferenceError = String(error); row.reference = 'exact dense GPU'
      reference = await cpu.render(document, options, false, 'webgpu', true, false, { denseImageFields: true, displayMath: false })
    }
    if (!reference.linear || reference.linear.length !== result.linear.length) throw Error('Missing HDR reference float values')
    let mismatchedBits = 0, maxDifference = 0
    const a = new Uint32Array(result.linear.buffer), b = new Uint32Array(reference.linear.buffer)
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) mismatchedBits++
      if (!Number.isFinite(result.linear[i])) throw Error('Nonfinite HDR sample')
      maxDifference = Math.max(maxDifference, Math.abs(result.linear[i] - reference.linear[i]))
    }
    result.bitmap?.close(); reference.bitmap?.close()
    row.mismatchedBits = mismatchedBits; row.maxDifference = maxDifference
    if (mismatchedBits) throw Error(`HDR exact oracle differs in ${mismatchedBits} float words`)
  }
  output.textContent = JSON.stringify({ status: cpuReferenceLimited ? 'passed-with-cpu-reference-limit' : 'passed', nodes: Object.keys(document.nodes).length, rows,
    displaySpace: presenter.space, hardwareHdrReported: presenter.hdr, scope: 'Real color-managed crop float comparison; explicitly reports CPU budget failures and dense-GPU substitute; not physical luminance calibration' }, null, 2)
} catch (error) { output.textContent = JSON.stringify({ status: 'failed', rows, error: String(error) }, null, 2) }
finally { gpu.dispose(); cpu.dispose() }
window.addEventListener('pagehide', () => presenter?.dispose(), { once: true })
