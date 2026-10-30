import { expect, test } from 'vitest'
import type { DesignDocument } from './model'
import { blank, node, paint, stroke, validateDocument, hasImageAdjusts, defaultImageAdjust } from './model'

const uri =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const docWithAdjust = (schemaVersion: DesignDocument['schemaVersion']) => {
  const d = blank()
  d.schemaVersion = schemaVersion
  const rect = node('rectangle', 0, 0, 100, 100)
  rect.fills = [{ ...paint('#000000', 'image'), image: uri, fit: 'cover', adjust: defaultImageAdjust() }]
  rect.fills[0].adjust!.exposure = 0.4
  d.nodes[rect.id] = rect
  d.pages[0].children = [rect.id]
  return { d, rect }
}

test('image adjustments validate on schema-13 image paints and are detected', () => {
  const { d } = docWithAdjust(13)
  expect(() => validateDocument(d)).not.toThrow()
  expect(hasImageAdjusts(d)).toBe(true)
  expect(hasImageAdjusts(blank())).toBe(false)
  // JSON round-trip keeps the authored values (serde defaults on load).
  const restored = JSON.parse(JSON.stringify(d))
  expect(() => validateDocument(restored)).not.toThrow()
  expect(restored.nodes[Object.keys(restored.nodes)[0]].fills[0].adjust.exposure).toBe(0.4)
})

test('image adjustments reject older schemas, non-image paints and open ranges', () => {
  const older = docWithAdjust(12)
  expect(() => validateDocument(older.d)).toThrow('图片调整')
  const solid = docWithAdjust(13)
  solid.rect.fills = [{ ...paint('#818cf8'), adjust: defaultImageAdjust() }]
  expect(() => validateDocument(solid.d)).toThrow('图层数据无效')
  const outOfRange = docWithAdjust(13)
  outOfRange.d.nodes[outOfRange.rect.id].fills[0].adjust!.exposure = 1.5
  expect(() => validateDocument(outOfRange.d)).toThrow('图层数据无效')
  const badThreshold = docWithAdjust(13)
  badThreshold.d.nodes[badThreshold.rect.id].fills[0].adjust!.highlightShadowThreshold = 1.2
  expect(() => validateDocument(badThreshold.d)).toThrow('图层数据无效')
  const unknownField = docWithAdjust(13)
  ;(unknownField.d.nodes[unknownField.rect.id].fills[0].adjust as unknown as Record<string, unknown>).vibrance = 0.5
  expect(() => validateDocument(unknownField.d)).toThrow('图层数据无效')
})

test('absent adjust stays identity and keeps legacy documents valid', () => {
  const d = blank()
  d.schemaVersion = 2
  const rect = node('rectangle', 0, 0, 10, 10)
  rect.fills = [{ ...paint('#000000', 'image'), image: uri, fit: 'contain' }]
  d.nodes[rect.id] = rect
  d.pages[0].children = [rect.id]
  expect(() => validateDocument(d)).not.toThrow()
  expect(hasImageAdjusts(d)).toBe(false)
  // Stroke paints carry the same gate.
  const stroked = docWithAdjust(13)
  stroked.rect.fills = [paint('#818cf8')]
  stroked.rect.strokes = [stroke('#303344')]
  stroked.rect.strokes[0].paint = { ...paint('#000000', 'image'), image: uri, adjust: defaultImageAdjust() }
  expect(hasImageAdjusts(stroked.d)).toBe(true)
  expect(() => validateDocument(stroked.d)).not.toThrow()
})
