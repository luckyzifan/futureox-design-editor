import { expect, test } from 'vitest'
import { nativeSourceBadgeText } from './native-source-status'

test('a reprojected frame is not labeled sharp, and a held zero-tile refine is not 0/N', () => {
  expect(nativeSourceBadgeText({ phase: 'ready', done: 9, total: 9 }, {
    cpu: false, openingMaterial: false, previewRejected: true, holdingFrame: true,
  })).toBe('计算中')
  expect(nativeSourceBadgeText({ phase: 'ready', done: 9, total: 9 }, {
    cpu: false, openingMaterial: false, previewRejected: false, holdingFrame: true,
  })).toBe('WebGPU · 清晰')
  expect(nativeSourceBadgeText({ phase: 'refining', done: 0, total: 25 }, {
    cpu: false, openingMaterial: false, previewRejected: true, holdingFrame: true,
  })).toBe('计算中')
  expect(nativeSourceBadgeText({ phase: 'refining', done: 0, total: 9 }, {
    cpu: false, openingMaterial: false, previewRejected: false, holdingFrame: false,
  })).toBe('正在绘制 0 / 9')
  expect(nativeSourceBadgeText({ phase: 'refining', done: 3, total: 25 }, {
    cpu: false, openingMaterial: false, previewRejected: false, holdingFrame: true,
  })).toBe('正在绘制 3 / 25')
})
