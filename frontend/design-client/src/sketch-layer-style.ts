import type { DesignSystem } from './design-system'
import { cloneValue } from './draft'
import { equalValue } from './document-patch'
import type { Editor } from './engine'
import type { DesignDocument, DesignNode, Paint } from './model'
import { commitPendingEdits } from './pending-edits'

export type LayerStyle = DesignSystem['styles'][string]

export function captureLayerStyle(node: DesignNode, name: string): LayerStyle {
  return {
    kind: 'paint', name, value: cloneValue(node.fills),
    strokes: cloneValue(node.strokes), effects: cloneValue(node.effects),
  }
}

export function copyLayerStyle(node: DesignNode, style: LayerStyle) {
  node.fills = cloneValue(style.value as Paint[])
  if (style.strokes?.length && !node.styleRefs?.strokes) node.strokes = cloneValue(style.strokes)
  if (style.effects?.length) {
    node.effects = cloneValue(style.effects)
    if (node.styleRefs) delete node.styleRefs.effects
  }
  delete node.sketchLayerStyleOverridden
}

export function applySketchLayerStyle(node: DesignNode, id: string, style: LayerStyle) {
  copyLayerStyle(node, style)
  node.styleRefs = { ...node.styleRefs, fills: id }
}

export function linkedLayerStyle(doc: DesignDocument, node: DesignNode) {
  const id = node.styleRefs?.fills
  const style = id && doc.designSystem?.styles[id]
  if (id && style && style.kind === 'paint') return { id, style }
}

export function keepSketchLayerStyleEdit(doc: DesignDocument, node: DesignNode, before: DesignNode) {
  if (node.sketchLayerStyleOverridden || node.instance || node.instanceOrigin || !linkedLayerStyle(doc, node)) return
  if (!equalValue(node.fills, before.fills) ||
      (!node.styleRefs?.strokes && !equalValue(node.strokes, before.strokes)) ||
      (!node.styleRefs?.effects && !equalValue(node.effects, before.effects))) {
    node.sketchLayerStyleOverridden = true
    doc.schemaVersion = 26
  }
}

export function resetSketchLayerStyle(editor: Editor) {
  const { doc, page, selection } = editor.state
  const [id] = selection
  const generation = editor.sessionGeneration
  const selectedStyle = () => {
    if (editor.sessionGeneration !== generation || editor.state.page !== page || editor.state.doc.id !== doc.id ||
        editor.state.selection.length !== 1 || editor.state.selection[0] !== id || editor.interactionActive ||
        editor.state.busy || editor.topSelection()[0] !== id) return
    const selected = editor.state.doc.nodes[id]
    if (!selected || selected.instance || selected.instanceOrigin) return
    return linkedLayerStyle(editor.state.doc, selected)
  }
  const linked = selectedStyle()
  if (!linked || !commitPendingEdits(editor) || selectedStyle()?.id !== linked.id) return false
  editor.change('还原共享样式', draft => {
    const node = draft.nodes[id]
    const current = linkedLayerStyle(draft, node)
    if (current?.id !== linked.id) return
    node.fills = cloneValue(current.style.value as Paint[])
    if (!node.styleRefs?.strokes) node.strokes = cloneValue(current.style.strokes ?? [])
    if (!node.styleRefs?.effects) node.effects = cloneValue(current.style.effects ?? [])
    delete node.sketchLayerStyleOverridden
  })
  return true
}
