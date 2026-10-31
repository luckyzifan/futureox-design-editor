import { readFileSync } from 'node:fs'
import { zstdCompressSync } from 'node:zlib'
import { beforeAll, expect, test } from 'vitest'
import { compileSchema, decodeBinarySchema, type Schema } from 'kiwi-schema'
import { deflateSync, inflateSync, zipSync } from 'fflate'
import { decodeFig, figArchive, importFig } from './import-fig'
import { validateDocument } from './model'

// Use the schema shipped in an actual Figma local export. These are generated
// regression scenes encoded with that schema, not an external layout/pixel oracle.
const nativeFile = new Uint8Array(
  readFileSync(
    new URL(
      '../../../testing/fixtures/design/figma-materials-native-2026-10-08.fig',
      import.meta.url,
    ),
  ),
)
let schema: Schema
let schemaPart: Uint8Array
let encoder: ReturnType<typeof compileSchema>
let nodeFields: Set<string>
function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`Missing fixture ${name}`)
  return value
}

beforeAll(() => {
  const canvas = figArchive(nativeFile)['canvas.fig'],
    length = new DataView(canvas.buffer, canvas.byteOffset, canvas.byteLength).getUint32(12, true)
  schemaPart = canvas.slice(16, 16 + length)
  schema = decodeBinarySchema(inflateSync(schemaPart))
  encoder = compileSchema(schema)
  nodeFields = new Set(
    required(
      schema.definitions.find((d) => d.name === 'NodeChange'),
      'NodeChange',
    ).fields.map((f) => f.name),
  )
})

const guid = (localID: number) => ({ sessionID: 1, localID })
const patch = (values: Record<string, unknown>) => {
  for (const key of Object.keys(values)) {
    if (!nodeFields.has(key))
      throw new Error(`Test field ${key} is absent from the native FIG schema`)
  }
  return values
}
function fixture(
  frame: Record<string, unknown> = {},
  child: Record<string, unknown> = {},
  changes: Record<string, unknown>[] = [],
  compression: 'deflate' | 'zstd' = 'deflate',
) {
  const data = encoder.encodeMessage({
    nodeChanges: [
      { guid: guid(1), type: 'CANVAS', name: 'Page' },
      {
        guid: guid(2),
        type: 'FRAME',
        name: 'Layout',
        parentIndex: { guid: guid(1), position: 'a' },
        size: { x: 200, y: 100 },
        stackPrimarySizing: 'FIXED',
        stackCounterSizing: 'FIXED',
        ...patch(frame),
      },
      {
        guid: guid(3),
        type: 'RECTANGLE',
        name: 'Child',
        parentIndex: { guid: guid(2), position: 'a' },
        size: { x: 20, y: 10 },
        ...patch(child),
      },
      ...changes.map(patch),
    ],
  })
  const parts = [schemaPart, compression === 'zstd' ? zstdCompressSync(data) : deflateSync(data)],
    bytes = new Uint8Array(12 + parts.reduce((size, part) => size + 4 + part.length, 0)),
    view = new DataView(bytes.buffer)
  bytes.set(new TextEncoder().encode('fig-kiwi'))
  view.setUint32(8, 15, true)
  let at = 12
  for (const part of parts) {
    view.setUint32(at, part.length, true)
    bytes.set(part, at + 4)
    at += 4 + part.length
  }
  return bytes
}
function imported(frame: Record<string, unknown> = {}, child: Record<string, unknown> = {}) {
  const result = importFig(fixture(frame, child)),
    nodes = Object.values(result.document.nodes)
  return {
    ...result,
    frame: required(
      nodes.find((n) => n.name === 'Layout'),
      'Layout',
    ),
    child: required(
      nodes.find((n) => n.name === 'Child'),
      'Child',
    ),
  }
}

test('layout fixture vocabulary is the native export schema, including GRID and asymmetric padding', () => {
  expect(schema.definitions.find((d) => d.name === 'StackMode')?.fields.map((f) => f.name)).toEqual(
    ['NONE', 'HORIZONTAL', 'VERTICAL', 'GRID'],
  )
  expect(nodeFields.has('stackHorizontalPadding')).toBe(true)
  expect(nodeFields.has('stackVerticalPadding')).toBe(true)
  expect(nodeFields.has('stackPaddingTop')).toBe(false)
  expect(nodeFields.has('stackPaddingLeft')).toBe(false)
  const raw = decodeFig(
    fixture({ stackMode: 'HORIZONTAL', stackPrimarySizing: 'RESIZE_TO_FIT' }),
  ).data
  expect(raw.nodeChanges[1].stackMode).toBe('HORIZONTAL')
  expect(raw.nodeChanges[1].stackPrimarySizing).toBe('RESIZE_TO_FIT')
})

