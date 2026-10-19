import { describe, it, expect } from 'vitest'
import { blank, node, uid, effect, validateDocument, type Point, type Network } from './model'
import { booleanContours, outlineNetwork, splitEdge, dashNetwork } from './vector'
import {
  area,
  contours,
  contoursToNetwork,
  networkWalks,
  walkPoints,
  apply,
  multiply,
  inverse,
  rotate,
  translate,
  worldMatrix,
  pointInContours,
  toNetwork,
  SpatialIndex,
  scene,
} from './geometry'
import { Editor } from './engine'
const rect = (x: number, y: number, w: number, h: number): Point[] => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + h },
  { x, y: y + h },
]
const total = (cs: Point[][]) => Math.abs(cs.reduce((s, p) => s + area(p), 0))
it('rejects unrenderable effects and invalid titles before publishing an edit', () => {
  const d = blank(),
    n = node('rectangle', 0, 0, 30, 30)
  d.nodes[n.id] = n
  d.pages[0].children = [n.id]
  for (const radius of [-1, 1001]) {
    const candidate = structuredClone(d)
    candidate.nodes[n.id].effects = [{ ...effect('blur'), radius }]
    expect(() => validateDocument(candidate)).toThrow()
  }
  const editor = new Editor(d),
    before = editor.state.doc
  editor.change('invalid rename', (candidate) => {
    candidate.name = ''
  })
  expect(editor.state.doc).toBe(before)
  expect(editor.canUndo).toBe(false)
})
describe('self-developed planar boolean operations', () => {
  const a = [rect(0, 0, 100, 100)],
    b = [rect(50, 20, 100, 100)]
  it.each([
    ['union', 16000],
    ['intersect', 4000],
    ['subtract', 6000],
    ['exclude', 12000],
  ] as const)('%s computes correct area', (op, expected) => {
    const result = booleanContours([a, b], op)
    expect(total(result)).toBeCloseTo(expected, 4)
  })
  it.each(['union', 'intersect', 'subtract', 'exclude'] as const)(
    'coincident boundaries: %s',
    (op) => {
      const result = booleanContours([a, a], op)
      expect(total(result)).toBeCloseTo(op === 'union' || op === 'intersect' ? 10000 : 0)
    },
  )
  it('preserves a hole and point membership', () => {
    const result = booleanContours([a, [rect(20, 20, 60, 60)]], 'subtract')
    expect(total(result)).toBeCloseTo(6400)
    expect(pointInContours({ x: 50, y: 50 }, result)).toBe(false)
    expect(pointInContours({ x: 10, y: 10 }, result)).toBe(true)
    const network = contoursToNetwork(result)
    expect(
      pointInContours(
        { x: 50, y: 50 },
        networkWalks(network).map((w) => walkPoints(network, w)),
      ),
    ).toBe(false)
  })
  it('merges collinear shared boundaries', () => {
    expect(total(booleanContours([a, [rect(100, 0, 100, 100)]], 'union'))).toBeCloseTo(20000)
  })
  it('preserves disjoint islands', () => {
    expect(booleanContours([a, [rect(200, 0, 50, 50)]], 'union')).toHaveLength(2)
  })
  it('handles a corner touch', () => {
    expect(total(booleanContours([a, [rect(100, 100, 100, 100)]], 'union'))).toBeCloseTo(20000)
  })
  it('splits self-intersecting bow ties', () => {
    const bow = [
      [
        { x: 0, y: 0 },
        { x: 100, y: 100 },
        { x: 0, y: 100 },
        { x: 100, y: 0 },
      ],
    ]
    const result = booleanContours([bow], 'union')
    expect(total(result)).toBeCloseTo(5000)
  })
  it('retains a concave boundary', () => {
    const l = [rect(0, 0, 100, 30)],
      r = [rect(0, 0, 30, 100)]
    expect(total(booleanContours([l, r], 'union'))).toBeCloseTo(5100)
  })
  it('rejects unbounded work', () => {
    const polygon = Array.from({ length: 6001 }, (_, i) => ({ x: Math.cos(i), y: Math.sin(i) }))
    expect(() => booleanContours([[polygon]], 'union')).toThrow('6000')
  })
})
describe('vector network and strokes', () => {
  it('outlines dashed strokes with gaps preserved', () => {
    const g: Network = {
      vertices: [
        { id: 'a', x: 0, y: 0 },
        { id: 'b', x: 100, y: 0 },
      ],
      edges: [{ id: 'e', from: 'a', to: 'b' }],
      fillRule: 'evenodd',
    }
    const dashed = dashNetwork(g, '10 10')
    expect(dashed.edges).toHaveLength(5)
    expect(total(outlineNetwork(dashed, 4, 'butt', 'round'))).toBeCloseTo(200)
  })
  it('supports a branching network with a filled region', () => {
    const g = contoursToNetwork([rect(0, 0, 100, 100)]),
      v = { id: uid(), x: 160, y: 0 }
    g.vertices.push(v)
    g.edges.push({ id: uid(), from: g.vertices[1].id, to: v.id })
    expect(networkWalks(g).some((w) => area(walkPoints(g, w)) > 9000)).toBe(true)
  })
  it('splits a cubic using de Casteljau without changing endpoints', () => {
    const g: Network = {
      vertices: [
        { id: 'a', x: 0, y: 0 },
        { id: 'b', x: 100, y: 0 },
      ],
      edges: [{ id: 'e', from: 'a', to: 'b', c1: { x: 0, y: 100 }, c2: { x: 100, y: 100 } }],
      fillRule: 'evenodd',
    }
    const id = splitEdge(g, 'e')
    expect(g.vertices.find((v) => v.id === id)).toMatchObject({ x: 50, y: 75 })
    expect(g.edges).toHaveLength(2)
    expect(g.edges[0].c1).toEqual({ x: 0, y: 50 })
  })
  it.each(['butt', 'round', 'square'] as const)('outlines %s caps', (cap) => {
    const g: Network = {
      vertices: [
        { id: 'a', x: 0, y: 0 },
        { id: 'b', x: 100, y: 0 },
      ],
      edges: [{ id: 'e', from: 'a', to: 'b' }],
      fillRule: 'evenodd',
    }
    const result = outlineNetwork(g, 10, cap, 'round')
    expect(total(result)).toBeCloseTo(
      cap === 'butt' ? 1000 : cap === 'square' ? 1100 : 1077.6457,
      1,
    )
  })
  it('ellipse conversion preserves closed fill', () => {
    const n = node('ellipse', 0, 0, 100, 100)
    n.network = toNetwork(n)
    expect(total(contours(n))).toBeCloseTo(7848.3755, 1)
  })
})
describe('transforms and editor commands', () => {
  it('new groups preserve pass through across undo, redo and serialization', () => {
    const e = new Editor(blank())
    const a = e.add('rectangle', { x: 0, y: 0, width: 64, height: 64 })
    const b = e.add('rectangle', { x: 32, y: 32, width: 64, height: 64 })
    e.update([a], { blend: 'multiply' }, '混合模式')
    e.select([a, b])
    e.group()
    const group = e.state.selection[0]
    expect(e.state.doc.nodes[group].blend).toBe('pass-through')
    expect(validateDocument(JSON.parse(JSON.stringify(e.state.doc))).nodes[group].blend).toBe(
      'pass-through',
    )
    e.undo()
    expect(e.state.doc.nodes[group]).toBeUndefined()
    e.redo()
    expect(e.state.doc.nodes[group].blend).toBe('pass-through')
    expect(e.state.doc.nodes[a].blend).toBe('multiply')
  })
  it('allows pass through only on a layer, not a paint', () => {
    const d = blank(),
      n = node('rectangle')
    d.nodes[n.id] = n
    d.pages[0].children = [n.id]
    n.blend = 'pass-through'
    expect(() => validateDocument(d)).not.toThrow()
    const invalid = JSON.parse(JSON.stringify(d))
    invalid.nodes[n.id].fills[0].blend = 'pass-through'
    expect(() => validateDocument(invalid)).toThrow()
  })
  it('locked layers reject destructive transforms', () => {
    const e = new Editor(blank())
    const id = e.add('rectangle', { x: 10, y: 20, width: 40, height: 40 })
    e.update([id], { locked: true }, '切换锁定')
    e.transformSelection(translate(100, 100))
    e.remove()
    expect(e.state.doc.nodes[id].transform[4]).toBe(10)
    e.update([id], { locked: false }, '切换锁定')
    expect(e.state.doc.nodes[id].locked).toBe(false)
  })
  it('group bounds follow edited children', () => {
    const e = new Editor(blank())
    const id = e.add('rectangle', { x: 0, y: 0, width: 40, height: 40 })
    e.select([id])
    e.group()
    const group = e.state.selection[0]
    e.update([id], { transform: translate(100, 0) })
    expect(scene(e.state.doc, e.state.page).find((n) => n.id === group)!.bounds.x).toBe(100)
  })
  it('round trips a nested rotated matrix', () => {
    const m = multiply(translate(60, -40), multiply(rotate(38), [2, 0.1, 0.3, 0.8, 40, 50]))
    const p = { x: -24, y: 85 }
    const back = apply(inverse(m), apply(m, p))
    expect(back.x).toBeCloseTo(p.x)
    expect(back.y).toBeCloseTo(p.y)
  })
  it('reparenting and ungrouping preserve world geometry', () => {
    const editor = new Editor(blank())
    const f = editor.add('frame', { x: 100, y: 100, width: 400, height: 400 })
    editor.update([f], { transform: multiply(translate(100, 100), rotate(30)) })
    const a = editor.add('rectangle', { x: 30, y: 20, width: 40, height: 50 })
    const before = worldMatrix(editor.state.doc, a)
    editor.reparent(a, f)
    expect(worldMatrix(editor.state.doc, a)).toEqual(
      expect.arrayContaining(before.map((n) => expect.closeTo(n, 7))),
    )
    editor.select([a])
    editor.group()
    editor.ungroup()
    expect(worldMatrix(editor.state.doc, a)[4]).toBeCloseTo(30)
  })
  it('prevents ancestor cycles', () => {
    const editor = new Editor(blank())
    const a = editor.add('frame', { x: 0, y: 0, width: 200, height: 200 }),
      b = editor.add('frame', { x: 0, y: 0, width: 100, height: 100 }, a)
    editor.reparent(a, b)
    expect(validateDocument(editor.state.doc)).toBeTruthy()
    expect(editor.state.message).toContain('后代')
  })
  it('one drag creates one undo step and cancellation creates none', () => {
    const e = new Editor(blank())
    const id = e.add('rectangle', { x: 0, y: 0, width: 100, height: 100 })
    e.begin('drag')
    for (let i = 0; i < 20; i++) e.preview({ [id]: { transform: translate(i, 0) } })
    e.commit()
    e.undo()
    expect(e.state.doc.nodes[id].transform[4]).toBe(0)
    e.redo()
    expect(e.state.doc.nodes[id].transform[4]).toBe(19)
    e.begin('cancel')
    e.preview({ [id]: { transform: translate(80, 0) } })
    e.cancel()
    expect(e.state.doc.nodes[id].transform[4]).toBe(19)
  })
  it('paste regenerates hierarchy identities', () => {
    const e = new Editor(blank())
    const f = e.add('frame', { x: 0, y: 0, width: 200, height: 200 })
    e.add('rectangle', { x: 5, y: 5, width: 20, height: 20 }, f)
    e.select([f])
    e.copy()
    e.paste()
    expect(Object.keys(e.state.doc.nodes)).toHaveLength(4)
    expect(validateDocument(e.state.doc)).toBeTruthy()
  })
  it('deleting a page deletes only its subtree and undo restores it', () => {
    const e = new Editor(blank())
    e.add('rectangle', { x: 0, y: 0, width: 10, height: 10 })
    e.addPage()
    e.add('rectangle', { x: 0, y: 0, width: 20, height: 20 })
    e.removePage()
    expect(Object.keys(e.state.doc.nodes)).toHaveLength(1)
    e.undo()
    expect(e.state.doc.pages).toHaveLength(2)
    expect(validateDocument(e.state.doc)).toBeTruthy()
  })
  it('aligns independently of selection order', () => {
    const e = new Editor(blank())
    const ids = [0, 80, 230].map((x) => e.add('rectangle', { x, y: 10, width: 40, height: 30 }))
    e.select(ids.reverse())
    e.align('x', 'distribute')
    expect(e.state.doc.nodes[ids[1]].transform[4]).toBeCloseTo(115)
  })
  it('indexes negative coordinates and large frames', () => {
    const d = blank(),
      n = node('frame', -100000, -100000, 200000, 200000)
    d.nodes[n.id] = n
    d.pages[0].children = [n.id]
    const index = new SpatialIndex(scene(d, d.pages[0].id))
    expect(index.query({ x: 0, y: 0, width: 1, height: 1 })).toHaveLength(1)
  })
  it('rejects dangerous fills and duplicate references', () => {
    const d = blank(),
      n = node('rectangle')
    d.nodes[n.id] = n
    d.pages[0].children = [n.id, n.id]
    expect(() => validateDocument(d)).toThrow()
    d.pages[0].children = [n.id]
    n.fills[0].kind = 'image'
    n.fills[0].image = 'javascript:alert(1)'
    expect(() => validateDocument(d)).toThrow()
  })
})
