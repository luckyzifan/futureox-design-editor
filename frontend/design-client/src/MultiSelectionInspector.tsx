import { usePropertyText, propertyLayerCount } from './property-interface-messages'
import { FontManagementPanel } from './FontManagementPanel'
import { MultiStylePanel } from './MultiStylePanel'
import {smartSelection,smartSpacing} from './smart-selection'
import { AlignmentControls } from './AlignmentControls'
import {NumberField} from './fields'
import { propertyUnitReader, styleUnitDescription, type PropertyUnitReader } from './property-units'
import { numericExpression } from './numeric-expression'
import { SelectionColorsPanel } from './SelectionColorsPanel'
import type { Editor } from './engine'
import { type DesignNode, type NodeBlend, type TextStyle, defaultTextStyle, defaultSizing, blendModes } from './model'
import { applyWholeTextStyle, setWholeTextFontSize } from './text'
import { commonValue, resizeNodeDimension, selectionMetric, setNodePosition, type SelectionMetric } from './selection-properties'
import { useSyncExternalStore } from 'react'
import { selectionLocalBounds, rotateNode } from './canvas-view'
import { formatAngleDegrees } from './selection-handles'
import { figmaRotationDegrees, nodeDegreesForFigmaAngle } from './rotation-field'
import { MixedNumberField } from './MixedNumberField'