test('modern horizontal auto-layout preserves actual padding fields, wrapping, alignment and hug sizing', () => {
  const { document, frame, warnings } = imported({
    stackMode: 'HORIZONTAL',
    stackSpacing: 7,
    stackCounterSpacing: 13,
    stackHorizontalPadding: 11,
    stackVerticalPadding: 9,
    stackPaddingRight: 17,
    stackPaddingBottom: 0,
    stackWrap: 'WRAP',
    stackPrimaryAlignItems: 'SPACE_BETWEEN',
    stackCounterAlignItems: 'CENTER',
    stackPrimarySizing: 'RESIZE_TO_FIT',
    stackCounterSizing: 'FIXED',
  })
  expect(frame.layout).toEqual({
    mode: 'horizontal',
    gap: 7,
    lineGap: 13,
    padding: [9, 17, 0, 11],
    wrap: true,
    justify: 'space-between',
    align: 'center',
    columns: 3,
    fillRows: false,
  })
  expect(frame.sizing).toMatchObject({ width: 'hug', height: 'fixed' })
  expect(warnings).toEqual([])
  const saved = JSON.parse(JSON.stringify(document))
  expect(saved.nodes[frame.id].layout).toEqual(frame.layout)
  expect(saved.nodes[frame.id].sizing).toEqual(frame.sizing)
  expect(() => validateDocument(saved)).not.toThrow()
})

test('modern vertical layout maps primary and counter sizing to their actual axes', () => {
  const { frame } = imported({
    stackMode: 'VERTICAL',
    stackPrimarySizing: 'RESIZE_TO_FIT',
    stackCounterSizing: 'FIXED',
    stackHorizontalPadding: 5,
    stackVerticalPadding: 6,
    stackPrimaryAlignItems: 'MAX',
    stackCounterAlignItems: 'MIN',
  })
  expect(frame.layout).toMatchObject({
    mode: 'vertical',
    padding: [6, 5, 6, 5],
    justify: 'end',
    align: 'start',
    gap: 0,
    lineGap: 0,
    wrap: false,
  })
  expect(frame.sizing).toMatchObject({ width: 'fixed', height: 'hug' })
})

test('native implicit-size hug and omitted primary sizing are preserved on either axis', () => {
  for (const stackMode of ['HORIZONTAL', 'VERTICAL']) {
    const { frame } = imported({
      stackMode,
      stackPrimarySizing: undefined,
      stackCounterSizing: 'RESIZE_TO_FIT_WITH_IMPLICIT_SIZE',
    })
    expect(frame.sizing).toMatchObject({ width: 'hug', height: 'hug' })
  }
})

test.each(['HORIZONTAL', 'VERTICAL'])(
  'child fill and optional bounds survive %s layout import',
  (stackMode) => {
    const { document, child } = imported(
      { stackMode },
      {
        stackChildPrimaryGrow: 1,
        stackChildAlignSelf: 'STRETCH',
        stackPositioning: 'AUTO',
        minSize: { value: { x: 10, y: 5 } },
        maxSize: { value: { x: 100, y: 50 } },
      },
    )
    expect(child.sizing).toMatchObject({
      width: 'fill',
      height: 'fill',
      alignSelf: 'stretch',
      absolute: false,
      minWidth: 10,
      minHeight: 5,
      maxWidth: 100,
      maxHeight: 50,
    })
    expect(() => validateDocument(JSON.parse(JSON.stringify(document)))).not.toThrow()
  },
)

test.each([
  ['HORIZONTAL', 'width', 'height'],
  ['VERTICAL', 'height', 'width'],
] as const)('primary grow only fills the primary %s axis', (stackMode, primary, counter) => {
  const { child } = imported(
    { stackMode },
    { stackChildPrimaryGrow: 1, stackChildAlignSelf: 'AUTO', minSize: {}, maxSize: {} },
  )
  expect(child.sizing?.[primary]).toBe('fill')
  expect(child.sizing?.[counter]).toBe('fixed')
  expect(child.sizing?.alignSelf).toBe(null)
})

test.each([
  ['MIN', 'start'],
  ['CENTER', 'center'],
  ['MAX', 'end'],
  ['STRETCH', 'stretch'],
  ['SCALE', 'scale'],
])('constraints preserve %s and the source parent reference size', (source, target) => {
  const { document, child } = imported(
    {},
    { horizontalConstraint: source, verticalConstraint: source },
  )
  expect(child.constraints).toEqual({
    horizontal: target,
    vertical: target,
    referenceWidth: 200,
    referenceHeight: 100,
  })
  expect(JSON.parse(JSON.stringify(document)).nodes[child.id].constraints).toEqual(
    child.constraints,
  )
})

