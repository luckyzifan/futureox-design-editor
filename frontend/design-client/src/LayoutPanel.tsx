import { layoutSuggestionText, layoutSuggestionError } from './layout-suggestion-messages'
import { usePropertyText } from './property-interface-messages'
import { Fragment, type ReactNode, useState } from 'react'
import type { LayoutSuggestionPreview } from './layout-suggestions'
import { UnitNumberField } from './UnitNumberField'
import { propertyUnits } from './property-units'
import { layoutGapMinimum } from './interface-layout'
import { stackOrder } from './layer-order'
import type { UiMode } from './interface-preference'
import { DraftInput } from './DraftInput'
import type { Editor } from './engine'
import {
  type DesignDocument,
  type DesignNode,
  type AutoLayout,
  type Sizing,
  type StackingOrder,
  type Constraints,
  type ConstraintAnchor,
  defaultLayout,
  defaultSizing,
  LAYOUT_GAP_LIMIT,
  container,
} from './model'
import { NumberField } from './fields'
import { LayoutGuidePanel } from './LayoutGuidePanel'
import { LayoutDashboard, Rows3, Columns3, Grid2X2 } from 'lucide-react'
const packed = ['start', 'center', 'end'] as const
const alignments = [
  ['start', '起点'],
  ['center', '居中'],
  ['end', '终点'],
  ['stretch', '拉伸'],
] as const
/** Sketch stacks keep overflowing content at the leading edge, so the
 * Figma-only allow-overflow choices collapse to their safe counterparts. */
const safeAlignment = (value: string) =>
  value === 'unsafe-center' ? 'center' : value === 'unsafe-end' ? 'end' : value

function isUnstackedFrame(node: DesignNode | undefined): node is DesignNode {
  return node?.kind === 'frame' && !node.graphic && (node.layout?.mode ?? 'none') === 'none'
}

function readSketchSmartLayout(document: DesignDocument, node: DesignNode) {
  const metadata = document.designSystem?.sketchContainers?.nodeMetadata as
    Record<string, { bindings?: Record<string, unknown> }> | undefined
  const raw = node.bindings?.sketchInferredGroupLayout ?? metadata?.[node.id]?.bindings?.sketchInferredGroupLayout
  if (typeof raw !== 'string') return
  try {
    const fields: { _class?: unknown; axis?: unknown; layoutAnchor?: unknown } | null = JSON.parse(raw)
    if (fields?._class !== 'MSImmutableInferredGroupLayout' ||
        (fields.axis !== 0 && fields.axis !== 1) ||
        (fields.layoutAnchor !== 0 && fields.layoutAnchor !== 1 && fields.layoutAnchor !== 2)) return
    const horizontal = fields.axis === 0
    const anchors = horizontal ? ['左侧', '居中', '右侧'] : ['顶部', '居中', '底部']
    return { direction: horizontal ? '横向' : '纵向', anchor: anchors[fields.layoutAnchor] }
  } catch {
    return undefined
  }
}

