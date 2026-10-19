import { expect, test } from 'vitest'
import { gradientLine } from './Renderer'
test('SVG gradient projection matches the kernel at arbitrary angles and box coordinates', () => {
  for (const angle of [-130, 0, 17, 30, 45, 80, 90, 135, 270]) {
    const line = gradientLine(angle),
      dx = line.x2 - line.x1,
      dy = line.y2 - line.y1
    const radians = (angle * Math.PI) / 180,
      x = Math.cos(radians),
      y = Math.sin(radians)
    for (const [u, v] of [
      [0, 0],
      [0.5, 0.5],
      [0.2, 0.8],
      [1, 1],
    ]) {
      const svg = ((u - line.x1) * dx + (v - line.y1) * dy) / (dx * dx + dy * dy)
      const kernel = ((u - 0.5) * x + (v - 0.5) * y) / (Math.abs(x) + Math.abs(y)) + 0.5
      expect(svg).toBeCloseTo(kernel, 12)
    }
  }
})
