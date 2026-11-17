import { Component, Frame, Paintbrush, Search, SquareDashed, SwatchBook, Type } from 'lucide-react'
import { useId, useMemo, useState, type RefObject } from 'react'
import { variableValue } from './design-system'
import type { DesignDocument } from './model'
import { usePropertyText } from './property-interface-messages'

export const sketchComponentCategories = [
  ['symbols', '符号', Component],
  ['text', '文本样式', Type],
  ['layer', '图层样式', Paintbrush],
  ['color', '颜色变量', SwatchBook],
  ['frames', '画框模板', Frame],
  ['graphics', '图形模板', SquareDashed],
] as const
export type SketchComponentCategory = typeof sketchComponentCategories[number][0]
type Item = { id: string; name: string; detail?: string; color?: string }

function itemsFor(doc: DesignDocument, category: SketchComponentCategory): Item[] {
  const system = doc.designSystem
  if (category === 'text' || category === 'layer') {
    const kind = category === 'text' ? 'text' : 'paint'
    return Object.entries(system?.styles ?? {}).flatMap(([id, style]) =>
      style.kind === kind || (category === 'layer' && style.kind === 'effect') ? [{ id, name: style.name }] : [])
  }
  if (category === 'color') {
    if (!system) return []
    return Object.entries(system.variables).flatMap(([id, variable]) => {
      if (variable.kind !== 'color') return []
      let color: unknown
      try { color = variableValue(system, id) } catch { /* The name is still available. */ }
      return [{ id, name: variable.name, color: typeof color === 'string' ? color : undefined }]
    })
  }
  const libraryNodes = new Set(Object.values(system?.libraries ?? {})
    .flatMap(library => [...library.componentIds, ...Object.values(library.nodeMap)]))
  return Object.values(doc.nodes).flatMap(node => {
    if (node.instanceOrigin || libraryNodes.has(node.id)) return []
    if (category === 'symbols') {
      if (!node.component) return []
      return [{ id: node.id, name: node.name, detail: Object.values(node.component.variants).join(' / ') }]
    }
    if (!node.sketchTemplate || (category === 'graphics') !== !!node.graphic) return []
    return [{ id: node.id, name: node.name, detail: `${node.width} × ${node.height}` }]
  })
}

export function SketchComponentsView({ document, category, onCategory, searchField, onInsert }: {
  document: DesignDocument
  category: SketchComponentCategory
  onCategory: (category: SketchComponentCategory) => void
  searchField: RefObject<HTMLInputElement | null>
  onInsert: (id: string) => void
}) {
  const { tr, locale } = usePropertyText()
  const id = useId()
  const [query, setQuery] = useState('')
  const items = useMemo(() => itemsFor(document, category), [document, category])
  const needle = query.trim().toLocaleLowerCase()
  const visible = items.filter(item => `${item.name} ${item.detail ?? ''}`.toLocaleLowerCase().includes(needle))
  const active = sketchComponentCategories.find(([key]) => key === category)!
  const Icon = active[2]
  return <section className="sketch-components-view" aria-label={tr('组件视图')}>
    <div className="sketch-components-bar">
      <div className="layer-tabs" role="tablist" aria-label={tr('组件视图')}>
        {sketchComponentCategories.map(([key, label, CategoryIcon], index) =>
          <button key={key} type="button" role="tab" id={`${id}-${key}`} aria-controls={`${id}-panel`}
            aria-selected={category === key} aria-pressed={category === key} tabIndex={category === key ? 0 : -1}
            aria-keyshortcuts={`Meta+${index + 1}`} onClick={() => onCategory(key)} onKeyDown={event => {
              if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
              const count = sketchComponentCategories.length
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? count - 1 :
                event.key === 'ArrowRight' ? (index + 1) % count : event.key === 'ArrowLeft' ? (index + count - 1) % count : null
              if (next === null) return
              event.preventDefault()
              const target = sketchComponentCategories[next][0]
              onCategory(target)
              event.currentTarget.parentElement?.querySelectorAll('button')[next]?.focus()
            }}><CategoryIcon size={15} aria-hidden="true" />{label === '图层样式' && locale === 'en' ? 'Layer styles' : tr(label)}</button>)}
      </div>
      <label className="layer-search">
        <Search size={14} aria-hidden="true" />
        <input ref={searchField} aria-label={tr('搜索组件')} placeholder={tr('搜索本地组件…')}
          value={query} onChange={event => setQuery(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Escape' && query) { event.stopPropagation(); setQuery('') }
          }} />
      </label>
    </div>
    <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${category}`} className="sketch-components-list">
      {visible.length ? <ul>
        {visible.map(item => <li key={item.id}>
          {item.color ? <span className="component-swatch" style={{ background: item.color }} /> : <Icon size={17} aria-hidden="true" />}
          <span><strong>{item.name}</strong>{item.detail && <small>{item.detail}</small>}</span>
          {category === 'symbols' && <button type="button" className="text-button"
            aria-label={`${tr('插入')} ${item.name}`} onClick={() => onInsert(item.id)}>{tr('插入')}</button>}
        </li>)}
      </ul> : <p className="muted">{tr(needle ? '暂无匹配的组件' : '此类别暂无本地资源')}</p>}
    </div>
  </section>
}
