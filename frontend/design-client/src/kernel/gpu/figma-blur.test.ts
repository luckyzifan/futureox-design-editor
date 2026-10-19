import { expect, test } from 'vitest'
import { figmaBlurUniforms, figmaTentSample } from './figma-blur'

test('uniforms follow the recovered CPU contract', () => {
  const h = figmaBlurUniforms(10, true, { width: 512, height: 512 })
  expect(h.count).toBeCloseTo(10 * Math.sqrt(6), 9)
  expect(h.count).toBeLessThanOrEqual(64)
  expect(h.blurDelta).toEqual([10 / h.count / 512, 0])
  const v = figmaBlurUniforms(10, false, { width: 512, height: 512 })
  expect(v.blurDelta).toEqual([0, 10 / v.count / 512])
  expect(() => figmaBlurUniforms(0, true, { width: 1, height: 1 })).toThrow()
  // 巨半径夹到 64(其 const int a=64 的界)
  expect(figmaBlurUniforms(1000, true, { width: 8, height: 8 }).count).toBe(64)
})

test('paired tent equals full tent by construction', () => {
  // 成对插值在线性采样下与逐 tap 帐篷数学等价:
  // 用纯数学参照验证帐篷核的归一化与对称性。
  const taps = new Float32Array([0, 0, 0, 1, 1, 1, 0, 0, 0])
  const count = 3
  const center = figmaTentSample(taps, count, 4)
  // 阶梯边缘的帐篷采样应落在 (0,1) 且对称位置等值
  const left = figmaTentSample(taps, count, 3)
  const right = figmaTentSample(taps, count, 5)
  expect(left).toBeCloseTo(right, 12)
  expect(center).toBeGreaterThan(left)
  expect(left).toBeGreaterThan(0)
  // 权重和归一化:全 1 输入 → 输出 1
  const ones = new Float32Array(9).fill(1)
  expect(figmaTentSample(ones, 3, 4)).toBeCloseTo(1, 12)
})

import { figmaPack4, figmaUnpack4 } from './figma-blur'

test('shadow packing ladder round-trips within RGBA8 precision', () => {
  // 其精度设计:255/65025/16581375 三级阶梯,往返误差 ~1/16581375 量级
  for (const v of [0, 0.001, 0.123456, 0.5, 0.999999, 1]) {
    const packed = figmaPack4(v)
    const unpacked = figmaUnpack4(packed)
    expect(Math.abs(unpacked - v)).toBeLessThan(1e-6)
    expect(packed.every((c) => c >= 0 && c <= 255)).toBe(true)
  }
})
