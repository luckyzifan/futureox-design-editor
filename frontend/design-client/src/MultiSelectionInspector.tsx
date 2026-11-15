import { usePropertyText, propertyLayerCount } from './property-interface-messages'
import { FontManagementPanel } from './FontManagementPanel'
import { MultiStylePanel } from './MultiStylePanel'
import {smartSelection,smartSpacing} from './smart-selection'
import { AlignmentControls, FlipControls } from './AlignmentControls'
import { CalculatedDimension, NumberField } from './fields'
import { propertyUnitReader, styleUnitDescription, type PropertyUnitReader } from './property-units'
import { numericExpression } from './numeric-expression'
import { SelectionColorsPanel } from './SelectionColorsPanel'
import type { Editor } from './engine'
import { type DesignNode, type NodeBlend, type TextStyle, blendModes } from './model'
import { applyWholeTextStyle, setWholeTextFontSize } from './text'
import { commonValue, resizeNodeDimension, selectionMetric, setNodePosition, type SelectionMetric } from './selection-properties'
import { useSyncExternalStore } from 'react'
import { selectionLocalBounds, rotateNode } from './canvas-view'
import { formatAngleDegrees } from './selection-handles'
import { figmaRotationDegrees, nodeDegreesForFigmaAngle } from './rotation-field'
import { MixedNumberField } from './MixedNumberField'
import { TextSizingControls } from './TextSizingControls'
import { useInterfacePreferences } from './interface-preference'

