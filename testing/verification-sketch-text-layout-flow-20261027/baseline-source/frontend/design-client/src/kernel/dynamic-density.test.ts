import { describe, test, expect } from 'vitest'
import { densityForScale } from './tile-cache'

describe('动态密度计算', () => {
  test('缩小时降低密度 (scale < 0.5)', () => {
    expect(densityForScale(0.1)).toBe(0.5)
    expect(densityForScale(0.25)).toBe(0.5)
    expect(densityForScale(0.4)).toBe(0.5)
  })

  test('正常视图使用标准密度 (0.5 ≤ scale ≤ 2)', () => {
    expect(densityForScale(0.5)).toBe(1.0)
    expect(densityForScale(1.0)).toBe(1.0)
    expect(densityForScale(1.5)).toBe(1.0)
    expect(densityForScale(2.0)).toBe(1.0)
  })

  test('放大时提升密度 (scale > 2)', () => {
    expect(densityForScale(2.1)).toBe(2.0)
    expect(densityForScale(3.0)).toBe(2.0)
    expect(densityForScale(5.0)).toBe(2.0)
  })

  test('边界值处理', () => {
    expect(densityForScale(0.5)).toBe(1.0)
    expect(densityForScale(2.0)).toBe(1.0)
    expect(densityForScale(0.49)).toBe(0.5)
    expect(densityForScale(2.01)).toBe(2.0)
  })

  test('无效值返回默认密度', () => {
    expect(densityForScale(NaN)).toBe(1.0)
    expect(densityForScale(-1)).toBe(1.0)
    expect(densityForScale(0)).toBe(1.0)
    expect(densityForScale(Infinity)).toBe(1.0)
  })
})
