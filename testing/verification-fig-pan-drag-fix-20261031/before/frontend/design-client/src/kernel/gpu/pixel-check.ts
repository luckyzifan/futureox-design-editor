import { KernelClient } from '../client'
import { pixelCases, expectedCoverage } from '../../pixel-fixtures'
const run = document.querySelector<HTMLButtonElement>('#run')!,
  status = document.querySelector('#status')!,
  results = document.querySelector('#results')!
run.onclick = async () => {
  run.disabled = true
  results.replaceChildren()
  const records: unknown[] = []
  let failures = 0
  const client = new KernelClient()
  try {
    for (const c of pixelCases()) {
      const section = document.createElement('section'),
        heading = document.createElement('h2'),
        pre = document.createElement('pre')
      heading.textContent = c.name
      section.append(heading, pre)
      results.append(section)
      const metrics = []
      for (const backend of ['cpu', 'webgpu', 'webgl2'] as const) {
        status.textContent = `运行 ${c.name} / ${backend}`
        const r = await client.render(c.document, c.options, false, backend, true)
        r.bitmap?.close()
        let max = 0,
          sum = 0,
          bad = 0,
          mass = 0,
          cx = 0,
          cy = 0,
          expectedMass = 0,
          expectedX = 0,
          expectedY = 0
        for (let y = 0; y < 80; y++)
          for (let x = 0; x < 80; x++) {
            const expected = expectedCoverage(c.bounds, x, y),
              actual = r.bytes[(y * 80 + x) * 4 + 3] / 255
            const error = Math.abs(Math.round(expected * 255) - r.bytes[(y * 80 + x) * 4 + 3])
            max = Math.max(max, error)
            sum += error
            if (error > 1) bad++
            mass += actual
            cx += actual * (x + 0.5)
            cy += actual * (y + 0.5)
            expectedMass += expected
            expectedX += expected * (x + 0.5)
            expectedY += expected * (y + 0.5)
          }
        const metric = {
          backend,
          maxAlphaError: max,
          meanAlphaError: sum / 6400,
          pixelsOutsideTolerance: bad,
          coverageCentroidErrorPx: Math.hypot(
            cx / mass - expectedX / expectedMass,
            cy / mass - expectedY / expectedMass,
          ),
          passed: max <= 1,
        }
        if (!metric.passed) failures++
        metrics.push(metric)
        const canvas = document.createElement('canvas')
        canvas.width = 80
        canvas.height = 80
        canvas.title = backend
        canvas
          .getContext('2d')!
          .putImageData(new ImageData(new Uint8ClampedArray(r.bytes), 80, 80), 0, 0)
        section.append(canvas)
      }
      records.push({ name: c.name, metrics })
      pre.textContent = JSON.stringify(metrics, null, 2)
    }
    status.textContent = `完成：${records.length} 组 / 3 后端，${failures} 项超过 1/255 透明度容差`
    status.setAttribute('data-results', JSON.stringify(records))
  } catch (error) {
    status.textContent = String(error)
  } finally {
    client.dispose()
    run.disabled = false
  }
}
