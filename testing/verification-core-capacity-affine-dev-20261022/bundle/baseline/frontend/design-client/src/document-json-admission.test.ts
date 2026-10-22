import { expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { admitDocumentJsonSync, admitDocumentSync } from './document-admission'
import { prepareDocumentJsonForEditing, prepareDocumentForEditing } from './kernel/picking'
import { blank, node, type DesignDocument } from './model'
import { Editor } from './engine'
import { componentFixture } from './component-fixtures'
const fixture = JSON.parse(readFileSync(new URL('../../../design-studio/crates/design-kernel/tests/fixtures/document-admission.json', import.meta.url), 'utf8')) as {
  base: DesignDocument; cases: { name: string; accepted: boolean; patches: { path: string; value: unknown }[] }[]
}
function expectJsonGraphSame(actual: unknown, expected: unknown): void {
  if (actual === null || typeof actual !== 'object') { expect(Object.is(actual, expected)).toBe(true); return }
  expect(Object.getPrototypeOf(actual)).toBe(Object.getPrototypeOf(expected))
  expect(Object.keys(actual)).toEqual(Object.keys(expected as object))
  for (const key of Object.keys(actual)) expectJsonGraphSame((actual as any)[key], (expected as any)[key])
}
function outcome(action: () => DesignDocument) {
  try { return { json: JSON.stringify(action()) } }
  catch (error) { return { error: { name: (error as Error).name, message: (error as Error).message } } }
}
for (const entry of fixture.cases) test(`private raw JSON matches baseline admission and error: ${entry.name}`, () => {
  const document = structuredClone(fixture.base)
  for (const patch of entry.patches) {
    const parts = patch.path.slice(1).split('/'); let target: any = document
    for (const part of parts.slice(0, -1)) target = target[part]
    target[parts.at(-1)!] = structuredClone(patch.value)
  }
  const source = JSON.stringify(document), before = structuredClone(document)
  const expected = outcome(() => admitDocumentSync(JSON.parse(source)))
  expect(outcome(() => admitDocumentJsonSync(source))).toEqual(expected)
  expect('error' in expected).toBe(!entry.accepted)
  expect(document).toEqual(before)
})

for (const [label, field] of [
  ['negative zero', '"extra":-0'], ['negative underflow', '"extra":-1e-400'],
  ['positive overflow', '"extra":1e400'], ['negative overflow', '"extra":-1e400'],
  ['deep numeric normalization', '"extra":{"nested":[1,{"values":[-0,1e400,-1e-400]}]}'],
  ['own proto', '"__proto__":{"polluted":true,"extra":[-0,1e400]}'],
  ['own constructor', '"constructor":{"prototype":{"polluted":true}}'],
  ['inert toJSON string', '"extra":{"toJSON":"not callable","a":1}'],
  ['escaped lone surrogates', '"extra":["\\ud800","\\udfff","😀"]'],
  ['duplicate keys', '"extra":1,"extra":2,"duplicate":{"a":1,"a":2}'],
  ['integer key order', '"extra":{"10":1,"2":2,"01":3,"0":4}'],
  ['finite extremes', '"extra":[1.7976931348623157e308,5e-324,9007199254740993,1.23456789012345678]'],
] as const) test(`JSON normalization is byte-identical: ${label}`, () => {
  const source = JSON.stringify(blank()).replace(/}$/, `,${field}}`)
  const actual = admitDocumentJsonSync(source), expected = admitDocumentSync(JSON.parse(source))
  expect(JSON.stringify(actual)).toBe(JSON.stringify(expected))
  expectJsonGraphSame(actual, expected)
  expect(Object.getPrototypeOf(actual)).toBe(Object.prototype)
  expect(({} as any).polluted).toBeUndefined()
})

test('stable private input avoids only the redundant whole-graph JSON parse', () => {
  const source = JSON.stringify(blank()), parse = vi.spyOn(JSON, 'parse')
  try {
    admitDocumentJsonSync(source)
    expect(parse).toHaveBeenCalledTimes(1)
    parse.mockClear()
    admitDocumentSync(JSON.parse(source))
    expect(parse).toHaveBeenCalledTimes(2)
    parse.mockClear()
    admitDocumentJsonSync(source.replace(/}$/, ',"extra":-0}'))
    expect(parse).toHaveBeenCalledTimes(2)
  } finally { parse.mockRestore() }
})

test('non-string callers cannot smuggle mutable references, accessors or coercion callbacks', () => {
  const coerce = vi.fn(() => JSON.stringify(blank()))
  for (const value of [blank(), { toString: coerce }, new String('{}'), undefined, null, 7])
    expect(() => admitDocumentJsonSync(value as string)).toThrow(TypeError)
  expect(coerce).not.toHaveBeenCalled()
})

test('object-input admission still normalizes holes/undefined and detaches caller references', () => {
  const source = { ...blank(), extra: [undefined, , -0], omitted: undefined }
  const admitted = admitDocumentSync(source) as unknown as typeof source
  expect(admitted.extra).toEqual([null, null, 0]); expect(Object.hasOwn(admitted, 'omitted')).toBe(false)
  expect(source.extra[0]).toBeUndefined(); expect(1 in source.extra).toBe(false)
  expect(Object.is(source.extra[2], -0)).toBe(true)
  expect(admitted).not.toBe(source); expect(admitted.extra).not.toBe(source.extra)
})

