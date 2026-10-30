import { describe, expect, test } from 'vitest'
import { apply, inverse } from './geometry'
import { cropImageNode, imageUvTransform } from './image-crop'
import type { Matrix } from './model'

const stretch = { fit: 'stretch' as const }

describe('image crop math (kernel ImageCoordinates convention)', () => {
  test('full-frame crop is the identity edit', () => {
    const node = { width: 200, height: 100, transform: [1, 0, 0, 1, 100, 50] as Matrix }
    const result = cropImageNode(node, stretch, { x: 0, y: 0, width: 200, height: 100 })
    expect(result.transform).toEqual(node.transform)
    expect(result.width).toBe(200)
    expect(result.height).toBe(100)
    expect(result.fillTransform).toEqual([1, 0, 0, 1, 0, 0])
  })

  test('stretch crop keeps every surviving pixel stationary', () => {
    const node = { width: 200, height: 100, transform: [1, 0, 0, 1, 100, 50] as Matrix }
    const rect = { x: 50, y: 25, width: 100, height: 50 }
    const result = cropImageNode(node, stretch, rect)
    expect(result.transform).toEqual([1, 0, 0, 1, 150, 75])
    // New local point p shows the same texel as old local point rect.origin + p.
    const inv = inverse(result.fillTransform)
    for (const p of [{ x: 0, y: 0 }, { x: 40, y: 20 }, { x: 100, y: 50 }]) {
      const uvNode = { x: p.x / result.width, y: p.y / result.height }
      const uvImage = apply(inv, uvNode)
      const oldLocal = { x: rect.x + p.x, y: rect.y + p.y }
      expect(uvImage.x).toBeCloseTo(oldLocal.x / node.width, 12)
      expect(uvImage.y).toBeCloseTo(oldLocal.y / node.height, 12)
    }
  })

  test('cover fit composes the implicit centered mapping into the crop', () => {
    // 100×100 image covering a 200×100 node: scale 2, vertically centered.
    const m = imageUvTransform({ fit: 'cover' }, 200, 100, { width: 100, height: 100 })
    expect(m).toEqual([1, 0, 0, 2, 0, -0.5])
    // The visible image window is uv y ∈ [0.25, 0.75].
    expect(apply(m, { x: 0, y: 0.25 })).toEqual({ x: 0, y: 0 })
    expect(apply(m, { x: 0, y: 0.75 })).toEqual({ x: 0, y: 1 })
    const node = { width: 200, height: 100, transform: [1, 0, 0, 1, 0, 0] as Matrix }
    const result = cropImageNode(node, { fit: 'cover' }, { x: 50, y: 25, width: 100, height: 50 }, { width: 100, height: 100 })
    const inv = inverse(result.fillTransform)
    // Cropped node's top-left texel is old local (50,25): image uv (0.25, 0.375).
    const uv = apply(inv, { x: 0, y: 0 })
    expect(uv.x).toBeCloseTo(0.25, 12)
    expect(uv.y).toBeCloseTo(0.375, 12)
  })

  test('an authored paint transform composes instead of being replaced', () => {
    const fill = { fit: 'cover' as const, transform: [2, 0, 0, 2, 0.1, 0.2] as Matrix }
    expect(imageUvTransform(fill, 50, 50)).toEqual(fill.transform)
    const result = cropImageNode({ width: 100, height: 100, transform: [1, 0, 0, 1, 0, 0] }, fill, { x: 0, y: 0, width: 50, height: 100 })
    // inverse([0.5,0,0,1,0,0]) · transform = [2,0,0,1,0,0] · [2,0,0,2,0.1,0.2]
    expect(result.fillTransform).toEqual([4, 0, 0, 2, 0.2, 0.2])
  })

  test('crop outside the node is rejected', () => {
    const node = { width: 100, height: 100, transform: [1, 0, 0, 1, 0, 0] as Matrix }
    expect(() => cropImageNode(node, stretch, { x: -1, y: 0, width: 50, height: 50 })).toThrow()
    expect(() => cropImageNode(node, stretch, { x: 60, y: 0, width: 50, height: 50 })).toThrow()
    expect(() => cropImageNode(node, stretch, { x: 0, y: 0, width: 0, height: 50 })).toThrow()
    expect(() => imageUvTransform({ fit: 'cover' }, 100, 100)).toThrow()
  })
})
