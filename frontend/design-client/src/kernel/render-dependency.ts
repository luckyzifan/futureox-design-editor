import type { Effect } from '../model'
import type { GpuNode } from './gpu/types'

/** Capability classification only, not a kernel dependency certificate. Never
 * infer effect support from its radius: an unknown visible effect blocks reuse. */
export function effectsAreKnown(effects: readonly Effect[]): boolean {
  return effects.every(effect => !effect.visible ||
    ['shadow', 'inner-shadow', 'blur', 'background-blur', 'glass', 'noise', 'texture', 'color-controls', 'gaussian-blur', 'motion-blur', 'zoom-blur'].includes(effect.kind))
}

export function backdropEffect(effects: Effect[]) {
  const first = effects.find(
    (e) => e.visible && (e.kind === 'glass' || e.kind === 'background-blur'),
  )
  return first &&
    (backdropRadius(first) > 0 ||
      (first.colorControls !== undefined && (first.colorControls.brightness !== 0 || first.colorControls.contrast !== 1 || first.colorControls.saturation !== 1 || first.colorControls.hue !== 0)) ||
      (first.kind === 'glass' &&
        (first.glass
          ? first.glass.refraction !== 0 ||
            first.glass.dispersion !== 0 ||
            first.glass.lightIntensity !== 0
          : first.amount !== 0 || first.opacity !== 0)))
    ? first
    : undefined
}
export function backdropRadius(effect: Effect) {
  return effect.kind === 'glass' && effect.glass ? Math.max(1, effect.radius) : effect.radius
}

export type SourceReuseReason = 'isolated' | 'missing' | 'dynamic' | 'mask' |
  'passthrough' | 'backdrop' | 'unknown-effect' | 'empty' | 'invalid-bounds'
export type SourceReuseClassification = { reusable: boolean; reason: SourceReuseReason }

/** One shared admission predicate for retained compiled sources. The caller
 * still owns identity, quality, sample-plane, resource and runtime validity.
 * Internal masks, clipping, opacity and known effects stay inside the source;
 * external backdrop reads must be recomputed. Bounds are compiler-issued.
 * unknownSubtreeEffects comes from the immutable scene index, not authored bounds. */
export function classifyCompiledSourceReuse(node: GpuNode | undefined,
  unknownSubtreeEffects = false): SourceReuseClassification {
  let reason: SourceReuseReason = 'isolated'
  if (!node) reason = 'missing'
  else if (unknownSubtreeEffects || !effectsAreKnown(node.effects)) reason = 'unknown-effect'
  else if (node.previewDynamic) reason = 'dynamic'
  else if (node.mask) reason = 'mask'
  else if (node.passthrough) reason = 'passthrough'
  else if (backdropEffect(node.effects)) reason = 'backdrop'
  else if (![node.rect.x, node.rect.y, node.rect.w, node.rect.h].every(Number.isFinite)) reason = 'invalid-bounds'
  else if (node.rect.w <= 0 || node.rect.h <= 0) reason = 'empty'
  return { reusable: reason === 'isolated', reason }
}