test('all parser containers use the layout mapper and merged node changes retain source semantics', () => {
  for (const compression of ['deflate', 'zstd'] as const) {
    const raw = fixture(
      { stackMode: 'HORIZONTAL', stackHorizontalPadding: 12 },
      {},
      [{ guid: guid(2), stackPaddingRight: 3, stackCounterAlignItems: 'MAX' }],
      compression,
    )
    for (const bytes of [raw, zipSync({ 'canvas.fig': raw })]) {
      const { document } = importFig(bytes),
        frame = required(
          Object.values(document.nodes).find((n) => n.name === 'Layout'),
          'Layout',
        )
      expect(frame.layout).toMatchObject({
        mode: 'horizontal',
        padding: [0, 3, 0, 12],
        align: 'end',
      })
    }
  }
})

test.each([
  ['stackMode', 'GRID'],
  ['stackCounterAlignItems', 'BASELINE'],
  ['stackPrimaryAlignItems', 'SPACE_EVENLY_CSS'],
  ['stackCounterAlignContent', 'SPACE_BETWEEN'],
  ['stackCounterAlign', 'BASELINE'],
  ['stackReverseZIndex', true],
  ['stackSpacing', -1],
  ['stackPaddingRight', -1],
  ['stackPadding', 8],
])(
  'unsupported %s=%s is rejected rather than silently imported with different behavior',
  (field, value) => {
    expect(() => importFig(fixture({ stackMode: 'HORIZONTAL', [field]: value }))).toThrow(
      String(field),
    )
  },
)

test.each([
  ['stackChildPrimaryGrow', 2],
  ['stackChildAlignSelf', 'BASELINE'],
  ['stackChildMarginLeft', 4],
  ['horizontalConstraint', 'FIXED_MIN'],
  ['verticalConstraint', 'FIXED_MAX'],
])('unsupported child %s=%s is diagnosed against its source field', (field, value) => {
  expect(() => importFig(fixture({ stackMode: 'HORIZONTAL' }, { [field]: value }))).toThrow(
    String(field),
  )
})

test('dormant layout fields do not turn ordinary or absolute nodes into flow items', () => {
  const plain = imported(
    {
      stackMode: 'NONE',
      stackPadding: 8,
      stackWrap: 'WRAP',
      stackCounterAlignContent: 'SPACE_BETWEEN',
      stackPrimarySizing: 'RESIZE_TO_FIT_WITH_IMPLICIT_SIZE',
    },
    { stackChildPrimaryGrow: 2, stackChildAlignSelf: 'BASELINE', stackChildMarginLeft: 4 },
  )
  expect(plain.frame.layout).toBeUndefined()
  expect(plain.frame.sizing).toBeUndefined()
  expect(plain.child.sizing).toBeUndefined()
  const absolute = imported(
    { stackMode: 'HORIZONTAL' },
    {
      stackPositioning: 'ABSOLUTE',
      stackChildPrimaryGrow: 2,
      stackChildAlignSelf: 'BASELINE',
      stackChildMarginLeft: 4,
    },
  )
  expect(absolute.child.sizing).toMatchObject({
    absolute: true,
    width: 'fixed',
    height: 'fixed',
    alignSelf: null,
  })
})

test('inverted bounds are not silently accepted', () => {
  expect(() =>
    importFig(
      fixture({}, { minSize: { value: { x: 100, y: 100 } }, maxSize: { value: { x: 50, y: 50 } } }),
    ),
  ).toThrow('minSize/maxSize')
})

test('the actual native material export remains importable after layout preservation', () => {
  const { document } = importFig(nativeFile)
  expect(Object.keys(document.nodes).length).toBeGreaterThan(0)
  // Read-only Plugin API verification, 2026-10-09: these exact source nodes
  // reported AUTO/AUTO and HUG/HUG, with matching names, sizes and spacing.
  // https://www.figma.com/design/KawVhUXCap10WDTprxYEmu?node-id=44-3
  const frames = Object.values(document.nodes).filter((n) => n.layout)
  expect(frames).toHaveLength(5)
  for (const frame of frames) {
    expect(frame.sizing).toMatchObject({ width: 'hug', height: 'hug' })
    // The export itself records ascending child x positions in these horizontal
    // frames. Locale collation of fractional index punctuation scrambles them.
    const positions = frame.children.map((id) => document.nodes[id].transform[4])
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
  }
  expect(() => validateDocument(JSON.parse(JSON.stringify(document)))).not.toThrow()
})
