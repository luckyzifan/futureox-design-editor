import { createRoot } from 'react-dom/client'
import { useSyncExternalStore } from 'react'
import { Editor } from './engine'
import { Canvas } from './Canvas'
import { Layers } from './Layers'
import { Inspector } from './Inspector'
import { initializePicking } from './kernel/picking'
import { strokeFixture } from './stroke-fixtures'
import './styles.css'
await initializePicking()
const { doc, ids } = strokeFixture(),
  editor = new Editor(doc)
editor.select([ids[0]])
editor.set({ tool: 'width', view: { x: 20, y: 20, zoom: 1 }, grid: false })
function Harness() {
  const s = useSyncExternalStore(editor.subscribe, editor.snapshot)
  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header
        style={{
          padding: 12,
          display: 'flex',
          gap: 12,
          alignItems: 'center',
          flexWrap: 'wrap',
          background: 'white',
        }}
      >
        <strong>自研可变宽度验证</strong>
        <button onClick={() => editor.undo()} disabled={!editor.canUndo}>
          撤销
        </button>
        <button onClick={() => editor.redo()} disabled={!editor.canRedo}>
          重做
        </button>
        <button onClick={() => editor.set({ tool: 'select' })}>选择</button>
        <button onClick={() => editor.set({ tool: 'width' })}>宽度工具</button>
        <button onClick={() => editor.geometry('outline')}>描边转轮廓</button>
        <output
          data-testid="stroke-state"
          style={{ fontSize: 10, maxWidth: 360, overflow: 'hidden' }}
        >
          {JSON.stringify(
            s.selection.map((id) => s.doc.nodes[id]?.strokes.map((st) => st.widthProfile)),
          )}
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
