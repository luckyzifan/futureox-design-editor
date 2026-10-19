import { useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { Editor } from './engine'
import { Canvas } from './Canvas'
import { Inspector } from './Inspector'
import { initializePicking, kernelLayout } from './kernel/picking'
import { KernelClient } from './kernel/client'
import { layoutFixture, named, type LayoutExample } from './layout-fixtures'
import { defaultSizing, validateDocument, blank, node } from './model'
import './styles.css'
await initializePicking()
const editor = new Editor()
editor.load(layoutFixture('horizontal'))
editor.select([named(editor.state.doc, '容器').id])
editor.set({ view: { x: 16, y: 28, zoom: 0.72 }, grid: false })
const assert = (ok: unknown, message: string) => {
  if (!ok) throw new Error(message)
}
function Harness() {
  const s = useSyncExternalStore(editor.subscribe, editor.snapshot),
    [report, setReport] = useState('就绪'),
    [busy, setBusy] = useState(false)
  async function run() {
    setBusy(true)
    const checks: string[] = []
    const e = new Editor()
    const client = new KernelClient()
    try {
      e.load(layoutFixture('horizontal'))
      let p = named(e.state.doc, '容器'),
        a = named(e.state.doc, '固定项目'),
        b = named(e.state.doc, '填满项目')
      assert(b.width === 196 && b.height === 88, 'fill allocation')
      e.update([p.id], { width: 400, height: 170 })
      assert(
        named(e.state.doc, '填满项目').width === 296 &&
          named(e.state.doc, '填满项目').height === 138,
        'parent resize',
      )
      e.undo()
      assert(named(e.state.doc, '填满项目').width === 196, 'undo resize')
      e.redo()
      assert(named(e.state.doc, '填满项目').width === 296, 'redo resize')
      checks.push('填满尺寸、父级缩放、撤销重做')
      e.load(layoutFixture('wrap'))
      p = named(e.state.doc, '容器')
      assert(p.height === 146, 'wrap initial')
      e.update([p.id], { width: 150 })
      assert(named(e.state.doc, '容器').height === 230, 'wrap reflow')
      e.undo()
      const last = named(e.state.doc, '项目 5')
      e.update([last.id], { sizing: { ...defaultSizing(), absolute: true } })
      assert(named(e.state.doc, '容器').height === 104, 'absolute excluded')
      checks.push('换行、内容自适应、绝对定位')
      e.load(layoutFixture('constraints'))
      p = named(e.state.doc, '容器')
      e.update([p.id], { width: 400, height: 200 })
      a = named(e.state.doc, '右下锚定')
      b = named(e.state.doc, '水平拉伸')
      assert(
        a.transform[4] === 300 &&
          a.transform[5] === 130 &&
          b.width === 180 &&
          b.transform[5] === 45,
        'constraints',
      )
      checks.push('右下锚定、拉伸与居中约束')
      e.load(layoutFixture('text'))
      p = named(e.state.doc, '容器')
      const old = p.width
      const text = named(e.state.doc, '文字')
      e.update([text.id], { text: '让想法自由生长，布局随内容变化' })
      assert(named(e.state.doc, '容器').width > old, 'text hug')
      checks.push('Rust 字体测量驱动文字自适应')
      e.load(layoutFixture('wrap'))
      p = named(e.state.doc, '容器')
      const first = p.children[0]
      e.begin('布局内重排')
      assert(e.previewLayoutOrder(first, { x: 120, y: 155 }), 'drag handled')
      e.commit()
      assert(named(e.state.doc, '容器').children.at(-1) === first, 'drag reorder')
      e.undo()
      assert(named(e.state.doc, '容器').children[0] === first, 'reorder undo')
      checks.push('拖动重排与单次撤销')
      const d = blank()
      const x = node('rectangle', 10, 10, 50, 30),
        y = node('rectangle', 80, 10, 60, 30)
      d.nodes[x.id] = x
      d.nodes[y.id] = y
      d.pages[0].children = [x.id, y.id]
      e.load(d)
      e.select([x.id, y.id])
      e.autoLayout()
      assert(Object.keys(e.state.doc.nodes).length === 3, 'wrap selection')
      e.undo()
      assert(Object.keys(e.state.doc.nodes).length === 2, 'atomic wrap undo')
      checks.push('多选创建自动布局为一个撤销操作')
      e.load(layoutFixture('grid'))
      const saved = JSON.stringify(e.state.doc)
      e.load(validateDocument(JSON.parse(saved)))
      assert(JSON.stringify(e.state.doc) === saved, 'roundtrip')
      assert(JSON.stringify(kernelLayout(e.state.doc)) === saved, 'idempotence')
      checks.push('网格跨行跨列、文件往返、幂等重排')
      const results = new Map<string, Uint8Array>()
      for (const backend of ['cpu', 'webgpu', 'webgl2'] as const) {
        const result = await client.render(
          e.state.doc,
          {
            pageId: e.state.page,
            width: 420,
            height: 280,
            view: { x: 0, y: 0, zoom: 1 },
            transparent: false,
            grid: false,
          },
          false,
          backend,
          true,
        )
        result.bitmap?.close()
        results.set(backend, result.bytes)
      }
      let max = 0
      const wg = results.get('webgpu')!,
        gl = results.get('webgl2')!
      for (let i = 0; i < wg.length; i++) max = Math.max(max, Math.abs(wg[i] - gl[i]))
      assert(max <= 1, 'GPU parity')
      const cpu = results.get('cpu')!
      for (const n of Object.values(e.state.doc.nodes).filter((n) => n.name.startsWith('网格'))) {
        const parent = named(e.state.doc, '容器'),
          px = Math.floor(parent.transform[4] + n.transform[4] + n.width / 2),
          py = Math.floor(parent.transform[5] + n.transform[5] + n.height / 2),
          at = (py * 420 + px) * 4
        for (let c = 0; c < 4; c++)
          assert(Math.abs(cpu[at + c] - wg[at + c]) <= 1, 'CPU/GPU interior pixel')
      }
      checks.push('CPU / WebGPU / WebGL 2 布局与内部像素一致')
      setReport(`PASS ${checks.length} 项\n${checks.join('\n')}`)
    } catch (error) {
      setReport(`FAIL ${String(error)}\n${checks.join('\n')}`)
    } finally {
      client.dispose()
      setBusy(false)
    }
  }
  return (
    <div
      style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: '#eef0f5' }}
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: 12, background: 'white' }}>
        {(['horizontal', 'wrap', 'grid', 'constraints', 'text'] as LayoutExample[]).map(
          (kind, i) => (
            <button
              key={kind}
              onClick={() => {
                editor.load(layoutFixture(kind))
                editor.select([named(editor.state.doc, '容器').id])
                editor.set({ view: { x: 16, y: 28, zoom: 0.72 }, grid: false })
              }}
            >
              {['横向示例', '换行示例', '网格示例', '约束示例', '文字示例'][i]}
            </button>
          ),
        )}
        <button onClick={run} disabled={busy}>
          运行布局回归
        </button>
        <button onClick={() => editor.undo()} disabled={!editor.canUndo}>
          撤销
        </button>
        <button onClick={() => editor.redo()} disabled={!editor.canRedo}>
          重做
        </button>
      </div>
      <div style={{ display: 'flex', gap: 6, padding: 8, flexWrap: 'wrap' }}>
        {Object.values(s.doc.nodes).map((n) => (
          <button key={n.id} onClick={() => editor.select([n.id])}>
            选择 {n.name}
          </button>
        ))}
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(230px,1fr) 292px',
          minHeight: 360,
          flex: 1,
        }}
      >
        <div
          style={{
            position: 'relative',
            minWidth: 0,
            minHeight: 0,
            display: 'flex',
            overflow: 'hidden',
          }}
        >
          <Canvas editor={editor} />
        </div>
        <Inspector editor={editor} />
      </div>
      <pre
        id="layout-report"
        style={{
          padding: 12,
          margin: 0,
          background: '#fff',
          whiteSpace: 'pre-wrap',
          maxHeight: 140,
          overflow: 'auto',
        }}
      >
        {report}
      </pre>
      <pre
        id="layout-state"
        style={{ padding: 8, margin: 0, fontSize: 11, maxHeight: 100, overflow: 'auto' }}
      >
        {JSON.stringify(
          Object.values(s.doc.nodes).map((n) => ({
            name: n.name,
            x: n.transform[4],
            y: n.transform[5],
            width: n.width,
            height: n.height,
            layout: n.layout,
            sizing: n.sizing,
          })),
          null,
          2,
        )}
      </pre>
    </div>
  )
}
createRoot(document.getElementById('root')!).render(<Harness />)