export function MultiSelectionInspector({ editor, nodes }: { editor: Editor; nodes: DesignNode[] }) {
  const { locale, tr } = usePropertyText()
  const live = useSyncExternalStore(editor.subscribeLiveRotation, () => editor.liveRotation)
  const ids = nodes.map((node) => node.id)
  const readUnits = propertyUnitReader(editor.state.doc)
  const styleDescription = styleUnitDescription(editor.state.doc, nodes.filter(n => n.kind === 'text' || n.strokes.length || n.effects.length).map(n => n.id), editor.parentMap())
  const update = (label: string, change: (node: DesignNode, units: PropertyUnitReader) => void) => {
    // Read the current published snapshot when an edit commits, rather than
    // closing over the possibly older panel render or an evolving Immer draft.
    const units = propertyUnitReader(editor.state.doc)
    editor.updateProperties(ids, node => change(node, units), label)
  }
  const metric = (field: SelectionMetric, input: number | string) => update('修改所选图层属性', (node, units) => {
    const resolved = field === 'rotation' || field === 'opacity' ? undefined : units(node.id)
    const value = typeof input === 'string' ? numericExpression(input, selectionMetric(node, field, editor.state.doc, resolved), field === 'opacity' ? 'percent' : field === 'rotation' ? 'angle' : 'length') : input
    if (field === 'x' || field === 'y') setNodePosition(node, field, value, editor.state.doc, resolved)
    else if (field === 'rotation') rotateNode(node, nodeDegreesForFigmaAngle(value), selectionLocalBounds(editor.state.doc, node.id))
    else if (field === 'opacity') node.opacity = value / 100
    else resizeNodeDimension(node, field, value, editor.state.doc, resolved)
  })
  const smart=smartSelection(editor.state.doc,editor.state.page,editor.topSelection())
  const blend = commonValue(nodes.map((node) => node.blend))
  const visible = commonValue(nodes.map((node) => node.visible)), locked = commonValue(nodes.map((node) => node.locked))
  return <aside className="inspector" aria-label={tr("多选属性")}>
    <div className="panel-tabs"><b>{tr("设计")}</b><span>{propertyLayerCount(nodes.length, locale)}</span></div>
    <div className="inspector-scroll">
      {styleDescription && <p role="note" className="property-unit-notice">＊ 最大缩放系数换算。{styleDescription}</p>}
      <section><h3>{propertyLayerCount(nodes.length, locale)}</h3><p className="muted">{tr("混合表示数值不同。输入后会同时应用于所选图层。")}</p>
        <AlignmentControls editor={editor}/>
        <div className="field-grid">
          {([['x', 'X'], ['y', 'Y'], ['width', 'W'], ['height', 'H'], ['rotation', '旋转 °'], ['opacity', '透明度 %']] as const).map(([field, label]) => {
            const liveOn = field === 'rotation' && live && editor.interactionActive && live.session === editor.sessionGeneration && live.page === editor.state.page && live.documentId === editor.state.doc.id
            const values = nodes.map(node => {
              if (field === 'rotation') {
                const text = liveOn ? live!.textById[node.id] : undefined
                return text !== undefined ? Number(text) : figmaRotationDegrees(node.transform)
              }
              return selectionMetric(node, field, editor.state.doc, field === 'opacity' ? undefined : readUnits(node.id))
            })
            const shared = field === 'rotation'
              ? (values.every(value => formatAngleDegrees(value) === formatAngleDegrees(values[0])) ? Number(formatAngleDegrees(values[0])) : undefined)
              : commonValue(values)
            return <MixedNumberField historyLabel={label} key={field} unit={field === 'opacity' ? 'percent' : field === 'rotation' ? 'angle' : 'length'} diagnosticFamily={field === 'opacity' ? 10 : field === 'width' ? 3 : field === 'height' ? 4 : 2} label={tr(label)} caption={field === 'rotation' ? '∠' : undefined} formatValue={field === 'rotation' ? formatAngleDegrees : undefined} value={shared}
              min={field === 'width' || field === 'height' ? 0.01 : field === 'opacity' ? 0 : -1e6}
              max={field === 'opacity' ? 100 : 1e6} bases={values} onExpression={value => metric(field, value)} onChange={(value) => metric(field, value)} />})}
        </div>
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
      {nodes.some(n => n.kind === 'text') && <FontManagementPanel editor={editor} ids={ids} />}
      {nodes.every(n => n.kind === 'text') && <section aria-label={tr("多选文字")}><h3>{tr("文字")}</h3>
        <MixedNumberField unitDescription={styleUnitDescription(editor.state.doc, nodes.map(n => n.id), editor.parentMap())} historyLabel="字号" diagnosticFamily={2} unit="length" label={tr("字号")} min={1} max={4096}
          value={commonValue(nodes.map(n => n.fontSize * readUnits(n.id).style))}
          onChange={v => update('批量修改字号', (n, units) => setWholeTextFontSize(n, v / units(n.id).style))}/>
        <MixedNumberField historyLabel="字重" diagnosticFamily={2} unit="number" label={tr("字重")} min={1} max={1000} value={commonValue(nodes.map(n => n.textStyle?.weight ?? 400))}
          onChange={weight => update('批量修改字重', n => applyWholeTextStyle(n, { weight }))}/>
        <label className="labeled-select">{tr("文字对齐")}<select aria-label={tr("文字对齐")} value={commonValue(nodes.map(n => n.textStyle?.align ?? 'start')) ?? ''}
          onChange={e => update('批量修改文字对齐', n => applyWholeTextStyle(n, { align: e.target.value as TextStyle['align'] }))}>
          <option value="" disabled>{tr("混合")}</option><option value="start">{tr("起始")}</option><option value="center">{tr("居中")}</option><option value="end">{tr("末尾")}</option><option value="justify">{locale === 'en' ? 'Justify' : tr("两端对齐")}</option>
        </select></label>
        <label className="labeled-select">{tr("文字尺寸")}<select aria-label={tr("文字尺寸模式")}
          value={commonValue(nodes.map(n => n.sizing?.width === 'hug' ? 'width' : n.sizing?.height === 'hug' ? 'height' : 'fixed')) ?? ''}
          onChange={e => update('批量修改文字尺寸模式', n => {
            const mode = e.target.value
            n.textStyle = { ...defaultTextStyle(), ...n.textStyle, wrap: mode !== 'width' }
            n.sizing = { ...defaultSizing(), ...n.sizing, width: mode === 'width' ? 'hug' : 'fixed', height: mode === 'fixed' ? 'fixed' : 'hug' }
          })}>
          <option value="" disabled>{tr("混合")}</option><option value="width">{tr("自动宽度")}</option><option value="height">{tr("自动高度")}</option><option value="fixed">{tr("固定尺寸")}</option>
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
