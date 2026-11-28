import type { Editor } from './engine'
import type { DesignDocument, DesignNode } from './model'
import { authorSketchHotspot, isSketchHotspot } from './sketch-hotspot'

/** Native Sketch Prototype menu edits. All three go through the same
 * document transaction as the inspector, so undo, save and reopen keep them. */

const startable = (node: DesignNode | undefined): node is DesignNode =>
  !!node && node.kind === 'frame' && !node.locked

export function prototypeStartCandidate(editor: Editor): DesignNode | undefined {
  const { doc, selection } = editor.state
  if (selection.length !== 1) return
  const node = doc.nodes[selection[0]]
  return startable(node) ? node : undefined
}

export function canSetPrototypeStart(editor: Editor) {
  return !!prototypeStartCandidate(editor)
}

export function setPrototypeStart(editor: Editor) {
  const node = prototypeStartCandidate(editor)
  if (!node) return false
  const result = editor.change('将画框设为起点', draft => {
    const target = draft.nodes[node.id]
    if (!target || !startable(target)) return
    ;(draft.prototype ??= { interactions: {} }).startNode = target.id
  })
  return result.status === 'committed'
}

const hotspotSource = (doc: DesignDocument, node: DesignNode | undefined): node is DesignNode =>
  !!node && !['frame', 'section', 'slice'].includes(node.kind) && !node.locked && !isSketchHotspot(doc, node)

export function hotspotCandidates(editor: Editor): DesignNode[] {
  const { doc } = editor.state
  const parents = editor.parentMap()
  return editor.topSelection().flatMap(id => {
    const node = doc.nodes[id]
    if (!node || !hotspotSource(doc, node)) return []
    // A locked ancestor keeps the whole subtree out of the edit.
    for (let parent = parents.get(id); parent; parent = parents.get(parent)) if (doc.nodes[parent]?.locked) return []
    return [node]
  })
}

export function canConvertToHotspot(editor: Editor) {
  return hotspotCandidates(editor).length > 0
}

export function convertSelectionToHotspot(editor: Editor) {
  const ids = hotspotCandidates(editor).map(node => node.id)
  if (!ids.length) return false
  const result = editor.change('转换为热区', draft => {
    for (const id of ids) {
      const node = draft.nodes[id]
      if (!node || node.locked || ['frame', 'section', 'slice'].includes(node.kind) || isSketchHotspot(draft, node)) continue
      authorSketchHotspot(draft, node)
    }
  })
  return result.status === 'committed'
}

export function linkedSelection(editor: Editor) {
  const { doc, selection } = editor.state
  return selection.filter(id => !!doc.prototype?.interactions[id]?.length)
}

export function canRemovePrototypeLinks(editor: Editor) {
  return linkedSelection(editor).length > 0
}

export function removePrototypeLinks(editor: Editor) {
  const ids = linkedSelection(editor)
  if (!ids.length) return false
  const result = editor.change('移除链接', draft => {
    const prototype = draft.prototype
    if (!prototype) return
    for (const id of ids) delete prototype.interactions[id]
    if (!Object.keys(prototype.interactions).length && !prototype.startNode && !prototype.flows?.length)
      delete draft.prototype
  })
  return result.status === 'committed'
}