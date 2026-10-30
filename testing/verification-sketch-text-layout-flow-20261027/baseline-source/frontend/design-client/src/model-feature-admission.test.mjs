import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { blank, node, paint, stroke, effect, defaultTextStyle, validateDocument } from './model.ts'
import { localSave } from './local-store.ts'

// These are TS admission tests mapped to named canonical Rust predicates below.
// They do not execute Rust or establish complete cross-language schema parity.
function fixture(version = 3, kind = 'rectangle') {
  const document = blank(), shape = node(kind)
  document.schemaVersion = version
  document.nodes[shape.id] = shape
  document.pages[0].children = [shape.id]
  return { document, shape }
}
const system = () => ({ collections: {}, variables: {}, activeModes: {}, styles: {}, libraries: {} })
const extended = [
  ['angular fill', shape => { shape.fills[0].kind = 'angular' }],
  ['diamond fill', shape => { shape.fills[0].kind = 'diamond' }],
  ['fill transform', shape => { shape.fills[0].transform = [1, 0, 0, 1, 0, 0] }],
  ['stroke transform', shape => { shape.strokes = [stroke()]; shape.strokes[0].paint.transform = [1, 0, 0, 1, 0, 0] }],
  ['angular stroke', shape => { shape.strokes = [stroke()]; shape.strokes[0].paint.kind = 'angular' }],
  ['rich-text color', shape => { shape.textRuns = [{ start: 0, end: 1, color: '#123456' }] }],
  ['rich-text link', shape => { shape.textRuns = [{ start: 0, end: 1, link: 'https://example.test/' }] }],
  ['rich-text underline', shape => { shape.textRuns = [{ start: 0, end: 1, underline: true }] }],
  ['rich-text strikethrough', shape => { shape.textRuns = [{ start: 0, end: 1, strikethrough: true }] }],
  ['paragraph spacing', shape => { shape.textStyle = { ...defaultTextStyle(), paragraphSpacing: 10 } }],
  ['paragraph indent', shape => { shape.textStyle = { ...defaultTextStyle(), paragraphIndent: -10 } }],
  ['paragraph justify', shape => { shape.textStyle = { ...defaultTextStyle(), align: 'justify' } }],
]
for (const [name, configure] of extended) {
  test(`${name} requires schema 4 before persistence, including hidden content`, () => {
    for (const version of [1, 2, 3, 4, 5, 6]) {
      const { document, shape } = fixture(version, name.includes('text') || name.includes('paragraph') ? 'text' : 'rectangle')
      shape.text = 'A'; shape.visible = false
      configure(shape)
      const before = JSON.stringify(document)
      if (version < 4) assert.throws(() => validateDocument(document), /设计文件版本 4/)
      else assert.equal(validateDocument(document), document)
      assert.equal(JSON.stringify(document), before)
    }
  })
}

test('boolean operations and nonempty binding/style maps require schema 4 independently of their resources', () => {
  for (const patch of [{ booleanOperation: 'union' }, { bindings: { opacity: 'v' } }, { styleRefs: { fills: 's' } }]) {
    const { document, shape } = fixture(3)
    Object.assign(shape, patch)
    assert.throws(() => validateDocument(document), /设计文件版本 4/)
  }
  const { document, shape } = fixture(4, 'vector'), child = node('rectangle')
  shape.booleanOperation = 'union'; shape.children = [child.id]; document.nodes[child.id] = child
  assert.equal(validateDocument(document), document)
})

test('design-system and prototype presence gates schema 4; null keeps Option absence semantics', () => {
  for (const value of [system(), { interactions: {} }]) {
    const field = 'interactions' in value ? 'prototype' : 'designSystem'
    const { document } = fixture(3)
    document[field] = value
    assert.throws(() => validateDocument(document), /设计文件版本 4/)
    document.schemaVersion = 4
    assert.equal(validateDocument(document), document)
    document.schemaVersion = 2
    document[field] = null
    assert.equal(validateDocument(document), document)
  }
})

test('valid schema4 binding/style resources remain admissible', () => {
  const { document, shape } = fixture(4)
  document.designSystem = system()
  document.designSystem.collections.c = { name: 'C', modes: ['day'], defaultMode: 'day' }
  document.designSystem.variables.v = { name: 'Opacity', collection: 'c', kind: 'number', values: { day: 0.5 } }
  document.designSystem.styles.s = { name: 'Fill', kind: 'paint', value: [paint()] }
  shape.bindings = { opacity: 'v' }; shape.styleRefs = { fills: 's' }
  assert.equal(validateDocument(document), document)
})

for (const kind of ['glass', 'texture']) {
  test(`${kind} material parameters in nodes and shared styles require schema 5`, () => {
    for (const location of ['node', 'style']) {
      const { document, shape } = fixture(4), material = effect(kind)
      if (location === 'node') shape.effects = [material]
      else { document.designSystem = system(); document.designSystem.styles.material = { name: 'Material', kind: 'effect', value: [material] } }
      const before = JSON.stringify(document)
      assert.throws(() => validateDocument(document), /设计文件版本 5/)
      assert.equal(JSON.stringify(document), before)
      document.schemaVersion = 5
      assert.equal(validateDocument(document), document)
    }
  })
}

