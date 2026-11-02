import type { ConstraintAnchor } from './model'

/** Figma's constraint diagram. A plain click picks one edge or the center.
 * Shift-click the opposite edge pins both sides (stretch). Shift-click one
 * side of a stretch removes that side. */
export function nextConstraint(current: ConstraintAnchor, edge: 'start' | 'end' | 'center', shift: boolean): ConstraintAnchor {
  if (edge === 'center') return 'center'
  if (shift && current === 'stretch') return edge === 'start' ? 'end' : 'start'
  if (shift && current !== edge && (current === 'start' || current === 'end')) return 'stretch'
  return edge
}
