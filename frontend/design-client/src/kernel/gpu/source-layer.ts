import { inverse } from '../../commands/affine'
import { source_linear_phase_parameters } from '../../generated/design-kernel/design_kernel'
import type { GpuNode, GpuPaint, PathMesh, Rect, SourceFilterField } from './types'

export const SOURCE_LAYER_MODE = 76
export const SOURCE_IMAGE_LAYER_MODE = 77
// The existing 256-float uniforms reserve the first five vectors for the
// destination and bindings, and the final eight for the backend.
export const SOURCE_LAYER_FLOATS = (56 - 5) * 4
const sampleOffsets = [[.375, .125], [.875, .375], [.125, .625], [.625, .875]]
const rectWords = (r: Rect) => [r.x, r.y, r.w, r.h]
const covers = (a: Rect | undefined, b: Rect) => a && a.x <= b.x && a.y <= b.y &&
  a.x + a.w >= b.x + b.w && a.y + a.h >= b.y + b.h

/** Parameter corners are in the original layer domain. The GPU interpolates
 * the two affine coordinates before calculating the nonlinear radial distance. */
export function radialCorners(node: GpuNode, paint: GpuPaint, phase: number) {
  const transform = paint.transform
  if (transform && Math.abs(transform[0] * transform[3] - transform[1] * transform[2]) < 1e-12) return
  const paintInverse = transform && inverse(transform)
  const offset = sampleOffsets[phase], r = node.rect, m = node.inverse
  const xs: number[] = [], ys: number[] = []
  for (const y of [r.y, r.y + r.h - 1]) for (const x of [r.x, r.x + r.w - 1]) {
    const px = x + offset[0], py = y + offset[1]
    const u = (m[0] * px + m[2] * py + m[4]) / node.size[0]
    const v = (m[1] * px + m[3] * py + m[5]) / node.size[1]
    const mappedX = paintInverse ? paintInverse[0] * u + paintInverse[2] * v + paintInverse[4] : u
    const mappedY = paintInverse ? paintInverse[1] * u + paintInverse[3] * v + paintInverse[5] : v
    xs.push(2 * (mappedX - .5)); ys.push(2 * (mappedY - .5))
  }
  const values = [...xs, ...ys]
  if (values.every(v => Number.isFinite(v) && Math.abs(v) <= 8)) return values
}

export type SourceLayerProgram = { data: Float32Array[]; fields: SourceFilterField[] }

/** Pack normal, independent leaves for the display driver. A brush carries
 * its native interval program, inside/outside alignment and a material.
 * Shadow instructions follow the brushes in author order. Positions are vec4
 * offsets, relative to the start of this layer, even in a multi-layer draw. */
