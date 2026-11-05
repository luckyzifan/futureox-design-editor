/** @vitest-environment jsdom */
import { expect, test } from 'vitest'
import { canvasPixelGrid, LOUPE_SPAN } from './canvas-color-picker'

test('loupe grid center matches the published pixel', () => {
  const host = document.createElement('div')
  const canvas = document.createElement('canvas')
  canvas.width = 5
  canvas.height = 5
  canvas.dataset.frameVisible = 'true'
  const pixels = new Uint8ClampedArray(5 * 5 * 4)
  for (let i = 0; i < 25; i++) pixels.set([i, 0, 255 - i, 255], i * 4)
  canvas.getContext = (() => ({ getImageData: (x: number, y: number, w: number, h: number) => {
    const data = new Uint8ClampedArray(w * h * 4)
    for (let row = 0; row < h; row++) for (let col = 0; col < w; col++) {
      const sx = x + col, sy = y + row
      const source = sx >= 0 && sy >= 0 && sx < 5 && sy < 5 ? pixels.subarray((sy * 5 + sx) * 4, (sy * 5 + sx) * 4 + 4) : new Uint8ClampedArray(4)
      data.set(source, (row * w + col) * 4)
    }
    return { data }
  } })) as unknown as typeof canvas.getContext
  const box = (width: number, height: number) => ({ left: 0, top: 0, width, height, right: width, bottom: height, x: 0, y: 0, toJSON() { return {} } })
  host.getBoundingClientRect = () => box(5, 5) as DOMRect
  canvas.getBoundingClientRect = () => box(5, 5) as DOMRect
  for (const element of [canvas, host, document.body, document.documentElement]) element.style.opacity = '1'
  host.append(canvas)
  document.body.append(host)
  const grid = canvasPixelGrid(host, 2, 2)
  expect(grid).toHaveLength(LOUPE_SPAN * LOUPE_SPAN)
  expect(grid[(LOUPE_SPAN * LOUPE_SPAN - 1) / 2]).toBe('#0c00f3')
  host.remove()
})
