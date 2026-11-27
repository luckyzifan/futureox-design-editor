import { usePropertyText } from './property-interface-messages'
import { useMemo } from 'react'
import { ChevronRight } from 'lucide-react'
import type { Editor } from './engine'
import { ColorInput } from './ColorInput'
import { commitPendingEdits } from './pending-edits'
import { useInterfacePreferences } from './interface-preference'
import { selectionColors, replaceSelectionColor, selectionColorLayerIds, type SelectionColor } from './selection-colors'

export function SelectionColorsPanel({ editor }: { editor: Editor }) {
  const { locale, tr } = usePropertyText()
  const { uiMode } = useInterfacePreferences()
  const { doc, selection } = editor.state
  const groups = useMemo(() => selectionColors(doc, selection), [doc, selection])
  if (!groups.length) return null
  return <section aria-label={tr("选区颜色")}><h3>{tr("选区颜色")}<small>{groups.length}</small></h3>
    {groups.map((group, index) => {
      const linked = group.uses.some(use => use.linked)
      const count = group.uses.length
      const references = locale === 'en' ? `${count} ${count === 1 ? 'reference' : 'references'}` : `${count} 处`
      return <div className="selection-color-row" data-selection-color={group.color} key={`${group.color}/${index}`}>
        {linked ? <span className="linked-color" title={tr("此颜色引用变量或共享样式")}>{group.color}</span> :
          <ColorInput editableHex label={`${tr("选区颜色")} ${index + 1}`} value={group.color} onChange={color => editor.updateProperties(
            [...new Set(group.uses.map(use => use.id))], node => replaceSelectionColor(node, group.uses, color), '修改选区颜色')} />}
        <span className="selection-color-count" title={references} aria-label={references}>{uiMode === 'figma' ? count : references}</span>
        <button type="button" className="selection-color-select" aria-label={tr("选择使用此颜色的图层")} title={tr("选择使用此颜色的图层")}
          onClick={() => selectLayersUsingColor(editor, group)}>
          <ChevronRight size={13} />
        </button>
        {linked && <button type="button" title={tr("保留当前外观；所在填充、描边或效果列表的共享样式将转为本地属性")} onClick={() => editor.updateProperties(
          [...new Set(group.uses.map(use => use.id))], node => replaceSelectionColor(node, group.uses, group.color, true), '将选区颜色转为本地覆盖')}>{tr("转为本地颜色")}</button>}
      </div>
    })}
  </section>
}

function selectLayersUsingColor(editor: Editor, group: SelectionColor) {
  if (!commitPendingEdits(editor)) return
  const ids = selectionColorLayerIds(group)
  if (ids.length) editor.select(ids)
}
