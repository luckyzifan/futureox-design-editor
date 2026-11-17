import { selectionParentBounds } from './canvas-view'
import type { Editor } from './engine'
import { inverse, multiply, worldMatrix } from './geometry'
import type { DesignNode, Matrix } from './model'
import { interactivePath } from './selection-hierarchy'
import { resizedNode } from './selection-properties'

/** A transform can put an already integral edge a few ulps away from its
 * pixel. Canonicalize that drift before taking an outward floor or ceiling. */
function stableEdge(value: number) {
  const whole = Math.round(value)
  const tolerance = Math.max(1e-9, 8 * Number.EPSILON * Math.abs(value))
  return Math.abs(value - whole) <= tolerance ? whole : value
}

export function fitSelectionToPixelBounds(editor: Editor) {
  const { doc, page, tool } = editor.state
  if (editor.interactionActive || editor.state.busy || !['select', 'scale'].includes(tool)) return
  const parents = editor.parentMap(doc)
  const patches = new Map<string, Partial<DesignNode>>()
  let controlledByLayout = false
  for (const id of editor.topSelection()) {
    if (!interactivePath(doc, page, id, false, parents).length) continue
    const layer = doc.nodes[id], parent = parents.get(id)
    const flow = parent && doc.nodes[parent]?.layout
    if (flow && flow.mode !== 'none' && !layer.sizing?.absolute) {
      controlledByLayout = true
      continue
    }
    const matrix = worldMatrix(doc, id, parents)
    const box = selectionParentBounds(doc, id, matrix)
    const left = stableEdge(box.x), top = stableEdge(box.y)
    const right = stableEdge(box.x + box.width), bottom = stableEdge(box.y + box.height)
    const x = Math.floor(left), y = Math.floor(top), r = Math.ceil(right), b = Math.ceil(bottom)
    if (x === left && y === top && r === right && b === bottom) continue
    const sx = box.width > 0 && right > left ? (r - x) / box.width : 1
    const sy = box.height > 0 && bottom > top ? (b - y) / box.height : 1
    const delta: Matrix = [sx, 0, 0, sy, x - box.x * sx, y - box.y * sy]
    const transform = multiply(inverse(worldMatrix(doc, parent ?? page, parents)), multiply(delta, matrix))
    if (sx === 1 && sy === 1) {
      patches.set(id, { transform })
      continue
    }
    const axes = (['width', 'height'] as const).filter((_, i) => {
      const at = i * 2
      return Math.abs(Math.hypot(transform[at], transform[at + 1]) /
        Math.hypot(layer.transform[at], layer.transform[at + 1]) - 1) > 1e-10
    })
    patches.set(id, resizedNode(layer, transform, axes))
  }
  if (patches.size)
    editor.update([...patches.keys()], layer => Object.assign(layer, patches.get(layer.id)), '贴合像素边界')
  else if (controlledByLayout)
    editor.notify('层叠布局控制所选图层的位置，无法单独贴合像素边界')
}
