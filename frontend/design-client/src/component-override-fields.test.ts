/// <reference types="node" />
import { expect, test } from 'vitest'
import { readFile } from 'node:fs/promises'
import { originNode } from './component-fixtures'
import { insertInstance, overrideFields, stampKeys } from './components'
import { admitDocumentSync } from './document-admission'
import { Editor } from './engine'
import { kernelLayout } from './kernel/picking'
import { blank, node, paint, type DesignDocument } from './model'

// test-setup.ts initializes the actual packaged CPU WASM. No renderer is used.
function overrideFixture() {
  const doc = blank('Component field overrides'),
    main = node('frame', 0, 0, 120, 140),
    mask = node('rectangle', 0, 0, 80, 40),
    boolean = node('vector', 0, 60, 80, 40),
    left = node('rectangle', 0, 0, 60, 40),
    right = node('rectangle', 20, 0, 60, 40)
  doc.schemaVersion = 4
  main.component = { variants: {}, properties: {} }
  main.mask = mask.mask = true
  main.maskType = mask.maskType = 'alpha'
  main.children = [mask.id, boolean.id]
  boolean.booleanOperation = 'union'
  boolean.children = [left.id, right.id]
  boolean.fills = [paint('#818cf8')]
  boolean.strokes = []
  for (const n of [main, mask, boolean, left, right]) doc.nodes[n.id] = n
  doc.pages[0].children = [main.id]
  stampKeys(doc, main.id)
  const a = insertInstance(doc, main.id, doc.pages[0].id, { x: 200, y: 0 }),
    b = insertInstance(doc, main.id, doc.pages[0].id, { x: 400, y: 0 })
  return { e: new Editor(doc), ids: { main: main.id, mask: mask.id, boolean: boolean.id, a, b } }
}

function expectCanonical(doc: DesignDocument) {
  expect(() => admitDocumentSync(doc)).not.toThrow()
  expect(kernelLayout(doc)).toEqual(doc)
}

test('captured component fields exactly match the Rust FIELDS authority', async () => {
  const source = await readFile(
    new URL('../../../design-studio/crates/design-kernel/src/components.rs', import.meta.url),
    'utf8',
  )
  const declarations = [...source.matchAll(
    /\bpub\s+const\s+FIELDS\s*:\s*&\s*\[\s*&str\s*\]\s*=\s*&\s*\[([\s\S]*?)\]\s*;/g,
  )]
  expect(declarations).toHaveLength(1)
  // Parse the complete literal, rather than extracting/ignoring unknown tokens.
  const rustFields: unknown = JSON.parse(`[${declarations[0][1].replace(/,\s*$/, '')}]`)
  expect(Array.isArray(rustFields)).toBe(true)
  const fields = rustFields as string[]
  expect(fields.length).toBeGreaterThan(0)
  expect(fields.every((field) => typeof field === 'string')).toBe(true)
  expect(new Set(fields).size).toBe(fields.length)
  expect(new Set(overrideFields).size).toBe(overrideFields.length)
  expect([...overrideFields].sort()).toEqual([...fields].sort())
})

