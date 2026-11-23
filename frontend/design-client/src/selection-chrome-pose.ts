import type { Bounds, Matrix, Point } from './model'
import { apply, bounds, boxPoints } from './geometry'
import { sharedRotationFrame } from './selection-outline'

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
 * One object keeps its quad. Several objects use the same union as the
 * resting selection, including a shared rotation. */
export function rotationStartMemberCorners(
  nodes: readonly { id: string; bounds: Bounds }[],
  matrices: Readonly<Record<string, Matrix>>,
): Point[][] | null {
  if (!nodes.length) return null
  const members: Point[][] = []
  for (const node of nodes) {
    const matrix = matrices[node.id]
    const box = node.bounds
    if (!matrix || !box || ![box.x, box.y, box.width, box.height].every(Number.isFinite) || !matrix.every(Number.isFinite)) return null
    members.push(boxPoints(box).map(point => apply(matrix, point)))
  }
  return members
}

export function rotationStartOutline(members: readonly (readonly Point[])[], matrices?: readonly (Matrix | undefined)[]): Point[] {
  if (members.length <= 1) return [...(members[0] ?? [])]
  if (matrices && matrices.length === members.length && matrices.every((matrix): matrix is Matrix => !!matrix && matrix.every(Number.isFinite))) {
    const shared = sharedRotationFrame(members.map((corners, index) => ({ matrix: matrices[index], corners })))
    if (shared) return shared.corners
  }
  return boxPoints(bounds(members.flat()))
}
