import { expect, test } from 'vitest'
import { blank, effect, node, paint, stroke, type Matrix } from '../model'
import { applyDocumentPatch, type DocumentPatch } from '../document-patch'
import { bitmapRotationPatch, expandBitmapRotationPatch, interactionPatchTransforms, isBitmapTranslationPatch, isInnerShadowPosePatch, isProgressiveBlurEditPatch } from './interaction-patch-transforms'

test('pose admission compares normalized authored paints and still rejects actual edits', () => {
  const before=blank(), path=node('vector',0,0,32,32), id=path.id
  path.fills=[paint('#3388ff')]
  path.strokes=[{...stroke(),visible:false}]
  path.effects=[effect('inner-shadow')]
  before.nodes[id]=path
  before.pages[0].children=[id]
  const raw={...path,transform:[0,1,-1,0,17,23] as Matrix,
    fills:path.fills.map(p=>({...p,image:null})),strokes:path.strokes.map(s=>({...s,paint:{...s.paint,image:null}}))}
  const patch={nodes:{[id]:raw},fields:{}} as unknown as DocumentPatch
  const after=applyDocumentPatch(before,patch)
  expect(interactionPatchTransforms(before,patch,[id])).toBeNull()
  expect(isInnerShadowPosePatch(before,after,patch)).toBe(true)
  raw.fills[0].color='#507090'
  expect(isInnerShadowPosePatch(before,applyDocumentPatch(before,patch),patch)).toBe(false)
  expect(isInnerShadowPosePatch(before,after,{...patch,fields:{name:'other'}})).toBe(false)
  expect(isInnerShadowPosePatch(before,after,{nodes:{[id]:null},fields:{}})).toBe(false)
})

test('viewport commit admission accepts only one pure bitmap translation', () => {
  const before = blank()
  const image = node('rectangle', 0, 0, 320, 240)
  image.fills = [{ ...paint('#000000'), kind: 'image' }]
  before.nodes[image.id] = image
  before.pages[0].children = [image.id]
  const translated = { ...image, transform: [1, 0, 0, 1, 12.5, -2] as Matrix }
  const patch = { fields: {}, nodes: { [image.id]: translated } }
  expect(isBitmapTranslationPatch(before, applyDocumentPatch(before, patch), patch)).toBe(true)
  for (const edited of [
    { ...translated, transform: [0, 1, -1, 0, 12.5, -2] as Matrix },
    { ...translated, fills: [{ ...translated.fills[0], fit: 'contain' }] },
    { ...translated, effects: [effect('gaussian-blur')] },
  ]) {
    const change = { fields: {}, nodes: { [image.id]: edited } } as DocumentPatch
    expect(isBitmapTranslationPatch(before, applyDocumentPatch(before, change), change)).toBe(false)
  }
})

test('a compact bitmap rotation reconstructs the original patch only for a changed affine matrix', () => {
  const before = blank(), image = node('rectangle', 0, 0, 200, 180)
  image.fills = [{ ...paint('#ffffff'), kind: 'image', image: 'test-bitmap' }]
  before.nodes[image.id] = image
  const transform: Matrix = [.8, .6, -.6, .8, 10, 14]
  const changed = { ...image, transform }
  const patch = { nodes: { [image.id]: changed }, fields: {} }
  const compact = bitmapRotationPatch(before, patch)
  expect(compact).toEqual({ [image.id]: transform })
  expect(expandBitmapRotationPatch(before, compact)).toEqual(patch)
  expect(bitmapRotationPatch(before, { nodes: { [image.id]: { ...changed, opacity: .5 } }, fields: {} })).toBeUndefined()
  expect(bitmapRotationPatch(before, { nodes: { [image.id]: changed }, fields: { name: 'changed' } })).toBeUndefined()
  expect(() => expandBitmapRotationPatch(before, { [image.id]: [1, 0, 0, 1, 10, 14] })).toThrow('Invalid bitmap rotation')
  expect(() => expandBitmapRotationPatch(before, { unknown: transform })).toThrow('Invalid bitmap rotation')
})

test('progressive blur repair admits a single changed radius field and excludes unrelated edits', () => {
  const before = blank(), layer = node('ellipse', 0, 0, 40, 25)
  layer.effects = [{ ...effect('background-blur'), gradientBlur: {
    start: [0, 0], end: [16, 8], startCount: 1, endCount: 2, smooth: false,
  } }]
  before.nodes[layer.id] = layer
  const edited = structuredClone(layer)
  edited.effects[0].gradientBlur!.end = [17, 9]
  const qualifies = (next: typeof layer) => {
    const patch = { nodes: { [layer.id]: next }, fields: {} }
    return isProgressiveBlurEditPatch(before, applyDocumentPatch(before, patch), patch)
  }
  expect(qualifies(layer)).toBe(false)
  expect(qualifies(edited)).toBe(true)
  expect(qualifies({ ...edited, opacity: .5 })).toBe(false)
  expect(qualifies({ ...edited, effects: [{ ...edited.effects[0], visible: false }] })).toBe(false)
})