test('prototype serializer hooks, including self-removing getters, keep original capture semantics', () => {
  const source = JSON.stringify(blank())
  const run = (admit: () => DesignDocument) => {
    Object.defineProperty(Object.prototype, 'toJSON', { configurable: true, get() {
      delete (Object.prototype as any).toJSON
      return function(this: DesignDocument) { return { ...this, name: 'serialized replacement' } }
    } })
    try { return outcome(admit) } finally { delete (Object.prototype as any).toJSON }
  }
  expect(run(() => admitDocumentJsonSync(source))).toEqual(run(() => admitDocumentSync(JSON.parse(source))))
})

test('array prototype serializers keep original normalization and never leak into later calls', () => {
  const source = JSON.stringify({ ...blank(), extra: [1, 2, 3] })
  Object.defineProperty(Array.prototype, 'toJSON', { configurable: true, value: function(this: unknown[]) { return [...this].reverse() } })
  try { expect(outcome(() => admitDocumentJsonSync(source))).toEqual(outcome(() => admitDocumentSync(JSON.parse(source)))) }
  finally { delete (Array.prototype as any).toJSON }
  expect(admitDocumentJsonSync(JSON.stringify(blank()))).toBeDefined()
})

for (const source of ['', '{', '[,]', '{"id":undefined}', '{"x":NaN}', 'null', '[]'])
  test(`malformed or invalid JSON preserves error class and message: ${JSON.stringify(source)}`, () => {
    expect(outcome(() => admitDocumentJsonSync(source))).toEqual(outcome(() => admitDocumentSync(JSON.parse(source))))
  })

test('UTF-8 canonical size rejection is unchanged, including multibyte unknown fields', () => {
  const source = JSON.stringify({ ...blank(), extra: '界'.repeat(Math.ceil(32 * 1024 * 1024 / 3)) })
  expect(outcome(() => admitDocumentJsonSync(source))).toEqual(outcome(() => admitDocumentSync(JSON.parse(source))))
  expect(() => admitDocumentJsonSync(source)).toThrow('设计文件超过 32 MB')
})

test('the raw source route shares exact component/layout/derived validation and failure isolation', () => {
  const document = blank(), shape = node('rectangle', 2, 3, 40, 20)
  document.nodes[shape.id] = shape; document.pages[0].children.push(shape.id)
  const source = JSON.stringify(document), before = structuredClone(document)
  expect(JSON.stringify(prepareDocumentJsonForEditing(source))).toBe(JSON.stringify(prepareDocumentForEditing(JSON.parse(source))))
  expect(document).toEqual(before)
  const editor = new Editor(blank()), old = editor.state.doc, generation = editor.sessionGeneration
  shape.visible = 'bad' as never
  expect(() => editor.load(prepareDocumentJsonForEditing(JSON.stringify(document)))).toThrow()
  expect(editor.state.doc).toBe(old); expect(editor.sessionGeneration).toBe(generation); expect(editor.canUndo).toBe(false)
})

for (const value of ['-0', '-1e-400', '1e400', '-1e400']) test(`known numeric fields preserve normalization or first rejection: ${value}`, () => {
  const document = blank(), shape = node('rectangle', 0, 0, 40, 20)
  document.nodes[shape.id] = shape; document.pages[0].children.push(shape.id)
  const source = JSON.stringify(document).replace('"width":40', `"width":${value}`)
  expect(outcome(() => admitDocumentJsonSync(source))).toEqual(outcome(() => admitDocumentSync(JSON.parse(source))))
})

test('component and nested instance preparation is exact and never mutates the caller fixture', () => {
  const { doc } = componentFixture(), source = JSON.stringify(doc)
  expect(JSON.stringify(prepareDocumentJsonForEditing(source))).toBe(JSON.stringify(prepareDocumentForEditing(JSON.parse(source))))
  expect(JSON.stringify(doc)).toBe(source)
})

test('deep and wide unknown graphs have no recursive walker or spread-argument boundary', () => {
  const wide = { ...blank(), extra: Array.from({ length: 70000 }, (_, i) => ({ value: i })) }
  let deep: unknown = -0
  for (let i = 0; i < 500; i++) deep = { child: deep }
  for (const document of [wide, { ...blank(), extra: deep }]) {
    const source = JSON.stringify(document)
    expect(outcome(() => admitDocumentJsonSync(source))).toEqual(outcome(() => admitDocumentSync(JSON.parse(source))))
  }
})

test('original object getters and callable toJSON remain on the unchanged snapshot path', () => {
  const object = { ...blank(), extra: { get value() { return 7 }, toJSON() { return { canonical: true } } } }
  const admitted = admitDocumentSync(object) as unknown as typeof object
  expect(admitted.extra).toEqual({ canonical: true }); expect(typeof object.extra.toJSON).toBe('function')
  expect(admitted.extra).not.toBe(object.extra)
})

test('accepted transforms and unknown fields normalize actual graph values, not merely encoded bytes', () => {
  const document = blank(), shape = node('rectangle', 0, 0, 40, 20)
  document.nodes[shape.id] = shape; document.pages[0].children.push(shape.id)
  shape.transform[4] = 'numeric-marker' as never
  for (const value of ['-0', '-1e-400']) {
    const source = JSON.stringify({ ...document, extra: ['numeric-marker', 'overflow-marker'] })
      .replaceAll('"numeric-marker"', value).replace('"overflow-marker"', '1e400')
    const admitted = admitDocumentJsonSync(source) as DesignDocument & { extra: unknown[] }
    expect(admitted).toStrictEqual(admitDocumentSync(JSON.parse(source)))
    expect(Object.is(admitted.nodes[shape.id].transform[4], -0)).toBe(false)
    expect(admitted.nodes[shape.id].transform[4]).toBe(0)
    expect(Object.is(admitted.extra[0], -0)).toBe(false); expect(admitted.extra[0]).toBe(0)
    expect(admitted.extra[1]).toBeNull()
  }
})