export function sourceLayer(node: GpuNode, programOffset: (path: PathMesh) => number | undefined,
  colour: (value: string) => number[], availableFloats = SOURCE_LAYER_FLOATS): SourceLayerProgram | undefined {
  if (node.children.length || node.mask || node.maskId || node.clip || node.blend !== 'normal' ||
      node.captureReplay || node.textureReplay || node.gaussianRegion || node.postCompositeBox ||
      node.passthrough || node.fills.length + node.strokes.length > 8) return

  const premultiply = (value: string, opacity = 1) => {
    const channels = colour(value)
    if (channels.length !== 4 || channels.some(v => !Number.isFinite(v) || v < 0 || v > 1)) return
    const alpha = channels[3] * opacity
    return [channels[0] * alpha, channels[1] * alpha, channels[2] * alpha, alpha]
  }
  const mask = (path: PathMesh) => {
    if (!path.count) return -1
    if (covers(path.opaqueRect, path.rect)) return -2
    if (path.area && path.sampleCount === 4) return programOffset(path)
  }
  const fill = mask(node.fill)
  if (fill === undefined) return
  const effects = node.effects.filter(e => e.visible), first = node.sourceFilterField
  const fields: SourceFilterField[] = [], shadows: number[] = []
  let sharp = false
  for (const [i, effect] of effects.entries()) {
    if ((effect.kind !== 'inner-shadow' && effect.kind !== 'shadow') || effect.gradientBlur || !Number.isFinite(effect.radius)) return
    const dx = node.matrix[0] * effect.x + node.matrix[2] * effect.y
    const dy = node.matrix[1] * effect.x + node.matrix[3] * effect.y
    const field = first?.effectIndex === i ? first : first?.additional?.find(f => f.effectIndex === i)
    let source: number
    if (effect.radius === 0) {
      if (i !== 0 || effect.spread !== 0) return
      sharp = true
      source = Number.isInteger(dx) && Number.isInteger(dy) ? -1 : 0
    } else {
      if (!field || fields.length === 3) return
      source = fields.push(field)
    }
    const color = premultiply(effect.color, effect.opacity)
    if (!color) return
    shadows.push(effect.kind === 'inner-shadow' ? 2 : 1, dx, dy, source, ...color, ...(field ? rectWords(field.output) : [0, 0, 0, 0]))
  }

  const brushes = node.fills.map(paint => ({ path: node.fill, paint, align: 0 }))
  for (const stroke of node.strokes)
    brushes.push({ path: stroke.path, paint: stroke.paint, align: stroke.align === 'inside' ? 1 : stroke.align === 'outside' ? -1 : 0 })
  const phases = Array.from({ length: 4 }, () => [] as number[])
  for (const { path, paint, align } of brushes) {
    if (!paint.visible || !paint.opacity || !path.count) continue
    if (paint.blend !== 'normal' || !['solid', 'linear', 'radial'].includes(paint.kind)) return
    const offset = mask(path)
    if (offset === undefined) return
    const radial = paint.kind === 'radial'
    const stopCount = paint.kind === 'solid' ? 0 : paint.stops.length
    const header = [...rectWords(path.rect), offset, align, radial ? -stopCount : stopCount, paint.opacity]
    const brushFloats = header.length + (radial ? 8 : 4) + stopCount * 8
    if (16 + phases[0].length + brushFloats + shadows.length > availableFloats) return
    if (paint.kind === 'solid') {
      const rgba = premultiply(paint.color)
      if (!rgba) return
      for (const words of phases) words.push(...header, ...rgba)
      continue
    }
    if (stopCount < 2 || stopCount > 12 || paint.stops.some((s, i) => i > 0 && s.offset - paint.stops[i - 1].offset < 1 / 64)) return
    const stops: number[] = []
    for (const stop of paint.stops) {
      const rgba = premultiply(stop.color)
      if (!rgba || (sharp && stops.length && rgba[3] !== stops[7])) return
      stops.push(stop.offset, 0, 0, 0, ...rgba)
    }
    let linear: Float32Array | undefined
    if (!radial) {
      const parameters = JSON.stringify({ kind: 'linear', color: '#000000', angle: paint.angle, transform: paint.transform,
        stops: paint.stops.map(s => ({ offset: s.offset, color: '#000000' })) })
      linear = source_linear_phase_parameters(JSON.stringify(node.rect), new Float64Array(node.matrix), new Float64Array(node.size), parameters)
      if (linear.length !== 16) return
    }
    for (let phase = 0; phase < 4; phase++) {
      const weights = linear ? linear.subarray(4 * phase, 4 * phase + 4) : radialCorners(node, paint, phase)
      if (!weights) return
      phases[phase].push(...header, ...weights, ...stops)
    }
  }
  const brushesEnd = 9 + phases[0].length / 4, end = brushesEnd + shadows.length / 4
  if (end > 56 || (end - 5) * 4 > availableFloats || (brushesEnd === 9 && !effects.length)) return
  const data = phases.map((words, i) => new Float32Array([i, node.opacity, brushesEnd, end,
    ...rectWords(node.rect), ...rectWords(node.fill.rect), fill, 0, 0, 0, ...words, ...shadows]))
  return { data, fields }
}
