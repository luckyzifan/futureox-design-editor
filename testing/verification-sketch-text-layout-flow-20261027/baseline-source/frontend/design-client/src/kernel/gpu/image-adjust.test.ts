import { expect, test } from 'vitest'
import type { ImageAdjust } from '../../model'
import {
  applyImageAdjust,
  adjustRgba8Premultiplied,
  adjustLinearPremultiplied,
  imageAdjustActive,
  imageAdjustTag,
} from './image-adjust'

const adjust = (partial: Partial<ImageAdjust>): ImageAdjust => ({
  exposure: 0,
  contrast: 0,
  temperature: 0,
  tint: 0,
  highlights: 0,
  shadows: 0,
  color: 0,
  highlightShadowThreshold: 0.5,
  ...partial,
})

const lum = (c: number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]

test('identity adjustment is an exact no-op', () => {
  expect(imageAdjustActive(undefined)).toBe(false)
  expect(imageAdjustActive(adjust({}))).toBe(false)
  for (let i = 0; i <= 16; i++) {
    const v = i / 16
    for (const rgb of [[v, v, v], [v, 1 - v, 0.5], [1, v * 0.7, v]]) {
      expect(applyImageAdjust(rgb, adjust({}), false)).toEqual(rgb)
      expect(applyImageAdjust(rgb, adjust({}), true)).toEqual(rgb)
    }
  }
  // A threshold alone never activates baking or cache separation.
  expect(imageAdjustActive(adjust({ highlightShadowThreshold: 0.8 }))).toBe(false)
})

test('axes move colors in their documented directions', () => {
  const mid = [0.5, 0.5, 0.5]
  const dark = [0.15, 0.15, 0.17]
  const bright = [0.85, 0.84, 0.82]
  // Headroom below 1.0: the shader caps saturation by the max-channel factor.
  const warmish = [0.7, 0.45, 0.25]
  expect(lum(applyImageAdjust(mid, adjust({ exposure: 0.5 }), false))).toBeGreaterThan(lum(mid))
  expect(lum(applyImageAdjust(mid, adjust({ exposure: -0.5 }), false))).toBeLessThan(lum(mid))
  expect(lum(applyImageAdjust(dark, adjust({ shadows: 0.8 }), false))).toBeGreaterThan(lum(dark))
  expect(lum(applyImageAdjust(bright, adjust({ highlights: 0.8 }), false))).toBeGreaterThan(lum(bright))
  const spread = (c: number[]) => Math.max(...c) - Math.min(...c)
  expect(spread(applyImageAdjust(warmish, adjust({ color: 0.8 }), false))).toBeGreaterThan(spread(warmish))
  expect(spread(applyImageAdjust(warmish, adjust({ color: -0.8 }), false))).toBeLessThan(spread(warmish))
  const warm = applyImageAdjust(mid, adjust({ temperature: 0.6 }), false)
  const cool = applyImageAdjust(mid, adjust({ temperature: -0.6 }), false)
  expect(warm[2]).toBeLessThan(mid[2])
  expect(cool[2]).toBeGreaterThan(mid[2])
  const magenta = applyImageAdjust(mid, adjust({ tint: 0.6 }), false)
  const green = applyImageAdjust(mid, adjust({ tint: -0.6 }), false)
  expect(magenta[1]).toBeLessThan(mid[1])
  expect(green[1]).toBeGreaterThan(mid[1])
})

// Reference values dumped from the Rust kernel implementation
// (design-kernel/src/image_adjust.rs, apply_srgb), itself cross-checked
// against the transcribed reference in tests/image_adjust.rs.
const rustReference: [string, ImageAdjust, number[], number[]][] = [
  ['A', adjust({ exposure: 0.4 }), [0.2, 0.5, 0.8], [0.607320070, 0.814888835, 1.0]],
  ['A', adjust({ exposure: 0.4 }), [0.65, 0.3, 0.1], [0.977694094, 0.620798171, 0.467708737]],
  ['A', adjust({ exposure: 0.4 }), [0.5, 0.5, 0.5], [0.814681411, 0.814681709, 0.814681411]],
  ['A', adjust({ exposure: 0.4 }), [0.9, 0.85, 0.2], [0.983304799, 0.970586777, 0.844005525]],
  ['B', adjust({ temperature: 0.6 }), [0.2, 0.5, 0.8], [0.378442466, 0.492185414, 0.676664710]],
  ['B', adjust({ temperature: 0.6 }), [0.65, 0.3, 0.1], [0.655802846, 0.298767179, 0.0]],
  ['B', adjust({ temperature: 0.6 }), [0.5, 0.5, 0.5], [0.545053124, 0.496021420, 0.383141875]],
  ['B', adjust({ temperature: 0.6 }), [0.9, 0.85, 0.2], [0.914717019, 0.848672152, 0.0]],
  ['C', adjust({ exposure: -0.15, contrast: -0.35, tint: 0.25, highlights: 0.3, shadows: 0.5, color: -0.2 }), [0.2, 0.5, 0.8], [0.261062711, 0.367688358, 0.595456719]],
  ['C', adjust({ exposure: -0.15, contrast: -0.35, tint: 0.25, highlights: 0.3, shadows: 0.5, color: -0.2 }), [0.65, 0.3, 0.1], [0.544741392, 0.251695007, 0.169915065]],
  ['C', adjust({ exposure: -0.15, contrast: -0.35, tint: 0.25, highlights: 0.3, shadows: 0.5, color: -0.2 }), [0.5, 0.5, 0.5], [0.408453047, 0.363316685, 0.374832153]],
  ['C', adjust({ exposure: -0.15, contrast: -0.35, tint: 0.25, highlights: 0.3, shadows: 0.5, color: -0.2 }), [0.9, 0.85, 0.2], [0.750353277, 0.663706779, 0.320540726]],
  ['D', adjust({ exposure: 1, contrast: 1, temperature: 1, tint: 1, highlights: 1, shadows: 1, color: 1 }), [0.2, 0.5, 0.8], [0.999999464, 0.981983662, 0.996414602]],
  ['D', adjust({ exposure: 1, contrast: 1, temperature: 1, tint: 1, highlights: 1, shadows: 1, color: 1 }), [0.65, 0.3, 0.1], [0.999999523, 0.905966699, 0.905966699]],
  ['D', adjust({ exposure: 1, contrast: 1, temperature: 1, tint: 1, highlights: 1, shadows: 1, color: 1 }), [0.5, 0.5, 0.5], [0.999999523, 0.984923959, 0.979286194]],
  ['D', adjust({ exposure: 1, contrast: 1, temperature: 1, tint: 1, highlights: 1, shadows: 1, color: 1 }), [0.9, 0.85, 0.2], [0.999999523, 0.999774158, 0.997420192]],
]

