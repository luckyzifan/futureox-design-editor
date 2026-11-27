import { apply, bounds, boxPoints, around, rotate, unionBounds, worldMatrix } from './geometry'
import { prepareDuplication, type DuplicationPlan } from './commands/duplication-command'
import { SelectionCommandError } from './commands/selection-command'
import { duplicateGraph } from './duplicate-graph'
import type { Editor } from './engine'
import { interfacePreference } from './interface-preference'
import type { DesignDocument, Point } from './model'

/** Native Sketch 2025.1.3 Layer > Path > Rotate Copies asks for a copy count
 * and rotates copies around a center point. The sheet default is 6 copies,
 * producing 7 layers including the original, so the step is 360 / 7. The
 * built-in tool exposes a draggable center; this command uses the selection's
 * world-bounds center and keeps the original unrotated. */
export const MAX_ROTATE_COPIES = 64
export const DEFAULT_ROTATE_COPIES = 6

export type SketchRotateCopiesTarget = {
  document: DesignDocument
  revision: number
  session: number
  page: string
  selection: readonly string[]
  roots: readonly string[]
  center: Point
  content: DuplicationPlan['content']
}

export function validRotateCopies(value: number) {
  return Number.isInteger(value) && value >= 1 && value <= MAX_ROTATE_COPIES
}

function activeLayout(doc: DesignDocument, id: string) {
  const layout = doc.nodes[id]?.layout
  return !!layout && layout.mode !== 'none'
}

function selectionCenter(doc: DesignDocument, roots: readonly string[]): Point | null {
  const boxes = roots.map(id => {
    const node = doc.nodes[id]
    if (!node || ![node.width, node.height].every(Number.isFinite)) return null
    const matrix = worldMatrix(doc, id)
    if (!matrix.every(Number.isFinite)) return null
    return bounds(boxPoints({ x: 0, y: 0, width: node.width, height: node.height }).map(point => apply(matrix, point)))
  })
  if (boxes.some(box => !box)) return null
  const all = unionBounds(boxes as Exclude<typeof boxes[number], null>[])
  return { x: all.x + all.width / 2, y: all.y + all.height / 2 }
}

/** Snapshot the admitted selection before the dialog can be answered. */
export function rotateCopiesTarget(editor: Editor): SketchRotateCopiesTarget | null {
  const { doc, page, selection, busy } = editor.state
  if (interfacePreference.getSnapshot().uiMode !== 'sketch' || busy || editor.interactionActive ||
      !selection.length || selection.length > MAX_ROTATE_COPIES) return null
  try {
    const plan = prepareDuplication(doc, selection, { kind: 'world-offset', x: 0, y: 0 },
      { fresh: true, singleStep: true, mutable: false })
    const roots = plan.content.roots, parents = editor.parentMap()
    // Native layout owns the placement of flow children, so a rotated copy
    // would not keep its authored transform. Containers themselves stay valid.
    if (!roots.length || roots.some(id => activeLayout(doc, parents.get(id) ?? ''))) return null
    const center = selectionCenter(doc, roots)
    if (!center) return null
    return { document: doc, revision: editor.state.version, session: editor.sessionGeneration, page,
      selection: [...selection], roots: [...roots], center, content: plan.content }
  } catch (error) {
    if (error instanceof SelectionCommandError) return null
    throw error
  }
}

export function canRotateCopies(editor: Editor) {
  return rotateCopiesTarget(editor) !== null
}

export function rotateCopiesTargetIsCurrent(editor: Editor, target: SketchRotateCopiesTarget) {
  const state = editor.state
  return interfacePreference.getSnapshot().uiMode === 'sketch' && !state.busy && !editor.interactionActive &&
    state.doc === target.document && state.version === target.revision &&
    editor.sessionGeneration === target.session && state.page === target.page &&
    state.selection.length === target.selection.length &&
    state.selection.every((id, index) => id === target.selection[index])
}

/** One undoable edit. Each step copies the same admitted roots and applies a
 * world rotation around the captured center; duplicated copies become the
 * selection so the inspector shows the generated layers. */
export function applySketchRotateCopies(editor: Editor, target: SketchRotateCopiesTarget, copies: number) {
  if (!rotateCopiesTargetIsCurrent(editor, target) || !validRotateCopies(copies)) return
  const step = 360 / (copies + 1)
  const selection: string[] = []
  return editor.change('旋转副本', draft => {
    for (let index = 1; index <= copies; index++) {
      const transforms = new Map(target.roots.map(id => [id, around(target.center, rotate(step * index))]))
      const created = duplicateGraph(draft, target.content, { transforms, wrapAnimated: true })
      selection.push(...created.roots)
    }
  }, selection)
}

const dialogs = new WeakMap<Editor, (target: SketchRotateCopiesTarget) => void>()

export function bindRotateCopiesDialog(editor: Editor, open: (target: SketchRotateCopiesTarget) => void) {
  dialogs.set(editor, open)
  return () => { if (dialogs.get(editor) === open) dialogs.delete(editor) }
}

export function requestRotateCopies(editor: Editor) {
  const open = dialogs.get(editor), target = rotateCopiesTarget(editor)
  if (open && target) open(target)
}