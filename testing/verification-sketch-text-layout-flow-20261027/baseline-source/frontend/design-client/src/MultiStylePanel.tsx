import { usePropertyText, stylePropertyLabel } from './property-interface-messages'
import type { Editor } from './engine'
import { blendModes, paint, stroke, effect, type DesignNode, type Effect } from './model'
import { propertyUnitReader, styleUnitDescription, type PropertyUnitReader } from './property-units'
import { commonValue } from './selection-properties'
import { MixedNumberField } from './MixedNumberField'
import { DraftInput } from './DraftInput'
import { validColor } from './color'
import { clearWholeTextRunColor } from './text'
import { styleSlots, editStyleSlot, styleValue, setStyleValue, type StyleField } from './style-stack'

const effectNames: Record<Effect['kind'], string> = { shadow: '投影', 'inner-shadow': '内阴影', blur: '图层模糊', 'background-blur': '背景模糊', glass: '玻璃', noise: '噪声', texture: '纹理', 'color-controls': '颜色调整', 'gaussian-blur': '高斯模糊', 'motion-blur': '运动模糊', 'zoom-blur':'缩放模糊' }
const paintNames: Record<string, string> = {solid:'纯色',linear:'线性渐变',radial:'径向渐变',angular:'角度渐变',diamond:'菱形渐变',image:'图片'}
const names = { fills: '填充', strokes: '描边', effects: '效果' }
export function MultiStylePanel({ editor, nodes, field, readUnits = propertyUnitReader(editor.state.doc) }: { editor: Editor; nodes: DesignNode[]; field: StyleField; readUnits?: PropertyUnitReader }) {
  const { locale, tr } = usePropertyText()
  const add = (kind: Effect['kind'] = 'shadow') => editor.updateProperties(nodes.map(n => n.id), n => {
    if (n[field].length >= 16) throw new Error(tr('每层最多支持 16 项样式'))
    if (field === 'fills') { n.fills.push(paint()); clearWholeTextRunColor(n) }
    else if (field === 'strokes') n.strokes.push(stroke())
    else n.effects.push(effect(kind))
  }, `批量添加${names[field]}`)
  return <section aria-label={locale === 'en' ? `Multi-selection ${tr(names[field]).toLowerCase()}` : `多选${names[field]}`}><h3>{tr(names[field])}
    {field === 'effects' ? <select aria-label={tr("添加效果")} value="" onChange={e => { if (e.target.value) add(e.target.value as Effect['kind']) }}>
      <option value="">{tr("＋ 添加")}</option>{Object.entries(effectNames).map(([kind, label]) => <option key={kind} value={kind}>{tr(label)}</option>)}
    </select> : <button type="button" aria-label={locale === 'en' ? `Add ${tr(names[field]).toLowerCase()} to selection` : `批量添加${names[field]}`} onClick={() => add()}>{tr("＋ 添加")}</button>}
  </h3>{styleSlots(nodes, field).map(slot => {
    const slotIds = new Set(slot.ids), selected = nodes.filter(n => slotIds.has(n.id)), items = selected.map(n => n[field][slot.index])
    const title = `${names[field]} ${slot.index + 1}`, displayTitle = `${tr(names[field])} ${slot.index + 1}`, prefix = field === 'strokes' ? 'paint.' : ''
    const displayLabel = (label: string) => stylePropertyLabel(field, slot.index, label.slice(title.length), locale)
    const update = (path: string, value: unknown, scaled = false) => {
      const units = propertyUnitReader(editor.state.doc)
      editor.updateProperties(slot.ids, n =>
      editStyleSlot(n, field, slot, item => {
        const changed = setStyleValue(item, path, scaled && typeof value === 'number' ? value / units(n.id).style : value)
        if (changed && field === 'fills') clearWholeTextRunColor(n)
      }), `批量修改${title}`)
    }
    const number = (path: string, label: string, min = 0, max = 10000, scaled = false, percent = false) => {
      const values = items.map((item, i) => {
        const v = styleValue(item, path)
        return typeof v === 'number' ? v * (scaled ? readUnits(selected[i].id).style : 1) * (percent ? 100 : 1) : undefined
      })
      if (values.every(v => v === undefined)) return null
      return <MixedNumberField key={path} unitDescription={scaled ? styleUnitDescription(editor.state.doc, selected.map(n => n.id), editor.parentMap()) : undefined} historyLabel={label} diagnosticFamily={2} unit={percent ? 'percent' : path === 'angle' || path.endsWith('.angle') || path === 'glass.lightAngle' ? 'angle' : field === 'strokes' || path === 'glass.bevelSize' || path.startsWith('texture.noiseSize.') ? 'length' : 'number'} label={displayLabel(label)} value={commonValue(values)} min={min} max={max}
        onChange={v => update(path, percent ? v / 100 : v, scaled)}/>
    }
    const choice = (path: string, label: string, options: readonly (readonly [string, string])[]) => {
      const value = commonValue(items.map(item => styleValue(item, path)))
      return <label className="labeled-select" key={path}>{displayLabel(label)}<select aria-label={displayLabel(label)} value={typeof value === 'string' ? value : ''} onChange={e => update(path, e.target.value)}>
        <option value="" disabled>{tr("混合")}</option>{options.map(([v, text]) => <option key={v} value={v}>{tr(text)}</option>)}
      </select></label>
    }
    const color = (path: string, label: string) => {
      const value = commonValue(items.map(item => styleValue(item, path)))
      return <label className="labeled-select" key={path}>{displayLabel(label)}<DraftInput aria-label={displayLabel(label)} value={typeof value === 'string' ? value : ''} placeholder={tr("混合")}
        normalize={v => v.trim()} validate={v => !v || validColor(v)} onCommit={v => { if (v) update(path, v) }}/></label>
    }
    const remove = () => editor.updateProperties(slot.ids, n => editStyleSlot(n, field, slot, () => { n[field].splice(slot.index, 1); if (field === 'fills') clearWholeTextRunColor(n) }), `删除${title}`)
    const reorder = (delta: number) => editor.updateProperties(slot.ids, n => editStyleSlot(n, field, slot, () => {
      const list = n[field], target = slot.index + delta
      if (target >= 0 && target < list.length) [list[slot.index], list[target]] = [list[target], list[slot.index]]
      if (field === 'fills') clearWholeTextRunColor(n)
    }), `排列${title}`)
    const visible = items.every(item => item.visible)
    return <div className="property-card" key={`${slot.index}:${slot.kind}`}>
      <div className="property-title"><b>{displayTitle} · {tr(field === 'effects' ? effectNames[slot.kind as Effect['kind']] : paintNames[slot.kind])}</b><small>{locale === 'en' ? `${slot.ids.length}/${nodes.length} layers` : `${slot.ids.length}/${nodes.length} 层`}</small></div>
      <div className="selection-actions">
        <button type="button" aria-label={locale === 'en' ? `Move up ${displayTitle}` : `上移${title}`} disabled={slot.index === 0} onClick={() => reorder(-1)}>↑</button>
        <button type="button" aria-label={locale === 'en' ? `Move down ${displayTitle}` : `下移${title}`} disabled={selected.every(n => n[field].length <= slot.index + 1)} onClick={() => reorder(1)}>↓</button>
        <button type="button" aria-label={locale === 'en' ? `${visible ? 'Hide' : 'Show'} ${displayTitle}` : `${tr(visible ? '隐藏' : '显示')}${title}`} onClick={() => update('visible', !visible)}>{tr(visible ? '隐藏' : '显示')}</button>
        <button type="button" aria-label={locale === 'en' ? `Remove ${displayTitle}` : `删除${title}`} onClick={remove}>{tr("删除")}</button>
      </div>
      {field !== 'effects' && <>
        {slot.kind === 'solid' && color(`${prefix}color`, `${title}颜色`)}
        {number(`${prefix}opacity`, `${title}不透明度 %`, 0, 100, false, true)}
        {choice(`${prefix}blend`, `${title}混合模式`, blendModes.map(v => [v, v]))}
        {['linear', 'radial', 'angular', 'diamond'].includes(slot.kind) && <>
          {number(`${prefix}angle`, `${title}渐变角度`, -360, 360)}
          {Array.from({ length: Math.max(...items.map(item => (styleValue(item, `${prefix}stops`) as unknown[]).length)) }, (_, i) => <div key={i}>
            {color(`${prefix}stops.${i}.color`, `${title}色标 ${i + 1}`)}{number(`${prefix}stops.${i}.offset`, `${title}色标位置 ${i + 1} %`, 0, 100, false, true)}
          </div>)}
        </>}
        {slot.kind === 'image' && choice(`${prefix}fit`, `${title}图片适配`, [['cover', '填满'], ['contain', '适应'], ['stretch', '拉伸']])}
      </>}
      {field === 'strokes' && <>
        {number('width', `${title}粗细`, 0, 10000, true)}
        {choice('align', `${title}位置`, [['inside', '内部'], ['center', '居中'], ['outside', '外部']])}
        {choice('cap', `${title}端点`, [['butt', '平头'], ['round', '圆头'], ['square', '方头']])}
        {choice('join', `${title}连接`, [['miter', '尖角'], ['round', '圆角'], ['bevel', '斜角']])}
      </>}
      {field === 'effects' && <>
        {slot.kind !== 'zoom-blur' && number('radius', `${title}模糊`, 0, 1000, true)}
        {['shadow', 'inner-shadow'].includes(slot.kind) && <>{color('color', `${title}阴影颜色`)}{number('x', `${title}偏移 X`, -1000, 1000, true)}{number('y', `${title}偏移 Y`, -1000, 1000, true)}{number('spread', `${title}扩展`, -1000, 1000, true)}</>}
        {slot.kind !== 'zoom-blur' && number('opacity', `${title}强度 %`, 0, 100, false, true)}
        {['glass', 'texture', 'noise'].includes(slot.kind) && number('amount', `${title}幅度`, 0, 1000)}
        {number('zoomBlur.amount', `${title}缩放模糊强度`, 0, 1000)}
        {number('zoomBlur.center.0', `${title}焦点 X %`, -1e8, 1e8, false, true)}
        {number('zoomBlur.center.1', `${title}焦点 Y %`, -1e8, 1e8, false, true)}
        {(['depth', 'bevelSize', 'refraction', 'dispersion', 'lightAngle', 'lightIntensity'] as const).map(key => {
          const percent = ['refraction', 'dispersion', 'lightIntensity'].includes(key)
          const label = {depth:'深度',bevelSize:'倒角宽度',refraction:'折射',dispersion:'色散',lightAngle:'光线角度',lightIntensity:'照明'}[key]
          return number(`glass.${key}`, `${title}${label}${percent ? ' %' : ''}`, key === 'lightAngle' ? -360 : key === 'depth' ? 1 : key === 'bevelSize' ? .001 : 0, percent ? 100 : key === 'lightAngle' ? 360 : 1000, ['depth', 'bevelSize'].includes(key), percent)
        })}
        {number('texture.noiseSize.0', `${title}纹理宽`, .001, 10000, true)}{number('texture.noiseSize.1', `${title}纹理高`, .001, 10000, true)}
      </>}
    </div>
  })}</section>
}
