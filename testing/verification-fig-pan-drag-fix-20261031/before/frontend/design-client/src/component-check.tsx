import { useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { Editor } from './engine'
import { Canvas } from './Canvas'
import { Inspector } from './Inspector'
import { Layers } from './Layers'
import { initializePicking, kernelLayout } from './kernel/picking'
import { KernelClient } from './kernel/client'
import { componentFixture, originNode } from './component-fixtures'
import { paint, blank, validateDocument } from './model'
import { family } from './components'
import './styles.css'
await initializePicking()
let fixture = componentFixture()
const editor = new Editor(fixture.doc)
editor.select([fixture.ids.a])
editor.set({ view: { x: 20, y: 20, zoom: 1 }, grid: false })
const assert = (value: unknown, message: string) => {
  if (!value) throw new Error(message)
}
function Harness() {
  const state = useSyncExternalStore(editor.subscribe, editor.snapshot),
    [report, setReport] = useState('就绪'),
    [busy, setBusy] = useState(false)
  async function run() {
    setBusy(true)
    const checks: string[] = []
    const client = new KernelClient()
    try {
      const f = componentFixture(),
        e = new Editor(f.doc),
        ids = f.ids,
        key = e.state.doc.nodes[ids.label].componentKey!
      e.setComponentProperty(ids.a, ids.title, '立即提交')
      e.update([ids.label], { text: '新的默认' })
      assert(originNode(e.state.doc, ids.a, key).text === '立即提交', 'override lost')
      assert(originNode(e.state.doc, ids.b, key).text === '新的默认', 'main edit did not propagate')
      checks.push('主组件联动与实例文本覆盖')
      const width = e.state.doc.nodes[ids.a].width
      e.setComponentProperty(ids.a, ids.show, false)
      assert(e.state.doc.nodes[ids.a].width < width, 'boolean property layout')
      e.setComponentProperty(ids.a, ids.icon, ids.iconB)
      assert(
        originNode(e.state.doc, ids.a, e.state.doc.nodes[ids.slot].componentKey!).instance!
          .componentId === ids.iconB,
        'nested swap',
      )
      checks.push('显示开关、嵌套实例替换与自动布局')
      const stable = originNode(e.state.doc, ids.a, key).id,
        variant = e.addVariant(ids.button)
      e.update([variant], { fills: [paint('#fde6ce')] })
      e.swapInstance(ids.a, variant)
      assert(
        originNode(e.state.doc, ids.a, key).id === stable &&
          originNode(e.state.doc, ids.a, key).text === '立即提交',
        'variant override identity',
      )
      assert(e.state.doc.nodes[ids.a].fills[0].color === '#fde6ce', 'variant style')
      e.undo()
      assert(e.state.doc.nodes[ids.a].instance!.componentId === ids.button, 'undo variant')
      e.redo()
      assert(e.state.doc.nodes[ids.a].instance!.componentId === variant, 'redo variant')
      checks.push('变体切换、稳定图层标识、撤销重做')
      const before = e.state.doc
      e.setComponentProperty(ids.a, ids.icon, variant)
      assert(e.state.doc === before, 'cycle accepted')
      checks.push('动态组件循环原子拒绝')
      e.select([ids.a])
      e.copy()
      const snapshot = e.state.doc
      e.load(blank('粘贴验证'))
      e.paste()
      assert(
        e.state.doc.nodes[e.state.selection[0]]?.instance?.componentId === variant,
        'cross document instance',
      )
      assert(family(e.state.doc, variant), 'variant set not imported')
      assert(e.state.doc.nodes[ids.iconB]?.component, 'nested dependency not imported')
      checks.push('跨文件复制携带变体和嵌套依赖')
      e.load(snapshot)
      const saved = JSON.stringify(e.state.doc)
      e.load(JSON.parse(saved))
      assert(JSON.stringify(kernelLayout(e.state.doc)) === saved, 'save roundtrip')
      checks.push('保存重开与幂等展开')
      const buffers = new Map<string, Uint8Array>()
      for (const backend of ['cpu', 'webgpu', 'webgl2'] as const) {
        const result = await client.render(
          e.state.doc,
          {
            pageId: e.state.page,
            width: 640,
            height: 360,
            view: { x: 0, y: 0, zoom: 1 },
            transparent: false,
            grid: false,
          },
          false,
          backend,
          true,
        )
        assert(result.backend === backend, 'unexpected fallback')
        result.bitmap?.close()
        buffers.set(backend, result.bytes)
      }
      const a = buffers.get('webgpu')!,
        b = buffers.get('webgl2')!
      let max = 0
      for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i] - b[i]))
      assert(max <= 2, `GPU mismatch ${max}`)
      checks.push(`CPU / WebGPU / WebGL 2 渲染成功，GPU 最大通道差 ${max}`)
      e.detachInstance(ids.a)
      assert(!e.state.doc.nodes[ids.a].instance, 'detach failed')
      e.undo()
      assert(e.state.doc.nodes[ids.a].instance, 'detach undo failed')
      e.select([ids.iconA])
      e.remove()
      assert(!e.state.doc.nodes[ids.iconA], 'delete failed')
      validateDocument(e.state.doc)
      e.undo()
      assert(e.state.doc.nodes[ids.iconA]?.component, 'delete undo failed')
      checks.push('分离、删除主组件保留外观、撤销恢复关联')
      setReport(`PASS ${checks.length} 项\n${checks.join('\n')}`)
    } catch (e) {
      setReport(`FAIL ${String(e)}\n${checks.join('\n')}`)
    } finally {
      client.dispose()
      setBusy(false)
    }
  }
  return (
    <div
      style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: '#eef0f5' }}
    >
      <div style={{ display: 'flex', gap: 8, padding: 12, background: 'white', flexWrap: 'wrap' }}>
        <button
          onClick={() => {
            fixture = componentFixture()
            editor.load(fixture.doc)
            editor.select([fixture.ids.a])
            editor.set({ view: { x: 20, y: 20, zoom: 1 }, grid: false })
          }}
        >
          重置示例
        </button>
        <button onClick={() => editor.select([fixture.ids.button])}>选择主组件</button>
        <button onClick={() => editor.select([fixture.ids.a])}>选择实例 A</button>
        <button onClick={() => editor.select([fixture.ids.b])}>选择实例 B</button>
        <button onClick={() => editor.addVariant(fixture.ids.button)}>新增变体</button>
        <button onClick={run} disabled={busy}>
          运行组件回归
        </button>
        <button onClick={() => editor.undo()} disabled={!editor.canUndo}>
          撤销
        </button>
        <button onClick={() => editor.redo()} disabled={!editor.canRedo}>
          重做
        </button>
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '208px minmax(300px,1fr) 292px',
          flex: 1,
          minHeight: 360,
        }}
      >
        <Layers editor={editor} />
        <div
          style={{
            display: 'flex',
            position: 'relative',
            minWidth: 0,
            minHeight: 0,
            overflow: 'hidden',
          }}
        >
          <Canvas editor={editor} />
        </div>
        <Inspector editor={editor} />
      </div>
      <pre
        id="component-report"
        style={{
          margin: 0,
          padding: 10,
          maxHeight: 150,
          overflow: 'auto',
          whiteSpace: 'pre-wrap',
          background: 'white',
        }}
      >
        {report}
      </pre>
      <pre
        id="component-state"
        style={{ margin: 0, padding: 10, maxHeight: 90, overflow: 'auto', fontSize: 11 }}
      >
        {JSON.stringify(
          {
            message: state.message,
            selection: state.selection,
            nodes: Object.values(state.doc.nodes).map((n) => ({
              id: n.id,
              name: n.name,
              text: n.text,
              visible: n.visible,
              width: n.width,
              component: n.component,
              instance: n.instance,
              origin: n.instanceOrigin,
            })),
          },
          null,
          2,
        )}
      </pre>
    </div>
  )
}
createRoot(document.getElementById('root')!).render(<Harness />)
