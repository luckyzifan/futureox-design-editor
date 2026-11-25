import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { figmaFixture, referenceSize } from './figma-fixtures'
import { VectorEngine } from './generated/design-kernel/design_kernel'

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

test('software export matches the frozen black and white rotated curve', () => {
  const png = readFileSync(new URL('../public/fidelity/rotated-curve.png', import.meta.url))
  expect(sha256(png)).toBe('9991f106808da73a9ce35148b946e327c20b879d6fce770f64d3dea24d2dd065')
  const document = figmaFixture('rotated-curve')
  const engine = new VectorEngine()
  try {
    engine.load_document(JSON.stringify(document))
    const size = referenceSize('rotated-curve')
    const base = {
      ...size, pageId: document.pages[0].id,
      view: { x: 0, y: 0, zoom: 1 }, grid: false, transparent: false,
    }
    // RGBA8 digest of the pinned reference PNG after decoding.
    const expected = '7d428192d51ec044a4c5d20cd8265666ec4205635e82aca885de740d1528b795'
    for (const rasterProfile of ['figma', 'figmaSoftware']) {
      expect(sha256(engine.render_rgba(JSON.stringify({ ...base, rasterProfile })))).toBe(expected)
    }
  } finally {
    engine.free()
  }
})
