import { createRoot } from 'react-dom/client'
import { useSyncExternalStore } from 'react'
import { initializePicking } from './kernel/picking'
import { figmaFixture } from './figma-fixtures'
import { Editor } from './engine'
import { Canvas } from './Canvas'
import { Layers } from './Layers'
import { Inspector } from './Inspector'
import { node, paint } from './model'
import './styles.css'
await initializePicking()
const doc = figmaFixture('curve'),
  rect = node('rectangle', 8.125, 8.125, 20.4, 12.6)
rect.name = '小数精度样本'
rect.fills = [paint('#4477dd')]
doc.nodes[rect.id] = rect
doc.pages[0].children.push(rect.id)
const curve = Object.values(doc.nodes).find((n) => n.kind === 'vector')!,
  frame = doc.pages[0].children[0],
  editor = new Editor(doc)
editor.select([rect.id])
editor.set({ view: { x: 60, y: 55, zoom: 2 }, grid: false, snap: false })
function Harness() {
  const s = useSyncExternalStore(editor.subscribe, editor.snapshot)
  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header
        style={{ padding: 12, background: 'white', display: 'flex', gap: 10, alignItems: 'center' }}
      >
        <strong>画布行为 / 像素预览</strong>
        <button type="button" onClick={() => editor.select([rect.id])}>
          小数矩形
        </button>
        <button type="button" onClick={() => editor.select([curve.id])}>
          曲线 100×75
        </button>
        <button type="button" onClick={() => editor.select([frame])}>
          画板
        </button>
        <button type="button" onClick={() => editor.set({ view: { x: 60, y: 55, zoom: 4 } })}>
          居中 400%
        </button>
        <button type="button" onClick={() => editor.undo()} disabled={!editor.canUndo}>
          撤销
        </button>
        <output
          data-testid="canvas-state"
          style={{ fontSize: 10, maxWidth: 400, overflow: 'hidden' }}
        >
          {JSON.stringify({
            preview: s.pixelPreview,
            snap: s.snapPixels,
            zoom: s.view.zoom,
            nodes: s.selection.map((id) => ({
              id,
              transform: s.doc.nodes[id].transform,
              width: s.doc.nodes[id].width,
              height: s.doc.nodes[id].height,
            })),
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
