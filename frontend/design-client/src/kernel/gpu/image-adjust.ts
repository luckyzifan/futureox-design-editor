import type { ImageAdjust } from '../../model'

/** shader_62 / wgsl_116 `imageColorAdjustPaint` math, TS port of the kernel's
 * `image_adjust.rs` (f64 evaluation; deviation from the f32 shader is ~1e-6,
 * far below the 1/255 byte quantum the GPU path quantizes to).
 *
 * GPU integration shape: the renderer applies the adjustments to the decoded
 * texels at upload time (premultiplied storage in, premultiplied storage out)
 * instead of adding a per-draw shader branch — see E3-IMAGE-ADJUST.md for the
 * contract reasons and the known interpolation-order difference.
 */
const LUMA = [0.2126, 0.7152, 0.0722] as const

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
const dotLuma = (c: readonly number[]) => c[0] * LUMA[0] + c[1] * LUMA[1] + c[2] * LUMA[2]

/** GLSL `b` / WGSL `hb`. */
const srgbToLinear = (c: readonly number[]) => c.map((v) => Math.pow(v, 2.2))
/** GLSL `d` / WGSL `hf`. */
const linearToSrgb = (c: readonly number[]) => c.map((v) => Math.pow(v, 1 / 2.2))

/** GLSL `e` / WGSL `hj`: soft highlight/shadow exposure delta. */
function highlightShadowDelta(
  c: readonly number[],
  shadows: number,
  highlights: number,
  threshold: number,
): number {
  const h = dotLuma(c) - Math.pow(threshold, 2.2)
  const scale = h > 0 ? highlights : -shadows * 0.999
  return ((0.75 * h) / Math.sqrt(1 + 4 * h * h)) * scale
}

/** GLSL `s` / WGSL `jl`: Perlin smootherstep. */
function smootherstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0))
  return t * t * t * (t * (t * 6 - 15) + 10)
}

/** GLSL `i` / WGSL `ht`: exposure (Reinhard-like around 10^(2j)-1). */
function exposureAdjust(c: number[], j: number): number[] {
  const k = Math.pow(10, 2 * j) - 1
  const anchor = 0.75
  let m = 1 / (1 - anchor) - 1
  let n = dotLuma(c)
  const negative = Math.min(0, j)
  m *= 1 + ((n * n * negative) / (0.2 - negative))
  c = c.map((v) => v + (n - v) * anchor)
  if (j < 0) {
    const scale = 1 + j / 16
    c = c.map((v) => v * scale)
    n *= scale
  }
  c = c.map((v) => (v * (k + 1)) / (v * k + 1))
  n = (n * (k + 1)) / (n * k + 1)
  c = c.map((v) => v + (v - n) * m)
  return c.map(clamp01)
}

/** GLSL `o` / WGSL `iv`: saturation (globalColor). */
function saturationAdjust(c: number[], p: number): number[] {
  const n = dotLuma(c)
  if (p <= 0) return c.map((v) => v - (n - v) * p)
  const q = n / (n - Math.min(c[0], c[1], c[2]) + 1e-6)
  const r = (1 - n) / (Math.max(c[0], c[1], c[2]) - n + 1e-6)
  const k = Math.min(1 + (Math.min(q, r) - 1) * p, 2)
  return c.map((v) => v + (n - v) * (1 - k))
}

/** GLSL `w` / WGSL `jr`: temperature/tint/contrast in CIE Lab (D65). */
function labAdjust(
  c: number[],
  temperature: number,
  tint: number,
  contrast: number,
  threshold: number,
): number[] {
  let xyz = [
    0.4124564 * c[0] + 0.3575761 * c[1] + 0.1804375 * c[2],
    0.2126729 * c[0] + 0.7151522 * c[1] + 0.072175 * c[2],
    0.0193339 * c[0] + 0.119192 * c[1] + 0.9503041 * c[2],
  ]
  xyz[0] /= 0.95047
  xyz[2] /= 1.08883
  const f = xyz.map((v) => Math.pow(v, 1 / 3))
  const lab = [116 * f[1] - 16, 500 * (f[0] - f[1]), 200 * (f[1] - f[2])]
  lab[1] += 30 * tint
  lab[2] += 30 * temperature
  const midpoint = threshold * 100
  const halfWidth = 30
  const darkTarget = (lab[0] - midpoint) * 0.2 + 50
  const brightTarget = smootherstep(midpoint - halfWidth, midpoint + halfWidth, lab[0]) * 100
  const amount = contrast < 0 ? contrast + 1 : contrast
  lab[0] =
    contrast < 0
      ? darkTarget + (lab[0] - darkTarget) * amount
      : lab[0] + (brightTarget - lab[0]) * amount
  f[1] = (lab[0] + 16) / 116
  f[0] = lab[1] / 500 + f[1]
  f[2] = f[1] - lab[2] / 200
  xyz = f.map((v) => v * v * v)
  xyz[0] *= 0.95047
  xyz[2] *= 1.08883
  return [
    clamp01(3.2404542 * xyz[0] - 1.5371385 * xyz[1] - 0.4985314 * xyz[2]),
    clamp01(-0.969266 * xyz[0] + 1.8760108 * xyz[1] + 0.041556 * xyz[2]),
    clamp01(0.0556434 * xyz[0] - 0.2040259 * xyz[1] + 1.0572252 * xyz[2]),
  ]
}

