import type { Bounds, ConstraintAnchor, Constraints, DesignNode } from './model'
import { container } from './model'

export function nextConstraint(current: ConstraintAnchor, edge: 'start' | 'end' | 'center', shift: boolean): ConstraintAnchor {
  if (edge === 'center') return 'center'
  if (shift && current === 'stretch') return edge === 'start' ? 'end' : 'start'
  if (shift && current !== edge && (current === 'start' || current === 'end')) return 'stretch'
  return edge
}

function nextSketchPin(current: ConstraintAnchor | undefined, edge: 'start' | 'end', alternate: boolean): ConstraintAnchor {
  const opposite = edge === 'start' ? 'end' : 'start'
  if (current === 'stretch') return alternate ? 'center' : opposite
  if (current === edge) return 'center'
  if (current === opposite) return alternate ? edge : 'stretch'
  return alternate ? 'stretch' : edge
}

function writeSketchPins(node: DesignNode, horizontal: ConstraintAnchor, vertical: ConstraintAnchor) {
  if (horizontal === 'center' && vertical === 'center') delete node.constraints
  else node.constraints = { ...node.constraints, horizontal, vertical }
}

export function editSketchPin(node: DesignNode, axis: 'horizontal' | 'vertical', edge: 'start' | 'end', alternate: boolean) {
  const anchor = nextSketchPin(node.constraints?.[axis], edge, alternate)
  // Center is the existing fixed-size anchor without either edge pinned.
  writeSketchPins(node, axis === 'horizontal' ? anchor : node.constraints?.horizontal ?? 'center',
    axis === 'vertical' ? anchor : node.constraints?.vertical ?? 'center')
}

export function setSketchPinPreset(node: DesignNode, preset: 'all' | 'none' | 'default') {
  const anchor = preset === 'all' ? 'stretch' : preset === 'default' ? 'start' : 'center'
  writeSketchPins(node, anchor, anchor)
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
