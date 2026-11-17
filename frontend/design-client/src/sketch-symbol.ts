import { createMain, definitionOwner, insertInstance, instanceOwner } from './components'
import { cloneValue } from './draft'
import type { Editor } from './engine'
import { framePlacementRight } from './frame-presets'
import { allParents, apply, bounds, boxPoints, multiply, translate, worldMatrix } from './geometry'
import { uid, type DesignDocument } from './model'

export function sketchSymbolSelection(editor: Editor) {
  const ids = editor.topSelection()
  if (!ids.length || ids.length !== editor.topSelection(true).length) return []
  const doc = editor.state.doc, parents = editor.parentMap(doc)
  const parent = parents.get(ids[0])
  if (ids.some(id => parents.get(id) !== parent || instanceOwner(doc, id) || definitionOwner(doc, id, parents))) return []
  return ids
}

export function createSketchSymbol(doc: DesignDocument, ids: string[], pageId: string, name: string, sendToSymbols: boolean) {
  const parents = allParents(doc), parent = parents.get(ids[0]) || pageId
  const page = doc.pages.find(item => item.id === pageId)!
  const siblings = doc.nodes[parent]?.children ?? page.children
  const selected = new Set(ids)
  const sourceId = createMain(doc, siblings.filter(id => selected.has(id)), pageId)
  const source = doc.nodes[sourceId]
  source.name = name

  let sourcePage = sendToSymbols ? doc.pages.find(item => item.name === 'Symbols') : page
  if (!sourcePage) {
    sourcePage = { id: uid(), name: 'Symbols', children: [], background: page.background }
    doc.pages.push(sourcePage)
  }
  const matrix = worldMatrix(doc, sourceId)
  const box = bounds(boxPoints({ x: 0, y: 0, width: source.width, height: source.height }).map(point => apply(matrix, point)))
  const right = framePlacementRight(doc, sourcePage.id)
  const x = Number.isFinite(right) ? right + 100 : 0
  const y = sourcePage.id === pageId ? box.y : 0

  const instanceId = insertInstance(doc, sourceId, pageId, { x: matrix[4], y: matrix[5] }, doc.nodes[parent] ? parent : undefined)
  const instance = doc.nodes[instanceId]
  instance.transform = [...source.transform]
  if (source.constraints) instance.constraints = cloneValue(source.constraints)
  if (source.variableModes) instance.variableModes = cloneValue(source.variableModes)
  delete instance.sketchTemplate
  siblings.pop()
  siblings.splice(siblings.indexOf(sourceId), 1, instanceId)

  source.transform = multiply(translate(x - box.x, y - box.y), matrix)
  delete source.constraints
  sourcePage.children.push(sourceId)
  return instanceId
}

const dialogs = new WeakMap<Editor, () => boolean>()

export function bindSketchSymbolDialog(editor: Editor, open: () => boolean) {
  dialogs.set(editor, open)
  return () => { if (dialogs.get(editor) === open) dialogs.delete(editor) }
}

export function requestSketchSymbolDialog(editor: Editor) {
  return dialogs.get(editor)?.()
}
