import { selectionLocalBounds } from './canvas-view'
import { allParents, apply, boxPoints, inverse, multiply, worldMatrix } from './geometry'
import type { DesignDocument, Matrix } from './model'

/** A drawn Sketch frame adopts only complete, positionable siblings. Keep
 * painter order and measure in the new frame's own coordinate system. */
export function enclosedSketchFrameLayers(doc: DesignDocument, parentId: string, frameWorld: Matrix, width: number, height: number) {
  const parent = doc.nodes[parentId]
  const siblings = parent?.children ?? doc.pages.find(page => page.id === parentId)?.children ?? []
  // Moving individual members of a mask chain changes the other members'
  // appearance. Leave a masked sibling stack intact.
  if (siblings.some(id => doc.nodes[id]?.mask) || parent?.layout && parent.layout.mode !== 'none') return []
  const parents = allParents(doc), frameInverse = inverse(frameWorld)
  return siblings.flatMap(id => {
    const node = doc.nodes[id]
    if (!node?.visible || node.locked || node.instanceOrigin || node.kind === 'section' || node.kind === 'slice') return []
    const transform = multiply(frameInverse, worldMatrix(doc, id, parents))
    const enclosed = boxPoints(selectionLocalBounds(doc, id)).every(point => {
      const { x, y } = apply(transform, point)
      return x >= -1e-9 && y >= -1e-9 && x <= width + 1e-9 && y <= height + 1e-9
    })
    return enclosed ? [{ id, transform }] : []
  })
}
