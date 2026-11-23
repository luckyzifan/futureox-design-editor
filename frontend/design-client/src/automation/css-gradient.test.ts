import { describe, expect, it } from 'vitest'
import { inverse } from '../commands/affine'
import type { Matrix } from '../model'
import { cssLinearGradient, cssRadialGradient, type GradientStopCss } from './css-gradient'

const stops: GradientStopCss[] = [
  { offset: 0, color: '#ff0000' },
  { offset: 1, color: '#0000ff' },
]

/** Independent of css-gradient.ts. Matches design-kernel paint.rs gradient_t. */
function kernelLinearT(angle: number, transform: Matrix | undefined, u: number, v: number): number {
  if (transform) {
    const inverted = inverse(transform)
    return inverted[0] * u + inverted[2] * v + inverted[4]
  }
  const radians = (angle * Math.PI) / 180
  const cos = Math.cos(radians), sin = Math.sin(radians)
  return ((u - 0.5) * cos + (v - 0.5) * sin) / (Math.abs(cos) + Math.abs(sin)) + 0.5
}

function splitCssList(value: string): string[] {
  const parts: string[] = []
  let depth = 0, start = 0
  for (let index = 0; index < value.length; index++) {
    const char = value[index]
    if (char === '(') depth++
    else if (char === ')') depth--
    else if (char === ',' && depth === 0) { parts.push(value.slice(start, index)); start = index + 1 }
  }
  parts.push(value.slice(start))
  return parts
}

function parseLinear(css: string) {
  const match = /^linear-gradient\(([-+\d.]+)deg,([\s\S]*)\)$/.exec(css)
  if (!match) throw new Error(`Not a linear gradient: ${css}`)
  const parsed = splitCssList(match[2]).map(part => {
    const stop = /^(.*) ([-+\d.]+)%$/.exec(part)
    if (!stop) throw new Error(`Bad stop: ${part}`)
    return { color: stop[1], position: Number(stop[2]) / 100 }
  })
  return { angle: Number(match[1]), stops: parsed }
}

/** CSS Images linear-gradient parameter at a pixel. 0 is the start of the gradient line. */
function cssLineT(angle: number, x: number, y: number, width: number, height: number): number {
  const radians = (angle * Math.PI) / 180
  const dx = Math.sin(radians), dy = -Math.cos(radians)
  const length = Math.abs(width * dx) + Math.abs(height * dy)
  return 0.5 + ((x - width / 2) * dx + (y - height / 2) * dy) / length
}

function nativeFromCss(css: string, u: number, v: number, width: number, height: number, authored: GradientStopCss[]): number {
  const parsed = parseLinear(css)
  const line = cssLineT(parsed.angle, u * width, v * height, width, height)
  const positions = parsed.stops.map(stop => {
    const source = authored.find(item => item.color === stop.color && !authored.some(other => other !== item && other.color === item.color))
    return { offset: source?.offset ?? authored[parsed.stops.indexOf(stop)].offset, position: stop.position }
  })
  if (line <= positions[0].position) return positions[0].offset
  const last = positions[positions.length - 1]
  if (line >= last.position) return last.offset
  for (let index = 1; index < positions.length; index++) {
    if (line <= positions[index].position) {
      const span = positions[index].position - positions[index - 1].position
      const mix = span === 0 ? 0 : (line - positions[index - 1].position) / span
      return positions[index - 1].offset + mix * (positions[index].offset - positions[index - 1].offset)
    }
  }
  return last.offset
}

describe('CSS linear gradient geometry', () => {
  const samples = [0, 0.2, 0.5, 0.8, 1]
  it.each([
    [100, 100, 0],
    [200, 80, 0],
    [80, 240, 90],
    [200, 100, 45],
    [320, 50, -30],
    [90, 90, 180],
    [140, 70, 270],
  ] as const)('matches the kernel field for %sx%s at %s degrees', (width, height, angle) => {
    const css = cssLinearGradient(width, height, angle, undefined, stops)
    expect(css).toBeTruthy()
    for (const u of samples) for (const v of samples) {
      const expected = Math.min(1, Math.max(0, kernelLinearT(angle, undefined, u, v)))
      expect(nativeFromCss(css!, u, v, width, height, stops)).toBeCloseTo(expected, 4)
    }
  })

  it('uses the paint transform instead of a stale angle', () => {
    // FIG top-to-bottom gradient stored as the inverse of the file matrix. angle 0 is not the direction.
    const transform: Matrix = [0, 1, -1, 0, 1, 0]
    const css = cssLinearGradient(200, 80, 0, transform, stops)
    expect(css).toBe('linear-gradient(180deg,#ff0000 0%,#0000ff 100%)')
    expect(kernelLinearT(0, transform, 0.25, 0.75)).toBeCloseTo(0.75, 12)
    const shifted: Matrix = [1, 0, 0, 1, 0.25, 0]
    const shiftedCss = cssLinearGradient(200, 100, 90, shifted, stops)
    expect(shiftedCss).toContain('90deg')
    for (const u of samples) for (const v of samples) {
      const expected = Math.min(1, Math.max(0, kernelLinearT(90, shifted, u, v)))
      expect(nativeFromCss(shiftedCss!, u, v, 200, 100, stops)).toBeCloseTo(expected, 4)
    }
  })

  it('sorts stops and scales a gradient that does not cross the whole box', () => {
    const authored = [{ offset: 1, color: '#0000ff' }, { offset: 0, color: '#ff0000' }]
    const css = cssLinearGradient(100, 40, 0, [0.5, 0, 0, 1, 0, 0], authored)
    expect(css).toBe('linear-gradient(90deg,#ff0000 0%,#0000ff 50%)')
  })

  it('omits a singular paint transform instead of emitting the angle', () => {
    expect(cssLinearGradient(100, 100, 0, [0, 0, 0, 0, 0, 0], stops)).toBeUndefined()
    expect(cssLinearGradient(0, 100, 0, undefined, stops)).toBeUndefined()
  })
})

describe('CSS radial gradient shape', () => {
  it('uses the side-touching ellipse unless a paint transform moves it', () => {
    const reversed = [{ offset: 1, color: '#0000ff' }, { offset: 0, color: '#00ff00' }]
    expect(cssRadialGradient(reversed, false)).toBe('radial-gradient(ellipse closest-side at center,#00ff00 0%,#0000ff 100%)')
    expect(cssRadialGradient(stops, true)).toBe('radial-gradient(ellipse at center,#ff0000 0%,#0000ff 100%)')
  })
})
