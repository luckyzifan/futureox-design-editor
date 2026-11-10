import type { Matrix, Point } from './model'
import { apply, bounds, boxPoints } from './geometry'

/** Own-paint rotation draws the moving outline. The document outline is still
 * the pre-gesture quad while preview is deferred, so it must not also paint. */
export function rotationDocumentChromeSuppressed(input: {
  kind: string | undefined
  sourcePaint: boolean
  holding: boolean
}): boolean {
  return input.kind === 'rotate' && input.sourcePaint && !input.holding
}

/** The blue box stays on the texture still showing. A gesture-follow snapshot
 * already moves its own outline with those pixels, so this hold does not apply
 * while that layer is placing the snapshot. */
export function rotationChromeHeldToTexture(input: {
  kind: string | undefined
  liveDocument: object
  presentedDocument: object | null | undefined
  gestureFollow: boolean
}): boolean {
  return input.kind === 'rotate'
    && !input.gestureFollow
    && input.presentedDocument != null
    && input.presentedDocument !== input.liveDocument
}

/** Oriented corners of the pose the current texture was built from.
 * One object keeps its quad. Several objects use the union rectangle. */
export function rotationStartMemberCorners(
  nodes: readonly { id: string; width: number; height: number }[],
  matrices: Readonly<Record<string, Matrix>>,
): Point[][] | null {
  if (!nodes.length) return null
  const members: Point[][] = []
  for (const node of nodes) {
    const matrix = matrices[node.id]
    if (!matrix || !(node.width > 0) || !(node.height > 0) || !matrix.every(Number.isFinite)) return null
    members.push(boxPoints({ x: 0, y: 0, width: node.width, height: node.height }).map(point => apply(matrix, point)))
  }
  return members
}

export function rotationStartOutline(members: readonly (readonly Point[])[]): Point[] {
  return members.length === 1 ? [...members[0]] : boxPoints(bounds(members.flat()))
}
