import { afterEach, describe, expect, test, vi } from 'vitest'
import { INTERACTION_ADAPTIVE_DENSITY_BUDGET, interactionAdaptiveDensityEnabled, interactionAdaptiveScale } from './interaction-adaptive-density'

const BUDGET = INTERACTION_ADAPTIVE_DENSITY_BUDGET

describe('interaction adaptive gesture density (Figma viewer §2.4 stepping)', () => {
  afterEach(() => vi.unstubAllEnvs())

  test('flag off keeps full density even far above the budget', () => {
    vi.stubEnv('VITE_DESIGN_INTERACTION_ADAPTIVE_DENSITY', '0')
    const bounds = { width: 2000, height: 2000 }
    expect(interactionAdaptiveScale(50, bounds, true, false)).toBe(50)
    expect(interactionAdaptiveDensityEnabled()).toBe(false)
  })

  test('demand within the budget is never reduced', () => {
    vi.stubEnv('VITE_DESIGN_INTERACTION_ADAPTIVE_DENSITY', '1')
    const bounds = { width: 1000, height: 1000 }
    expect(interactionAdaptiveScale(2, bounds, true, false)).toBe(2) // 4M pixels
  })

  test('inactive gestures and the low-zoom reduced tier keep full density', () => {
    vi.stubEnv('VITE_DESIGN_INTERACTION_ADAPTIVE_DENSITY', '1')
    const bounds = { width: 2000, height: 2000 } // 200M pixels at 50
    expect(interactionAdaptiveScale(50, bounds, false, false)).toBe(50)
    expect(interactionAdaptiveScale(50, bounds, true, true)).toBe(50)
  })

  test('2x-over-budget demand halves density into the budget', () => {
    vi.stubEnv('VITE_DESIGN_INTERACTION_ADAPTIVE_DENSITY', '1')
    const bounds = { width: 1000, height: 1000 } // 16M pixels at 4, ratio 2
    expect(interactionAdaptiveScale(4, bounds, true, false)).toBe(2)
    expect(1000 * 1000 * 2 * 2).toBeLessThanOrEqual(BUDGET)
  })

  test('8x-over-budget demand quarters scale; nearby zooms share one lattice step', () => {
    vi.stubEnv('VITE_DESIGN_INTERACTION_ADAPTIVE_DENSITY', '1')
    const bounds = { width: 1000, height: 1000 }
    expect(interactionAdaptiveScale(8, bounds, true, false)).toBe(2) // 64M -> divisor 4 -> 4M
    // zoom 20 vs 21 (demand ratio 1.1) must share one lattice step: the
    // divisor is stable; density still tracks zoom inside the step.
    const wide = { width: 600, height: 600 }
    const at20 = interactionAdaptiveScale(20, wide, true, false)
    const at21 = interactionAdaptiveScale(21, wide, true, false)
    expect(at20 * 8).toBe(20)
    expect(at21 * 8).toBe(21)
    expect(wide.width * wide.height * at21 * at21).toBeLessThanOrEqual(BUDGET)
  })

  test('high zoom lands within the budget and keeps a positive finite scale', () => {
    vi.stubEnv('VITE_DESIGN_INTERACTION_ADAPTIVE_DENSITY', '1')
    const bounds = { width: 300, height: 300 } // 2480% DPR2 -> scale ~49.6, ~222M pixels
    const scale = interactionAdaptiveScale(49.6, bounds, true, false)
    expect(scale).toBeGreaterThan(0)
    expect(bounds.width * bounds.height * scale * scale).toBeLessThanOrEqual(BUDGET)
    // divisor is a power of two times sqrt-scaled: 4^ceil keeps the lattice stable
    expect([49.6 / 8, 49.6 / 16, 49.6 / 4]).toContain(scale)
  })
})
