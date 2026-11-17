import { SketchAssetPicker } from './SketchAssetPicker'
import { componentSources } from './components'
import type { Editor } from './engine'
import { useInterfacePreferences } from './interface-preference'
import { insertKeyboardPlacedNode, keyboardPlacedNode } from './keyboard-placement'
import { defaultTextStyle, type Point, type TextStyle } from './model'
import { commitPendingEdits } from './pending-edits'

export type SketchInsertionAnchor = {
  documentId: string; page: string; generation: number; point: Point; kind: 'text' | 'symbol'
}

export function SketchInsertionDialog({ editor, anchor, onClose }: {
  editor: Editor
  anchor: SketchInsertionAnchor
  onClose: () => void
}) {
  const { locale } = useInterfacePreferences()
  const en = locale === 'en'
  const symbol = anchor.kind === 'symbol'
  const candidates = symbol ? componentSources(editor.authoredDocument).map(({ id, name }) => ({ id, name })) :
    Object.entries(editor.authoredDocument.designSystem?.styles ?? {})
      .flatMap(([id, style]) => style.kind === 'text' ? [{ id, name: style.name }] : [])
  const unavailable = en ? 'Finish the current edit and try again.' : '请先完成当前编辑。'
  const ownsAnchor = () => editor.sessionGeneration === anchor.generation &&
    editor.state.doc.id === anchor.documentId && editor.state.page === anchor.page &&
    !editor.state.busy && !editor.interactionActive
  const insert = (id: string) => {
    if (!ownsAnchor() || !commitPendingEdits(editor) || !ownsAnchor())
      return en ? 'The document changed. Reopen the picker.' : '文档已变化，请重新打开选择器。'
    if (symbol) {
      const source = editor.authoredDocument.nodes[id]
      if (!source?.component || source.instanceOrigin)
        return en ? 'The symbol is unavailable.' : '此控件已不可用。'
      const inserted = editor.insertComponent(id, anchor.point)
      if (editor.state.doc.nodes[inserted]?.instance?.componentId === id) {
        editor.set({ tool: 'select' })
        return
      }
      return unavailable
    }
    const layer = keyboardPlacedNode('text', anchor.point, editor.state.snapPixels)
    const result = editor.change('置入文字样式', doc => {
      const style = doc.designSystem?.styles[id]
      if (style?.kind !== 'text') throw new Error(en ? 'The text style is unavailable.' : '此文字样式已不可用。')
      const { fontSize, ...typography } = style.value as Partial<TextStyle> & { fontSize?: number }
      layer.textStyle = { ...defaultTextStyle(), ...typography }
      if (typeof fontSize === 'number' && Number.isFinite(fontSize) && fontSize >= 1 && fontSize <= 4096)
        layer.fontSize = fontSize
      layer.styleRefs = { textStyle: id }
      insertKeyboardPlacedNode(doc, anchor.page, layer)
    }, [layer.id])
    if (result.status === 'committed') {
      editor.set({ tool: 'select' })
      return
    }
    return result.status === 'rejected' ? result.message : unavailable
  }
  if (symbol) return <SketchAssetPicker title={en ? 'Insert Symbol' : '置入控件'}
    searchLabel={en ? 'Search symbols' : '搜索控件'} emptyLabel={en ? 'No symbols found' : '没有可置入的控件'}
    confirmLabel={en ? 'Insert' : '置入'} candidates={candidates} onChoose={insert} onClose={onClose} />
  return <SketchAssetPicker title={en ? 'Insert Text Style' : '置入文字样式'}
    searchLabel={en ? 'Search text styles' : '搜索文字样式'} emptyLabel={en ? 'No text styles found' : '没有匹配的文字样式'}
    confirmLabel={en ? 'Insert' : '置入'} candidates={candidates} onChoose={insert} onClose={onClose} />
}