test.each(['root', 'descendant'] as const)(
  'maskType %s overrides survive history, regeneration and reset locally',
  (target) => {
    const { e, ids } = overrideFixture(),
      key = target === 'root' ? '$root' : ids.mask,
      master = target === 'root' ? ids.main : ids.mask
    const layer = (editor: Editor, owner: string) => target === 'root'
      ? editor.state.doc.nodes[owner]
      : originNode(editor.state.doc, owner, key)
    const id = layer(e, ids.a).id
    const check = (editor: Editor, value: 'alpha' | 'luminance', overridden: boolean) => {
      expect(layer(editor, ids.a).id).toBe(id)
      expect(layer(editor, ids.a).mask).toBe(true)
      expect(layer(editor, ids.a).maskType, editor.state.message).toBe(value)
      expect(editor.state.doc.nodes[ids.a].instance!.overrides[key]?.maskType)
        .toBe(overridden ? 'luminance' : undefined)
      expect(editor.state.doc.nodes[master].maskType).toBe('alpha')
      expect(layer(editor, ids.b).maskType).toBe('alpha')
      expect(editor.state.doc.nodes[ids.b].instance!.overrides).toEqual({})
    }

    check(e, 'alpha', false)
    e.update([id], { maskType: 'luminance' })
    check(e, 'luminance', true)
    e.undo()
    check(e, 'alpha', false)
    e.redo()
    check(e, 'luminance', true)

    e.update([master], { name: 'Regenerated mask default' })
    check(e, 'luminance', true)
    expect(layer(e, ids.a).name).toBe('Regenerated mask default')
    expect(layer(e, ids.b).name).toBe('Regenerated mask default')
    const reloaded = new Editor(JSON.parse(JSON.stringify(e.state.doc)))
    check(reloaded, 'luminance', true)
    expectCanonical(reloaded.state.doc)

    e.resetInstance(id)
    check(e, 'alpha', false)
    e.undo()
    check(e, 'luminance', true)
    e.redo()
    check(e, 'alpha', false)
    e.update([master], { name: 'Regenerated after mask reset' })
    check(e, 'alpha', false)
    expect(layer(e, ids.a).name).toBe('Regenerated after mask reset')
    expectCanonical(e.state.doc)
  },
)

test('booleanOperation descendant overrides survive history, regeneration and reset locally', () => {
  const { e, ids } = overrideFixture(),
    key = ids.boolean,
    generated = originNode(e.state.doc, ids.a, key),
    id = generated.id,
    operands = [...generated.children],
    unionNetwork = JSON.stringify(generated.network)
  const check = (
    editor: Editor,
    value: 'union' | 'subtract' | 'intersect' | 'exclude',
    masterValue: 'union' | 'intersect' | 'exclude',
    overridden: boolean,
  ) => {
    const local = originNode(editor.state.doc, ids.a, key)
    expect(local.id).toBe(id)
    expect(local.kind).toBe('vector')
    expect(local.children).toEqual(operands)
    expect(local.network?.edges.length).toBeGreaterThan(0)
    expect(local.booleanOperation, editor.state.message).toBe(value)
    expect(editor.state.doc.nodes[ids.a].instance!.overrides[key]?.booleanOperation)
      .toBe(overridden ? 'subtract' : undefined)
    expect(editor.state.doc.nodes[ids.boolean].booleanOperation).toBe(masterValue)
    expect(originNode(editor.state.doc, ids.b, key).booleanOperation).toBe(masterValue)
    expect(editor.state.doc.nodes[ids.b].instance!.overrides).toEqual({})
  }

  check(e, 'union', 'union', false)
  e.update([id], { booleanOperation: 'subtract' })
  check(e, 'subtract', 'union', true)
  const subtractNetwork = JSON.stringify(e.state.doc.nodes[id].network)
  expect(subtractNetwork).not.toBe(unionNetwork)
  e.undo()
  check(e, 'union', 'union', false)
  expect(JSON.stringify(e.state.doc.nodes[id].network)).toBe(unionNetwork)
  e.redo()
  check(e, 'subtract', 'union', true)
  expect(JSON.stringify(e.state.doc.nodes[id].network)).toBe(subtractNetwork)

  e.update([ids.boolean], { booleanOperation: 'intersect' })
  check(e, 'subtract', 'intersect', true)
  const reloaded = new Editor(JSON.parse(JSON.stringify(e.state.doc)))
  check(reloaded, 'subtract', 'intersect', true)
  expectCanonical(reloaded.state.doc)

  e.resetInstance(id)
  check(e, 'intersect', 'intersect', false)
  expect(e.state.doc.nodes[id].network).toEqual(originNode(e.state.doc, ids.b, key).network)
  e.undo()
  check(e, 'subtract', 'intersect', true)
  e.redo()
  check(e, 'intersect', 'intersect', false)
  e.update([ids.boolean], { booleanOperation: 'exclude' })
  check(e, 'exclude', 'exclude', false)
  expectCanonical(e.state.doc)
})
