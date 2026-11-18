import type { Editor } from './engine'

const placements = new WeakMap<Editor, { componentId: string; documentId: string; page: string; session: number }>()

export function armComponentPlacement(editor: Editor, componentId: string) {
  const { doc, page, busy, tool } = editor.state
  if (busy || editor.interactionActive || tool !== 'select' || !doc.nodes[componentId]?.component) return false
  placements.set(editor, { componentId, documentId: doc.id, page, session: editor.sessionGeneration })
  return true
}

export function cancelComponentPlacement(editor: Editor) {
  return placements.delete(editor)
}

export function takeComponentPlacement(editor: Editor) {
  const placement = placements.get(editor)
  if (!placement) return
  placements.delete(editor)
  const { doc, page, busy, tool } = editor.state
  if (placement.session !== editor.sessionGeneration || placement.documentId !== doc.id || placement.page !== page ||
      tool !== 'select' || busy || editor.interactionActive || !doc.nodes[placement.componentId]?.component) return
  return placement.componentId
}
