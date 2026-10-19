import { KernelClient } from '../client'
import {
  figmaFixture,
  referenceSize,
  referenceScale,
  type ReferenceCase,
} from '../../figma-fixtures'
const raw = new URLSearchParams(location.search).has('source')
const button = document.querySelector<HTMLButtonElement>('#run')!,
  referenceSelect = document.querySelector<HTMLSelectElement>('#reference-set')!,
  status = document.querySelector('#status')!,
  summary = document.querySelector<HTMLTableSectionElement>('#summary')!,
  results = document.querySelector('#results')!
button.onclick = async () => {
  button.disabled = true
  referenceSelect.disabled = true
  const referenceSet = referenceSelect.value === 'mcp-2026-10-06' ? 'mcp-2026-10-06' : 'baseline'
  status.removeAttribute('data-error')
  status.setAttribute('data-running', 'true')
  results.replaceChildren()
  summary.replaceChildren()
  status.textContent = '正在渲染并比较原始 RGBA…'
  const client = new KernelClient()
  const records: unknown[] = []
  let failed = 0
  try {
    const cases = (
      referenceSet === 'mcp-2026-10-06'
        ? ['shadow', 'layer-blur', 'backdrop-blur', 'mask-half-overlap']
        : [
            'mask-overlap',
            'mask-outside',
            'rectangle',
            'curve',
            'rotated-curve',
            'alpha-curve',
            'shadow',
            'layer-blur',
            'blur-radii',
            'coverage-overlap',
            'coverage-overlap-2x',
            'group-blur',
            'group-shadow',
            'group-inner-shadow',
            'backdrop-blur',
            'pass-through',
            'pass-through-opacity',
            'isolated-opacity',
            'pass-through-blur',
            'large-nested',
          ]
    ) as ReferenceCase[]
    for (const kind of cases) {
      const doc = figmaFixture(kind),
        size = referenceSize(kind),
        width = size.width * (raw ? 2 : 1),
        height = size.height * (raw ? 2 : 1),
        section = document.createElement('section'),
        h = document.createElement('h2')
      h.textContent = kind
      section.append(h)
      results.append(section)
      let reference: Uint8ClampedArray | undefined
      if (!raw) {
        const response = await fetch(
          `/fidelity/${referenceSet === 'baseline' ? '' : `${referenceSet}/`}${kind}.png`,
        )
        if (!response.ok) throw new Error(`Missing Figma reference: ${kind}`)
        const bitmap = await createImageBitmap(await response.blob())
        if (bitmap.width !== size.width || bitmap.height !== size.height)
          throw new Error('Figma reference dimensions differ')
        const c = document.createElement('canvas')
        c.width = size.width
        c.height = size.height
        c.style.width = `${Math.min(size.width * 2, 384)}px`
        c.style.height = `${(Math.min(size.width * 2, 384) * size.height) / size.width}px`
        c.getContext('2d')!.drawImage(bitmap, 0, 0)
        bitmap.close()
        reference = c.getContext('2d')!.getImageData(0, 0, size.width, size.height).data
        c.title = 'Figma'
        section.append(c)
      }
      let cpuBytes: Uint8Array | undefined
      for (const backend of ['cpu', 'webgpu', 'webgl2'] as const) {
        const r = await client.render(
          doc,
          {
            pageId: doc.pages[0].id,
            width,
            height,
            view: { x: 0, y: 0, zoom: referenceScale(kind) * (raw ? 2 : 1) },
            transparent: kind === 'alpha-curve',
            grid: false,
            rasterProfile: raw ? 'figmaSubpixel' : 'figma',
          },
          false,
          backend,
          true,
        )
        r.bitmap?.close()
        if (r.backend !== backend) throw new Error(`请求 ${backend}，实际执行 ${r.backend}`)
        if (backend === 'cpu') cpuBytes = r.bytes
        let backendMaxError = 0,
          backendDifferentPixels = 0
        for (let i = 0; i < r.bytes.length; i += 4) {
          let pixelError = 0
          for (let c = 0; c < 4; c++)
            pixelError = Math.max(pixelError, Math.abs(r.bytes[i + c] - cpuBytes![i + c]))
          backendMaxError = Math.max(backendMaxError, pixelError)
          if (pixelError) backendDifferentPixels++
        }
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        canvas.style.width = `${Math.min(size.width * 2, 384)}px`
        canvas.style.height = `${(Math.min(size.width * 2, 384) * size.height) / size.width}px`
        canvas.id = `${kind}-${backend}`
        canvas.title = backend
        canvas
          .getContext('2d')!
          .putImageData(new ImageData(new Uint8ClampedArray(r.bytes), width, height), 0, 0)
        section.append(canvas)
        const link = document.createElement('a')
        link.textContent = `下载 ${kind} ${backend} PNG`
        link.download = `Core-render-${kind}-${backend}-20261005.png`
        link.href = canvas.toDataURL('image/png')
        section.append(link)
        if (reference) {
          let max = 0,
            different = 0,
            sum = 0
          const heat = new Uint8ClampedArray(r.bytes.length)
          const firstDifferences: { x: number; y: number; expected: number[]; actual: number[] }[] =
            []
          for (let i = 0; i < r.bytes.length; i += 4) {
            let pixel = 0
            for (let ch = 0; ch < 4; ch++) {
              const delta = Math.abs(r.bytes[i + ch] - reference[i + ch])
              max = Math.max(max, delta)
              pixel = Math.max(pixel, delta)
              sum += delta
            }
            heat[i] = Math.min(255, pixel * 64)
            heat[i + 3] = 255
            if (pixel) {
              different++
              if (firstDifferences.length < 12)
                firstDifferences.push({
                  x: (i / 4) % width,
                  y: Math.floor(i / 4 / width),
                  expected: Array.from(reference.slice(i, i + 4)),
                  actual: Array.from(r.bytes.slice(i, i + 4)),
                })
            }
          }
          const record = {
            referenceSet,
            kind,
            backend,
            maxChannelError: max,
            differentPixels: different,
            meanChannelError: sum / r.bytes.length,
            passed: different === 0,
            firstDifferences,
            renderMs: r.renderMs,
            drawCalls: r.drawCalls,
            passPixels: r.passPixels,
            effectLayers: backend === 'cpu' ? r.stats.effectLayers : r.effectLayers,
            backdropReads: backend === 'cpu' ? r.stats.backdropReads : r.backdropReads,
            backendParity: {
              maxChannelError: backendMaxError,
              differentPixels: backendDifferentPixels,
            },
          }
          records.push(record)
          if (!record.passed) failed++
          const row = summary.insertRow()
          for (const value of [
            kind,
            backend,
            `${max}/255`,
            String(different),
            record.passed ? '通过' : '失败',
          ])
            row.insertCell().textContent = value
          row.className = record.passed ? 'pass' : 'fail'
          const heatmap = document.createElement('canvas')
          heatmap.width = width
          heatmap.height = height
          heatmap.style.width = `${Math.min(size.width * 2, 384)}px`
          heatmap.style.height = `${(Math.min(size.width * 2, 384) * size.height) / size.width}px`
          heatmap.title = `${kind} ${backend} 差异放大 64 倍（仅诊断显示，验收无容差）`
          heatmap.getContext('2d')!.putImageData(new ImageData(heat, width, height), 0, 0)
          section.append(heatmap)
          const result = document.createElement('pre')
          result.textContent = JSON.stringify(record, null, 2)
          section.append(result)
        }
      }
    }
    status.textContent = raw
      ? '完成'
      : `严格验收（${referenceSet}）：${records.length} 项，${failed} 项未达到零差异`
    status.setAttribute('data-results', JSON.stringify(records))
  } catch (error) {
    status.textContent = String(error)
    status.setAttribute('data-error', String(error))
  } finally {
    status.setAttribute('data-results', JSON.stringify(records))
    status.setAttribute('data-running', 'false')
    client.dispose()
    button.disabled = false
    referenceSelect.disabled = false
  }
}
