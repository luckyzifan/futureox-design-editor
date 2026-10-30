import { createRoot } from 'react-dom/client'
import { useSyncExternalStore } from 'react'
import { Editor } from './engine'
import { Canvas } from './Canvas'
import { Layers } from './Layers'
import { Inspector } from './Inspector'
import { initializePicking } from './kernel/picking'
import { freehandFixture } from './freehand-fixtures'
import './styles.css'
await initializePicking()
const editor = new Editor(freehandFixture())
editor.set({ tool: 'pencil', view: { x: 20, y: 35, zoom: 1 }, grid: false })
function Harness() {
  const s = useSyncExternalStore(editor.subscribe, editor.snapshot)
  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header
        style={{ padding: 12, display: 'flex', gap: 12, alignItems: 'center', background: 'white' }}
      >
        <strong>自研铅笔 / 贝塞尔拟合</strong>
        <button onClick={() => editor.set({ tool: 'pencil' })}>铅笔 B</button>
        <button onClick={() => editor.set({ tool: 'select' })}>选择 V</button>
        <button disabled={!editor.canUndo} onClick={() => editor.undo()}>
          撤销
        </button>
        <button disabled={!editor.canRedo} onClick={() => editor.redo()}>
          重做
        </button>
        <button onClick={() => editor.geometry('outline')}>描边转轮廓</button>
        <output data-testid="freehand-state">
          {JSON.stringify({
            nodes: Object.keys(s.doc.nodes).length,
            selection: s.selection.map((id) => ({
              kind: s.doc.nodes[id].kind,
              curves: s.doc.nodes[id].network?.edges.length,
              width: s.doc.nodes[id].strokes[0]?.width,
              profile: s.doc.nodes[id].strokes[0]?.widthProfile?.length,
            })),
            tool: s.tool,
          })}
        </output>
      </header>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '208px minmax(300px,1fr) 292px',
          flex: 1,
          minHeight: 360,
        }}
      >
        <Layers editor={editor} />
        <Canvas editor={editor} />
        <Inspector editor={editor} />
      </div>
      <footer className="statusbar">{s.message}</footer>
    </div>
  )
}
createRoot(document.getElementById('root')!).render(<Harness />)