export function LayoutPanel({
  editor,
  node: n,
  ids,
  uiMode = 'figma',
  embedded = false,
  geometry,
}: {
  editor: Editor
  node: DesignNode
  ids: string[]
  uiMode?: UiMode
  embedded?: boolean
  geometry?: ReactNode
}) {
  const { tr, locale } = usePropertyText()
  const [suggestion, setSuggestion] = useState<LayoutSuggestionPreview | null>(null)
  const [suggestionError, setSuggestionError] = useState('')
  const allowsGrid = uiMode !== 'sketch'
  const visibleSuggestions = suggestion?.suggestions.filter(candidate =>
    allowsGrid || candidate.changes.every(change => change.layout.mode !== 'grid')) ?? []
  const parents = editor.parentMap(), units = propertyUnits(editor.state.doc, n.id, parents)
  const parent = editor.state.doc.nodes[parents.get(n.id) || ''],
    flow = !!parent?.layout && parent.layout.mode !== 'none',
    layout = n.layout || defaultLayout(),
    active = !!n.layout && n.layout.mode !== 'none',
    sizing = { ...defaultSizing(), ...n.sizing }
  const legacySmartLayout = uiMode === 'sketch' && ids.length === 1 && n.layout == null && !n.graphic
    ? readSketchSmartLayout(editor.state.doc, n) : undefined
  const existingGridInSketch = !allowsGrid && layout.mode === 'grid'
  const frameRelativeItem = uiMode === 'sketch' && isUnstackedFrame(parent)
  const relativeItem = frameRelativeItem || (!sizing.absolute &&
    (parent?.layout?.mode === 'horizontal' || parent?.layout?.mode === 'vertical'))
  const sketchMode = uiMode === 'sketch'
  const justifyValue = (sketchMode ? safeAlignment(layout.justify) : layout.justify) as AutoLayout['justify']
  const alignValue = (sketchMode ? safeAlignment(layout.align) : layout.align) as AutoLayout['align']
  const gapMin = layoutGapMinimum(layout.mode, 'gap', uiMode)
  const lineGapMin = layoutGapMinimum(layout.mode, 'lineGap', uiMode)
  const updateLayout = (patch: Partial<AutoLayout>) =>
    editor.updateProperties(
      ids,
      (n) => {
        n.layout = { ...defaultLayout(), ...n.layout, ...patch }
        if (sketchMode) {
          n.layout.justify = safeAlignment(n.layout.justify) as AutoLayout['justify']
          n.layout.align = safeAlignment(n.layout.align) as AutoLayout['align']
        }
      },
      '修改自动布局',
    )
  const updateSize = (patch: Partial<Sizing>) =>
    editor.updateProperties(
      ids,
      (n) => {
        n.sizing = { ...defaultSizing(), ...n.sizing, ...patch }
      },
      '修改响应式尺寸',
    )
  const useFrameRelativeSize = (axis: 'width' | 'height') =>
    editor.updateProperties(ids, (target, doc) => {
      const frame = doc.nodes[parents.get(target.id) || '']
      if (!isUnstackedFrame(frame)) return
      const ratio = target[axis] / frame[axis]
      if (!(ratio >= 0 && ratio <= 1)) return
      const ratioKey = axis === 'width' ? 'widthRatio' : 'heightRatio'
      target.sizing = { ...defaultSizing(), ...target.sizing, [axis]: 'relative', [ratioKey]: ratio }
    }, '修改响应式尺寸')
  const updateStackOrder = (order: StackingOrder) => editor.updateProperties(ids, (target, doc) => {
    const current = target.layout
    if (!current || (current.mode !== 'horizontal' && current.mode !== 'vertical')) return
    if (stackOrder(current) !== order) {
      // Mirror the painter slots while preserving the flow's visual sequence.
      const flowing = target.children.filter(id => !doc.nodes[id].sizing?.absolute).reverse()
      let index = 0
      target.children = target.children.map(id => doc.nodes[id].sizing?.absolute ? id : flowing[index++])
    }
    current.stackingOrder = order
    delete current.reverseFlow
  }, '修改重叠顺序')
  const updateConstraint = (patch: Partial<Constraints>) =>
    editor.updateProperties(
      ids,
      (n) => {
        n.constraints = { horizontal: 'start', vertical: 'start', ...n.constraints, ...patch }
      },
      '修改约束',
    )
  const setLayoutMode = (mode?: AutoLayout['mode']) => {
    if (mode === 'grid' && !allowsGrid) return
    try { editor.autoLayout(mode, ids); setSuggestionError('') }
    catch (error) { setSuggestionError(error instanceof Error ? error.message : String(error)) }
  }
  const compact = uiMode === 'figma' && embedded && n.kind === 'frame' && !n.graphic && !active && !flow
  const sizingDisclosure = compact || (uiMode === 'figma' && embedded && !active && !flow && !container(n))
  const suggestions = container(n) && ids.length === 1 && <div className="layout-suggestions">
        <button type="button" disabled={n.locked} onClick={() => {
          try { setSuggestion(editor.previewSuggestedLayout(n.id)); setSuggestionError('') }
          catch (error) { setSuggestion(null); setSuggestionError(String(error)) }
        }}>{tr("建议自动布局…")}</button>
        {suggestion && suggestion.frameId === n.id && <div role="region" aria-label={tr("建议布局预览")}>
          <p>{tr("预览不会改变设计。请选择方案后应用。")}</p>
          {visibleSuggestions.map(candidate => <div key={candidate.id}>
            <strong>{layoutSuggestionText(candidate.display?.label, candidate.label, locale)} · {Math.round(candidate.confidence * 100)}%</strong>
            {candidate.explanation.map((line, index) => {
              const display = candidate.display?.explanation[index]
              return !allowsGrid && display?.key === 'grid-versus-wrap'
                ? null : <p key={index}>{layoutSuggestionText(display, line, locale)}</p>
            })}
            <button type="button" onClick={() => {
              try { editor.applySuggestedLayout(suggestion, candidate.id); setSuggestion(null); setSuggestionError('') }
              catch (error) { setSuggestionError(String(error)) }
            }}>{tr("应用此方案")}</button>
          </div>)}
          {!visibleSuggestions.length && <p>{tr("没有可安全应用的规则布局。")}</p>}
          {suggestion.warnings.map((warning, index) => <p key={index}>{layoutSuggestionText(suggestion.warningDisplay?.[index], warning, locale)}</p>)}
          <button type="button" onClick={() => { setSuggestion(null); setSuggestionError('') }}>{tr("取消")}</button>
        </div>}
      </div>
  const sizingControls = !parent?.graphic && <>
      {(n.kind !== 'text' || (!!geometry && flow)) && <>
      <h4>{tr("响应式尺寸")}</h4>
      {(['width', 'height'] as const).map(axis => {
        const ratioKey = axis === 'width' ? 'widthRatio' : 'heightRatio'
        const modeLabel = axis === 'width' ? '宽度模式' : '高度模式'
        const ratioLabel = axis === 'width' ? '相对宽度 %' : '相对高度 %'
        const frameRatio = n[axis] / (parent?.[axis] ?? 0)
        const relativeDisabled = !relativeItem || (frameRelativeItem && sizing[axis] !== 'relative'
          && !(frameRatio >= 0 && frameRatio <= 1))
        return <Fragment key={axis}>
          <label className="labeled-select">{tr(modeLabel)}
            <select aria-label={tr(modeLabel)} value={sizing[axis]} onChange={e => {
              const mode = e.currentTarget.value as Sizing['width']
              if (mode === 'relative' && frameRelativeItem) useFrameRelativeSize(axis)
              else updateSize(mode === 'relative' ? { [axis]: mode, [ratioKey]: sizing[ratioKey] ?? 1 } : { [axis]: mode })
            }}>
              <option value="fixed">{tr("固定")}</option>
              <option value="hug" disabled={!active && n.kind !== 'text'}>{tr("内容自适应")}</option>
              <option value="fill" disabled={!flow || sizing.absolute}>{tr("填满容器")}</option>
              {(uiMode === 'sketch' && relativeItem || sizing[axis] === 'relative') &&
                <option value="relative" disabled={relativeDisabled}>{tr('相对尺寸 (%)')}</option>}
            </select>
          </label>
          {relativeItem && sizing[axis] === 'relative' &&
            <NumberField historyLabel={ratioLabel} unit="percent" diagnosticFamily={axis === 'width' ? 3 : 4}
              label={tr(ratioLabel)} value={(sizing[ratioKey] ?? 1) * 100} min={0} max={100}
              onChange={value => updateSize({ [ratioKey]: value / 100 })} />}
        </Fragment>
      })}
      </>}
      <details>
        <summary>{tr("最小 / 最大尺寸")}</summary>
        <div className="field-grid">
          <UnitNumberField historyLabel="最小宽度" diagnosticFamily={2} unit="length" unitScale={units.x}
            label={tr("最小宽度")}
            value={sizing.minWidth}
            min={0.01}
            max={sizing.maxWidth}
            onChange={(minWidth) => updateSize({ minWidth })}
          />
          <UnitNumberField historyLabel="最小高度" diagnosticFamily={2} unit="length" unitScale={units.y}
            label={tr("最小高度")}
            value={sizing.minHeight}
            min={0.01}
            max={sizing.maxHeight}
            onChange={(minHeight) => updateSize({ minHeight })}
          />
          {(['maxWidth', 'maxHeight'] as const).map((key, i) => (
            <label className="number-field" key={key}>
              <span>{i ? tr("最大高度") : tr("最大宽度")}</span>
              <DraftInput aria-label={tr(i ? '最大高度' : '最大宽度')} type="number"
                value={sizing[key] >= 1e7 ? '' : String(sizing[key] * (i ? units.y : units.x))} placeholder={tr("不限")}
                min={(i ? sizing.minHeight : sizing.minWidth) * (i ? units.y : units.x)} max={1e7 * (i ? units.y : units.x)}
                validate={(text) => text === '' || (Number.isFinite(Number(text)) && Number(text) / (i ? units.y : units.x) >= (i ? sizing.minHeight : sizing.minWidth) && Number(text) / (i ? units.y : units.x) <= 1e7)}
                onCommit={(text) => updateSize({ [key]: text === '' ? 1e7 : Number(text) / (i ? units.y : units.x) })} />
            </label>
          ))}
        </div>
      </details>
      </>
  const Tag = embedded ? 'div' : 'section'
  const Heading = embedded ? 'h4' : 'h3'
  return (
    <Tag className="layout-panel">
      {!(embedded && uiMode === 'figma') && !compact && !n.graphic && <Heading>{tr(legacySmartLayout ? "智能布局（旧版）" : "自动布局")}{' '}
        {!active && (
          <button title={tr("添加自动布局 Shift+A")} onClick={() => setLayoutMode()}>
            ＋
          </button>
        )}
        {active && (
          <button title={tr("移除自动布局")} onClick={() => setLayoutMode('none')}>
            −
          </button>
        )}
      </Heading>}
      {!compact && suggestions}
      {suggestionError && <p role="alert">{layoutSuggestionError(suggestionError, locale)}</p>}
      {compact && <div className="layout-field-label">{tr('流向')}</div>}
      {legacySmartLayout && <div className="layout-field-label" data-testid="sketch-legacy-smart-layout">
        {tr(legacySmartLayout.direction)} · {tr("布局锚点")} {tr(legacySmartLayout.anchor)}
      </div>}
      {container(n) && <div className="layout-flow" role="radiogroup" aria-label={tr("布局方向")}>
        {([['none','自由布局',LayoutDashboard],['vertical','纵向布局',Rows3],['horizontal','横向布局',Columns3],['grid','网格布局',Grid2X2]] as const)
          .filter(([mode]) => (allowsGrid || mode !== 'grid') && (!legacySmartLayout || mode !== 'none')).map(([mode,label,Icon]) =>
          <button key={mode} type="button" role="radio" aria-label={tr(label)} title={tr(label)} aria-checked={(active ? layout.mode : 'none') === mode}
            onClick={() => { if ((active ? layout.mode : 'none') !== mode) setLayoutMode(mode) }}><Icon size={16} /></button>)}
      </div>}
      {compact && <div className="layout-field-label">{tr('尺寸')}</div>}
      {geometry}
      {active && (layout.mode === 'horizontal' || layout.mode === 'vertical') && <div className="align-pad" role="group" aria-label={tr("对齐")}>
        {packed.flatMap(row => packed.map(col => {
          const justify = layout.mode === 'vertical' ? row : col
          const align = layout.mode === 'vertical' ? col : row
          const horizontal = layout.mode === 'vertical' ? align : justify
          const vertical = layout.mode === 'vertical' ? justify : align
          return <button key={`${row}-${col}`} type="button" aria-pressed={layout.justify === justify && layout.align === align}
            aria-label={`${tr(horizontal === 'start' ? '左侧' : horizontal === 'end' ? '右侧' : '居中')} ${tr(vertical === 'start' ? '顶部' : vertical === 'end' ? '底部' : '居中')}`}
            onClick={() => updateLayout({ justify, align })} />
        }))}
      </div>}
      {active && (
        <>
          {existingGridInSketch && <p>{tr("Sketch 兼容导出时，网格以当前位置导出。")}</p>}
          {!existingGridInSketch && <label className="labeled-select">{tr("排列方式")}<select
              aria-label={tr("排列方式")}
              value={layout.mode}
              onChange={(e) => setLayoutMode(e.target.value as AutoLayout['mode'])}
            >
              <option value="horizontal">{tr("横向")}</option>
              <option value="vertical">{tr("纵向")}</option>
              {allowsGrid && <option value="grid">{tr("网格")}</option>}
            </select>
          </label>}
          <div className="field-grid">
            <UnitNumberField historyLabel={layout.mode === 'grid' ? '列间距' : '项目间距'} unit="length" diagnosticFamily={2} unitScale={layout.mode === 'vertical' ? units.y : units.x}
              label={tr(layout.mode === 'grid' ? '列间距' : '项目间距')}
              caption={uiMode === 'figma' && layout.mode !== 'grid' ? tr('间距') : undefined}
              value={layout.gap}
              min={gapMin}
              max={LAYOUT_GAP_LIMIT}
              clampMinimum={gapMin === 0}
              onChange={(gap) => updateLayout({ gap })}
            />
            <UnitNumberField historyLabel={layout.mode === 'grid' ? '行间距' : '换行间距'} unit="length" diagnosticFamily={2} unitScale={layout.mode === 'vertical' ? units.x : units.y}
              label={tr(layout.mode === 'grid' ? '行间距' : '换行间距')}
              caption={uiMode === 'figma' && layout.mode !== 'grid' ? (locale === 'en' ? 'Wrap gap' : '换行间距') : undefined}
              value={layout.lineGap}
              min={lineGapMin}
              max={LAYOUT_GAP_LIMIT}
              clampMinimum={lineGapMin === 0}
              onChange={(lineGap) => updateLayout({ lineGap })}
            />
          </div>
          {layout.mode === 'grid' ? (
            <>
              <NumberField historyLabel="列数" diagnosticFamily={2} unit="number"
                label={tr("列数")}
                value={layout.columns}
                min={1}
                max={64}
                onChange={(columns) => updateLayout({ columns: Math.round(columns) })}
              />
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={layout.fillRows}
                  onChange={(e) => updateLayout({ fillRows: e.target.checked })}
                />{tr("行均分剩余高度")}</label>
            </>
          ) : (
            <label className="check-row">
              <input
                type="checkbox"
                checked={layout.wrap}
                onChange={(e) => updateLayout({ wrap: e.target.checked })}
              />{tr("自动换行")}</label>
          )}
          {(layout.mode === 'horizontal' || layout.mode === 'vertical') &&
            (uiMode === 'sketch' || layout.bordersAffectLayout) && <label className="check-row">
              <input type="checkbox" checked={!!layout.bordersAffectLayout}
                onChange={e => updateLayout({ bordersAffectLayout: e.currentTarget.checked || undefined })} />
              {tr('边框计入布局')}
            </label>}
          {(layout.mode === 'horizontal' || layout.mode === 'vertical') &&
            <label className="labeled-select">{tr('重叠顺序')}
              <select aria-label={tr('重叠顺序')} value={stackOrder(layout)}
                onChange={event => updateStackOrder(event.currentTarget.value as StackingOrder)}>
                <option value="first-on-top">{tr('首项在上')}</option>
                <option value="last-on-top">{tr('末项在上')}</option>
              </select>
            </label>}
          <h4>{tr("内边距")}</h4>
          <div className="field-grid">
            {layout.padding.map((v, i) => (
              <UnitNumberField historyLabel={['上内边距', '右内边距', '下内边距', '左内边距'][i]} unit="length" diagnosticFamily={2} unitScale={i % 2 ? units.x : units.y}
                key={i}
                label={tr(['上内边距', '右内边距', '下内边距', '左内边距'][i])}
                value={v}
                min={0}
                max={1e5}
                onChange={(value) => {
                  const padding = [...layout.padding] as AutoLayout['padding']
                  padding[i] = value
                  updateLayout({ padding })
                }}
              />
            ))}
          </div>
          {layout.mode !== 'grid' && (
            <label className="labeled-select">{tr("主轴分布")}<select
                aria-label={tr("主轴分布")}
                value={justifyValue}
                onChange={(e) => updateLayout({ justify: e.target.value as AutoLayout['justify'] })}
              >
                <option value="start">{tr("起点")}</option>
                <option value="center">{tr("居中")}</option>
                <option value="end">{tr("终点")}</option>
                {!sketchMode && <option value="unsafe-center">{tr("居中（允许溢出）")}</option>}
                {!sketchMode && <option value="unsafe-end">{tr("终点（允许溢出）")}</option>}
                <option value="space-between">{tr("两端对齐")}</option>
                <option value="space-around">{tr("环绕等距")}</option>
                <option value="space-evenly">{tr("全部等距")}</option>
              </select>
            </label>
          )}
          <label className="labeled-select">{tr("交叉轴对齐")}<select
              aria-label={tr("交叉轴对齐")}
              value={alignValue}
              onChange={(e) => updateLayout({ align: e.target.value as AutoLayout['align'] })}
            >
              {!sketchMode && <option value="unsafe-center">{tr("居中（允许溢出）")}</option>}
              {!sketchMode && <option value="unsafe-end">{tr("终点（允许溢出）")}</option>}
              {alignments.map(([value, label]) => (
                <option key={value} value={value}>
                  {tr(label)}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      {sizingDisclosure ? <details className="layout-options" key={n.id}>
        <summary>{tr('布局选项')}</summary>
        {sizingControls}
        {compact && suggestions}
      </details> : sizingControls}
      {flow && (
        <>
          <label className="check-row">
            <input
              type="checkbox"
              aria-label={tr("忽略自动布局")}
              checked={sizing.absolute}
              onChange={(e) =>
                updateSize({ absolute: e.target.checked, width: 'fixed', height: 'fixed' })
              }
            />{tr("忽略自动布局（绝对定位）")}</label>
          {!sizing.absolute && (
            <>
              <label className="labeled-select">{tr("自身对齐")}<select
                  aria-label={tr("自身对齐")}
                  value={sizing.alignSelf || 'auto'}
                  onChange={(e) =>
                    updateSize({
                      alignSelf:
                        e.target.value === 'auto' ? null : (e.target.value as Sizing['alignSelf']),
                    })
                  }
                >
                  <option value="auto">{tr("跟随容器")}</option>
                  {alignments.map(([value, label]) => (
                    <option key={value} value={value}>
                      {tr(label)}
                    </option>
                  ))}
                </select>
              </label>
              {parent.layout?.mode === 'grid' && (
                <div className="field-grid">
                  <NumberField historyLabel="跨列" diagnosticFamily={2} unit="number"
                    label={tr("跨列")}
                    value={sizing.columnSpan}
                    min={1}
                    max={64}
                    onChange={(columnSpan) => updateSize({ columnSpan: Math.round(columnSpan) })}
                  />
                  <NumberField historyLabel="跨行" diagnosticFamily={2} unit="number"
                    label={tr("跨行")}
                    value={sizing.rowSpan}
                    min={1}
                    max={64}
                    onChange={(rowSpan) => updateSize({ rowSpan: Math.round(rowSpan) })}
                  />
                </div>
              )}
            </>
          )}
        </>
      )}
      {parent && !parent.graphic && (parent.kind === 'frame' || parent.kind === 'section') && (!flow || sizing.absolute) && (
        <>
          <h4>{tr("父画板尺寸约束")}</h4>
          {(['horizontal', 'vertical'] as const).map((axis, i) => (
            <label className="labeled-select" key={axis}>
              {i ? tr("垂直约束") : tr("水平约束")}
              <select
                aria-label={tr(i ? '垂直约束' : '水平约束')}
                value={n.constraints?.[axis] || 'start'}
                onChange={(e) => updateConstraint({ [axis]: e.target.value as ConstraintAnchor })}
              >
                <option value="start">{i ? tr("顶部") : tr("左侧")}</option>
                <option value="center">{tr("居中")}</option>
                <option value="end">{i ? tr("底部") : tr("右侧")}</option>
                <option value="stretch">{i ? tr("上下拉伸") : tr("左右拉伸")}</option>
                <option value="scale">{tr("比例缩放")}</option>
              </select>
            </label>
          ))}
        </>
      )}
      {n.kind === 'frame' && !(uiMode === 'figma' && embedded) &&
        <LayoutGuidePanel editor={editor} frame={n} ids={ids} />}
    </Tag>
  )
}
