import { expect, test } from 'vitest'
import { apply, around, inverse, multiply, rotate } from './commands/affine'
import { largeRotatedSourceDirect, rotationBitmapFollowPlan, visibleRotationCrop } from './rotation-bitmap-follow'

function followCamera(view: { x: number; y: number; zoom: number }) {
  return [view.zoom, 0, 0, view.zoom, view.x, view.y] as const
}
function screenWarp(view: { x: number; y: number; zoom: number }, worldDelta: readonly number[]) {
  const camera = followCamera(view)
  return multiply(camera, multiply(worldDelta, inverse(camera)))
}

const view = { x: 40, y: 24, zoom: 1 }

test('a large bitmap and its baked selection leave the old orientation during the drag', () => {
  const box = { x: -400, y: -300, width: 2000, height: 1600 }
  const visible = visibleRotationCrop(box, view, 800, 600)
  expect(visible).not.toBeNull()
  expect(visible!.x).toBeGreaterThan(box.x)
  expect(visible!.width).toBeLessThan(box.width)
  const plan = rotationBitmapFollowPlan({ bakedOutline: true, ownPaint: null, visibleBox: visible, largeBitmap: true })
  expect(plan).toEqual({ mode: 'snapshot', drawSelection: false })
  const center = { x: visible!.x + visible!.width / 2, y: visible!.y + visible!.height / 2 }
  const delta = around(center, rotate(24))
  const bitmap = { x: visible!.x + 30, y: visible!.y + 40 }
  const moved = apply(delta, bitmap)
  expect(Math.hypot(moved.x - bitmap.x, moved.y - bitmap.y)).toBeGreaterThan(8)
  const screen = apply(followCamera(view), bitmap)
  const warped = apply(screenWarp(view, delta)!, screen)
  expect(warped.x).toBeCloseTo(moved.x * view.zoom + view.x, 5)
  expect(warped.y).toBeCloseTo(moved.y * view.zoom + view.y, 5)
  const held = apply(screenWarp(view, [1, 0, 0, 1, 0, 0])!, screen)
  expect(held).toEqual(screen)
  expect(Math.hypot(warped.x - held.x, warped.y - held.y)).toBeGreaterThan(8)
})

test('a solid keeps own paint, and a missing snapshot does not pretend the bitmap followed', () => {
  const visible = visibleRotationCrop({ x: 80, y: 60, width: 120, height: 80 }, view, 800, 600)
  expect(rotationBitmapFollowPlan({ bakedOutline: false, ownPaint: 'solid', visibleBox: visible, largeBitmap: true }).mode).toBe('own-paint')
  expect(rotationBitmapFollowPlan({ bakedOutline: false, ownPaint: 'image', visibleBox: visible, largeBitmap: false }).mode).toBe('own-paint')
  expect(rotationBitmapFollowPlan({ bakedOutline: true, ownPaint: 'image', visibleBox: null, largeBitmap: true })).toEqual({ mode: 'gpu', drawSelection: false })
  expect(rotationBitmapFollowPlan({ bakedOutline: false, ownPaint: 'image', visibleBox: visible, largeBitmap: true })).toEqual({ mode: 'snapshot', drawSelection: true })
  expect(rotationBitmapFollowPlan({ bakedOutline: false, ownPaint: null, visibleBox: visible, largeBitmap: true })).toEqual({ mode: 'snapshot', drawSelection: true })
  expect(rotationBitmapFollowPlan({ bakedOutline: false, ownPaint: null, visibleBox: null, largeBitmap: true }).mode).toBe('gpu')
})

test('only a large rotated display image skips the dense source grid', () => {
  const turned = [Math.cos(0.4), Math.sin(0.4), -Math.sin(0.4), Math.cos(0.4), 10, 20]
  const aligned = [2, 0, 0, 3, 10, 20]
  expect(largeRotatedSourceDirect(800 * 600, turned, false, false)).toBe(true)
  expect(largeRotatedSourceDirect(256 * 256, turned, false, false)).toBe(true)
  expect(largeRotatedSourceDirect(800 * 600, aligned, false, false)).toBe(false)
  expect(largeRotatedSourceDirect(128 * 16, turned, false, false)).toBe(false)
  expect(largeRotatedSourceDirect(800 * 600, turned, true, false)).toBe(false)
  expect(largeRotatedSourceDirect(800 * 600, turned, false, true)).toBe(false)
})
