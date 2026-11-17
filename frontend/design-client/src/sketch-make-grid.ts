import { selectionParentBounds } from './canvas-view'
import { prepareDuplication } from './commands/duplication-command'
import { assertStructuralParent, indexSelection, SelectionCommandError } from './commands/selection-command'
import { duplicateGraph } from './duplicate-graph'
import type { Editor } from './engine'
import { interfacePreference } from './interface-preference'
import type { DesignDocument } from './model'
import { interactivePath } from './selection-hierarchy'

export const MAX_GRID_CELLS = 256
const GRID_TOLERANCE = 0.01
const DEFAULT_GRID_GAP = 16

export type MakeGridOptions = { rows: number; columns: number; gapX: number; gapY: number }
type ExistingCell = { id: string; column: number; row: number; x: number; y: number }
type GridSource = {
  originX: number; originY: number; cellWidth: number; cellHeight: number
  template: ExistingCell; cells: ExistingCell[]; existing: MakeGridOptions
}
export type MakeGridTarget = {
  document: DesignDocument; revision: number; session: number; page: string
  selection: readonly string[]; source: GridSource
}

function gridAxis(points: number[], size: number) {
  const coordinates: number[] = []
  for (const point of points.sort((a, b) => a - b)) {
    if (!coordinates.length || point - coordinates.at(-1)! > GRID_TOLERANCE) coordinates.push(point)
  }
  const pitch = coordinates.length < 2 ? size + DEFAULT_GRID_GAP :
    (coordinates.at(-1)! - coordinates[0]) / (coordinates.length - 1)
  if (pitch + GRID_TOLERANCE < size ||
      coordinates.some((point, index) => Math.abs(point - coordinates[0] - index * pitch) > GRID_TOLERANCE)) return null
  return { coordinates, gap: Math.max(0, Math.round((pitch - size) * 1e6) / 1e6) }
}

/** Infer an existing lattice in the common parent's coordinates. Selection
 * order supplies the template, while position determines occupied cells. */
function gridSource(editor: Editor): GridSource | null {
  const { doc, page, selection, busy } = editor.state
  if (busy || editor.interactionActive || !selection.length || selection.length > MAX_GRID_CELLS) return null
  try {
    const { ids, parents, pageId } = indexSelection(doc, selection, false, editor.parentMap(doc))
    const parent = parents.get(ids[0])!, owner = doc.nodes[parent]
    if (pageId !== page || owner?.booleanOperation || ids.some(id => parents.get(id) !== parent ||
        !interactivePath(doc, page, id, false, parents).length ||
        (owner?.layout && owner.layout.mode !== 'none' && !doc.nodes[id].sizing?.absolute))) return null
    assertStructuralParent(doc, parent, parents)
    if (ids.some(id => doc.nodes[id].instanceOrigin)) return null
    const boxes = ids.map(id => selectionParentBounds(doc, id))
    if (boxes.some(box => ![box.x, box.y, box.width, box.height].every(Number.isFinite))) return null
    const cellWidth = Math.max(...boxes.map(box => box.width))
    const cellHeight = Math.max(...boxes.map(box => box.height))
    const x = gridAxis(boxes.map(box => box.x), cellWidth)
    const y = gridAxis(boxes.map(box => box.y), cellHeight)
    if (!x || !y || x.coordinates.length * y.coordinates.length > MAX_GRID_CELLS) return null
    const cells = boxes.map((box, index) => ({
      id: ids[index], x: box.x, y: box.y,
      column: x.coordinates.findIndex(value => Math.abs(box.x - value) <= GRID_TOLERANCE),
      row: y.coordinates.findIndex(value => Math.abs(box.y - value) <= GRID_TOLERANCE),
    }))
    if (new Set(cells.map(cell => `${cell.row}:${cell.column}`)).size !== cells.length) return null
    return { originX: x.coordinates[0], originY: y.coordinates[0], cellWidth, cellHeight, cells,
      template: cells.at(-1)!, existing: { rows: y.coordinates.length, columns: x.coordinates.length, gapX: x.gap, gapY: y.gap } }
  } catch (error) {
    if (error instanceof SelectionCommandError) return null
    throw error
  }
}

export function canMakeSketchGrid(editor: Editor) {
  return gridSource(editor) !== null
}

export function makeGridTargetIsCurrent(editor: Editor, target: MakeGridTarget) {
  const state = editor.state
  return interfacePreference.getSnapshot().uiMode === 'sketch' && !state.busy && !editor.interactionActive &&
    state.doc === target.document && state.version === target.revision && editor.sessionGeneration === target.session &&
    state.page === target.page && state.selection.length === target.selection.length &&
    state.selection.every((id, index) => id === target.selection[index])
}

export function validMakeGridOptions(target: MakeGridTarget, options: MakeGridOptions) {
  const { rows, columns, gapX, gapY } = options, { existing } = target.source
  return Number.isInteger(rows) && Number.isInteger(columns) && rows >= existing.rows && columns >= existing.columns &&
    rows * columns <= MAX_GRID_CELLS && Number.isFinite(gapX) && gapX >= 0 && Number.isFinite(gapY) && gapY >= 0
}

export function applySketchGrid(editor: Editor, target: MakeGridTarget, options: MakeGridOptions) {
  if (!makeGridTargetIsCurrent(editor, target) || !validMakeGridOptions(target, options)) return
  const { cells, template, originX, originY, cellWidth, cellHeight } = target.source
  const bySlot = new Map(cells.map(cell => [cell.row * options.columns + cell.column, cell]))
  const copies = options.rows * options.columns - cells.length
  const copyPlan = copies ? prepareDuplication(target.document, [template.id], { kind: 'world-offset', x: 0, y: 0 },
    { fresh: true, singleStep: true, mutable: false }) : null
  const selection: string[] = []
  return editor.change('制作网格', draft => {
    for (let row = 0; row < options.rows; row++) {
      for (let column = 0; column < options.columns; column++) {
        const existing = bySlot.get(row * options.columns + column)
        const source = existing ?? template
        const id = existing?.id ?? duplicateGraph(draft, copyPlan!.content, { wrapAnimated: true }).roots[0]
        const node = draft.nodes[id]
        node.transform[4] += originX + column * (cellWidth + options.gapX) - source.x
        node.transform[5] += originY + row * (cellHeight + options.gapY) - source.y
        selection.push(id)
      }
    }
  }, selection)
}

const dialogs = new WeakMap<Editor, (target: MakeGridTarget) => void>()

export function bindMakeGridDialog(editor: Editor, open: (target: MakeGridTarget) => void) {
  dialogs.set(editor, open)
  return () => { if (dialogs.get(editor) === open) dialogs.delete(editor) }
}

export function requestMakeGrid(editor: Editor) {
  const open = dialogs.get(editor), source = gridSource(editor)
  if (!open || !source) return
  const { doc, version, page, selection } = editor.state
  open({ document: doc, revision: version, session: editor.sessionGeneration, page, selection: [...selection], source })
}
