import { usePropertyText } from './property-interface-messages'
import type { Editor } from './engine'
import { ColorInput } from './ColorInput'
import { selectionColors, replaceSelectionColor } from './selection-colors'

export function SelectionColorsPanel({ editor }: { editor: Editor }) {
  const { locale, tr } = usePropertyText()
  const groups = selectionColors(editor.state.doc, editor.state.selection)
  if (!groups.length) return null
  return <section aria-label={tr("选区颜色")}><h3>{tr("选区颜色")}<small>{groups.length}</small></h3>
    {groups.map((group, index) => {
      const linked = group.uses.some(use => use.linked)
      return <div className="selection-color-row" key={`${group.color}/${index}`}>
        {linked ? <span className="linked-color" title={tr("此颜色引用变量或共享样式")}>{group.color}</span> :
          <ColorInput label={`${tr("选区颜色")} ${index + 1}`} value={group.color} onChange={color => editor.updateProperties(
            [...new Set(group.uses.map(use => use.id))], node => replaceSelectionColor(node, group.uses, color), '修改选区颜色')} />}
        <span title={tr("引用位置数量")}>{locale === 'en' ? `${group.uses.length} references` : `${group.uses.length} 处`}</span>
        {linked && <button type="button" title={tr("保留当前外观；所在填充、描边或效果列表的共享样式将转为本地属性")} onClick={() => editor.updateProperties(
          [...new Set(group.uses.map(use => use.id))], node => replaceSelectionColor(node, group.uses, group.color, true), '将选区颜色转为本地覆盖')}>{tr("转为本地颜色")}</button>}
      </div>
    })}
  </section>
}
