import { usePropertyText, fontEditStatus, propertyStatusText, type PropertyStatus } from './property-interface-messages'
import { useMemo, useState, useSyncExternalStore } from 'react'
import type { Editor } from './engine'
import { SystemFontPicker } from './SystemFontPicker'
import { applySelectionFont, documentFontChoices, replaceFontReferences, searchFontChoices, unmatchedEditableSourceFonts } from './font-management'
import { suggestDocumentFont, substituteMissingFonts, suggestionNote } from './font-substitution'

/** Metadata-only panel: no eager font loading, glyph previews, or camera subscriptions. */
export function FontManagementPanel({ editor, ids, includeNative = true, detachSharedStyle, onDetachSharedStyleChange }: { editor: Editor; ids?: string[]; includeNative?: boolean; detachSharedStyle?: boolean; onDetachSharedStyleChange?: (value: boolean) => void }) {
  const { locale, tr } = usePropertyText()
  const { doc, selection } = useSyncExternalStore(editor.subscribe, editor.panelSnapshot)
  const selected = ids || selection
  const choices = useMemo(() => documentFontChoices(doc, locale), [doc.fonts, locale])
  const [query, setQuery] = useState(''), [target, setTarget] = useState('default'), [source, setSource] = useState('default')
  const [scope, setScope] = useState('selection'), [fallbacks, setFallbacks] = useState(false), [localDetach, setLocalDetach] = useState(false)
  const detach = detachSharedStyle ?? localDetach
  const setDetach = onDetachSharedStyleChange || setLocalDetach
  const [message, setMessage] = useState<PropertyStatus>('')
  const filtered = useMemo(() => searchFontChoices(choices, query), [choices, query])
  const missing = useMemo(() => {
    const faces = choices.map(font => ({ id: font.id, family: font.family, style: font.style, postscript: font.postscript }))
    return unmatchedEditableSourceFonts(doc).map(name => ({ name, suggestion: suggestDocumentFont(name, faces) }))
  }, [choices, doc])
  const confirmMissing = (items: typeof missing) => {
    const result = substituteMissingFonts(editor, items.map(item => ({ name: item.name, fontId: item.suggestion.fontId || 'default' })))
    setMessage(result.status === 'blocked' || result.status === 'rejected' ? result.message : { zh: result.message, en: `Confirmed ${result.changedReferences} missing-font references in ${result.changedNodes} text layers.` })
  }
  const textIds = useMemo(() => selected.filter(id => doc.nodes[id]?.kind === 'text'), [doc.nodes, selected])
  const available = (id: string) => choices.some(font => font.id === id)
  const targetId = available(target) ? target : 'default', sourceId = available(source) ? source : 'default'
  const options = filtered.some(font => font.id === targetId) ? filtered : [...filtered, choices.find(font => font.id === targetId)!]
  return <section aria-label={tr("字体管理")} className="font-management-panel">
    <label>{tr("搜索文档字体")}<input aria-label={tr("搜索文档字体")} placeholder={tr("字体名称、样式或 PostScript 名称")} value={query} onChange={event => setQuery(event.target.value)} /></label>
    <label className="labeled-select">{tr("目标字体")}<select aria-label={tr("目标字体")} value={targetId} onChange={event => setTarget(event.target.value)}>
      {options.map(font => <option key={font.id} value={font.id}>{font.family}{font.style ? ` · ${font.style}` : ''}</option>)}
    </select></label>
    <label><input type="checkbox" checked={detach} onChange={event => setDetach(event.target.checked)} />{tr("转为本地文字样式")}</label>
    <button type="button" disabled={!textIds.length} onClick={() => setMessage(fontEditStatus(applySelectionFont(editor, textIds, targetId, { detachSharedStyle: detach }), 'apply'))}>{locale === 'en' ? `Apply to selected text (${textIds.length})` : `应用所选文字（${textIds.length}）`}</button>
    <small>{tr("应用会统一所选文字的字体，保留字号、字重和颜色。")}</small>
    {includeNative && <SystemFontPicker editor={editor} ids={textIds} detachSharedStyle={detach} />}
    {missing.length > 0 && <details open><summary>{tr('缺失字体')} ({missing.length})</summary>
      <small>{tr('下列原字体没有对应的字体文件。确认后才替换，不会下载或安装字体。本机若已安装同名字体，用「匹配文档原字体」。')}</small>
      {missing.map(item => {
        const note = suggestionNote(item.suggestion.kind, item.suggestion.scripts)
        const label = note === 'exact' ? tr('与文档中的字体一致') : note === 'nearest' ? tr('同一家族里最接近的字重') : note === 'han-variant' ? tr('内置 Noto Sans SC。繁体、日文或韩文可能显示简体字形') : tr('没有同名字体。内置 Noto Sans SC 能显示文字，但字宽和字形会不同')
        return <div key={item.name} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
          <span>{item.name}<br /><small>{label}</small></span>
          <button type="button" onClick={() => confirmMissing([item])}>{tr('替换这一项')}</button>
        </div>
      })}
      <button type="button" onClick={() => confirmMissing(missing)}>{tr('用建议字体替换全部')}</button>
    </details>}
    <details><summary>{tr("按原字体批量替换")}</summary>
      <label className="labeled-select">{tr("范围")}<select aria-label={tr("字体替换范围")} value={scope} onChange={event => setScope(event.target.value)}>
        <option value="selection">{tr("所选文字")}</option><option value="document">{tr("整个文档")}</option>
      </select></label>
      <label className="labeled-select">{tr("原字体")}<select aria-label={tr("原字体")} value={sourceId} onChange={event => setSource(event.target.value)}>
        {choices.map(font => <option key={font.id} value={font.id}>{font.family}{font.style ? ` · ${font.style}` : ''}</option>)}
      </select></label>
      <label><input aria-label={tr("同时替换后备字体")} type="checkbox" checked={fallbacks} onChange={event => setFallbacks(event.target.checked)} />{tr("同时替换后备字体")}</label>
      <button type="button" disabled={sourceId === targetId || (scope === 'selection' && !textIds.length)} onClick={() => setMessage(fontEditStatus(replaceFontReferences(editor, scope === 'document' ? { kind: 'document' } : { kind: 'selection', ids: textIds }, sourceId, targetId, { includeFallbacks: fallbacks, detachSharedStyle: detach }), 'replace'))}>{tr("替换匹配的字体")}</button>
      <small>{tr("仅替换匹配引用，保留混排。文档范围跳过锁定图层；组件继承继续跟随主组件。共享样式默认保留，勾选后才转为本地覆盖。")}</small>
    </details>
    <small>{tr("未覆盖的字形由已有后备字体和内置字体处理；不会下载或安装字体。")}</small>
    {message && <p role="status">{propertyStatusText(message, locale)}</p>}
  </section>
}
