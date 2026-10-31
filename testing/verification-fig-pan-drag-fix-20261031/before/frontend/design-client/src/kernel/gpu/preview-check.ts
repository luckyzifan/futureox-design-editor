import { KernelClient, type KernelOptions } from '../client'
import { blank, node, paint, stroke } from '../../model'
const button = document.querySelector<HTMLButtonElement>('#run')!,
  status = document.querySelector('#status')!,
  results = document.querySelector('#results')!
function expected(x: number, y: number, options: KernelOptions) {
  const density = options.pixelPreview!,
    scale = options.view.zoom / density
  const coverage = (sx: number, sy: number) =>
    Math.round(
      255 *
        Math.max(0, Math.min(sx + 1, 28.525 * density) - Math.max(sx, 8.125 * density)) *
        Math.max(0, Math.min(sy + 1, 20.725 * density) - Math.max(sy, 8.125 * density)),
    )
  if (scale >= 1)
    return coverage(
      Math.floor((x + 0.5 - options.view.x) / scale),
      Math.floor((y + 0.5 - options.view.y) / scale),
    )
  const x0 = (x - options.view.x) / scale,
    y0 = (y - options.view.y) / scale,
    x1 = x0 + 1 / scale,
    y1 = y0 + 1 / scale
  let sum = 0
  for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++)
    for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++)
      sum +=
        coverage(sx, sy) *
        Math.max(0, Math.min(x1, sx + 1) - Math.max(x0, sx)) *
        Math.max(0, Math.min(y1, sy + 1) - Math.max(y0, sy))
  return Math.round(sum * scale * scale)
}
button.onclick = async () => {
  button.disabled = true
  results.replaceChildren()
  const client = new KernelClient(),
    records: unknown[] = []
  let failures = 0
  const doc = blank('Preview sampling'),
    n = node('rectangle', 8.125, 8.125, 20.4, 12.6)
  n.fills = [paint('#4477dd')]
  doc.nodes[n.id] = n
  doc.pages[0].children = [n.id]
  try {
    for (const pixelPreview of [1, 2] as const)
      for (const zoom of [4, 2.5, 1, 0.5])
        for (const offset of [0, 0.375]) {
          const options: KernelOptions = {
            pageId: doc.pages[0].id,
            width: 80,
            height: 80,
            view: { x: offset, y: -offset, zoom },
            transparent: true,
            grid: false,
            pixelPreview,
          }
          const section = document.createElement('section'),
            h = document.createElement('h2'),
            pre = document.createElement('pre')
          h.textContent = `${pixelPreview}x / zoom ${zoom} / pan ${offset}`
          section.append(h, pre)
          results.append(section)
          const metrics = []
          for (const backend of ['cpu', 'webgpu', 'webgl2'] as const) {
            const r = await client.render(doc, options, false, backend, true)
            const canvas = document.createElement('canvas'),
              display = document.createElement('canvas')
            canvas.width = display.width = 80
            canvas.height = display.height = 80
            canvas.title = `${backend} readback`
            display.title = `${backend} bitmap`
            canvas
              .getContext('2d')!
              .putImageData(new ImageData(new Uint8ClampedArray(r.bytes), 80, 80), 0, 0)
            if (r.bitmap) {
              display.getContext('2d')!.drawImage(r.bitmap, 0, 0)
              r.bitmap.close()
            } else
              display
                .getContext('2d')!
                .putImageData(new ImageData(new Uint8ClampedArray(r.bytes), 80, 80), 0, 0)
            const shown = display.getContext('2d')!.getImageData(0, 0, 80, 80).data
            let maxAlphaError = 0,
              outsideTolerance = 0,
              bitmapAlphaError = 0
            for (let y = 0; y < 80; y++)
              for (let x = 0; x < 80; x++) {
                const i = (y * 80 + x) * 4,
                  error = Math.abs(r.bytes[i + 3] - expected(x, y, options))
                maxAlphaError = Math.max(maxAlphaError, error)
                if (error > 1) outsideTolerance++
                bitmapAlphaError = Math.max(
                  bitmapAlphaError,
                  Math.abs(r.bytes[i + 3] - shown[i + 3]),
                )
              }
            const metric = {
              backend,
              maxAlphaError,
              outsideTolerance,
              bitmapAlphaError,
              passed: outsideTolerance === 0 && bitmapAlphaError <= 1,
            }
            if (!metric.passed) failures++
            metrics.push(metric)
            section.append(canvas, display)
          }
          records.push({ pixelPreview, zoom, offset, metrics })
          pre.textContent = JSON.stringify(metrics, null, 2)
        }
    const large = blank('分块覆盖一致性'),
      curve = node('vector', 3.125, 7.25, 980, 780)
    curve.network = {
      fillRule: 'evenodd',
      vertices: [
        { id: 'a', x: 0, y: 0 },
        { id: 'b', x: 980, y: 0 },
        { id: 'c', x: 200, y: 220 },
        { id: 'd', x: 730, y: 220 },
        { id: 'e', x: 730, y: 350 },
        { id: 'f', x: 200, y: 350 },
      ],
      edges: [
        { id: 'ab', from: 'a', to: 'b', c1: { x: -80, y: 1050 }, c2: { x: 1060, y: 1050 } },
        { id: 'ba', from: 'b', to: 'a' },
        ...[
          ['c', 'd'],
          ['d', 'e'],
          ['e', 'f'],
          ['f', 'c'],
        ].map(([from, to], i) => ({ id: `hole-${i}`, from, to })),
      ],
    }
    curve.fills = [{ ...paint('#4477dd'), opacity: 0.63 }]
    curve.strokes = [{ ...stroke('#dc4477', 7.5), dash: '13 5' }]
    large.nodes[curve.id] = curve
    large.pages[0].children = [curve.id]
    for (const backend of ['webgpu', 'webgl2'] as const) {
      const options: KernelOptions = {
          pageId: large.pages[0].id,
          width: 1024,
          height: 832,
          view: { x: 0, y: 0, zoom: 1 },
          transparent: true,
          grid: false,
        },
        whole = await client.render(large, options, false, backend, true)
      whole.bitmap?.close()
      let max = 0,
        bad = 0
      for (const [x, y, w, h] of [
        [0, 0, 512, 416],
        [512, 0, 512, 416],
        [0, 416, 512, 416],
        [512, 416, 512, 416],
      ]) {
        const cropped = await client.render(
          large,
          { ...options, width: w, height: h, view: { x: -x, y: -y, zoom: 1 } },
          false,
          backend,
          true,
        )
        cropped.bitmap?.close()
        for (let py = 0; py < h; py++)
          for (let px = 0; px < w; px++) {
            const a = ((py + y) * 1024 + px + x) * 4,
              b = (py * w + px) * 4
            let delta = 0
            for (let c = 0; c < 4; c++) {
              const av =
                  c === 3 ? whole.bytes[a + c] : (whole.bytes[a + c] * whole.bytes[a + 3]) / 255,
                bv =
                  c === 3
                    ? cropped.bytes[b + c]
                    : (cropped.bytes[b + c] * cropped.bytes[b + 3]) / 255
              delta = Math.max(delta, Math.abs(av - bv))
            }
            max = Math.max(max, delta)
            if (delta > 1) bad++
          }
      }
      const metric = {
        backend,
        case: '16-sample tile boundaries / hole / dashed stroke',
        maxPremultipliedError: max,
        pixelsOutsideTolerance: bad,
        passed: bad === 0,
      }
      if (!metric.passed) failures++
      records.push(metric)
      const pre = document.createElement('pre')
      pre.textContent = JSON.stringify(metric, null, 2)
      results.append(pre)
    }
    status.textContent = `完成：16 组预览 / 3 后端 + 2 项分块验证，${failures} 项失败`
    status.setAttribute('data-results', JSON.stringify(records))
  } catch (error) {
    status.textContent = String(error)
  } finally {
    client.dispose()
    button.disabled = false
  }
}
