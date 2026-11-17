import type { Editor } from './engine'
import { useInterfacePreferences } from './interface-preference'
import { commitPendingEdits } from './pending-edits'
import { interactivePath } from './selection-hierarchy'
import { applySketchLayerStyle } from './sketch-layer-style'
import { SketchAssetPicker } from './SketchAssetPicker'

export type SketchReplacementTarget = {
  id: string
  kind: 'symbol' | 'text' | 'paint'
  source: string
  page: string
  generation: number
}

export function sketchReplacementTarget(editor: Editor): SketchReplacementTarget | undefined {
  const { doc, page, selection } = editor.state
  if (selection.length !== 1) return
  const id = selection[0], node = doc.nodes[id]
  if (!node || !interactivePath(doc, page, id, false, editor.parentMap()).length) return
  const selectionOwner = { id, page, generation: editor.sessionGeneration }
  if (node.instance) return { ...selectionOwner, kind: 'symbol', source: node.instance.componentId }
  if (node.instanceOrigin || node.kind === 'frame') return
  const text = node.styleRefs?.textStyle
  if (node.kind === 'text' && text && doc.designSystem?.styles[text]?.kind === 'text')
    return { ...selectionOwner, kind: 'text', source: text }
  const paint = node.styleRefs?.fills
  if (paint && doc.designSystem?.styles[paint]?.kind === 'paint')
    return { ...selectionOwner, kind: 'paint', source: paint }
}

const headings = {
  symbol: ['替换组件', 'Replace Symbol'],
  text: ['替换文字样式', 'Replace Text Style'],
  paint: ['替换图层样式', 'Replace Layer Style'],
} as const

export function SketchReplacementDialog({ editor, target, onClose }: {
  editor: Editor
  target: SketchReplacementTarget
  onClose: () => void
}) {
  const { locale } = useInterfacePreferences()
  const en = locale === 'en'
  const title = headings[target.kind][en ? 1 : 0]
  const { doc } = editor.state
  const candidates = target.kind === 'symbol'
    ? Object.values(doc.nodes).filter(node => node.component).map(({ id, name }) => ({ id, name }))
    : Object.entries(doc.designSystem?.styles || {}).filter(([, style]) => style.kind === target.kind)
      .map(([id, { name }]) => ({ id, name }))
  const ownsTarget = () => {
    if (editor.state.busy || editor.interactionActive) return false
    const current = sketchReplacementTarget(editor)
    return current?.generation === target.generation && current.page === target.page &&
      current.id === target.id && current.kind === target.kind && current.source === target.source
  }
  const replace = (id: string) => {
    if (!ownsTarget() || !commitPendingEdits(editor) || !ownsTarget())
      return en ? 'The selection changed. Reopen the replacement list.' : '所选图层已变化，请重新打开替换列表。'
    const result = target.kind === 'symbol'
      ? editor.swapInstance(target.id, id)
      : editor.change('应用共享样式', draft => {
          const style = draft.designSystem?.styles[id], node = draft.nodes[target.id]
          if (!style || style.kind !== target.kind) throw new Error(en ? 'The style is unavailable.' : '此样式已不可用。')
          if (style.kind === 'paint') applySketchLayerStyle(node, id, style)
          else node.styleRefs = { ...node.styleRefs, textStyle: id }
        })
    if (result.status !== 'committed' && result.status !== 'unchanged')
      return result.status === 'rejected' ? result.message : en ? 'Finish the current edit and try again.' : '请先完成当前编辑。'
  }

  return <SketchAssetPicker title={title} searchLabel={en ? 'Search replacements' : '搜索替换项'}
    emptyLabel={en ? 'No replacements found' : '没有匹配的替换项'} confirmLabel={en ? 'Replace' : '替换'}
    candidates={candidates.filter(({ id }) => id !== target.source)} onChoose={replace} onClose={onClose} />
}
