import { MultiStylePanel } from './MultiStylePanel'
import {smartSelection,smartSpacing} from './smart-selection'
import { AlignmentControls } from './AlignmentControls'
import {NumberField} from './fields'
import { propertyUnits } from './property-units'
import { numericExpression } from './numeric-expression'
import { SelectionColorsPanel } from './SelectionColorsPanel'
import type { Editor } from './engine'
import { type DesignNode, type NodeBlend, type TextStyle, defaultTextStyle, defaultSizing, blendModes } from './model'
import { applyWholeTextStyle, setWholeTextFontSize } from './text'
import { commonValue, resizeNodeDimension, selectionMetric, type SelectionMetric } from './selection-properties'
import { parentBounds, rotateNode } from './canvas-view'
import { MixedNumberField } from './MixedNumberField'

export function MultiSelectionInspector({ editor, nodes }: { editor: Editor; nodes: DesignNode[] }) {
  const ids = nodes.map((node) => node.id)
  const update = (label: string, change: (node: DesignNode) => void) => editor.updateProperties(ids, change, label)
  const metric = (field: SelectionMetric, input: number | string) => update('修改所选图层属性', (node) => {
    const value = typeof input === 'string' ? numericExpression(input, selectionMetric(node, field, editor.state.doc), field === 'opacity' ? 'percent' : field === 'rotation' ? 'angle' : 'length') : input
    if (field === 'x' || field === 'y') node.transform[field === 'x' ? 4 : 5] += value / propertyUnits(editor.state.doc, node.id)[field === 'x' ? 'parentX' : 'parentY'] - parentBounds(node)[field]
    else if (field === 'rotation') rotateNode(node, value)
    else if (field === 'opacity') node.opacity = value / 100
    else resizeNodeDimension(node, field, value, editor.state.doc)
  })
  const smart=smartSelection(editor.state.doc,editor.state.page,editor.topSelection())
  const blend = commonValue(nodes.map((node) => node.blend))
  const visible = commonValue(nodes.map((node) => node.visible)), locked = commonValue(nodes.map((node) => node.locked))
  return <aside className="inspector" aria-label="多选属性">
    <div className="panel-tabs"><b>设计</b><span>{nodes.length} 个图层</span></div>
    <div className="inspector-scroll">
      <section><h3>{nodes.length} 个图层</h3><p className="muted">混合表示数值不同。输入后会同时应用于所选图层。</p>
        <AlignmentControls editor={editor}/>
        <div className="field-grid">
          {([['x', 'X'], ['y', 'Y'], ['width', 'W'], ['height', 'H'], ['rotation', '旋转 °'], ['opacity', '透明度 %']] as const).map(([field, label]) =>
            <MixedNumberField key={field} label={label} value={commonValue(nodes.map((node) => selectionMetric(node, field, editor.state.doc)))}
              min={field === 'width' || field === 'height' ? 0.01 : field === 'opacity' ? 0 : -1e6}
              max={field === 'opacity' ? 100 : 1e6} bases={nodes.map(node => selectionMetric(node, field, editor.state.doc))} onExpression={value => metric(field, value)} onChange={(value) => metric(field, value)} />)}
        </div>
        <label className="labeled-select">混合模式<select aria-label="混合模式" value={blend ?? 'mixed'} onChange={(event) => update('批量修改混合模式', (node) => { node.blend = event.target.value as NodeBlend })}>
          {blend === undefined && <option value="mixed" disabled>混合</option>}<option value="pass-through">穿透</option>{blendModes.map((value) => <option key={value}>{value}</option>)}
        </select></label>
        <div className="selection-actions">
          <button type="button" onClick={() => update('切换可见性', (node) => { node.visible = visible !== true })}>{visible === true ? '隐藏所选图层' : '显示所选图层'}</button>
          <button type="button" onClick={() => update('切换锁定', (node) => { node.locked = locked !== true })}>{locked === true ? '解锁所选图层' : '锁定所选图层'}</button>
        </div>
      </section>
      {smart&&<section><h3>智能选择</h3><div className="field-grid">{(['x','y'] as const).filter(axis=>smart[axis].length>1).map(axis=><NumberField key={axis} label={axis==='x'?'水平间距':'垂直间距'} value={axis==='x'?smart.gapX:smart.gapY} min={0} onChange={value=>{const patches=smartSpacing(editor.state.doc,smart,axis,value);editor.change('调整智能选区间距',d=>{for(const [id,patch] of Object.entries(patches))Object.assign(d.nodes[id],patch)})}}/>)}</div></section>}
      <SelectionColorsPanel editor={editor} />
      {nodes.every(n => n.kind === 'text') && <section aria-label="多选文字"><h3>文字</h3>
        <MixedNumberField label="字号" min={1} max={4096}
          value={commonValue(nodes.map(n => n.fontSize * propertyUnits(editor.state.doc, n.id).style))}
          onChange={v => update('批量修改字号', n => setWholeTextFontSize(n, v / propertyUnits(editor.state.doc, n.id).style))}/>
        <MixedNumberField label="字重" min={1} max={1000} value={commonValue(nodes.map(n => n.textStyle?.weight ?? 400))}
          onChange={weight => update('批量修改字重', n => applyWholeTextStyle(n, { weight }))}/>
        <label className="labeled-select">文字对齐<select aria-label="文字对齐" value={commonValue(nodes.map(n => n.textStyle?.align ?? 'start')) ?? ''}
          onChange={e => update('批量修改文字对齐', n => applyWholeTextStyle(n, { align: e.target.value as TextStyle['align'] }))}>
          <option value="" disabled>混合</option><option value="start">起始</option><option value="center">居中</option><option value="end">末尾</option><option value="justify">两端对齐</option>
        </select></label>
        <label className="labeled-select">文字尺寸<select aria-label="文字尺寸模式"
          value={commonValue(nodes.map(n => n.sizing?.width === 'hug' ? 'width' : n.sizing?.height === 'hug' ? 'height' : 'fixed')) ?? ''}
          onChange={e => update('批量修改文字尺寸模式', n => {
            const mode = e.target.value
            n.textStyle = { ...defaultTextStyle(), ...n.textStyle, wrap: mode !== 'width' }
            n.sizing = { ...defaultSizing(), ...n.sizing, width: mode === 'width' ? 'hug' : 'fixed', height: mode === 'fixed' ? 'fixed' : 'hug' }
          })}>
          <option value="" disabled>混合</option><option value="width">自动宽度</option><option value="height">自动高度</option><option value="fixed">固定尺寸</option>
        </select></label>
      </section>}
      {(['fills', 'strokes', 'effects'] as const).map(field => <MultiStylePanel key={field} editor={editor} nodes={nodes} field={field}/>)}
      <section><h3>布局与组件</h3><div className="selection-actions">
        <button type="button" onClick={() => editor.autoLayout()}>添加自动布局</button><button type="button" onClick={() => editor.group()}>编组</button>
        <button type="button" onClick={() => editor.createComponent()}>创建组件</button>
        {nodes.every((node) => node.component) && <button type="button" onClick={() => editor.combineVariants()}>组合为变体</button>}
      </div></section>
    </div>
  </aside>
}
