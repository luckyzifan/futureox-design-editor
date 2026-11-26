import { selectionLocalBounds, selectionParentBounds } from './canvas-view'
import type { Editor } from './engine'
import { inverse, multiply, worldMatrix } from './geometry'
import type { DesignDocument, DesignNode, Matrix } from './model'
import { interactivePath } from './selection-hierarchy'
import { resizedNode } from './selection-properties'
import { nearestPixel, stablePixelEdge as stableEdge } from './commands/affine'

function applyPixelTransform(editor: Editor, label: string,
  transformLayer: (doc: DesignDocument, id: string, matrix: Matrix) => Matrix | undefined) {
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
    const result = transformLayer(doc, id, matrix)
    if (!result) continue
    const transform = multiply(inverse(worldMatrix(doc, parent ?? page, parents)), result)
    const axes = (['width', 'height'] as const).filter((_, i) => {
      const at = i * 2
      return Math.abs(Math.hypot(transform[at], transform[at + 1]) /
        Math.hypot(layer.transform[at], layer.transform[at + 1]) - 1) > 1e-10
    })
    patches.set(id, axes.length ? resizedNode(layer, transform, axes) : { transform })
  }
  if (patches.size)
    editor.update([...patches.keys()], layer => Object.assign(layer, patches.get(layer.id)), label)
  else if (controlledByLayout)
    editor.notify('层叠布局控制所选图层的位置，无法单独对齐到像素')
}

export function fitSelectionToPixelBounds(editor: Editor) {
  applyPixelTransform(editor, '贴合像素边界', (doc, id, matrix) => {
    const box = selectionParentBounds(doc, id, matrix)
    const left = stableEdge(box.x), top = stableEdge(box.y)
    const right = stableEdge(box.x + box.width), bottom = stableEdge(box.y + box.height)
    const x = Math.floor(left), y = Math.floor(top), r = Math.ceil(right), b = Math.ceil(bottom)
    if (x === left && y === top && r === right && b === bottom) return
    const sx = box.width > 0 && right > left ? (r - x) / box.width : 1
    const sy = box.height > 0 && bottom > top ? (b - y) / box.height : 1
    return multiply([sx, 0, 0, sy, x - box.x * sx, y - box.y * sy], matrix)
  })
}

export function roundSelectionToPixels(editor: Editor) {
  applyPixelTransform(editor, '四舍五入到像素', (doc, id, matrix) => {
    const local = selectionLocalBounds(doc, id)
    const { x, y } = selectionParentBounds(doc, id, matrix)
    const width = stableEdge(local.width * Math.hypot(matrix[0], matrix[1]))
    const height = stableEdge(local.height * Math.hypot(matrix[2], matrix[3]))
    const sx = width > 0 ? Math.max(1, nearestPixel(width)) / width : 1
    const sy = height > 0 ? Math.max(1, nearestPixel(height)) / height : 1
    const targetX = nearestPixel(x), targetY = nearestPixel(y)
    if (sx === 1 && sy === 1 && targetX === stableEdge(x) && targetY === stableEdge(y)) return
    // Size follows the layer's own axes. Position follows the canvas bounds.
    const resized = multiply(matrix, [sx, 0, 0, sy, 0, 0])
    const next = selectionParentBounds(doc, id, resized)
    resized[4] += targetX - next.x
    resized[5] += targetY - next.y
    return resized
  })
}
