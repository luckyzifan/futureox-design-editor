import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { initializePicking } from './kernel/picking'
import { KernelClient } from './kernel/client'
import { animationFixture } from './animation-fixture'
import { Editor } from './engine'
import { Canvas } from './Canvas'
import { Layers } from './Layers'
import { Inspector } from './Inspector'
import { AnimationPanel } from './AnimationPanel'
import './styles.css'
await initializePicking()
const { doc, clipId, orbId } = animationFixture(),
  editor = new Editor(doc)
editor.select([orbId])
editor.set({ grid: false, view: { x: 40, y: 25, zoom: 1 } })
function Harness() {
  const [status, setStatus] = useState('就绪'),
    [results, setResults] = useState<unknown[]>([]),
    [busy, setBusy] = useState(false)
  async function check() {
    setBusy(true)
    const client = new KernelClient(),
      records: unknown[] = []
    const hashes = new Map<string, string>()
    try {
      for (const timeMs of [0, 125, 300, 600, 900, 1200, 1800, 2400, 300]) {
        const bytes = new Map<string, Uint8Array>()
        for (const backend of ['cpu', 'webgpu', 'webgl2'] as const) {
          setStatus(`${backend} · ${timeMs} ms`)
          const r = await client.render(
            doc,
            {
              pageId: doc.pages[0].id,
              width: 520,
              height: 320,
              view: { x: 0, y: 0, zoom: 1 },
              transparent: false,
              grid: false,
              rasterProfile: 'figma',
              animation: { clipId, timeMs },
            },
            false,
            backend,
            true,
          )
          r.bitmap?.close()
          if (r.backend !== backend) throw new Error(`未执行 ${backend}`)
          bytes.set(backend, r.bytes)
          let max = 0,
            changed = 0
          const firstDifferences: {
            x: number
            y: number
            channel: number
            expected: number
            actual: number
          }[] = []
          const cpu = bytes.get('cpu')!
          for (let i = 0; i < r.bytes.length; i++) {
            const delta = Math.abs(r.bytes[i] - cpu[i])
            max = Math.max(max, delta)
            if (delta) {
              changed++
              if (firstDifferences.length < 8)
                firstDifferences.push({
                  x: Math.floor(i / 4) % 520,
                  y: Math.floor(i / 4 / 520),
                  channel: i % 4,
                  expected: cpu[i],
                  actual: r.bytes[i],
                })
            }
          }
          const sha256 = Array.from(
            new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(r.bytes))),
            (v) => v.toString(16).padStart(2, '0'),
          ).join('')
          const key = `${backend}:${timeMs}`,
            previous = hashes.get(key)
          hashes.set(key, sha256)
          records.push({
            timeMs,
            backend,
            maxChannelError: max,
            differentBytes: changed,
            sha256,
            firstDifferences,
            repeatConsistent: previous === undefined || previous === sha256,
            ms: r.milliseconds,
          })
        }
      }
      setResults(records)
      setStatus(
        `完成：${(records.length / 3) * 2} 项 GPU/CPU 比较，${records.filter((r) => (r as { differentBytes: number; repeatConsistent: boolean }).differentBytes > 0 || !(r as { repeatConsistent: boolean }).repeatConsistent).length} 项失败；${records.length / 3} 帧 CPU 基准`,
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
    <div className="app-shell">
      <header>
        <strong>自研动画内核验收</strong>
        <button type="button" disabled={busy} onClick={() => void check()}>
          检查动画三后端
        </button>
        <span id="animation-check-status" data-results={JSON.stringify(results)}>
          {status}
        </span>
        <button
          type="button"
          onClick={() =>
            editor.update(
              [orbId],
              (n) => {
                n.transform[4] += 40
              },
              '移动动画目标',
            )
          }
        >
          将圆形向右移动 40
        </button>
      </header>
      <main>
        <Layers editor={editor} />
        <Canvas editor={editor} />
        <Inspector editor={editor} />
      </main>
      <AnimationPanel editor={editor} onClose={() => {}} />
    </div>
  )
}
createRoot(document.getElementById('root')!).render(<Harness />)
