import type { Effect } from './model'

export const progressiveBlurKinds = ['blur', 'background-blur'] as const

export function isMotionZoomBlur(kind: Effect['kind']): kind is 'motion-blur' | 'zoom-blur' {
  return kind === 'motion-blur' || kind === 'zoom-blur'
}

export function canAddSketchEffect(kind: Effect['kind'], effects: readonly Effect[]): boolean {
  const blurFamily = (kind: Effect['kind']) =>
    kind === 'glass' || kind === 'gaussian-blur' || kind === 'blur' ||
    kind === 'background-blur' || isMotionZoomBlur(kind)
  return !blurFamily(kind) || !effects.some(effect => blurFamily(effect.kind))
}

export function setMotionZoomMode(effect: Effect, mode: 'motion-blur' | 'zoom-blur') {
  if (!isMotionZoomBlur(effect.kind) || effect.kind === mode) return
  if (mode === 'zoom-blur') {
    effect.zoomBlur = { amount: effect.radius, center: effect.motionZoomOrigin ?? [0.5, 0.5] }
    effect.radius = 0
    delete effect.motionZoomOrigin
  } else if (effect.zoomBlur) {
    const { amount, center } = effect.zoomBlur
    effect.radius = amount
    if (center[0] !== 0.5 || center[1] !== 0.5) effect.motionZoomOrigin = center
    delete effect.zoomBlur
  }
  effect.kind = mode
}

export function setProgressiveMode(effect: Effect, progressive: boolean, width: number, height: number) {
  if (progressive) {
    if (effect.gradientBlur) return
    const saved = effect.inactiveGradientBlur
    const uniform = effect.radius
    effect.gradientBlur = saved?.parameters ?? {
      start: [width / 2, 0], end: [width / 2, height], startCount: 0, endCount: 0, smooth: true,
    }
    effect.radius = saved?.baseRadius ?? 1
    delete effect.inactiveGradientBlur
    delete effect.sketchBackdrop
    if (!saved || uniform !== effect.radius * effect.gradientBlur.endCount) {
      setProgressiveRadius(effect, 'endCount', uniform)
    }
  } else if (effect.gradientBlur) {
    const uniform = effect.radius * effect.gradientBlur.endCount
    if (uniform > 1000) return
    effect.inactiveGradientBlur = { baseRadius: effect.radius, parameters: effect.gradientBlur }
    effect.radius = uniform
    delete effect.gradientBlur
  }
}

export function setProgressiveRadius(effect: Effect, endpoint: 'startCount' | 'endCount', radius: number) {
  const ramp = effect.gradientBlur
  if (!ramp) return
  const start = endpoint === 'startCount' ? radius : ramp.startCount * effect.radius
  const end = endpoint === 'endCount' ? radius : ramp.endCount * effect.radius
  // Keep the existing sampling scale whenever the authored pair still fits
  // the strength field. Larger radii retain their support by rescaling both.
  const base = Math.max(effect.radius || 1, start / 64, end / 64)
  effect.radius = base
  ramp.startCount = Math.min(start / base, 64)
  ramp.endCount = Math.min(end / base, 64)
}
