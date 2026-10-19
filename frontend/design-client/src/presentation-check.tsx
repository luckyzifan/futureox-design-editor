import { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { KernelSurface } from './kernel/Surface'
import { blank, node, paint } from './model'
const doc = blank('显示映射'),
  n = node('rectangle', 100, 20, 1, 100)
n.fills = [paint('#000000')]
doc.nodes[n.id] = n
doc.pages[0].children = [n.id]
const sizes = [780.51, 780.25, 377.328125]
function Harness() {
  const [i, setI] = useState(0),
    [result, setResult] = useState<unknown>(null),
    host = useRef<HTMLDivElement>(null)
  const verify = () => {
    const canvas = host.current!.querySelector('canvas')!,
      box = canvas.getBoundingClientRect(),
      parent = host.current!.getBoundingClientRect(),
      scale = Number(canvas.dataset.renderScale)
    if (!scale) {
      setResult({ error: '渲染尚未完成' })
      return
    }
    const errors = [0, 0.5, 10.125, sizes[i] - 1].map((x) =>
      Math.abs(box.left + ((x * scale) / canvas.width) * box.width - (parent.left + x)),
    )
    setResult({
      cssContainerWidth: sizes[i],
      bitmapWidth: canvas.width,
      displayedWidth: box.width,
      renderScale: scale,
      maxPositionErrorPx: Math.max(...errors),
      passed: Math.max(...errors) < 1 / 64,
    })
  }
  return (
    <main style={{ fontFamily: 'system-ui', padding: 24 }}>
      <h1>画布显示映射检查</h1>
      <button onClick={() => setI((i + 1) % sizes.length)}>切换小数宽度</button>
      <button onClick={verify}>验证显示映射</button>
      <p>当前宽度：{sizes[i]} CSS px</p>
      <pre id="result">{JSON.stringify(result, null, 2)}</pre>
      <div
        ref={host}
        style={{ position: 'relative', width: sizes[i], height: 180.4, overflow: 'hidden' }}
      >
        <KernelSurface
          document={doc}
          pageId={doc.pages[0].id}
          width={sizes[i]}
          height={180.4}
          view={{ x: 0, y: 0, zoom: 1 }}
          grid={false}
        />
      </div>
    </main>
  )
}
createRoot(document.getElementById('root')!).render(<Harness />)
