import { SketchAssetPicker } from './SketchAssetPicker'
import type { Editor } from './engine'
import { useInterfacePreferences } from './interface-preference'
import { insertKeyboardPlacedNode, keyboardPlacedNode } from './keyboard-placement'
import { defaultTextStyle, type Point, type TextStyle } from './model'
import { commitPendingEdits } from './pending-edits'

export type SketchTextStyleAnchor = { documentId: string; page: string; generation: number; point: Point }

export function SketchTextStyleDialog({ editor, anchor, onClose }: {
  editor: Editor
  anchor: SketchTextStyleAnchor
  onClose: () => void
}) {
  const { locale } = useInterfacePreferences()
  const en = locale === 'en'
  const candidates = Object.entries(editor.authoredDocument.designSystem?.styles ?? {})
    .flatMap(([id, style]) => style.kind === 'text' ? [{ id, name: style.name }] : [])
  const ownsAnchor = () => editor.sessionGeneration === anchor.generation &&
    editor.state.doc.id === anchor.documentId && editor.state.page === anchor.page &&
    !editor.state.busy && !editor.interactionActive
  const insert = (styleId: string) => {
    if (!ownsAnchor() || !commitPendingEdits(editor) || !ownsAnchor())
      return en ? 'The document changed. Reopen the style list.' : '文档已变化，请重新打开样式列表。'
    const layer = keyboardPlacedNode('text', anchor.point, editor.state.snapPixels)
    const result = editor.change('置入文字样式', doc => {
      const style = doc.designSystem?.styles[styleId]
      if (style?.kind !== 'text') throw new Error(en ? 'The text style is unavailable.' : '此文字样式已不可用。')
      const { fontSize, ...typography } = style.value as Partial<TextStyle> & { fontSize?: number }
      layer.textStyle = { ...defaultTextStyle(), ...typography }
      if (typeof fontSize === 'number' && Number.isFinite(fontSize) && fontSize >= 1 && fontSize <= 4096)
        layer.fontSize = fontSize
      layer.styleRefs = { textStyle: styleId }
      insertKeyboardPlacedNode(doc, anchor.page, layer)
    }, [layer.id])
    if (result.status === 'committed') {
      editor.set({ tool: 'select' })
      return
    }
    return result.status === 'rejected' ? result.message : en ? 'Finish the current edit and try again.' : '请先完成当前编辑。'
  }
  return <SketchAssetPicker title={en ? 'Insert Text Style' : '置入文字样式'}
    searchLabel={en ? 'Search text styles' : '搜索文字样式'} emptyLabel={en ? 'No text styles found' : '没有匹配的文字样式'}
    confirmLabel={en ? 'Insert' : '置入'} candidates={candidates} onChoose={insert} onClose={onClose} />
}
