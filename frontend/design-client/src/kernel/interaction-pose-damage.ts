/** Settled native pose damage. A closed local proof keeps the old and new
 * support. Anything the kernel does not prove, including a missing method,
 * stays a full redraw and does not release resources outside that decision. */

export type PoseDamage = {
  full: boolean
  bounds: [number, number, number, number] | null
  rects?: [number, number, number, number][]
  translationOnly?: boolean
  reason?: string
}

export function settledPoseDamage(local: PoseDamage | null | undefined): PoseDamage {
  if (local && local.full === false && local.bounds) return { ...local, reason: 'native-interaction-pose' }
  return { full: true, bounds: null, reason: 'native-interaction-pose' }
}
