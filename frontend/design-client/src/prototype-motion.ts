import type { DesignDocument, DesignNode, Effect } from './model'
import type { PrototypeAction, PrototypeEasing } from './prototype'

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

export type TransitionClock = {
  now(): number
  request(callback: FrameRequestCallback): number
  cancel(id: number): void
}

const browserClock: TransitionClock = {
  now: () => performance.now(),
  request: callback => requestAnimationFrame(callback),
  cancel: id => cancelAnimationFrame(id),
}

/** One animation clock. Cancel stops later ticks and does not schedule another. */
export function startTransitionClock(
  durationMs: number,
  onProgress: (progress: number) => void,
  clock: TransitionClock = browserClock,
) {
  if (!(durationMs > 0)) {
    onProgress(1)
    return () => {}
  }
  let live = true
  let request = 0
  const start = clock.now()
  const tick: FrameRequestCallback = now => {
    if (!live) return
    const progress = Math.max(0, Math.min(1, (now - start) / durationMs))
    onProgress(progress)
    if (live && progress < 1) request = clock.request(tick)
  }
  request = clock.request(tick)
  return () => {
    live = false
    clock.cancel(request)
  }
}

export function reducedMotionRequested() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** Omitted smart-animate and slide durations use the same 300ms ease-out as a new interaction. Explicit 0 and "none" stay instant. */
export function resolvePrototypeMotion(action: PrototypeAction, duration: number | undefined, easing: PrototypeEasing | undefined) {
  const instant = action.transitionStyle === 'none'
  const resolvedDuration = duration === undefined ? (instant ? 0 : 300) : duration
  const resolvedEasing = easing === undefined && resolvedDuration > 0 && !instant ? 'ease-out' as const : easing
  return { durationMs: resolvedDuration, easing: resolvedEasing }
}

function nodeRejectsSample(node: DesignNode) {
  const paints = [...node.fills, ...node.strokes.map(stroke => stroke.paint)]
  return paints.some(item => item.visible !== false && (item.kind === 'angular' || item.kind === 'diamond'))
}

/** Angular and diamond paints make the kernel sampler fail. Glass and blur stay
 * on the sampled path and are capped by lightenPrototypeMotion. */
export function framesNeedLightweightMotion(doc: DesignDocument, from: string, to: string) {
  const seen = new Set<string>()
  const walk = (id: string): boolean => {
    if (!id || seen.has(id)) return false
    seen.add(id)
    const node = doc.nodes[id]
    if (!node) return false
    if (nodeRejectsSample(node)) return true
    return node.children.some(walk)
  }
  return walk(from) || walk(to)
}
