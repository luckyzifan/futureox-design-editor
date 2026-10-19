import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { initializePicking } from './kernel/picking'
import { KernelClient } from './kernel/client'
import { KernelSurface } from './kernel/Surface'
import { colorFixture } from './color-fixture'
await initializePicking()
const images: Record<string, string> = {}
for (const name of ['p3-red-icc', 'pq-highlights', 'hlg-highlights']) {
  const response = await fetch(`/color-fixtures/${name}.png`)
  if (!response.ok) throw new Error(`缺少色彩夹具 ${name}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  images[name] =
    `data:image/png;base64,${btoa(Array.from(bytes, (v) => String.fromCharCode(v)).join(''))}`
}
const doc = colorFixture(images)
const options = {
  pageId: doc.pages[0].id,
  width: 320,
  height: 176,
  view: { x: 0, y: 0, zoom: 1 },
  transparent: false,
  grid: false,
  rasterProfile: 'figma' as const,
}
function pngMetadata(png: Uint8Array) {
  let offset = 8,
    bitDepth = 0,
    cicp: number[] = []
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  while (offset + 12 <= png.length) {
    const n = view.getUint32(offset),
      type = new TextDecoder().decode(png.subarray(offset + 4, offset + 8))
    if (type === 'IHDR') bitDepth = png[offset + 16]
    if (type === 'cICP') cicp = Array.from(png.subarray(offset + 8, offset + 8 + n))
    offset += n + 12
  }
  return { bitDepth, cicp }
}
function Harness() {
  const [status, setStatus] = useState('就绪'),
    [results, setResults] = useState<unknown[]>([]),
    [assets, setAssets] = useState<{ url: string; name: string }[]>([]),
    [busy, setBusy] = useState(false)
  async function check() {
    setBusy(true)
    setStatus('正在验证')
    const records: unknown[] = [],
      client = new KernelClient()
    let cpu: Float32Array | undefined
    try {
      for (const backend of ['cpu', 'webgpu', 'webgl2'] as const) {
        const r = await client.render(doc, options, false, backend, true)
        r.bitmap?.close()
        if (r.backend !== backend || !r.linear) throw new Error(`${backend} 未产生真实浮点输出`)
        if (backend === 'cpu') cpu = r.linear
        let maxError = 0,
          minSignal = 0,
          maxSignal = 0,
          violations = 0
        for (let i = 0; i < r.linear.length; i++) {
          const v = r.linear[i],
            d = Math.abs(v - cpu![i])
          maxError = Math.max(maxError, d)
          if (d > 0.002 + 0.003 * Math.abs(cpu![i])) violations++
          if (i % 4 !== 3) {
            minSignal = Math.min(minSignal, v)
            maxSignal = Math.max(maxSignal, v)
          }
        }
        if (maxSignal <= 1 || minSignal >= 0) throw new Error('HDR 高光或广色域负分量丢失')
        const png = await client.render(
          doc,
          { ...options, colorOutput: { space: 'rec2100-pq', toneMap: 'none' } },
          true,
          backend,
          true,
        )
        if (png.backend !== 'cpu') throw new Error('PNG 文件必须由 CPU 导出')
        const metadata = pngMetadata(png.bytes)
        if (metadata.bitDepth !== 16 || metadata.cicp.join(',') !== '9,16,0,1')
          throw new Error('HDR PNG 未包含正确的 16-bit/PQ/BT.2020 标记')
        records.push({
          totalMs: r.milliseconds,
          compileMs: r.compileMs,
          graphMs: r.graphMs,
          finishMs: r.finishMs,
          backend,
          pngBackend: png.backend,
          intermediateFormat: r.intermediateFormat,
          maxError,
          maxSignal,
          minSignal,
          violations,
          ...metadata,
        })
        const name = `HDR-cpu-export-after-${backend}-preview-rec2100-pq.png`,
          url = URL.createObjectURL(new Blob([new Uint8Array(png.bytes)], { type: 'image/png' }))
        setAssets((a) => [...a, { url, name }])
      }
      setResults(records)
      setStatus(
        `完成：1 份 CPU 浮点基准、2 份 GPU 浮点比较、3 份 CPU PNG；${records.reduce<number>((n, r) => n + (r as { violations: number }).violations, 0)} 个像素通道超出 FP16 误差限`,
      )
    } catch (e) {
      setStatus(String(e))
      setResults(records)
    } finally {
      client.dispose()
      setBusy(false)
    }
  }
  return (
    <main style={{ font: '15px system-ui', padding: 24, maxWidth: 1100, margin: 'auto' }}>
      <h1>广色域与 HDR 内核验收</h1>
      <p>
        工作信号为扩展线性 sRGB；CPU 为 FP32，GPU 为 FP16。此页面验证色彩与动态范围，不作为 Figma
        像素一致性验收。
      </p>
      <button type="button" onClick={() => void check()} disabled={busy}>
        检查三后端与 HDR PNG
      </button>
      <p id="color-check-status" data-results={JSON.stringify(results)}>
        {status}
      </p>
      <div style={{ position: 'relative', height: 352, background: '#000' }}>
        <KernelSurface
          document={doc}
          pageId={doc.pages[0].id}
          width={640}
          height={352}
          view={{ x: 0, y: 0, zoom: 2 }}
          grid={false}
          maxPixelRatio={1}
        />
      </div>
      <pre>{JSON.stringify(results, null, 2)}</pre>
      {assets.map((a) => (
        <p key={a.url}>
          <a href={a.url} download={a.name}>
            {a.name}
          </a>
        </p>
      ))}
    </main>
  )
}
const root = createRoot(document.getElementById('root')!)
root.render(<Harness />)
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount())
