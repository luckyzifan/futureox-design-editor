import { MAX_BLUR_STOPS, type BlurStop, type Effect, type GradientBlur, type SketchBlurRamp } from './model'

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


export function isSketchProgressiveBlur(kind: Effect['kind']) {
  return kind === 'gaussian-blur' || kind === 'background-blur'
}

export function setSketchBlurMode(effect: Effect, mode: 'uniform' | SketchBlurRamp['shape'], width: number, height: number) {
  if (mode === 'uniform') {
    const gradient = effect.gradientBlur
    if (!gradient) return
    effect.inactiveGradientBlur = { baseRadius: effect.radius, parameters: gradient }
    if (!gradient.sketch) effect.radius = Math.min(1000, gradient.endCount * effect.radius)
    delete effect.gradientBlur
  } else {
    const saved = effect.inactiveGradientBlur
    const previous = effect.gradientBlur ?? saved?.parameters
    const base = effect.gradientBlur ? effect.radius : saved?.baseRadius ?? effect.radius
    let gradient: GradientBlur
    if (previous?.sketch) {
      gradient = previous
    } else if (previous) {
      const start = base * previous.startCount
      const end = base * previous.endCount
      const radius = Math.min(1000, Math.max(start, end))
      const strength = (value: number) => radius === 0 ? 0 : Math.min(1, value / radius)
      effect.radius = radius
      gradient = { ...previous, startCount: 1, endCount: 1,
        sketch: { shape: 'linear', ellipse: 0, stops: [{ offset: 0, strength: strength(start) }, { offset: 1, strength: strength(end) }] } }
    } else {
      gradient = { start: [width / 2, mode === 'radial' ? height / 2 : 0], end: [width / 2, height],
        startCount: 1, endCount: 1, smooth: true,
        sketch: { shape: mode, ellipse: 0, stops: [{ offset: 0, strength: 0 }, { offset: 1, strength: 1 }] } }
    }
    const ramp = gradient.sketch!
    if (ramp.shape !== mode) {
      // A radial ramp's first point is its centre. Linear ramps retain the
      // same centre and outer edge when crossing between these modes.
      const factor = mode === 'radial' ? 0.5 : -1
      const [x, y] = gradient.start
      const [endX, endY] = gradient.end
      gradient.start = [x + factor * (endX - x), y + factor * (endY - y)]
      ramp.shape = mode
    }
    effect.gradientBlur = gradient
    delete effect.inactiveGradientBlur
  }
  if (effect.kind === 'background-blur') effect.sketchBackdrop = true
}

export function blurStopOffset(gradient: GradientBlur, point: { x: number; y: number }): number {
  const [x, y] = gradient.start
  const dx = gradient.end[0] - x, dy = gradient.end[1] - y
  const square = dx * dx + dy * dy
  return square ? Math.min(1, Math.max(0, ((point.x - x) * dx + (point.y - y) * dy) / square)) : 0
}

export function insertBlurStop(stops: BlurStop[], offset: number): number | undefined {
  if (stops.length >= MAX_BLUR_STOPS) return
  const after = stops.findIndex(stop => stop.offset > offset)
  const index = after < 0 ? stops.length : after
  const from = stops[index - 1], to = stops[index]
  const strength = from && to
    ? from.strength + (to.strength - from.strength) * (offset - from.offset) / (to.offset - from.offset)
    : (from ?? to).strength
  stops.splice(index, 0, { offset, strength })
  return index
}

export function changeBlurStopRadius(effect: Effect, index: number, radius: number) {
  const stops = effect.gradientBlur?.sketch?.stops
  if (!stops?.[index]) return
  if (radius > effect.radius) {
    for (const stop of stops) stop.strength *= effect.radius / radius
    effect.radius = radius
  }
  stops[index].strength = effect.radius === 0 ? 0 : radius / effect.radius
}
