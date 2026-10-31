import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { VectorEngine } from './generated/design-kernel/design_kernel'
import type { DesignNode } from './model'

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(
      new URL(
        `../../../design-studio/crates/design-kernel/tests/fixtures/mutation/${name}.json`,
        import.meta.url,
      ),
      'utf8',
    ),
  )
const options = JSON.stringify({
  pageId: 'p',
  width: 128,
  height: 128,
  view: { x: 0, y: 0, zoom: 1 },
  transparent: true,
})
test('shipping WASM dimension bindings resize vector geometry and visible pixels', () => {
  const engine = new VectorEngine()
  try {
    const d = fixture('bound-vector-width')
    engine.load_document(JSON.stringify(d))
    const n = JSON.parse(engine.resolve_components(JSON.stringify(d))).nodes.n
    expect(n.width).toBe(20)
    expect(n.network.vertices[1].x).toBe(20)
    expect(engine.render_rgba(options)[(5 * 128 + 15) * 4 + 3]).toBe(255)
  } finally {
    engine.free()
  }
})
test('shipping WASM text bindings reconcile shorter, longer and Unicode styled ranges', () => {
  const engine = new VectorEngine()
  try {
    for (const text of ['Hi', '😀e\u0301', 'A longer localized greeting', '']) {
      const d = fixture('bound-rich-text')
      d.designSystem.variables.v.values.m = text
      const n = JSON.parse(engine.resolve_components(JSON.stringify(d))).nodes.n
      expect(n.text).toBe(text)
      expect(n.textRuns?.at(-1)?.end || 0).toBe(text.length)
    }
  } finally {
    engine.free()
  }
})
test('shipping WASM component properties reconcile styled text ranges', () => {
  const engine = new VectorEngine()
  try {
    const nodes: Record<string, DesignNode> = JSON.parse(
      engine.resolve_components(JSON.stringify(fixture('component-rich-text'))),
    ).nodes
    const n = Object.values(nodes).find((n) => n.instanceOrigin?.owner === 'i')!
    expect(n.text).toBe('Hi')
    expect(n.textRuns!.at(-1)!.end).toBe(2)
  } finally {
    engine.free()
  }
})
test('shipping WASM rejects oversized effects with the native budget error', () => {
  const engine = new VectorEngine()
  try {
    engine.load_document(JSON.stringify(fixture('huge-effect')))
    expect(() => engine.render_rgba(options)).toThrow(/Effect expansion exceeds/)
  } finally {
    engine.free()
  }
})
