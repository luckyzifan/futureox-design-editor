import type { Effect } from '../../model'
import type { GpuNode } from './types'

/** Identity of the sharp and fully blurred planes for a layer-blur gradient.
 * Endpoint positions are the only operands applied by the composite, so they
 * are not part of this key. Counts, radius, geometry, and sampling policy are. */
export function gradientBlurPlaneKey(
  node: Pick<GpuNode, 'id' | 'matrix' | 'inverse' | 'size' | 'rect' | 'fills' | 'strokes' | 'children' | 'opacity' | 'blend' | 'effects' | 'clip' | 'mask' | 'maskId' | 'passthrough'>,
  effect: Effect,
  policy: readonly unknown[],
  coverage: boolean,
): string | undefined {
  const gradient = effect.gradientBlur
  if (!gradient || effect.kind !== 'blur') return
  const effects = node.effects.map(item => item.gradientBlur === gradient
    ? { ...item, gradientBlur: { ...gradient, start: [0, 0] as [number, number], end: [0, 0] as [number, number] } }
    : item)
  return JSON.stringify([
    node.id, node.matrix, node.inverse, node.size, node.rect, node.fills, node.strokes, node.children,
    node.opacity, node.blend, node.clip, node.mask, node.maskId, node.passthrough, effects, coverage, policy,
  ], (_key, value) => Object.is(value, -0) ? '-0' : value)
}
