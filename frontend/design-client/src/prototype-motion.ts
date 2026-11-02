import type { DesignDocument, DesignNode, Effect } from './model'

/** In-between prototype frames keep opacity and transform from the kernel
 * sample, and cap backdrop filters so glass and blur are not rebuilt from a
 * new full parameter set on every tick. Progress 0 and 1 stay on the authored
 * document; this function is only for an open interval. */
const BLUR_CAP = 12
const GLASS_DEPTH_CAP = 8
const GLASS_REFRACTION_CAP = 0.35
const GLASS_DISPERSION_CAP = 0.2
const GLASS_BEVEL_CAP = 4
const MOTION_AMOUNT_CAP = 0.25

function capEffect(effect: Effect): Effect {
  if (!effect.visible) return effect
  if (effect.kind === 'blur' || effect.kind === 'gaussian-blur' || effect.kind === 'background-blur') {
    return effect.radius > BLUR_CAP ? { ...effect, radius: BLUR_CAP } : effect
  }
  if (effect.kind === 'motion-blur' || effect.kind === 'zoom-blur') {
    const radius = Math.min(effect.radius, BLUR_CAP)
    const amount = Math.min(effect.amount, MOTION_AMOUNT_CAP)
    return radius === effect.radius && amount === effect.amount ? effect : { ...effect, radius, amount }
  }
  if (effect.kind !== 'glass') return effect
  const glass = effect.glass
  const radius = Math.min(effect.radius, BLUR_CAP)
  if (!glass) return radius === effect.radius ? effect : { ...effect, radius }
  const bevelSize = glass.bevelSize === undefined ? undefined : Math.min(glass.bevelSize, GLASS_BEVEL_CAP)
  const depth = Math.min(glass.depth, GLASS_DEPTH_CAP)
  const refraction = Math.min(glass.refraction, GLASS_REFRACTION_CAP)
  const dispersion = Math.min(glass.dispersion, GLASS_DISPERSION_CAP)
  if (radius === effect.radius && depth === glass.depth && refraction === glass.refraction && dispersion === glass.dispersion && bevelSize === glass.bevelSize) return effect
  return {
    ...effect,
    radius,
    glass: {
      ...glass,
      depth,
      refraction,
      dispersion,
      ...(bevelSize !== undefined ? { bevelSize } : {}),
    },
  }
}

function capNode(node: DesignNode): DesignNode {
  let effects = node.effects
  let changed = false
  const next = effects.map(effect => {
    const capped = capEffect(effect)
    if (capped !== effect) changed = true
    return capped
  })
  if (!changed) return node
  return { ...node, effects: next }
}

/** Returns the same document when nothing was capped, so a surface can keep
 * its previous capture instead of treating every tick as a new scene. */
export function lightenPrototypeMotion(document: DesignDocument): DesignDocument {
  let nodes = document.nodes
  let changed = false
  for (const [id, node] of Object.entries(document.nodes)) {
    const next = capNode(node)
    if (next === node) continue
    if (!changed) nodes = { ...document.nodes }
    nodes[id] = next
    changed = true
  }
  return changed ? { ...document, nodes } : document
}

export const PROTOTYPE_MOTION_CAPS = {
  blur: BLUR_CAP,
  glassDepth: GLASS_DEPTH_CAP,
  glassRefraction: GLASS_REFRACTION_CAP,
  glassDispersion: GLASS_DISPERSION_CAP,
} as const
