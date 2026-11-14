import { usePropertyText, translateProperty } from './property-interface-messages'
import { UnitNumberField } from './UnitNumberField'
import { propertyUnits, styleUnitDescription } from './property-units'
import { SystemFontPicker } from './SystemFontPicker'
import { FontManagementPanel } from './FontManagementPanel'
import { applySelectionFont } from './font-management'
import { commitPendingEdits, pendingEditsChanged, registerPendingEdit } from './pending-edits'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ImportOwner, importStep } from './import-ownership'
import { defaultTextStyle, defaultSizing, type DesignNode, type TextStyle, type TextParagraph } from './model'
import type { Editor } from './engine'
import { NumberField } from './fields'
import { applyWholeTextStyle, styleTextRange } from './text'
import { sourceFonts, storeRemappedSourceFonts } from './font-matching'

/** Comma-separated draft -> string[]; empty items drop at save time only. */
export function parseCommaList(text: string) {
  return text.split(',').map((item) => item.trim()).filter((item) => item.length > 0)
}

export { unmatchedSourceFonts as unmatchedSketchFonts } from './font-matching'
import { unmatchedSourceFonts as unmatchedSketchFonts } from './font-matching'
import { font_faces_json } from './generated/design-kernel/design_kernel'
import { initializeKernelModule } from './kernel/module'
/** Kernel limits: at most 16 toggles, each at most 32 characters. */
export function featuresIssue(items: string[], locale: 'zh-CN' | 'en' = 'zh-CN') {
  if (items.length > 16) return translateProperty('特性最多 16 项', locale)
  const long = items.find((item) => item.length > 32)
  return long ? (locale === 'en' ? `Feature ${long} exceeds 32 characters` : `特性 ${long} 超过 32 字符`) : ''
}
/** Fallback ids must resolve like fontId: "default" or a document font. */
export function fallbacksIssue(items: string[], fonts: Record<string, unknown> | undefined, locale: 'zh-CN' | 'en' = 'zh-CN') {
  if (items.length > 16) return translateProperty('后备字体最多 16 项', locale)
  const missing = items.find((id) => id !== 'default' && !(fonts && Object.hasOwn(fonts, id)))
  return missing ? (locale === 'en' ? `Font resource ${missing} does not exist` : `字体资源 ${missing} 不存在`) : ''
}
/** Variation axes are 4-character alphanumeric tags; wght follows 字重. */
export const variationTagValid = (tag: string) => /^[a-zA-Z0-9]{4}$/.test(tag) && tag !== 'wght'
export function variationsIssue(rows: { tag: string; value: string }[], locale: 'zh-CN' | 'en' = 'zh-CN') {
  const filled = rows.filter((r) => r.tag.trim() !== '' || r.value.trim() !== '')
  if (filled.length > 16) return translateProperty('变体轴最多 16 项', locale)
  for (const row of filled) {
    const tag = row.tag.trim()
    if (tag === 'wght') return translateProperty('wght 由字重字段控制', locale)
    if (!variationTagValid(tag)) return translateProperty('轴标签需为 4 位字母或数字', locale)
    if (!Number.isFinite(Number(row.value))) return locale === 'en' ? `Axis ${tag || '?'} has an invalid value` : `轴 ${tag || '?'} 的数值无效`
  }
  return ''
}
type VariationRow = { tag: string; value: string }
export function TextStylePanel({
  editor,
  node,
  ids,
}: {
  editor: Editor
  node: DesignNode
  ids: string[]
}) {
  const [paragraphIndex, setParagraphIndex] = useState(0)
  const paragraphs = Array.from(node.text.matchAll(/[^\r\n\u2028\u2029]*(?:\r\n|[\r\n\u2028\u2029]|$)/g))
    .filter(m=>m[0].length).map(m=>({start:m.index!,end:m.index!+m[0].length,text:m[0]}))
  const paragraphRange = paragraphs[Math.min(paragraphIndex, paragraphs.length-1)]
  const paragraph: TextParagraph = paragraphRange && node.textRuns?.find(r=>r.start<=paragraphRange.start&&paragraphRange.start<r.end)?.paragraph
    || {align:node.textStyle?.align??'start',minimumLineHeight:0,maximumLineHeight:0,spacing:node.textStyle?.paragraphSpacing??0,indent:node.textStyle?.paragraphIndent??0}
  const updateParagraph = (patch: Partial<TextParagraph>) => {
    if (!paragraphRange) return
    editor.change('修改段落样式', doc => {
      const n = doc.nodes[node.id]
      if (n?.text !== node.text) return
      const fonts = styleTextRange(n, paragraphRange.start, paragraphRange.end,
        { paragraph: { ...paragraph, ...patch } }, sourceFonts(doc, n))
      storeRemappedSourceFonts(doc, n.id, fonts)
    })
  }
  const { locale, tr } = usePropertyText()
  // Match the Inspector's camera-independent, bounded preview cadence. A
  // direct full-state subscription would rebuild these controls on every pan.
  const { doc } = useSyncExternalStore(editor.subscribe, editor.panelSnapshot)
  const units = propertyUnits(doc, node.id, editor.parentMap(doc))
  const styleDescription = styleUnitDescription(doc, [node.id], editor.parentMap(doc))
  const unmatchedFonts = unmatchedSketchFonts(doc, node)
  const [imports] = useState(() => new ImportOwner())
  useEffect(() => { imports.activate(); return () => imports.dispose() }, [imports])
  const [detachFontStyle, setDetachFontStyle] = useState(false)
  const fontTargetsKey = ids.join('\0')
  useEffect(() => { imports.invalidate(); setDetachFontStyle(false) }, [imports, editor, fontTargetsKey])
  const file = useRef<HTMLInputElement>(null),
    style = { ...defaultTextStyle(), ...node.textStyle }
  // Drafts for the comma-list fields stay local until blur; the effect
  // re-syncs them whenever the committed value moves (undo, other panels).
  const featuresValue = (style.features ?? []).join(',')
  const fallbacksValue = (style.fallbacks ?? []).join(',')
  const variationsValue = JSON.stringify(style.variations ?? [])
  const [featuresDraft, setFeaturesDraft] = useState(featuresValue)
  const [fallbacksDraft, setFallbacksDraft] = useState(fallbacksValue)
  const [variationRows, setVariationRows] = useState<VariationRow[]>(() =>
    (style.variations ?? []).map((v) => ({ tag: v.tag, value: String(v.value) })),
  )
  useEffect(() => setFeaturesDraft(featuresValue), [featuresValue])
  useEffect(() => setFallbacksDraft(fallbacksValue), [fallbacksValue])
  useEffect(
    () => setVariationRows((style.variations ?? []).map((v) => ({ tag: v.tag, value: String(v.value) }))),
    [variationsValue],
  )
  const featuresItems = parseCommaList(featuresDraft),
    featuresHint = featuresIssue(featuresItems, locale)
  const fallbacksItems = parseCommaList(fallbacksDraft),
    fallbacksHint = fallbacksIssue(fallbacksItems, doc.fonts, locale)
  const variationsHint = variationsIssue(variationRows, locale)
  useEffect(() => {
    const input = file.current
    const onCancel = () => imports.invalidate()
    input?.addEventListener('cancel', onCancel)
    return () => input?.removeEventListener('cancel', onCancel)
  })
  const update = (patch: Partial<TextStyle>) =>
    editor.updateProperties(
      ids,
      (n) => {
        applyWholeTextStyle(n, patch)
        if (patch.wrap !== undefined) n.sizing = { ...defaultSizing(), ...n.sizing, width: patch.wrap ? 'fixed' : 'hug', height: 'hug' }
      },
      '修改文字排版',
    )
  // These pre-existing list/axis inputs keep local drafts. Font application,
  // replacement, save and navigation must honor them just like DraftInput.
  const composing = useRef(false), draftSession = useRef(editor.sessionGeneration)
  const draftRows = JSON.stringify(variationRows)
  const committedRows = JSON.stringify((style.variations ?? []).map(v => ({ tag: v.tag, value: String(v.value) })))
  const draftsDirty = () => composing.current || featuresDraft !== featuresValue || fallbacksDraft !== fallbacksValue || draftRows !== committedRows
  if (!draftsDirty()) draftSession.current = editor.sessionGeneration
  const pending = useRef<{ dirty: () => boolean; commit: () => boolean }>({ dirty: () => false, commit: () => true })
  pending.current = { dirty: draftsDirty, commit: () => {
    if (composing.current || draftSession.current !== editor.sessionGeneration || featuresHint || fallbacksHint || variationsHint) return false
    const patch: Partial<TextStyle> = {}
    if (featuresDraft !== featuresValue) patch.features = featuresItems.length ? featuresItems : undefined
    if (fallbacksDraft !== fallbacksValue) patch.fallbacks = fallbacksItems
    if (draftRows !== committedRows) patch.variations = toVariations(variationRows)
    if (Object.keys(patch).length) {
      update(patch)
      const next = editor.state.doc.nodes[node.id]?.textStyle
      if (!next || Object.keys(patch).some(key => JSON.stringify(next[key as keyof TextStyle] ?? []) !== JSON.stringify(patch[key as keyof TextStyle] ?? []))) return false
    }
    setFeaturesDraft(featuresItems.join(',')); setFallbacksDraft(fallbacksItems.join(','))
    setVariationRows(toVariations(variationRows).map(v => ({ tag: v.tag, value: String(v.value) })))
    return true
  } }
  useEffect(() => registerPendingEdit(editor, { dirty: () => pending.current.dirty(), commit: () => pending.current.commit() }), [editor])
  useEffect(() => { pendingEditsChanged(editor) }, [editor, featuresDraft, fallbacksDraft, draftRows])
  const hint = (text: string) =>
    text ? <p role="alert" style={{ color: '#bf3d34', margin: 0 }}>{text}</p> : null
  return (
    <div className="text-style-panel" onCompositionStartCapture={() => { composing.current = true; pendingEditsChanged(editor) }} onCompositionEndCapture={() => { composing.current = false; pendingEditsChanged(editor) }}>
      <label className="labeled-select">{tr("文字尺寸")}<select aria-label={tr("文字尺寸模式")} value={node.sizing?.width === 'hug' ? 'width' : node.sizing?.height === 'hug' ? 'height' : 'fixed'}
          onChange={event => {
            const mode = event.target.value
            editor.updateProperties(ids, n => {
              applyWholeTextStyle(n, { wrap: mode !== 'width' })
              n.sizing = { ...defaultSizing(), ...n.sizing, width: mode === 'width' ? 'hug' : 'fixed', height: mode === 'fixed' ? 'fixed' : 'hug' }
            }, '调整文字尺寸模式')
          }}>
          <option value="width">{tr("自动宽度")}</option><option value="height">{tr("自动高度")}</option><option value="fixed">{tr("固定尺寸")}</option>
        </select>
      </label>
      <label>{tr("字体")}<select
          aria-label={tr("文字字体")}
          value={style.fontId}
          onChange={(e) => applySelectionFont(editor, ids, e.target.value, { detachSharedStyle: detachFontStyle })}
        >
          <option value="default">{tr("Noto Sans SC（内置）")}</option>
          {Object.entries(doc.fonts || {}).map(([id, font]) => (
            <option key={id} value={id}>
              {font.family}
            </option>
          ))}
        </select>
      </label>
      {unmatchedFonts.length > 0 && <p role="status" aria-label={tr("原字体匹配状态")}>{tr("原字体未匹配：")}{unmatchedFonts.join('、')}{tr("。当前使用 Noto Sans SC，可选择本机字体或导入字体替换。")}</p>}
      <SystemFontPicker editor={editor} ids={ids} detachSharedStyle={detachFontStyle} />
      <details><summary>{tr("字体管理与批量替换")}</summary><FontManagementPanel editor={editor} ids={ids} includeNative={false} detachSharedStyle={detachFontStyle} onDetachSharedStyleChange={setDetachFontStyle} /></details>
      <button onClick={() => { if (commitPendingEdits(editor)) { imports.invalidate(); file.current?.click() } }}>{tr("导入 TTF / OTF 字体")}</button>
      <input
        ref={file}
        type="file"
        accept=".ttf,.otf"
        hidden
        onChange={async (e) => {
          const selected = e.currentTarget.files?.[0]
          e.currentTarget.value = ''
          if (!selected || !commitPendingEdits(editor)) return
          const request = imports.begin(editor)
          try {
            if (selected.size > 20 * 1024 * 1024) throw new Error(tr('字体文件超过 20 MB'))
            const bytes = new Uint8Array(await importStep(request, () => selected.arrayBuffer()))
            await importStep(request, () => initializeKernelModule())
            const face = (JSON.parse(font_faces_json(bytes)) as Array<{ family: string; style: string; postscript: string; index: number; typographicFamily?: string; typographicStyle?: string }>)[0]
            if (!face) throw new Error(tr('字体文件中没有可用字形'))
            const familyName = (face.typographicFamily || '').trim() || (face.family || '').trim()
            const styleName = (face.typographicStyle || '').trim() || (face.style || '').trim()
            const id = Array.from(
              new Uint8Array(await importStep(request, () => crypto.subtle.digest('SHA-256', bytes))),
              (v) => v.toString(16).padStart(2, '0'),
            ).join('')
            let binary = ''
            for (let i = 0; i < bytes.length; i += 32768)
              binary += String.fromCharCode(...bytes.subarray(i, i + 32768))
            request.assertCurrent()
            const resource = {
              family: `${familyName} ${styleName}`.trim().slice(0, 200),
              postscript: face.postscript, index: face.index, data: btoa(binary),
            }
            const result = applySelectionFont(editor, ids, id, { matchSourceFonts: true, detachSharedStyle: detachFontStyle }, resource)
            if (result.status === 'blocked' || result.status === 'rejected') editor.notify(result.message)
          } catch (error) {
            if (request.isCurrent()) editor.notify(String(error))
          } finally { request.finish() }
        }}
      />
      <NumberField historyLabel="字重" diagnosticFamily={2} unit="number"
        label={tr("字重")}
        value={style.weight}
        min={1}
        max={1000}
        onChange={(weight) => update({ weight })}
      />
      <NumberField historyLabel="行高倍数" diagnosticFamily={2} unit="length"
        label={tr("行高倍数")}
        value={style.lineHeight}
        min={0.1}
        max={10}
        onChange={(lineHeight) => update({ lineHeight })}
      />
      <UnitNumberField unitDescription={styleDescription} historyLabel="字间距" diagnosticFamily={2} unit="length" unitScale={units.style}
        label={tr("字间距")}
        value={style.letterSpacing}
        min={-1000}
        max={1000}
        onChange={(letterSpacing) => update({ letterSpacing })}
      />
      <label>
        <input
          type="checkbox"
          checked={style.wrap}
          onChange={(e) => update({ wrap: e.target.checked })}
        />{tr("按文本框宽度换行")}</label>
      <label>{tr("对齐")}<select
          aria-label={tr("文字对齐")}
          value={style.align}
          onChange={(e) => update({ align: e.target.value as TextStyle['align'] })}
        >
          <option value="start">{tr("起始")}</option>
          <option value="center">{tr("居中")}</option>
          <option value="end">{tr("末尾")}</option><option value="justify">{locale === 'en' ? 'Justify' : tr("两端对齐")}</option>
        </select>
      </label>
      <UnitNumberField unitDescription={styleDescription} historyLabel="段落间距" diagnosticFamily={2} unit="length" unitScale={units.style} label={tr("段落间距")} value={style.paragraphSpacing||0} min={0} max={10000} onChange={paragraphSpacing=>update({paragraphSpacing})}/><UnitNumberField unitDescription={styleDescription} historyLabel="首行缩进" diagnosticFamily={2} unit="number" unitScale={units.style} label={tr("首行缩进")} value={style.paragraphIndent||0} min={-10000} max={10000} onChange={paragraphIndent=>update({paragraphIndent})}/>
      {paragraphs.length > 0 && <details><summary>{tr('分段样式')}</summary>
        <label>{tr('段落')}<select aria-label={tr('选择段落')} value={Math.min(paragraphIndex,paragraphs.length-1)} onChange={e=>setParagraphIndex(Number(e.target.value))}>
          {paragraphs.map((p,i)=><option key={p.start} value={i}>{i+1} · {p.text.trim().slice(0,24) || tr('空段落')}</option>)}
        </select></label>
        <label>{tr('对齐')}<select aria-label={tr('段落对齐')} value={paragraph.align} onChange={e=>updateParagraph({align:e.target.value as TextParagraph['align']})}>
          <option value="start">{tr('起始')}</option><option value="center">{tr('居中')}</option><option value="end">{tr('末尾')}</option><option value="justify">{tr('两端对齐')}</option>
        </select></label>
        <NumberField label="段落最小行高" value={paragraph.minimumLineHeight} min={0} max={paragraph.maximumLineHeight || 10000} onChange={minimumLineHeight=>updateParagraph({minimumLineHeight})}/>
        <NumberField label="段落最大行高" value={paragraph.maximumLineHeight} min={0} max={10000} onChange={maximumLineHeight=>updateParagraph({maximumLineHeight})}/>
        <small>{tr('行高为文档单位，0 表示不限制。')}</small>
        <NumberField label="本段段后间距" value={paragraph.spacing} min={0} max={10000} onChange={spacing=>updateParagraph({spacing})}/>
        <NumberField label="本段首行缩进" value={paragraph.indent} min={-10000} max={10000} onChange={indent=>updateParagraph({indent})}/>
      </details>}
      <label>{tr('文本垂直对齐')}<select
        aria-label={tr('文本垂直对齐')} value={style.verticalAlign ?? 'top'}
        onChange={e=>update({verticalAlign:e.target.value as TextStyle['verticalAlign']})}>
        <option value="top">{locale === 'en' ? 'Top' : '顶部'}</option>
        <option value="center">{locale === 'en' ? 'Center' : '居中'}</option>
        <option value="bottom">{locale === 'en' ? 'Bottom' : '底部'}</option>
      </select></label>
      <label>{tr("方向")}<select
          aria-label={tr("文字方向")}
          value={style.direction}
          onChange={(e) => update({ direction: e.target.value as TextStyle['direction'] })}
        >
          <option value="auto">{tr("自动")}</option>
          <option value="ltr">{tr("从左到右")}</option>
          <option value="rtl">{tr("从右到左")}</option>
        </select>
      </label>
      <label>{tr("排版走向")}<select
          aria-label={tr("文字排版走向")}
          value={style.writingMode ?? 'horizontal'}
          onChange={(e) => update({ writingMode: e.target.value === 'vertical' ? 'vertical' : undefined })}
        >
          <option value="horizontal">{tr("水平")}</option>
          <option value="vertical">{tr("竖排")}</option>
        </select>
      </label>
      <label>{tr("OpenType 特性")}<input
          aria-label={tr("OpenType 特性")}
          type="text"
          placeholder="-liga,kern,ss01"
          value={featuresDraft}
          onChange={(e) => setFeaturesDraft(e.currentTarget.value)}
          onBlur={() => { pending.current.commit() }}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
        />
      </label>
      {hint(featuresHint)}
      <div>{tr("变体轴")}{variationRows.map((row, i) => (
          <div className="feature-row" key={i}>
            <input
              aria-label={`${locale === 'en' ? 'Variation axis tag' : '变体轴标签'} ${i + 1}`}
              type="text"
              placeholder="wdth"
              value={row.tag}
              onChange={(e) => setVariationRows(variationRows.map((r, j) => j === i ? { ...r, tag: e.currentTarget.value } : r))}
              onBlur={commitVariations}
              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
            />
            <input
              aria-label={`${locale === 'en' ? 'Variation axis value' : '变体轴数值'} ${i + 1}`}
              type="text"
              inputMode="decimal"
              value={row.value}
              onChange={(e) => setVariationRows(variationRows.map((r, j) => j === i ? { ...r, value: e.currentTarget.value } : r))}
              onBlur={commitVariations}
              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
            />
            {row.tag.trim() === 'wght' && <span>{tr("由字重字段控制")}</span>}
            <button
              type="button"
              aria-label={`${locale === 'en' ? 'Remove variation axis' : '删除变体轴'} ${i + 1}`}
              onClick={() => {
                const next = variationRows.filter((_, j) => j !== i)
                setVariationRows(next)
                if (!variationsIssue(next))
                  update({ variations: next.length ? toVariations(next) : undefined })
              }}
            >
              −
            </button>
          </div>
        ))}
        <button
          type="button"
          aria-label={tr("添加变体轴")}
          onClick={() => setVariationRows([...variationRows, { tag: '', value: '' }])}
        >
          ＋
        </button>
      </div>
      {hint(variationsHint)}
      <label>{tr("后备字体")}<input
          aria-label={tr("后备字体")}
          type="text"
          placeholder={tr("逗号分隔字体资源 id")}
          value={fallbacksDraft}
          onChange={(e) => setFallbacksDraft(e.currentTarget.value)}
          onBlur={() => { pending.current.commit() }}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
        />
      </label>
      {hint(fallbacksHint)}
    </div>
  )
  function toVariations(rows: VariationRow[]) {
    return rows
      .map((r) => ({ tag: r.tag.trim(), value: Number(r.value) }))
      .filter((v) => variationTagValid(v.tag) && Number.isFinite(v.value))
  }
  function commitVariations() { pending.current.commit() }
}
