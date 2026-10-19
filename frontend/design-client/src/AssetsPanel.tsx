import { useState } from 'react'
import type { Editor } from './engine'
import { family } from './components'
export function AssetsPanel({ editor }: { editor: Editor }) {
  const [search, setSearch] = useState('')
  const doc = editor.state.doc
  const items = Object.values(doc.nodes).filter(
    (n) =>
      n.component &&
      !n.instanceOrigin &&
      `${n.name} ${family(doc, n.id)?.name || ''}`.toLowerCase().includes(search.toLowerCase()),
  )
  return (
    <div className="assets-panel">
      <input
        aria-label="搜索组件"
        placeholder="搜索本地组件…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <button
        className="text-button"
        disabled={!editor.state.selection.length}
        onClick={() => editor.createComponent()}
      >
        ◇ 从选择创建组件
      </button>
      <p className="muted">点击插入，或拖入画布</p>
      {items.map((n) => (
        <button
          className="component-asset"
          draggable
          key={n.id}
          onDragStart={(e) => {
            e.dataTransfer.setData('application/x-forma-component', n.id)
            e.dataTransfer.effectAllowed = 'copy'
          }}
          onClick={() => editor.insertComponent(n.id)}
        >
          <strong>◇ {n.name}</strong>
          <small>
            {family(doc, n.id)?.name || '本地组件'}
            {Object.keys(n.component!.variants).length
              ? ` · ${Object.values(n.component!.variants).join(' / ')}`
              : ''}
          </small>
        </button>
      ))}
      {!items.length && <p className="muted">暂无匹配的组件</p>}
    </div>
  )
}
