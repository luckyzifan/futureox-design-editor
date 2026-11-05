import { layoutSuggestionText, layoutSuggestionError } from './layout-suggestion-messages'
import { usePropertyText } from './property-interface-messages'
import { useState } from 'react'
import type { LayoutSuggestionPreview } from './layout-suggestions'
import { UnitNumberField } from './UnitNumberField'
import { propertyUnits } from './property-units'
import { DraftInput } from './DraftInput'
import type { Editor } from './engine'
import {
  type DesignNode,
  type AutoLayout,
  type Sizing,
  type Constraints,
  type ConstraintAnchor,
  type LayoutGrid,
  defaultLayout,
  defaultSizing,
  defaultLayoutGrid,
  container,
} from './model'
import { NumberField } from './fields'
import { ColorInput } from './ColorInput'
import { LayoutDashboard, Rows3, Columns3, Grid2X2 } from 'lucide-react'
const packed = ['start', 'center', 'end'] as const
const alignments = [
  ['start', '起点'],
  ['center', '居中'],
  ['end', '终点'],
  ['stretch', '拉伸'],
] as const
export function LayoutPanel({
  editor,
  node: n,
  ids,
  embedded = false,
}: {
  editor: Editor
  node: DesignNode
  ids: string[]
  embedded?: boolean
}) {
  const { tr, locale } = usePropertyText()
  const [suggestion, setSuggestion] = useState<LayoutSuggestionPreview | null>(null)
  const [suggestionError, setSuggestionError] = useState('')
  const parents = editor.parentMap(), units = propertyUnits(editor.state.doc, n.id, parents)
  const parent = editor.state.doc.nodes[parents.get(n.id) || ''],
    flow = !!parent?.layout && parent.layout.mode !== 'none',
    layout = n.layout || defaultLayout(),
    active = !!n.layout && n.layout.mode !== 'none',
    sizing = { ...defaultSizing(), ...n.sizing }
  const updateLayout = (patch: Partial<AutoLayout>) =>
    editor.updateProperties(
      ids,
      (n) => {
        n.layout = { ...defaultLayout(), ...n.layout, ...patch }
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
  const updateConstraint = (patch: Partial<Constraints>) =>
    editor.updateProperties(
      ids,
      (n) => {
        n.constraints = { horizontal: 'start', vertical: 'start', ...n.constraints, ...patch }
      },
      '修改约束',
    )
  const setLayoutMode = (mode?: AutoLayout['mode']) => {
    try { editor.autoLayout(mode, ids); setSuggestionError('') }
    catch (error) { setSuggestionError(error instanceof Error ? error.message : String(error)) }
  }
  const updateGrid = (patch: Partial<LayoutGrid>) =>
    editor.updateProperties(
      ids,
      (n) => {
        n.layoutGrid = { ...defaultLayoutGrid(), ...n.layoutGrid, ...patch }
      },
      '修改布局网格',
    )
  const Tag = embedded ? 'div' : 'section'
  const Heading = embedded ? 'h4' : 'h3'
  return (
    <Tag className="layout-panel">
      <Heading>{tr("自动布局")}{' '}
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
      </Heading>
      {container(n) && ids.length === 1 && <div className="layout-suggestions">
        <button type="button" disabled={n.locked} onClick={() => {
          try { setSuggestion(editor.previewSuggestedLayout(n.id)); setSuggestionError('') }
          catch (error) { setSuggestion(null); setSuggestionError(String(error)) }
        }}>{tr("建议自动布局…")}</button>
        {suggestion && suggestion.frameId === n.id && <div role="region" aria-label={tr("建议布局预览")}>
          <p>{tr("预览不会改变设计。请选择方案后应用。")}</p>
          {suggestion.suggestions.map(candidate => <div key={candidate.id}>
            <strong>{layoutSuggestionText(candidate.display?.label, candidate.label, locale)} · {Math.round(candidate.confidence * 100)}%</strong>
            {candidate.explanation.map((line, index) => <p key={index}>{layoutSuggestionText(candidate.display?.explanation[index], line, locale)}</p>)}
            <button type="button" onClick={() => {
              try { editor.applySuggestedLayout(suggestion, candidate.id); setSuggestion(null); setSuggestionError('') }
              catch (error) { setSuggestionError(String(error)) }
            }}>{tr("应用此方案")}</button>
          </div>)}
          {!suggestion.suggestions.length && <p>{tr("没有可安全应用的规则布局。")}</p>}
          {suggestion.warnings.map((warning, index) => <p key={index}>{layoutSuggestionText(suggestion.warningDisplay?.[index], warning, locale)}</p>)}
          <button type="button" onClick={() => { setSuggestion(null); setSuggestionError('') }}>{tr("取消")}</button>
        </div>}
      </div>}
      {suggestionError && <p role="alert">{layoutSuggestionError(suggestionError, locale)}</p>}
      {container(n) && <div className="layout-flow" role="radiogroup" aria-label={tr("布局方向")}>
        {([['none','自由布局',LayoutDashboard],['vertical','纵向布局',Rows3],['horizontal','横向布局',Columns3],['grid','网格布局',Grid2X2]] as const).map(([mode,label,Icon]) =>
          <button key={mode} type="button" role="radio" aria-label={tr(label)} title={tr(label)} aria-checked={(active ? layout.mode : 'none') === mode}
            onClick={() => { if ((active ? layout.mode : 'none') !== mode) setLayoutMode(mode) }}><Icon size={16} /></button>)}
      </div>}
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
          <label className="labeled-select">{tr("排列方式")}<select
              aria-label={tr("排列方式")}
              value={layout.mode}
              onChange={(e) => setLayoutMode(e.target.value as AutoLayout['mode'])}
            >
              <option value="horizontal">{tr("横向")}</option>
              <option value="vertical">{tr("纵向")}</option>
              <option value="grid">{tr("网格")}</option>
            </select>
          </label>
          <div className="field-grid">
            <UnitNumberField historyLabel={layout.mode === 'grid' ? '列间距' : '项目间距'} unit="length" diagnosticFamily={2} unitScale={layout.mode === 'vertical' ? units.y : units.x}
              label={tr(layout.mode === 'grid' ? '列间距' : '项目间距')}
              value={layout.gap}
              min={0}
              max={1e5}
              onChange={(gap) => updateLayout({ gap })}
            />
            <UnitNumberField historyLabel={layout.mode === 'grid' ? '行间距' : '换行间距'} unit="length" diagnosticFamily={2} unitScale={layout.mode === 'vertical' ? units.x : units.y}
              label={tr(layout.mode === 'grid' ? '行间距' : '换行间距')}
              value={layout.lineGap}
              min={0}
              max={1e5}
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
                value={layout.justify}
                onChange={(e) => updateLayout({ justify: e.target.value as AutoLayout['justify'] })}
              >
                <option value="start">{tr("起点")}</option>
                <option value="center">{tr("居中")}</option>
                <option value="end">{tr("终点")}</option>
                <option value="unsafe-center">{tr("居中（允许溢出）")}</option>
                <option value="unsafe-end">{tr("终点（允许溢出）")}</option>
                <option value="space-between">{tr("两端对齐")}</option>
                <option value="space-around">{tr("环绕等距")}</option>
                <option value="space-evenly">{tr("全部等距")}</option>
              </select>
            </label>
          )}
          <label className="labeled-select">{tr("交叉轴对齐")}<select
              aria-label={tr("交叉轴对齐")}
              value={layout.align}
              onChange={(e) => updateLayout({ align: e.target.value as AutoLayout['align'] })}
            >
              <option value="unsafe-center">{tr("居中（允许溢出）")}</option>
              <option value="unsafe-end">{tr("终点（允许溢出）")}</option>
              {alignments.map(([value, label]) => (
                <option key={value} value={value}>
                  {tr(label)}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      <h4>{tr("响应式尺寸")}</h4>
      {(['width', 'height'] as const).map((axis) => (
        <label className="labeled-select" key={axis}>
          {axis === 'width' ? tr("宽度模式") : tr("高度模式")}
          <select
            aria-label={tr(axis === 'width' ? '宽度模式' : '高度模式')}
            value={sizing[axis]}
            onChange={(e) => updateSize({ [axis]: e.target.value as Sizing['width'] })}
          >
            <option value="fixed">{tr("固定")}</option>
            <option value="hug" disabled={!active && n.kind !== 'text'}>{tr("内容自适应")}</option>
            <option value="fill" disabled={!flow || sizing.absolute}>{tr("填满容器")}</option>
          </select>
        </label>
      ))}
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
      {parent && (parent.kind === 'frame' || parent.kind === 'section') && (!flow || sizing.absolute) && (
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
      {n.kind === 'frame' && (
        <>
          <h4>{tr("布局网格")}{' '}
            {!n.layoutGrid && (
              <button title={tr("添加布局网格")} onClick={() =>
                editor.updateProperties(
                  ids,
                  (target) => {
                    target.layoutGrid = defaultLayoutGrid()
                  },
                  '添加布局网格',
                )
              }>
                ＋
              </button>
            )}
          </h4>
          {n.layoutGrid && (
            <div className="layout-grid-editor" data-testid="layout-grid-editor">
              <label className="check-row">
                <input
                  type="checkbox"
                  aria-label={tr("显示布局网格")}
                  checked={n.layoutGrid.visible}
                  onChange={(e) => updateGrid({ visible: e.target.checked })}
                />{tr("显示网格")}</label>
              <label className="labeled-select">{tr("网格方向")}<select
                  aria-label={tr("网格方向")}
                  value={n.layoutGrid.axis}
                  onChange={(e) => updateGrid({ axis: e.target.value as LayoutGrid['axis'] })}
                >
                  <option value="column">{tr("列")}</option>
                  <option value="row">{tr("行")}</option>
                  <option value="uniform">{tr("方块")}</option>
                </select>
              </label>
              <div className="field-grid">
                <NumberField historyLabel="数量" diagnosticFamily={2} unit="number"
                  label={tr("数量")}
                  value={n.layoutGrid.count}
                  min={1}
                  max={64}
                  onChange={(count) => updateGrid({ count: Math.round(count) })}
                />
                <UnitNumberField historyLabel={n.layoutGrid.axis === 'row' ? '间距' : '列间距'} unit="length" diagnosticFamily={2} unitScale={units.x}
                  label={tr(n.layoutGrid.axis === 'row' ? '间距' : '列间距')}
                  value={n.layoutGrid.gutter}
                  min={0}
                  max={1e5}
                  onChange={(gutter) => updateGrid({ gutter })}
                />
                <UnitNumberField historyLabel="边距" diagnosticFamily={2} unit="length" unitScale={units.x}
                  label={tr("边距")}
                  value={n.layoutGrid.margin}
                  min={0}
                  max={1e5}
                  onChange={(margin) => updateGrid({ margin })}
                />
                <NumberField historyLabel="不透明度 %" diagnosticFamily={11} unit="percent"
                  label={tr("不透明度 %")}
                  value={n.layoutGrid.opacity * 100}
                  min={0}
                  max={100}
                  onChange={(v) => updateGrid({ opacity: v / 100 })}
                />
              </div>
              <ColorInput
                label={tr("网格颜色")}
                value={n.layoutGrid.color}
                onChange={(color) => updateGrid({ color })}
              />
              <button type="button" onClick={() =>
                editor.change('移除布局网格', (d) => {
                  delete d.nodes[n.id]?.layoutGrid
                })
              }>{tr("移除网格")}</button>
            </div>
          )}
        </>
      )}
    </Tag>
  )
}