test('animated material keyframes also require schema 5 before a direct local save', () => {
  const { document, shape } = fixture(4)
  const pose = { kind: shape.kind, transform: shape.transform, width: shape.width, height: shape.height, opacity: 1,
    radii: shape.radii, smoothing: shape.smoothing, fills: shape.fills, strokes: [], effects: [effect('glass')] }
  document.animations = [{ id: 'clip', name: 'Clip', pageId: document.pages[0].id, durationMs: 1000, delayMs: 0,
    repeat: 'once', tracks: [{ nodeId: shape.id, rotationTurns: 0, keyframes: [{ timeMs: 0, value: pose, easing: { kind: 'linear' } }] }] }]
  assert.throws(() => validateDocument(document), /设计文件版本 5/)
  document.schemaVersion = 5
  assert.equal(validateDocument(document), document)
})

test('legacy empty maps, null paint transforms, zero paragraph settings and unparameterized effects retain old-schema semantics', () => {
  const { document, shape } = fixture(2, 'text')
  shape.bindings = {}; shape.styleRefs = {}; shape.fills[0].transform = null
  shape.textStyle = { ...defaultTextStyle(), paragraphSpacing: 0, paragraphIndent: 0 }
  shape.text = 'A'; shape.textRuns = [{ start: 0, end: 1, underline: false, strikethrough: false, color: null, link: null }]
  const legacy = effect('glass'); delete legacy.glass
  shape.effects = [legacy]
  assert.equal(validateDocument(document), document)
})

test('paint transforms match Rust finite coordinate and authored determinant bounds for fills and strokes', () => {
  const invalid = [[1, 0, 0, 1, 0], [1, 0, 0, 1, 0, 0, 0], [1, 0, 0, 1, Infinity, 0],
    [1, 0, 0, 1, 10000001, 0], [1, 0, 0, 0, 0, 0], [1e-13, 0, 0, 1, 0, 0], 'matrix', {}]
  for (const location of ['fill', 'stroke']) {
    for (const transform of invalid) {
      const { document, shape } = fixture(4)
      shape.strokes = [stroke()]
      const p = location === 'fill' ? shape.fills[0] : shape.strokes[0].paint
      p.transform = transform
      assert.throws(() => validateDocument(document), /图层数据无效/)
    }
    for (const transform of [undefined, null, [1e-12, 0, 0, 1, 0, 0], [1, 0, 0, 1, -1e7, 1e7]]) {
      const { document, shape } = fixture(4)
      shape.strokes = [stroke()]
      const p = location === 'fill' ? shape.fills[0] : shape.strokes[0].paint
      p.transform = transform
      assert.equal(validateDocument(document), document)
    }
  }
})

test('paint fit accepts the Rust omitted default or its three values and rejects unknown/null values', () => {
  for (const fit of [undefined, 'cover', 'contain', 'stretch', null, '', 'crop', 1]) {
    const { document, shape } = fixture(2)
    shape.fills[0].fit = fit
    if (fit === undefined || ['cover', 'contain', 'stretch'].includes(fit)) assert.equal(validateDocument(document), document)
    else assert.throws(() => validateDocument(document), /图层数据无效/)
  }
})

test('invalid feature versions and paints are rejected before IndexedDB opens', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB')
  let opens = 0
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: { open() { opens++; throw new Error('Storage must not begin') } } })
  try {
    for (const [version, configure] of [[3, s => { s.fills[0].kind = 'angular' }], [4, s => { s.effects = [effect('glass')] }], [4, s => { s.fills[0].fit = 'invalid' }]]) {
      const { document, shape } = fixture(version); configure(shape)
      await assert.rejects(localSave(document))
    }
    assert.equal(opens, 0)
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'indexedDB', descriptor)
    else delete globalThis.indexedDB
  }
})

test('the correspondence names the canonical Rust feature and transform predicates', () => {
  const read = file => readFileSync(new URL(file, import.meta.url), 'utf8')
  const scene = read('../../../design-studio/crates/design-kernel/src/scene.rs')
  const animation = read('../../../design-studio/crates/design-kernel/src/animation.rs')
  const math = read('../../../design-studio/crates/design-kernel/src/math.rs')
  for (const term of ['pub fn requires_schema4', 'self.mask_type.is_some()', '!self.bindings.is_empty()', '!self.style_refs.is_empty()', 'p.transform.is_some()', '"angular" | "diamond"', '"Material parameters require schema 5"', '"Material styles require schema 5"']) assert.ok(scene.includes(term), term)
  assert.match(animation, /doc\.schema_version < 5/)
  assert.match(math, /d\.abs\(\) < 1e-12/)
})
