import type { Bounds, ConstraintAnchor, Constraints, DesignNode } from './model'
import { container } from './model'

export function nextConstraint(current: ConstraintAnchor, edge: 'start' | 'end' | 'center', shift: boolean): ConstraintAnchor {
  if (edge === 'center') return 'center'
  if (shift && current === 'stretch') return edge === 'start' ? 'end' : 'start'
  if (shift && current !== edge && (current === 'start' || current === 'end')) return 'stretch'
  return edge
}

export function canAutoPinChild(parent: DesignNode, child: DesignNode): boolean {
  return container(parent) && !parent.graphic && !parent.locked && !parent.instance && !parent.instanceOrigin &&
    !child.locked && !child.instanceOrigin && (!parent.layout || parent.layout.mode === 'none' || !!child.sizing?.absolute)
}

/** Choose edges in the container's coordinate space at the current size. */
export function inferPins(parent: DesignNode, parentBox: Bounds, child: Bounds): Constraints {
  const axis = (start: number, end: number): ConstraintAnchor => {
    // Tolerate floating point error in transformed or imported rectangles.
    const epsilon = 1e-6
    if (start <= epsilon && end <= epsilon) return 'stretch'
    if (Math.abs(start - end) <= epsilon) return 'center'
    return start < end ? 'start' : 'end'
  }
  const x = child.x - parentBox.x, y = child.y - parentBox.y
  return {
    horizontal: axis(x, parentBox.width - x - child.width),
    vertical: axis(y, parentBox.height - y - child.height),
    referenceWidth: parent.width, referenceHeight: parent.height,
  }
}