test('TS port matches the Rust kernel reference within 1/255', () => {
  for (const [name, a, rgb, expected] of rustReference) {
    const got = applyImageAdjust(rgb, a, false)
    for (let ch = 0; ch < 3; ch++) {
      expect(Math.abs(got[ch] - expected[ch]), `case ${name} channel ${ch}`).toBeLessThanOrEqual(1 / 255)
    }
  }
})

test('premultiplied byte baking keeps alpha and matches the straight math', () => {
  const a = adjust({ exposure: 0.4 })
  // Opaque mid-gray texel: premultiplied == straight.
  const opaque = new Uint8Array([128, 128, 128, 255])
  const baked = adjustRgba8Premultiplied(opaque, a)
  const straight = applyImageAdjust([128 / 255, 128 / 255, 128 / 255], a, false)
  expect(baked[3]).toBe(255)
  for (let ch = 0; ch < 3; ch++) {
    expect(Math.abs(baked[ch] / 255 - straight[ch])).toBeLessThanOrEqual(1 / 255)
  }
  // Identity keeps bytes untouched; input stays unmutated (worker cache may
  // share the array). [10,100,30,128] is valid premultiplied data (rgb <= a);
  // a channel above its alpha would clamp, as it must for storage safety.
  const identityInput = new Uint8Array([10, 100, 30, 128])
  const snapshot = [...identityInput]
  const identityOut = adjustRgba8Premultiplied(identityInput, adjust({}))
  expect([...identityOut]).toEqual(snapshot)
  expect([...identityInput]).toEqual(snapshot)
  // Half-transparent texel: straight color unchanged in intent, alpha kept.
  const half = new Uint8Array([128, 128, 128, 128])
  const halfBaked = adjustRgba8Premultiplied(half, a)
  expect(halfBaked[3]).toBe(128)
  // Straight color of a [128,128,128,128] premultiplied texel is 1.0.
  const straightHalf = applyImageAdjust([1, 1, 1], a, false)
  for (let ch = 0; ch < 3; ch++) {
    expect(Math.abs(halfBaked[ch] / 128 - straightHalf[ch])).toBeLessThanOrEqual(1 / 255)
  }
  // Transparent stays zero.
  expect([...adjustRgba8Premultiplied(new Uint8Array([7, 8, 9, 0]), a)]).toEqual([0, 0, 0, 0])
})

test('linear float baking runs the linear core and preserves alpha', () => {
  const a = adjust({ exposure: 0.4 })
  const values = new Float32Array([0.25, 0.25, 0.25, 1])
  const baked = adjustLinearPremultiplied(values, a)
  expect(baked[3]).toBe(1)
  // Linear domain skips the gamma bookends: with the same input the result
  // differs from the sRGB pipeline (which darkens via pow(2.2) first).
  const viaSrgb = applyImageAdjust([0.25, 0.25, 0.25], a, false)
  expect(Math.abs(baked[0] - viaSrgb[0])).toBeGreaterThan(1 / 255)
  const input = new Float32Array([0.3, 0.6, 0.9, 0.5])
  const copy = Float32Array.from(input)
  const out = adjustLinearPremultiplied(input, adjust({ contrast: 0.5 }))
  expect([...input]).toEqual([...copy])
  expect(out[3]).toBe(0.5)
  // Premultiplied output = straight * alpha.
  const straight = applyImageAdjust([0.6, 0.6, 0.6], adjust({ contrast: 0.5 }), true)
  const full = adjustLinearPremultiplied(new Float32Array([0.3, 0.3, 0.3, 0.5]), adjust({ contrast: 0.5 }))
  for (let ch = 0; ch < 3; ch++) {
    expect(Math.abs(full[ch] - straight[ch] * 0.5)).toBeLessThanOrEqual(1 / 255)
  }
})

test('cache tags separate slider values but not equal ones', () => {
  expect(imageAdjustTag(adjust({ exposure: 0.5 }))).not.toBe(imageAdjustTag(adjust({ exposure: 0.4 })))
  expect(imageAdjustTag(adjust({ exposure: 0.5 }))).toBe(
    imageAdjustTag(adjust({ exposure: 0.5, highlightShadowThreshold: 0.5 })),
  )
})
