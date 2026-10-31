// Baseline contracts; the font-face cache experiments were not adopted.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { VectorEngine } from './generated/design-kernel/design_kernel'

function pressureNode() {
  return {
    id: 't',
    kind: 'text',
    text: '中'.repeat(80),
    fontSize: 20,
    width: 251.375,
    height: 30,
    textStyle: { wrap: true, paragraphIndent: 25, letterSpacing: -0.375 },
    textRuns: Array.from({ length: 80 }, (_, i) => ({
      start: i,
      end: i + 1,
      weight: 100 + (i % 40) * 20.125,
      fontSize: 12 + (i % 3) * 3.125,
      color: i % 2 ? '#112233' : '#cc2255',
      underline: i % 3 === 0,
    })),
  }
}
function withEngine(run: (engine: VectorEngine) => void) {
  const engine = new VectorEngine()
  try {
    engine.load_font(
      new Uint8Array(readFileSync(new URL('../public/fonts/NotoSansSC.ttf', import.meta.url))),
    )
    run(engine)
  } finally {
    engine.free()
  }
}
test('real WASM forty-weight rich text preserves pinned baseline geometry and outlines exactly', () => {
  withEngine((engine) => {
    const value = engine.text_layout(JSON.stringify(pressureNode()))
    expect(createHash('sha256').update(value).digest('hex')).toBe(
      '5ea0e9e19b71b82493ce2feda0096e29aaae7221df82ae23dca395bd752ee1f2',
    )
    const result = JSON.parse(value)
    expect([result.width, result.height, result.lines.length, result.glyphs.length]).toEqual([
      251.125, 135, 5, 80,
    ])
  })
})
test('real WASM each measurement sees edits and does not retain a prior font lookup', () => {
  withEngine((engine) => {
    const n = pressureNode()
    const before = engine.text_layout(JSON.stringify(n))
    n.textRuns[0].weight = 799.125
    expect(engine.text_layout(JSON.stringify(n))).not.toBe(before)
    n.textRuns[0].weight = 100
    expect(engine.text_layout(JSON.stringify(n))).toBe(before)
    // A vanished font id degrades to the embedded default face instead of
    // failing the measurement — the historical hard error let one stale id
    // blank a whole canvas render. Runs use no fontId override, so the
    // layout itself is unchanged by the style slot.
    const degraded = JSON.parse(
      engine.text_layout(
        JSON.stringify({ ...n, textStyle: { ...n.textStyle, fontId: 'missing' } }),
      ),
    )
    expect(degraded.width).toBe(JSON.parse(before).width)
    expect(engine.text_layout(JSON.stringify(n))).toBe(before)
  })
})
