import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { compileSchema, decodeBinarySchema } from 'kiwi-schema'
import { deflateSync, inflateSync } from 'fflate'
import { figArchive, importFig } from './import-fig'
import { validateDocument } from './model'

const native = new Uint8Array(readFileSync(new URL(
  '../../../testing/fixtures/design/figma-materials-native-2026-10-08.fig', import.meta.url,
)))
const canvas = figArchive(native)['canvas.fig']
const length = new DataView(canvas.buffer, canvas.byteOffset, canvas.byteLength).getUint32(12, true)
const schemaPart = canvas.slice(16, 16 + length)
const schema = decodeBinarySchema(inflateSync(schemaPart))
const encoder = compileSchema(schema)
const fields = new Set(schema.definitions.find((d) => d.name === 'NodeChange')!.fields.map((f) => f.name))
const guid = (localID: number) => ({ sessionID: 1, localID })

function encoded(page: Record<string, unknown>, layer?: Record<string, unknown>) {
  for (const key of [...Object.keys(page), ...Object.keys(layer ?? {})])
    expect(fields.has(key), `native schema field ${key}`).toBe(true)
  const message = encoder.encodeMessage({ nodeChanges: [
    { guid: guid(1), type: 'DOCUMENT', name: 'Document', documentColorProfile: 'SRGB' },
    { guid: guid(2), type: 'CANVAS', name: 'Page', parentIndex: { guid: guid(1), position: 'a' }, ...page },
    ...(layer ? [{
      guid: guid(3), type: 'RECTANGLE', name: 'Corner', parentIndex: { guid: guid(2), position: 'a' },
      size: { x: 30, y: 30 }, fillPaints: [], ...layer,
    }] : []),
  ] })
  const parts = [schemaPart, deflateSync(message)]
  const bytes = new Uint8Array(12 + parts.reduce((n, part) => n + 4 + part.length, 0))
  const view = new DataView(bytes.buffer)
  bytes.set(new TextEncoder().encode('fig-kiwi')); view.setUint32(8, 15, true)
  let offset = 12
  for (const part of parts) { view.setUint32(offset, part.length, true); bytes.set(part, offset + 4); offset += part.length + 4 }
  return bytes
}

const black = { type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 } }

test('page background keeps color alpha, backgroundOpacity, and the off switch', () => {
  const half = importFig(encoded({
    backgroundColor: { r: 1, g: 0, b: 0, a: 0.5 },
    backgroundOpacity: 0.5,
    backgroundEnabled: true,
  })).document
  const opacityOnly = importFig(encoded({
    backgroundColor: { r: 1, g: 0, b: 0, a: 1 },
    backgroundOpacity: 0.5,
  })).document
  const off = importFig(encoded({
    backgroundColor: { r: 0, g: 1, b: 0, a: 1 },
    backgroundEnabled: false,
  })).document
  const plain = importFig(encoded({})).document
  const opaque = importFig(encoded({
    backgroundColor: { r: 1, g: 0, b: 0, a: 1 },
    backgroundEnabled: true,
  })).document
  expect(half.pages[0].background).toBe('color(srgb 1 0 0 / 0.25)')
  expect(opacityOnly.pages[0].background).toBe('color(srgb 1 0 0 / 0.5)')
  expect(off.pages[0].background).toBe('color(srgb 0 1 0 / 0)')
  expect(plain.pages[0].background).toBe('#ffffff')
  expect(opaque.pages[0].background).toBe('#ff0000')
  validateDocument(half)
  const reopened = JSON.parse(JSON.stringify(half))
  expect(reopened.pages[0].background).toBe(half.pages[0].background)
  expect(() => importFig(encoded({ backgroundOpacity: 2 }))).toThrow(/页面背景透明度/)
})

test('a non-default miterLimit is stored and a limit of 4 stays omitted', () => {
  const sharp = importFig(encoded({}, {
    strokePaints: [black], strokeWeight: 8, strokeJoin: 'MITER', strokeAlign: 'CENTER', miterLimit: 1.25,
  }))
  validateDocument(sharp.document)
  const node = Object.values(sharp.document.nodes).find(item => item.name === 'Corner')!
  expect(node.strokes[0]).toMatchObject({ join: 'miter', width: 8, miterLimit: 1.25 })
  const meta = sharp.document.designSystem?.sketchContainers?.nodeMetadata as
    Record<string, { bindings?: { figUntranslated?: string } }> | undefined
  expect(meta?.[node.id]?.bindings?.figUntranslated).toBeUndefined()
  const reopened = validateDocument(JSON.parse(JSON.stringify(sharp.document)))
  expect(Object.values(reopened.nodes).find(item => item.name === 'Corner')!.strokes[0].miterLimit).toBe(1.25)

  const normal = importFig(encoded({}, {
    strokePaints: [black], strokeWeight: 8, strokeJoin: 'MITER', miterLimit: 4,
  })).document
  expect(Object.values(normal.nodes).find(item => item.name === 'Corner')!.strokes[0].miterLimit).toBeUndefined()

  const invalid = importFig(encoded({}, {
    strokePaints: [black], strokeWeight: 8, strokeJoin: 'MITER', miterLimit: -1,
  })).document
  const rejected = Object.values(invalid.nodes).find(item => item.name === 'Corner')!
  expect(rejected.strokes[0].miterLimit).toBeUndefined()
  const note = (invalid.designSystem?.sketchContainers?.nodeMetadata as
    Record<string, { bindings?: { figUntranslated?: string } }>)[rejected.id].bindings?.figUntranslated
  expect(note).toContain('miterLimit')
})
