import { selectionLocalBounds, selectionParentBounds } from './canvas-view'
import type { Editor } from './engine'
import { canAutoPinChild, inferPins } from './layout-constraints'
import type { Bounds, Constraints } from './model'

type PinEdit = [id: string, pins: Constraints | undefined]
const lastSelectionPins = new WeakMap<Editor, {
  session: number
  revision: number
  targets: string[]
  previous: PinEdit[]
}>()

export function sketchAutoPin(editor: Editor, mode: 'selection' | 'contents') {
  const { doc, version } = editor.state
  const session = editor.sessionGeneration
  const targets = new Map<string, string>()
  const add = (id: string, parentId: string) => {
    const child = doc.nodes[id], parent = doc.nodes[parentId]
    if (child && parent && canAutoPinChild(parent, child)) targets.set(id, parentId)
  }
  const parents = mode === 'selection' ? editor.parentMap() : undefined
  for (const selected of editor.topSelection()) {
    if (parents) {
      const parentId = parents.get(selected)
      if (parentId) add(selected, parentId)
    } else {
      for (const child of doc.nodes[selected].children) add(child, selected)
    }
  }
  if (!targets.size) return

  const apply = (label: string, updates: PinEdit[]) => editor.change(label, draft => {
    for (const [id, pins] of updates) {
      if (pins) draft.nodes[id].constraints = { ...pins }
      else delete draft.nodes[id].constraints
    }
  })
  // A second Shift+A restores the exact prior pins for the same selection.
  // An intervening edit retires the receipt so it cannot overwrite new pins.
  const last = mode === 'selection' ? lastSelectionPins.get(editor) : undefined
  if (last && last.session === session && last.revision === version &&
      last.targets.length === targets.size && last.targets.every(id => targets.has(id))) {
    if (apply('取消自动固定', last.previous).status === 'committed') lastSelectionPins.delete(editor)
    return
  }

  const updates: PinEdit[] = [], previous: PinEdit[] = []
  const parentBoxes = new Map<string, Bounds>()
  for (const [id, parentId] of targets) {
    let parentBox = parentBoxes.get(parentId)
    if (!parentBox) parentBoxes.set(parentId, parentBox = selectionLocalBounds(doc, parentId))
    const pins = inferPins(doc.nodes[parentId], parentBox, selectionParentBounds(doc, id))
    const current = doc.nodes[id].constraints
    if (current?.horizontal === pins.horizontal && current?.vertical === pins.vertical &&
        current.referenceWidth === pins.referenceWidth && current.referenceHeight === pins.referenceHeight) continue
    updates.push([id, pins])
    if (mode === 'selection') previous.push([id, current])
  }
  if (!updates.length) return
  const result = apply(mode === 'selection' ? '自动固定选区' : '自动固定子图层', updates)
  if (mode === 'selection' && result.status === 'committed')
    lastSelectionPins.set(editor, { session, revision: result.revision, targets: [...targets.keys()], previous })
}
