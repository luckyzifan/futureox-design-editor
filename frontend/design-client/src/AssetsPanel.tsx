import { useState } from 'react'
import type { Editor } from './engine'
import { family } from './components'
import { usePropertyText } from './property-interface-messages'
export function AssetsPanel({ editor }: { editor: Editor }) {
  const { tr } = usePropertyText()
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
        aria-label={tr('搜索组件')}
        placeholder={tr('搜索本地组件…')}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <button
        className="text-button"
        disabled={!editor.state.selection.length}
        onClick={() => editor.createComponent()}
      >
        {tr('◇ 从选择创建组件')}
      </button>
      <p className="muted">{tr('点击插入，或拖入画布')}</p>
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
          <strong title={n.name}>◇ {n.name}</strong>
          <small>
            {family(doc, n.id)?.name || tr('本地组件')}
            {Object.keys(n.component!.variants).length
              ? ` · ${Object.values(n.component!.variants).join(' / ')}`
              : ''}
          </small>
        </button>
      ))}
      {!items.length && <p className="muted">{tr('暂无匹配的组件')}</p>}
    </div>
  )
}
