// Real-fixture display-only multiresolution Gaussian pixel probe.
// Imports the actual .sketch through the production kernel import, renders the
// exact CPU reference (readback) and the WebGPU display lane (present), and
// reports the channel error. The multires lane is controlled by the build-time
// VITE_DESIGN_MULTIRES_BLUR flag; with it off this measures the baseline display
// error, with it on the multires approximation error. Neither path is an exact
// claim: the display gate is the frozen < 1/255 unquantized SDR bound.
import init, { import_sketch_json } from '../../generated/design-kernel/design_kernel'
import { KernelClient } from '../client'
import type { DesignDocument } from '../../model'

const output = document.querySelector('#results')!
const report: { status: string; flag: string; cases: unknown[]; error?: string; imageTransform?: number[]; diagnostic?: unknown } = {
  status: 'running', flag: String(import.meta.env.VITE_DESIGN_MULTIRES_BLUR ?? 'off'), cases: [],
}
const publish = () => { output.textContent = JSON.stringify(report, null, 2) }

async function run(sketchBytes: Uint8Array) {
  const cpu = new KernelClient(), gpu = new KernelClient()
  try {
    await init()
    const doc = JSON.parse(import_sketch_json(sketchBytes)).document as DesignDocument
    // Managed SDR float display lane (the lane the high-zoom refinement uses).
    doc.colorManagement = { documentSpace: 'srgb', referenceWhiteNits: 203, peakLuminanceNits: 1000 }
    const image = Object.values(doc.nodes).find(n => n.name === 'Image')!
    // Accumulate parent transforms to get the node's absolute page position.
    const absolute = (id: string): [number, number] => {
      let x = 0, y = 0, cur: string | undefined = id
      const chain: string[] = []
      while (cur) { chain.push(cur); cur = Object.values(doc.nodes).find(n => n.children?.includes(cur!))?.id }
      for (const nid of chain.reverse()) { const t = doc.nodes[nid].transform; x += t[4]; y += t[5] }
      return [x, y]
    }
    const [nx, ny] = absolute(image.id)
    const cx = nx + image.width / 2, cy = ny + image.height / 2
    report.imageTransform = [nx, ny, image.width, image.height]
    // Diagnostic: a broad low-zoom window must contain non-transparent content.
    {
      const z = 1
      const probe = async (px: number, py: number, label: string) => {
        const opts = { pageId: doc.pages[0].id, width: 256, height: 256, view: { x: 128 - px * z, y: 128 - py * z, zoom: z }, transparent: true, grid: false, rasterProfile: 'figmaSubpixel' as const }
        const g = await gpu.render(doc, opts, false, 'webgpu', false)
        let nz = 0, mx = 0; for (let i = 0; i < g.bytes.length; i++) { if (g.bytes[i]) nz++; if (g.bytes[i] > mx) mx = g.bytes[i] }
        g.bitmap?.close()
        return { label, center: [px, py], nonZero: nz, maxByte: mx, passPixels: (g as any).passPixels }
      }
      const g0 = Object.values(doc.nodes).find(n => n.name === 'g')!
      const [gx, gy] = absolute(g0.id)
      report.diagnostic = {
        nodes: Object.keys(doc.nodes).length,
        imageCenter: await probe(cx, cy, 'image-center'),
        imageOrigin: await probe(nx + 50, ny + 50, 'image-origin'),
        groupCenter: await probe(gx + g0.width / 2, gy + g0.height / 2, 'group-center'),
      }
      publish()
    }
    // options.width/height are device pixels here (no extra DPR), so a device
    // scale of 16 / 64 reproduces zoom-800 / zoom-3200 at DPR 2. The blurred
    // group (solid child, gaussian radius 7.7255) and the blurred image origin
    // (radius 9.5649) are the real fixture's generic-Gaussian sources.
    const g0 = Object.values(doc.nodes).find(n => n.name === 'g')!
    const [gx, gy] = absolute(g0.id)
    const targets = [
      { label: 'group', x: gx + g0.width / 2, y: gy + g0.height / 2 },
      { label: 'image', x: nx + 60, y: ny + 60 },
    ]
    for (const scale of [16, 64]) {
      for (const target of targets) {
        try {
        const options = {
          pageId: doc.pages[0].id, width: 256, height: 192,
          view: { x: 128 - target.x * scale, y: 96 - target.y * scale, zoom: scale },
          transparent: true, grid: false, rasterProfile: 'figmaSubpixel' as const,
          renderIntent: 'preview' as const, livePreview: true,
        }
        const expected = await cpu.render(doc, options, false, 'cpu', true)
        const actual = await gpu.render(doc, options, false, 'webgpu', false)
        expected.bitmap?.close(); actual.bitmap?.close()
        if (actual.backend !== 'webgpu') throw Error(`Expected webgpu, got ${actual.backend}`)
        if (actual.bytes.length !== expected.bytes.length) throw Error('Output size changed')
        let changed = 0, max = 0, sum = 0
        for (let i = 0; i < actual.bytes.length; i++) {
          const d = Math.abs(actual.bytes[i] - expected.bytes[i])
          if (d) { changed++; sum += d }
          max = Math.max(max, d)
        }
        let floatMax: number | undefined, floatChanged: number | undefined
        const al = (actual as { linear?: Float32Array }).linear, el = (expected as { linear?: Float32Array }).linear
        if (al && el && al.length === el.length) {
          floatMax = 0; floatChanged = 0
          for (let i = 0; i < al.length; i++) { const d = Math.abs(al[i] - el[i]); if (d) floatChanged++; if (d > floatMax) floatMax = d }
        }
        const diag = actual as { passPixels?: number; multiresBlurPasses?: number; multiresBlurReducedPixels?: number }
        const ediag = expected as { passPixels?: number }
        report.cases.push({
          target: target.label, deviceScale: scale, backend: actual.backend,
          rgba: { changed, max, mean: changed ? sum / changed : 0, total: actual.bytes.length },
          float: floatMax === undefined ? undefined : { changed: floatChanged, max: floatMax, underDisplayGate: floatMax < 1 / 255 },
          gpuPassPixels: diag.passPixels, cpuPassPixels: ediag.passPixels,
          multiresBlurPasses: diag.multiresBlurPasses, multiresBlurReducedPixels: diag.multiresBlurReducedPixels,
        })
        publish()
        } catch (caseError) {
          report.cases.push({ target: target.label, deviceScale: scale, status: 'blocked', error: String(caseError) })
          publish()
        }
      }
    }
    report.status = 'measured'
  } catch (error) {
    report.status = 'failed'; report.error = String(error)
  } finally {
    cpu.dispose(); gpu.dispose(); publish()
  }
}

;(window as unknown as { __multiresCheck: (bytes: Uint8Array) => Promise<void> }).__multiresCheck = run
publish()