function applyCore(c: readonly number[], a: ImageAdjust): number[] {
  const threshold = a.highlightShadowThreshold ?? 0.5
  const delta = highlightShadowDelta(c, a.shadows, a.highlights, threshold)
  let out = labAdjust([...c], a.temperature, a.tint, a.contrast, threshold)
  out = exposureAdjust(out, a.exposure + delta)
  out = saturationAdjust(out, Math.max(-1, Math.min(1, a.color)))
  return out.map(clamp01)
}

/** True when the paint carries a non-identity adjustment (renders unchanged
 * otherwise, matching the kernel's `ImageAdjust::is_identity` gate). */
export function imageAdjustActive(a: ImageAdjust | undefined): a is ImageAdjust {
  return (
    !!a &&
    (a.exposure !== 0 ||
      a.contrast !== 0 ||
      a.temperature !== 0 ||
      a.tint !== 0 ||
      a.highlights !== 0 ||
      a.shadows !== 0 ||
      a.color !== 0)
  )
}

/** Straight-alpha RGB in [0,1] → adjusted RGB. `linear` selects the
 * working-space core (managed documents) vs the full sRGB pipeline.
 * Identity returns the input exactly, mirroring the kernel gate. */
export function applyImageAdjust(
  rgb: readonly number[],
  a: ImageAdjust,
  linear: boolean,
): number[] {
  if (!imageAdjustActive(a)) return [...rgb]
  const c = rgb.map(clamp01)
  const core = linear ? applyCore(c, a) : applyCore(srgbToLinear(c), a)
  return linear ? core : linearToSrgb(core)
}

/** Stable cache tag: two adjustments with equal slider values share one
 * uploaded texture, any change re-uploads. */
export function imageAdjustTag(a: ImageAdjust): string {
  return [
    a.exposure,
    a.contrast,
    a.temperature,
    a.tint,
    a.highlights,
    a.shadows,
    a.color,
    a.highlightShadowThreshold ?? 0.5,
  ].join(',')
}

/** Round-half-to-even on non-negative values (the byte boundary the renderer
 * uses elsewhere, e.g. factory.ts straightAlpha). */
const roundTiesEvenByte = (x: number) => {
  const q = Math.floor(x)
  const fraction = x - q
  return q + (fraction > 0.5 || (fraction === 0.5 && q % 2 === 1) ? 1 : 0)
}

/** Adjust premultiplied RGBA8 texels out-of-place: unpremultiply, apply the
 * sRGB pipeline, premultiply and quantize once. */
export function adjustRgba8Premultiplied(
  bytes: Uint8Array,
  a: ImageAdjust,
): Uint8Array {
  const out = new Uint8Array(bytes.length)
  for (let i = 0; i < bytes.length; i += 4) {
    const alpha = bytes[i + 3]
    if (!alpha) {
      out[i + 3] = 0
      continue
    }
    const straight = [
      bytes[i] / alpha,
      bytes[i + 1] / alpha,
      bytes[i + 2] / alpha,
    ]
    const adjusted = applyImageAdjust(straight, a, false)
    out[i] = roundTiesEvenByte(adjusted[0] * alpha)
    out[i + 1] = roundTiesEvenByte(adjusted[1] * alpha)
    out[i + 2] = roundTiesEvenByte(adjusted[2] * alpha)
    out[i + 3] = alpha
  }
  return out
}

/** Adjust premultiplied linear RGBA32F texels out-of-place (managed docs). */
export function adjustLinearPremultiplied(
  values: Float32Array,
  a: ImageAdjust,
): Float32Array {
  const out = new Float32Array(values.length)
  for (let i = 0; i < values.length; i += 4) {
    const alpha = values[i + 3]
    if (!(alpha > 0)) continue
    const straight = [values[i] / alpha, values[i + 1] / alpha, values[i + 2] / alpha]
    const adjusted = applyImageAdjust(straight, a, true)
    out[i] = adjusted[0] * alpha
    out[i + 1] = adjusted[1] * alpha
    out[i + 2] = adjusted[2] * alpha
    out[i + 3] = alpha
  }
  return out
}
