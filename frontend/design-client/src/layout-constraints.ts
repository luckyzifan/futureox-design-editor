import type { ConstraintAnchor } from './model'

export function nextConstraint(current: ConstraintAnchor, edge: 'start' | 'end' | 'center', shift: boolean): ConstraintAnchor {
  if (edge === 'center') return 'center'
  if (shift && current === 'stretch') return edge === 'start' ? 'end' : 'start'
  if (shift && current !== edge && (current === 'start' || current === 'end')) return 'stretch'
  return edge
}
