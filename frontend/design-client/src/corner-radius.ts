/** Mac-style corner handles for rectangles, frames, and sections.
 * The authored `radii` array stays the document value. Rendering is unchanged. */

export function radiiUniform(radii: readonly number[]): boolean {
  return radii.length === 4 && radii.every(radius => radius === radii[0])
}

/** Place the handle on the edge that leaves this corner. `minInset` is a
 * screen-pixel clearance so a zero radius does not sit on the resize handle.
 * Drag distance is measured from the pointer, not from this point. */
export function cornerHandleLocal(width: number, height: number, index: number, radius: number, minInset = 0) {
  const limit = Math.max(0, Math.min(width, height))
  const placed = Math.min(limit, Math.max(Math.max(0, minInset), Math.max(0, radius)))
  if (index === 1) return { x: width, y: placed }
  if (index === 2) return { x: width - placed, y: height }
  if (index === 3) return { x: 0, y: height - placed }
  return { x: placed, y: 0 }
}

/** Pointer delta in local space. Index order is top-left, top-right,
 * bottom-right, bottom-left. The larger axis wins, matching a corner drag. */
export function cornerRadiusDrag(start: number, index: number, dx: number, dy: number, limit: number, shift: boolean) {
  const along = Math.abs(dx) >= Math.abs(dy)
  const delta = index === 1 ? (along ? -dx : dy)
    : index === 2 ? (along ? -dx : -dy)
    : index === 3 ? (along ? dx : -dy)
    : (along ? dx : dy)
  const next = Math.max(0, Math.min(Math.max(0, limit), start + delta))
  return shift ? Math.round(next) : next
}