export function MultiSelectionInspector({ editor, nodes }: { editor: Editor; nodes: DesignNode[] }) {
  const { locale, tr } = usePropertyText()
  const { uiMode } = useInterfacePreferences()
  const sketch = uiMode === 'sketch'
  const live = useSyncExternalStore(editor.subscribeLiveRotation, () => editor.liveRotation)
  const ids = nodes.map((node) => node.id)
  const readUnits = propertyUnitReader(editor.state.doc)
  const styleDescription = styleUnitDescription(editor.state.doc, nodes.filter(n => n.kind === 'text' || n.strokes.length || n.effects.length).map(n => n.id), editor.parentMap())
  const update = (label: string, change: (node: DesignNode, units: PropertyUnitReader) => void, targets = ids) => {
    // Read the current published snapshot when an edit commits, rather than
    // closing over the possibly older panel render or an evolving Immer draft.
    const units = propertyUnitReader(editor.state.doc)
    editor.updateProperties(targets, node => change(node, units), label)
  }
  const metric = (field: SelectionMetric, input: number | string) => update('修改所选图层属性', (node, units) => {
    const resolved = field === 'rotation' || field === 'opacity' ? undefined : units(node.id)
    const value = typeof input === 'string' ? numericExpression(input, selectionMetric(node, field, editor.state.doc, resolved), field === 'opacity' ? 'percent' : field === 'rotation' ? 'angle' : 'length') : input
    if (field === 'x' || field === 'y') setNodePosition(node, field, value, editor.state.doc, resolved)
    else if (field === 'rotation') rotateNode(node, nodeDegreesForFigmaAngle(value), selectionLocalBounds(editor.state.doc, node.id))
    else if (field === 'opacity') node.opacity = value / 100
    else resizeNodeDimension(node, field, value, editor.state.doc, resolved)
  })
  const smartIds = editor.topSelection()
  const smart = smartIds.length >= 2 && smartIds.length <= 256
    ? smartSelection(editor.state.doc, editor.state.page, smartIds, editor.entries())
    : null
  const blend = commonValue(nodes.map((node) => node.blend))
  const visible = commonValue(nodes.map((node) => node.visible)), locked = commonValue(nodes.map((node) => node.locked))
  const metricField = (field: SelectionMetric, label: string) => {
    const rotation = field === 'rotation', opacity = field === 'opacity'
    const dimension = field === 'width' || field === 'height'
    const liveOn = rotation && live && editor.interactionActive && live.session === editor.sessionGeneration &&
      live.page === editor.state.page && live.documentId === editor.state.doc.id
    const values = nodes.map(node => {
      const liveValue = liveOn ? live.textById[node.id] : undefined
      if (liveValue !== undefined) return Number(liveValue)
      return selectionMetric(node, field, editor.state.doc, rotation || opacity ? undefined : readUnits(node.id))
    })
    const shared = rotation ? commonValue(values.map(value => Number(formatAngleDegrees(value)))) : commonValue(values)
    if (!sketch && dimension && nodes.some(node => node.kind === 'text' && node.sizing?.[field] === 'hug')) {
      return <CalculatedDimension label={field === 'width' ? 'W' : 'H'} value={shared} />
    }
    return <MixedNumberField historyLabel={label} unit={opacity ? 'percent' : rotation ? 'angle' : 'length'}
      diagnosticFamily={opacity ? 10 : field === 'width' ? 3 : field === 'height' ? 4 : 2}
      label={tr(label)} caption={rotation ? '∠' : undefined} formatValue={rotation ? formatAngleDegrees : undefined} value={shared}
      min={dimension ? 0.01 : opacity ? 0 : -1e6} max={opacity ? 100 : 1e6}
      bases={values} onExpression={value => metric(field, value)} onChange={value => metric(field, value)} />
  }
  const rotation = metricField('rotation', '旋转 °')
  const position = <div className="geometry-position">{metricField('x', 'X')}{metricField('y', 'Y')}{sketch && rotation}</div>
  const dimensions = <div className="geometry-dimensions geometry-multiple-dimensions">{metricField('width', 'W')}{metricField('height', 'H')}</div>
  const textNodes = nodes.filter(node => node.kind === 'text'), textIds = textNodes.map(node => node.id)
  const textSizing = textNodes.length === nodes.length && <TextSizingControls editor={editor} nodes={textNodes} sketch={sketch} />
  return <aside className="inspector" aria-label={tr("多选属性")} data-geometry-mode={uiMode}>
    {sketch && <div className="sketch-inspector-alignment"><AlignmentControls editor={editor} compact /></div>}
    <div className="panel-tabs"><span>{propertyLayerCount(nodes.length, locale)}</span></div>
    <div className="inspector-scroll">
      {styleDescription && <p role="note" className="property-unit-notice">{tr('＊ 最大缩放系数换算。')}{tr(styleDescription)}</p>}
      <section className="geometry-position-section">
        {!sketch && <><h3>{tr('位置')}</h3><AlignmentControls editor={editor} compact /></>}
        {position}
        {sketch ? <>{dimensions}{textSizing}</> : <div className="geometry-rotation">
          {rotation}<div className="geometry-actions"><FlipControls editor={editor} /></div>
        </div>}
      </section>
      {!sketch && <section className="layout-panel"><h3>{tr('布局')}</h3>{dimensions}{textSizing}</section>}
      <section>
        <h3>{tr('外观')}</h3>
        {metricField('opacity', '透明度 %')}
        <label className="labeled-select">{tr("混合模式")}<select aria-label={tr("混合模式")} value={blend ?? 'mixed'} onChange={(event) => update('批量修改混合模式', (node) => { node.blend = event.target.value as NodeBlend })}>
          {blend === undefined && <option value="mixed" disabled>{tr("混合")}</option>}<option value="pass-through">{tr("穿透")}</option>{blendModes.map((value) => <option key={value}>{value}</option>)}
        </select></label>
        <div className="selection-actions">
          <button type="button" onClick={() => update('切换可见性', (node) => { node.visible = visible !== true })}>{tr(visible === true ? '隐藏所选图层' : '显示所选图层')}</button>
          <button type="button" onClick={() => update('切换锁定', (node) => { node.locked = locked !== true })}>{tr(locked === true ? '解锁所选图层' : '锁定所选图层')}</button>
        </div>
      </section>
      {smart&&<section><h3>{tr("智能选择")}</h3><div className="field-grid">{(['x','y'] as const).filter(axis=>smart[axis].length>1).map(axis=><NumberField historyLabel={axis==='x'?'水平间距':'垂直间距'} key={axis} unit="length" diagnosticFamily={2} label={tr(axis==='x'?'水平间距':'垂直间距')} value={axis==='x'?smart.gapX:smart.gapY} min={0} onChange={value=>{const patches=smartSpacing(editor.state.doc,smart,axis,value);editor.change('调整智能选区间距',d=>{for(const [id,patch] of Object.entries(patches))Object.assign(d.nodes[id],patch)})}}/>)}</div></section>}
      <SelectionColorsPanel editor={editor} />
      {!!textNodes.length && <FontManagementPanel editor={editor} ids={textIds} />}
      {!!textNodes.length && <section aria-label={tr("多选文字")}><h3>{tr(sketch ? '字符' : '排版')}</h3>
        <MixedNumberField unitDescription={styleUnitDescription(editor.state.doc, textIds, editor.parentMap())} historyLabel="字号" diagnosticFamily={2} unit="length" label={tr("字号")} min={1} max={4096}
          value={commonValue(textNodes.map(n => n.fontSize * readUnits(n.id).style))}
          onChange={v => update('批量修改字号', (n, units) => setWholeTextFontSize(n, v / units(n.id).style), textIds)}/>
        <MixedNumberField historyLabel="字重" diagnosticFamily={2} unit="number" label={tr("字重")} min={1} max={1000} value={commonValue(textNodes.map(n => n.textStyle?.weight ?? 400))}
          onChange={weight => update('批量修改字重', n => applyWholeTextStyle(n, { weight }), textIds)}/>
        <label className="labeled-select">{tr("文字对齐")}<select aria-label={tr("文字对齐")} value={commonValue(textNodes.map(n => n.textStyle?.align ?? 'start')) ?? ''}
          onChange={e => update('批量修改文字对齐', n => applyWholeTextStyle(n, { align: e.target.value as TextStyle['align'] }), textIds)}>
          <option value="" disabled>{tr("混合")}</option><option value="start">{tr("起始")}</option><option value="center">{tr("居中")}</option><option value="end">{tr("末尾")}</option><option value="justify">{locale === 'en' ? 'Justify' : tr("两端对齐")}</option>
        </select></label>
      </section>}
      {(['fills', 'strokes', 'effects'] as const).map(field => <MultiStylePanel key={field} editor={editor} nodes={nodes} field={field} readUnits={readUnits}/>)}
      <section><h3>{tr("布局与组件")}</h3><div className="selection-actions">
        <button type="button" onClick={() => editor.autoLayout()}>{tr("添加自动布局")}</button><button type="button" onClick={() => editor.group()}>{tr("编组")}</button>
        <button type="button" onClick={() => editor.createComponent()}>{tr("创建组件")}</button>
        {nodes.every((node) => node.component) && <button type="button" onClick={() => editor.combineVariants()}>{tr("组合为变体")}</button>}
      </div></section>
    </div>
  </aside>
}
