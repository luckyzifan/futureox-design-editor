import { expect, test } from 'vitest'
import { blank, node, stroke, effect, paint } from './model'

test('paint shared styles carry the node strokes and effects of a full layer style', () => {
  const d = blank()
  d.schemaVersion = 12
  const rect = node('rectangle', 0, 0, 100, 100)
  rect.strokes = [
    { ...stroke('#112233', 2.5), align: 'inside' as const, cap: 'round' as const, join: 'bevel' as const, dash: '4,2' },
  ]
  rect.effects = [{ ...effect('shadow'), radius: 10, x: 3, y: -4, spread: 2, opacity: 0.6 }]
  d.nodes[rect.id] = rect
  d.pages[0].children = [rect.id]
  d.designSystem = {
    collections: {},
    variables: {},
    activeModes: {},
    libraries: {},
    styles: {
      'style-1': {
        name: 'Card Style',
        kind: 'paint',
        value: structuredClone(rect.fills),
        strokes: structuredClone(rect.strokes),
        effects: structuredClone(rect.effects),
      },
    },
  }
  // The stored parts keep the node-side parameters verbatim: border width,
  // position, dash, cap/join and the full shadow parameter set.
  const shared = d.designSystem.styles['style-1']
  expect(shared.strokes).toHaveLength(1)
  expect(shared.strokes![0].width).toBe(2.5)
  expect(shared.strokes![0].align).toBe('inside')
  expect(shared.strokes![0].dash).toBe('4,2')
  expect(shared.strokes![0].cap).toBe('round')
  expect(shared.strokes![0].join).toBe('bevel')
  expect(shared.strokes![0].paint.color).toBe('#112233')
  expect(shared.effects).toHaveLength(1)
  const shadow = shared.effects![0]
  expect(shadow.radius).toBe(10)
  expect(shadow.y).toBe(-4)
  expect(shadow.spread).toBe(2)
  expect(shadow.opacity).toBe(0.6)
  // text styles never carry parts
  d.designSystem.styles['style-2'] = { name: 'Body', kind: 'text', value: { wrap: false } }
  expect(d.designSystem.styles['style-2'].strokes).toBeUndefined()
})

test('untinted documents keep plain paint styles part-free', () => {
  const d = blank()
  const frame = node('frame', 0, 0, 50, 50)
  frame.fills = [paint('#ffffff')]
  d.nodes[frame.id] = frame
  d.pages[0].children = [frame.id]
  d.designSystem = {
    collections: {},
    variables: {},
    activeModes: {},
    libraries: {},
    styles: { s: { name: 'Fill', kind: 'paint', value: structuredClone(frame.fills) } },
  }
  expect(d.designSystem.styles.s.strokes).toBeUndefined()
  expect(d.designSystem.styles.s.effects).toBeUndefined()
})
