import { blank, node, paint, type Paint } from '../../model'
import { KernelClient } from '../client'
import { initializePicking } from '../picking'
const output = document.querySelector('#results')!
const report: { status: string; stages: unknown[]; error?: string } = { status: 'running', stages: [] }
const client = new KernelClient()
try {
  await initializePicking()
  for (const profile of ['analytic', 'figmaSubpixel'] as const)
    for (const kind of ['linear', 'radial', 'angular', 'diamond'] as Paint['kind'][]) {
      const document = blank(`${profile} ${kind} alpha`), shape = node('rectangle', 0, 0, 128, 64)
      document.schemaVersion = 4
      const fill = paint('#000000', kind)
      fill.opacity = .5; fill.angle = 0
      fill.stops = [{ offset: 0, color: 'color(srgb 1 0.5 0.25 / 0.0001)' },
        { offset: 1, color: 'color(srgb 0.25 0.5 1 / 0.75)' }]
      shape.fills = [fill]; document.nodes = { [shape.id]: shape }; document.pages[0].children = [shape.id]
      const options = { pageId: document.pages[0].id, width: 128, height: 64, view: { x: 0, y: 0, zoom: 1 },
        grid: false, transparent: true, rasterProfile: profile }
      const reference = await client.render(document, options, false, 'cpu', true)
      for (const backend of ['webgpu', 'webgl2'] as const) {
        const actual = await client.render(document, options, false, backend, true)
        let max = 0, maxAlpha = 0
        if (actual.bytes.length !== reference.bytes.length) throw Error('Missing GPU pixels')
        for (let i = 0; i < actual.bytes.length; i += 4) {
          const a = actual.bytes[i + 3], b = reference.bytes[i + 3]
          maxAlpha = Math.max(maxAlpha, Math.abs(a - b))
          for (let c = 0; c < 3; c++) max = Math.max(max,
            Math.abs(actual.bytes[i + c] * a / 255 - reference.bytes[i + c] * b / 255))
        }
        report.stages.push({ profile, kind, backend, maxPremultipliedError: max, maxAlphaError: maxAlpha })
        if (max > 2 || maxAlpha > 2) throw Error(`Gradient alpha mismatch: ${JSON.stringify(report.stages.at(-1))}`)
        const canvas = window.document.querySelector<HTMLCanvasElement>('#preview')!
        canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(actual.bytes), 128, 64), 0, 0)
        actual.bitmap?.close()
      }
      reference.bitmap?.close()
    }
  report.status = 'passed'
} catch (error) { report.status = 'failed'; report.error = String(error) }
finally { client.dispose(); output.textContent = JSON.stringify(report, null, 2) }
