import { expect, test } from 'vitest'
import { parameters } from './types'
import { prefixSamplingGeometry } from './prefix-sampling-geometry'
import { backdropFilterRegion } from './backdrop-filter-region'

const f = Math.fround
test.each([0, 1] as const)('fractional capture axis %s keeps every original floor tap including real clamp edges', axis => {
  const source = { x: -1797.8828125, y: 964.162109375, w: 3659, h: 1857 }
  const output = { x: source.x + 1793, y: source.y, w: 72, h: 66 }
  for (const radius of [32, 1177.21484375, 1177.21484375 + 2 ** -14, 2048]) {
    const u = parameters(output, source); u[37] = axis; u[38] = 1
    expect(prefixSamplingGeometry(u, radius)).toBeUndefined()
    const geometry = prefixSamplingGeometry(u, radius, true)!
    expect(geometry.padding).toBe(Math.ceil(radius) + 1)
    expect(geometry.length).toBe(source[axis ? 'h' : 'w'] + geometry.padding * 2)
    for (let pixel = 0; pixel < u[2 + axis]; pixel++) for (let tap = -geometry.padding; tap <= geometry.padding; tap++) {
      const point = f(f(pixel + .5 + u[axis]) + tap)
      const clamped = Math.max(f(u[4 + axis] + .5), Math.min(f(f(u[4 + axis] + u[6 + axis]) - .5), point))
      const actual = Math.floor(f(clamped - u[4 + axis]))
      const virtual = Math.max(0, Math.min(u[6 + axis] - 1, pixel + geometry.offset + tap - geometry.padding))
      expect(actual).toBe(virtual)
    }
  }
})
test('unsafe phase, overflow, shared uniforms and oversized virtual lines keep scalar fallback', () => {
  const base = parameters({ x: .5, y: 0, w: 16, h: 16 }, { x: 0, y: 0, w: 32, h: 32 }); base[37] = 0; base[38] = 1
  expect(prefixSamplingGeometry(base, 32, true)).toBeUndefined()
  base[0] = .125
  expect(prefixSamplingGeometry(base, 32, true)).toBeDefined()
  base[6] = 16384
  expect(prefixSamplingGeometry(base, 32, true)).toBeUndefined()
  base[6] = 32; base[0] = 1048576; base[4] = 1048576
  expect(prefixSamplingGeometry(base, 32, true)).toBeUndefined()
  const shared = new Float32Array(new SharedArrayBuffer(1024)); shared.set(base)
  expect(prefixSamplingGeometry(shared, 32, true)).toBeUndefined()
})
test('actual117 small consumer retains real top-edge clamp and exact mode27 bilinear phase', () => {
  const input = { x: -1797.8828125, y: 964.162109375, w: 3659, h: 1857 }
  const output = backdropFilterRegion(input, [-2, 958, 68, 68])!
  expect(output).toEqual({ x: -4.8828125, y: 964.162109375, w: 73, h: 64 })
  expect(output.w * input.h * 16 + output.w * output.h * 16).toBeLessThan(3 * 1024 * 1024)
  expect(backdropFilterRegion(input, undefined)).toBeUndefined()
  expect(backdropFilterRegion(input, [-2, 958, 0, 68])).toBeUndefined()
  expect(backdropFilterRegion(input, [-2.5, 958, 68, 68])).toBeUndefined()
})
test('region addressing rejects a same-double-lattice crop when f32 bilinear weights change', () => {
  // The small source origin carries bits lost at the shifted larger exponent.
  const source = { x: -9280.606143, y: 0, w: 16000, h: 4 }
  expect(backdropFilterRegion(source, [-1280, 0, 64, 4])).toBeUndefined()
})

test('an exact regional box can emit zeros beyond the source only along its filtered axis', () => {
  const source = { x: -12, y: 24, w: 16, h: 32 }
  const output = { x: -15, y: 24, w: 21, h: 32 }
  const u = parameters(output, source)
  expect(prefixSamplingGeometry(u, 32)).toBeUndefined()
  expect(prefixSamplingGeometry(u, 32, false, 2048, true)).toEqual({ length: 16, offset: -3, crossOffset: 0, padding: 0 })
  u[37] = 1
  expect(prefixSamplingGeometry(u, 32, false, 2048, true)).toBeUndefined()
})
