import { useMemo, useState, useSyncExternalStore } from 'react'
import type { Editor } from './engine'
import { SystemFontPicker } from './SystemFontPicker'
import { applySelectionFont, documentFontChoices, replaceFontReferences, searchFontChoices } from './font-management'

/** Metadata-only panel: no eager font loading, glyph previews, or camera subscriptions. */
export function FontManagementPanel({ editor, ids, includeNative = true, detachSharedStyle, onDetachSharedStyleChange }: { editor: Editor; ids?: string[]; includeNative?: boolean; detachSharedStyle?: boolean; onDetachSharedStyleChange?: (value: boolean) => void }) {
  const { doc, selection } = useSyncExternalStore(editor.subscribe, editor.panelSnapshot)
  const selected = ids || selection
  const choices = useMemo(() => documentFontChoices(doc), [doc.fonts])
  const [query, setQuery] = useState(''), [target, setTarget] = useState('default'), [source, setSource] = useState('default')
  const [scope, setScope] = useState('selection'), [fallbacks, setFallbacks] = useState(false), [localDetach, setLocalDetach] = useState(false)
  const detach = detachSharedStyle ?? localDetach
  const setDetach = onDetachSharedStyleChange || setLocalDetach
  const [message, setMessage] = useState('')
  const filtered = useMemo(() => searchFontChoices(choices, query), [choices, query])
  const textIds = useMemo(() => selected.filter(id => doc.nodes[id]?.kind === 'text'), [doc.nodes, selected])
  const available = (id: string) => choices.some(font => font.id === id)
  const targetId = available(target) ? target : 'default', sourceId = available(source) ? source : 'default'
  const options = filtered.some(font => font.id === targetId) ? filtered : [...filtered, choices.find(font => font.id === targetId)!]
  return <section aria-label="字体管理" className="font-management-panel">
    <label>搜索文档字体<input aria-label="搜索文档字体" placeholder="字体名称、样式或 PostScript 名称" value={query} onChange={event => setQuery(event.target.value)} /></label>
    <label className="labeled-select">目标字体<select aria-label="目标字体" value={targetId} onChange={event => setTarget(event.target.value)}>
      {options.map(font => <option key={font.id} value={font.id}>{font.family}{font.style ? ` · ${font.style}` : ''}</option>)}
    </select></label>
    <label><input type="checkbox" checked={detach} onChange={event => setDetach(event.target.checked)} />转为本地文字样式</label>
    <button type="button" disabled={!textIds.length} onClick={() => setMessage(applySelectionFont(editor, textIds, targetId, { detachSharedStyle: detach }).message)}>应用所选文字（{textIds.length}）</button>
    <small>应用会统一所选文字的字体，保留字号、字重和颜色。</small>
    {includeNative && <SystemFontPicker editor={editor} ids={textIds} detachSharedStyle={detach} />}
    <details><summary>按原字体批量替换</summary>
      <label className="labeled-select">范围<select aria-label="字体替换范围" value={scope} onChange={event => setScope(event.target.value)}>
        <option value="selection">所选文字</option><option value="document">整个文档</option>
      </select></label>
      <label className="labeled-select">原字体<select aria-label="原字体" value={sourceId} onChange={event => setSource(event.target.value)}>
        {choices.map(font => <option key={font.id} value={font.id}>{font.family}{font.style ? ` · ${font.style}` : ''}</option>)}
      </select></label>
      <label><input aria-label="同时替换后备字体" type="checkbox" checked={fallbacks} onChange={event => setFallbacks(event.target.checked)} />同时替换后备字体</label>
      <button type="button" disabled={sourceId === targetId || (scope === 'selection' && !textIds.length)} onClick={() => setMessage(replaceFontReferences(editor, scope === 'document' ? { kind: 'document' } : { kind: 'selection', ids: textIds }, sourceId, targetId, { includeFallbacks: fallbacks, detachSharedStyle: detach }).message)}>替换匹配的字体</button>
      <small>仅替换匹配引用，保留混排。文档范围跳过锁定图层；组件继承继续跟随主组件。共享样式默认保留，勾选后才转为本地覆盖。</small>
    </details>
    <small>未覆盖的字形由已有后备字体和内置字体处理；不会下载或安装字体。</small>
    {message && <p role="status">{message}</p>}
  </section>
}
