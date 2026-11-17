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

function editLayerStyle(editor: Editor, styleId: string | undefined, label: string,
  edit: (doc: DesignDocument, node: DesignNode, id: string, style: LayerStyle) => void) {
  const { doc, page, selection } = editor.state
  const [id] = selection
  const generation = editor.sessionGeneration
  const selectedStyle = () => {
    if (editor.sessionGeneration !== generation || editor.state.page !== page || editor.state.doc.id !== doc.id ||
        editor.state.selection.length !== 1 || editor.state.selection[0] !== id || editor.interactionActive ||
        editor.state.busy || editor.topSelection()[0] !== id) return
    const selected = editor.state.doc.nodes[id]
    if (!selected || selected.instance || selected.instanceOrigin) return
    const styleKey = styleId ?? selected.styleRefs?.fills
    const style = styleKey && editor.state.doc.designSystem?.styles[styleKey]
    if (style && style.kind === 'paint') return styleKey
  }
  const linked = selectedStyle()
  if (!linked || !commitPendingEdits(editor) || selectedStyle() !== linked) return false
  const result = editor.change(label, draft => {
    const node = draft.nodes[id]
    const style = draft.designSystem?.styles[linked]
    if (style?.kind === 'paint') edit(draft, node, linked, style)
  })
  return result.status === 'committed' || result.status === 'unchanged'
}

function restoreLayerStyle(node: DesignNode, style: LayerStyle) {
  node.fills = cloneValue(style.value as Paint[])
  if (!node.styleRefs?.strokes) node.strokes = cloneValue(style.strokes ?? [])
  if (!node.styleRefs?.effects) node.effects = cloneValue(style.effects ?? [])
  delete node.sketchLayerStyleOverridden
}

export function resetSketchLayerStyle(editor: Editor) {
  return editLayerStyle(editor, undefined, '还原共享样式', (_doc, node, _id, style) => restoreLayerStyle(node, style))
}

export function updateSketchLayerStyle(editor: Editor, styleId?: string) {
  return editLayerStyle(editor, styleId, '更新共享样式', (doc, source, id, style) => {
    const updated = captureLayerStyle(source, style.name)
    if (!source.sketchLayerStyleOverridden && equalValue(updated.value, style.value) &&
        equalValue(updated.strokes, style.strokes ?? []) && equalValue(updated.effects, style.effects ?? [])) return
    Object.assign(style, updated)
    if (doc.schemaVersion < 12) doc.schemaVersion = 12
    for (const node of Object.values(doc.nodes)) {
      if (node.styleRefs?.fills === id && (!node.sketchLayerStyleOverridden || node.id === source.id))
        restoreLayerStyle(node, updated)
    }
  })
}
