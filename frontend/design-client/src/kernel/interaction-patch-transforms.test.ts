import { expect, test } from 'vitest'
import { blank, effect, node, paint, stroke, type Matrix } from '../model'
import { applyDocumentPatch, type DocumentPatch } from '../document-patch'
import { interactionPatchTransforms, isBitmapTranslationPatch, isInnerShadowPosePatch } from './interaction-patch-transforms'

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
