import { authoringFixture } from './authoring-fixture'
import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { initializePicking, kernelLayout } from './kernel/picking'
import { KernelClient } from './kernel/client'
import { blank, node, paint, uid } from './model'
import { Editor } from './engine'
import { Canvas } from './Canvas'
import { Layers } from './Layers'
import { Inspector } from './Inspector'
import { DesignTools } from './DesignTools'
import { importSvg } from './import-svg'
import { exportImage, exportVisualSvg } from './export'
import './styles.css'
await initializePicking()
const { doc, textId } = authoringFixture()
const editor = new Editor(doc)
editor.set({ grid: false, view: { x: 20, y: 20, zoom: 1 } })
editor.select([textId])
function Harness() {
  const [status, setStatus] = useState('就绪'),
    [tools, setTools] = useState(false),
    [records, setRecords] = useState<unknown[]>([])
  const run = async () => {
    const client = new KernelClient()
    try {
      const results: unknown[] = []
      let baseline: Uint8Array | undefined
      for (const backend of ['cpu', 'webgpu', 'webgl2'] as const) {
        setStatus(`正在验证 ${backend}`)
        const r = await client.render(
          doc,
          {
            pageId: doc.pages[0].id,
            width: 460,
            height: 280,
            view: { x: 0, y: 0, zoom: 1 },
            grid: false,
            transparent: true,
            rasterProfile: 'figma',
          },
          false,
          backend,
          true,
        )
        r.bitmap?.close()
        if (r.backend !== backend) throw new Error(`${backend} 未实际执行`)
        if (!baseline) baseline = r.bytes
        const max = r.bytes.reduce((max, v, i) => Math.max(max, Math.abs(v - baseline![i])), 0)
        results.push({ backend, max })
        if (max !== 0) throw new Error(`${backend} 与 CPU 差异 ${max}，要求逐字节一致`)
      }
      const imported = importSvg(
        '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="160" viewBox="0 0 100 80"><defs><linearGradient id="g"><stop stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient><clipPath id="c"><circle cx="50" cy="40" r="30"/></clipPath></defs><rect x="10" y="10" width="80" height="60" fill="url(#g)" clip-path="url(#c)"/><path d="M10 20 C30 0 70 0 90 20 L90 60Z" fill="none" stroke="#222222"/></svg>',
      )
      const resolved = kernelLayout(imported.document)
      const svg = await exportImage(resolved, resolved.pages[0].id, 'svg')
      if (!(await svg.blob.text()).includes('<path')) throw new Error('SVG 可编辑路径丢失')
      results.push({ svgImport: true, nodes: Object.keys(resolved.nodes).length })
      const visual = await exportVisualSvg(doc, doc.pages[0].id)
      if (!(await visual.blob.text()).includes('data:image/png;base64'))
        throw new Error('SVG 视觉导出缺少栅格效果')
      results.push({ visualSvg: true })
      setRecords(results)
      setStatus('通过')
    } catch (e) {
      setStatus(String(e))
    } finally {
      client.dispose()
    }
  }
  return (
    <>
      <header className="toolbar">
        <button type="button" onClick={run}>执行回归</button>
        <button type="button" onClick={() => setTools(true)}>设计系统与原型</button>
        <span id="authoring-status">{status}</span>
      </header>
      <pre id="authoring-results">{JSON.stringify(records)}</pre>
      <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr 300px', height: 650 }}>
        <Layers editor={editor} />
        <Canvas editor={editor} />
        <Inspector editor={editor} />
      </div>
      {tools && <DesignTools editor={editor} onClose={() => setTools(false)} />}
    </>
  )
}
createRoot(document.getElementById('root')!).render(<Harness />)
