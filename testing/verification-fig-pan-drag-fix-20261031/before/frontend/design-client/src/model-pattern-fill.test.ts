import { expect, test } from 'vitest'
import type { DesignDocument } from './model'
import { blank, node, paint, stroke, validateDocument, hasPatternTiles, defaultPatternTile } from './model'
import { prepareDocumentForEditing } from './kernel/picking'

const uri =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const docWithTile = (schemaVersion: DesignDocument['schemaVersion']) => {
  const d = blank()
  d.schemaVersion = schemaVersion
  const rect = node('rectangle', 0, 0, 100, 100)
  rect.fills = [{ ...paint('#000000', 'image'), image: uri, fit: 'cover', tile: defaultPatternTile() }]
  rect.fills[0].tile!.size = [24, 24]
  d.nodes[rect.id] = rect
  d.pages[0].children = [rect.id]
  return { d, rect }
}

test('pattern tiles validate on schema-14 image paints and are detected', () => {
  const { d } = docWithTile(14)
  expect(() => validateDocument(d)).not.toThrow()
  expect(hasPatternTiles(d)).toBe(true)
  expect(hasPatternTiles(blank())).toBe(false)
  // JSON round-trip keeps the authored values (serde defaults on load).
  const restored = JSON.parse(JSON.stringify(d))
  expect(() => validateDocument(restored)).not.toThrow()
  const fill = restored.nodes[Object.keys(restored.nodes)[0]].fills[0]
  expect(fill.tile.mode).toBe('grid')
  expect(fill.tile.size).toEqual([24, 24])
})

test('native pattern alignment survives frontend admission and actual WASM preparation',()=>{
  const {d,rect}=docWithTile(14)
  // Native Sketch windows serialize this field even for the default alignment.
  Object.assign(rect.fills[0].tile!,{alignment:['start','start']})
  expect(()=>validateDocument(d)).not.toThrow()
  const prepared=prepareDocumentForEditing(d)
  expect((prepared.nodes[rect.id].fills[0].tile as any).alignment).toEqual(['start','start'])
  expect(()=>validateDocument(prepared)).not.toThrow()
  for(const alignment of [['center','end'],['end','start']]){
    Object.assign(rect.fills[0].tile!,{alignment})
    expect(()=>validateDocument(d)).not.toThrow()
  }
  for(const alignment of [['start'],['unknown','start'],['start',0],null]){
    Object.assign(rect.fills[0].tile!,{alignment})
    expect(()=>validateDocument(d)).toThrow('图层数据无效')
  }
})

test('pattern tiles reject older schemas, non-image paints and bad values', () => {
  const older = docWithTile(13)
  expect(() => validateDocument(older.d)).toThrow('图案平铺')
  const solid = docWithTile(14)
  solid.rect.fills = [{ ...paint('#818cf8'), tile: defaultPatternTile() }]
  expect(() => validateDocument(solid.d)).toThrow('图层数据无效')
  const negative = docWithTile(14)
  negative.d.nodes[negative.rect.id].fills[0].tile!.size = [-8, 8]
  expect(() => validateDocument(negative.d)).toThrow('图层数据无效')
  const unknownMode = docWithTile(14)
  unknownMode.d.nodes[unknownMode.rect.id].fills[0].tile!.mode = 'brick' as never
  expect(() => validateDocument(unknownMode.d)).toThrow('图层数据无效')
  const unknownField = docWithTile(14)
  ;(unknownField.d.nodes[unknownField.rect.id].fills[0].tile as unknown as Record<string, unknown>).rotation = 0.5
  expect(() => validateDocument(unknownField.d)).toThrow('图层数据无效')
})

test('stagger modes validate and absent tiles keep legacy documents valid', () => {
  const d = blank()
  d.schemaVersion = 14
  const rect = node('rectangle', 0, 0, 10, 10)
  rect.fills = [
    { ...paint('#000000', 'image'), image: uri, tile: { mode: 'stagger_horizontal', size: [0, 0], offset: [3, -2] } },
    { ...paint('#000000', 'image'), image: uri, tile: { mode: 'stagger_vertical', size: [12.5, 0], offset: [0, 0] } },
    { ...paint('#000000', 'image'), image: uri, tile: { mode: 'none', size: [8, 8], offset: [0, 0] } },
  ]
  d.nodes[rect.id] = rect
  d.pages[0].children = [rect.id]
  expect(() => validateDocument(d)).not.toThrow()
  expect(hasPatternTiles(d)).toBe(true)
  // Legacy: no tile field anywhere, pre-14 schema stays valid.
  const legacy = blank()
  legacy.schemaVersion = 2
  const old = node('rectangle', 0, 0, 10, 10)
  old.fills = [{ ...paint('#000000', 'image'), image: uri, fit: 'contain' }]
  legacy.nodes[old.id] = old
  legacy.pages[0].children = [old.id]
  expect(() => validateDocument(legacy)).not.toThrow()
  expect(hasPatternTiles(legacy)).toBe(false)
  // Stroke paints carry the same gate.
  const stroked = docWithTile(14)
  stroked.rect.fills = [paint('#818cf8')]
  stroked.rect.strokes = [stroke('#303344')]
  stroked.rect.strokes[0].paint = { ...paint('#000000', 'image'), image: uri, tile: defaultPatternTile() }
  expect(() => validateDocument(stroked.d)).not.toThrow()
  expect(hasPatternTiles(stroked.d)).toBe(true)
})
